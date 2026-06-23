/**
 * 上下文记忆 — Agent 的可变对话历史管理器。
 *
 * 本模块是 Agent 消息历史的唯一数据源。
 * 负责追加用户消息、系统提醒和循环事件（流式 step/content/tool 事件），
 * 同时保证不变量：除了尾部外，任何位置不得出现未解决的 tool-call 交换。
 *
 * 核心职责：
 * - **历史管理**：追加、撤销、清空和压缩消息。
 * - **延迟消息队列**：当 tool-call 交换仍在进行中（部分工具结果待返回）时，
 *   新到的消息会排入 `deferredMessages`，待交换结束后再刷出。这可防止
 *   不相关的消息在未关闭的工具交换中间穿插。
 * - **Token 计数**：维护运行中的 token 数量估算，对追加的消息增量更新，
 *   并在每步结束后根据 Provider 报告的用量进行校准。
 * - **投影**：委托 projector 模块生成干净的面向 Provider 的消息数组
 *   （剥离元数据、合并相邻的用户消息、过滤占位符）。
 * - **重放构建器集成**：每个变更都会报告给重放构建器，以便会话录制
 *   能忠实还原对话过程。
 */

import { createToolMessage, type ContentPart, type Message } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '../../errors';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../loop';
import { estimateTokensForMessages } from '../../utils/tokens';
import type { CompactionResult } from '../compaction';
import { project, trimTrailingOpenToolExchange } from './projector';
import {
  USER_PROMPT_ORIGIN,
  type AgentContextData,
  type ContextMessage,
  type PromptOrigin,
} from './types';

export * from './types';

/** 工具执行本身失败时注入到工具结果中的标记。 */
const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
/** 工具未产生任何输出时注入到工具结果中的标记。 */
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
/** 工具执行失败且未产生任何输出时的标记。 */
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';
/** 中断后恢复时注入的标记，用于警告模型最后一次工具调用可能未完成。 */
const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

/**
 * 管理 Agent 的对话上下文 — 即构成 LLM 工作记忆的有序消息列表。
 *
 * 保证不变量：`_history` 中除尾部外不包含未解决的 tool-call 交换。
 * 当尾部存在未解决的工具调用（部分工具结果仍在等待中）时，新到的
 * 消息会暂存在 `deferredMessages` 中，待所有待返回的工具结果到齐后
 * 自动刷出。
 *
 * @remarks
 * 本类与拥有它的 {@link Agent} 实例紧密耦合 — 它会访问 Agent 的
 * 记录系统、重放构建器、注入系统、后台任务管理器和微压缩子模块。
 * 不适合独立使用。
 */
export class ContextMemory {
  /** 有序的对话历史 — 所有上下文操作的数据源。 */
  private _history: ContextMessage[] = [];
  /** 消息的缓存 token 计数，覆盖到 `tokenCountCoveredMessageCount` 为止的消息。 */
  private _tokenCount = 0;
  /** `_history` 中已精确计算 token 的消息索引上限。超出此索引的消息
   *  通过 `tokenCountWithPending` 按需估算。 */
  private tokenCountCoveredMessageCount = 0;
  /** 步骤 UUID → 该步骤正在构建的助手消息的映射。对应的 `step.end`
   *  事件到达后会被移除。 */
  private openSteps: Map<string, ContextMessage> = new Map();
  /** 尚未收到结果的工具调用 ID 集合。非空时，`_history` 的尾部
   *  包含一个未关闭的工具交换。 */
  private pendingToolResultIds = new Set<string>();
  /** 工具交换进行期间排队的消息。所有待返回的工具结果到齐后刷入 `_history`。 */
  private deferredMessages: ContextMessage[] = [];
  /** 最近一条助手消息的时间戳（毫秒纪元），用于空闲时间计算。
   *  尚未追加助手消息时为 null。 */
  private _lastAssistantAt: number | null = null;

  /**
   * @param agent - 拥有此上下文的 Agent 实例。用于访问记录系统、重放构建器、
   *   注入系统、后台任务、微压缩和状态发射。
   */
  constructor(protected readonly agent: Agent) {}

  /**
   * 最近一条助手消息的时间戳，如果不存在则返回 null。
   * 空闲检测子系统用它来判断 Agent 已沉默多久。
   */
  get lastAssistantAt(): number | null {
    return this._lastAssistantAt;
  }

  /**
   * 向上下文追加一条用户消息。
   *
   * 空的内容数组会被静默忽略。如果工具交换仍在进行中，消息会被排入
   * `deferredMessages`，确保它出现在交换结束后而非穿插在交换中间。
   *
   * @param content - 消息内容部分（文本、图片等）。
   * @param origin - 消息来源；默认为 {@link USER_PROMPT_ORIGIN}。
   */
  appendUserMessage(
    content: readonly ContentPart[],
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): void {
    if (content.length === 0) return;
    this.appendMessage({
      role: 'user',
      content: [...content],
      toolCalls: [],
      origin,
    });
  }

  /**
   * 向上下文追加一条系统提醒消息。
   *
   * 系统提醒会被包裹在 `<system-reminder>` XML 标签中，并以用户角色消息
   * 的形式注入。它们携带特定的来源标识，以便撤销和压缩逻辑能将其与用户
   * 输入的提示词区分开来。
   *
   * @param content - 提醒文本（会被 trim 处理）。
   * @param origin - 描述此提醒注入原因的来源信息。
   */
  appendSystemReminder(content: string, origin: PromptOrigin): void {
    const text = `<system-reminder>\n${content.trim()}\n</system-reminder>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin,
    });
  }

  appendLocalCommandStdout(content: string): void {
    const text = `<local-command-stdout>\n${content.trim()}\n</local-command-stdout>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'local-command-stdout' },
    });
  }

  popMatchedMessage(matcher: (origin: PromptOrigin | undefined) => boolean): boolean {
    const lastDeferred = this.deferredMessages.at(-1);
    const last = lastDeferred ?? this._history.at(-1);
    if (last === undefined) return false;
    if (!matcher(last.origin)) return false;
    if (lastDeferred !== undefined) {
      this.deferredMessages.pop();
    } else {
      this._history.pop();
    }
    return true;
  }

  /**
   * 重置整个上下文 — 历史记录、token 计数、已打开的步骤、延迟消息，
   * 以及所有关联子系统（微压缩、注入、重放构建器）。发射状态更新
   * 以便 UI 反映空状态。
   */
  clear(): void {
    this.agent.records.logRecord({ type: 'context.clear' });
    this._history = [];
    this._tokenCount = 0;
    this.tokenCountCoveredMessageCount = 0;
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
    this._lastAssistantAt = null;
    this.agent.microCompaction.reset();
    this.agent.injection.onContextClear();
    this.agent.emitStatusUpdated();
  }

  /**
   * 从上下文中撤销最近 N 个用户提示词。
   *
   * 从历史记录末尾向前遍历，移除与每个用户提示词关联的消息
   * （包括随后的助手回复和工具交换）。注入消息会被跳过；
   * 压缩摘要作为硬性边界 — 撤销不能跨越压缩。
   *
   * 如果请求的撤销次数超过活跃上下文中可撤销的提示词数量
   * （非从录制恢复时），将抛出 code 为 `REQUEST_INVALID` 的
   * {@link KimiError}。
   *
   * @param count - 要撤销的用户提示词数量。
   */
  undo(count: number): void {
    if (count <= 0) return;
    if (this._history.length === 0) return;

    this.agent.records.logRecord({ type: 'context.undo', count });

    let removedUserCount = 0;
    const removedMessages = new Set<ContextMessage>();
    let stoppedAtBoundary = false;
    for (let i = this._history.length - 1; i >= 0; i--) {
      const message = this._history[i];
      if (message === undefined) continue;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') {
        stoppedAtBoundary = true;
        break;
      }

      removedMessages.add(message);
      this._history.splice(i, 1);
      this.agent.injection.onContextMessageRemoved(i);

      if (i < this.tokenCountCoveredMessageCount) {
        this.tokenCountCoveredMessageCount--;
        this._tokenCount -= estimateTokensForMessages([message]);
      }

      if (isRealUserPrompt(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }

    this.agent.replayBuilder.removeLastMessages(removedMessages);

    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
    this.agent.microCompaction.reset(this._history.length);
    this.agent.emitStatusUpdated();

    if (
      !this.agent.records.restoring &&
      (stoppedAtBoundary || removedUserCount < count)
    ) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        formatUndoUnavailableMessage(count, removedUserCount, stoppedAtBoundary),
        {
          details: {
            reason: 'undo_limit',
            requestedCount: count,
            undoableCount: removedUserCount,
            stoppedAtCompaction: stoppedAtBoundary,
          },
        },
      );
    }
  }

  /**
   * 应用压缩结果 — 用一条摘要消息替换历史记录中被压缩的前缀部分。
   *
   * 更新 token 计数、重置已打开的步骤和微压缩状态，并通知注入系统
   * 以便其调整偏移跟踪。
   *
   * @param result - 包含摘要文本、计数和 token 测量值的压缩结果。
   */
  applyCompaction(result: CompactionResult): void {
    this.agent.records.logRecord({
      type: 'context.apply_compaction',
      ...result,
    });
    this.agent.replayBuilder.patchLast('compaction', {
      result: {
        summary: result.summary,
        compactedCount: result.compactedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      },
    });
    this._history = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: result.summary }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      },
      ...this._history.slice(result.compactedCount),
    ];
    this.openSteps.clear();
    this.flushDeferredMessagesIfToolExchangeClosed();
    this._tokenCount = result.tokensAfter;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.microCompaction.reset();
    this.agent.injection.onContextCompacted(result.compactedCount);
    this.agent.emitStatusUpdated();
  }

  /**
   * 返回当前上下文状态的只读快照。
   * 服务器 API 使用它向客户端报告上下文窗口的使用情况。
   */
  data(): AgentContextData {
    return {
      history: this.history,
      tokenCount: this.tokenCount,
    };
  }

  /** 已由 Provider 完全处理的消息的缓存 token 计数。 */
  get tokenCount(): number {
    return this._tokenCount;
  }

  /**
   * 包含尚未发送给 Provider 的待处理消息的估算总 token 数。
   * 比 `tokenCount` 更及时，但精度较低，因为它使用估算值
   * 而非 Provider 报告的实际用量。
   */
  get tokenCountWithPending(): number {
    const pendingMessages = this._history.slice(this.tokenCountCoveredMessageCount);
    return this._tokenCount + estimateTokensForMessages(pendingMessages);
  }

  /** 内部上下文消息历史（只读视图）。包含来源元数据。 */
  get history(): readonly ContextMessage[] {
    return this._history;
  }

  /**
   * 将一组上下文消息投影为面向 Provider 的消息。
   *
   * 先执行微压缩，然后委托 projector 剥离元数据并合并相邻的用户消息。
   *
   * @param messages - 要投影的上下文消息。
   * @returns 适合发送给 LLM Provider 的干净消息。
   */
  project(messages: readonly ContextMessage[]): Message[] {
    return project(this.agent.microCompaction.compact(messages));
  }

  /**
   * 便捷访问器，单次调用即可将完整的当前历史投影为
   * 面向 Provider 的消息。
   */
  get messages(): Message[] {
    return this.project(this.history);
  }

  /**
   * 用另一个 {@link ContextMemory} 实例的投影历史替换当前上下文的历史。
   *
   * 当一个 Agent 从另一个 Agent 的对话中恢复时使用 — 投影后的历史
   * 已剥离上下文元数据，尾部不完整的工具交换也会被裁剪，
   * 以确保干净的起始点。
   *
   * @param source - 要从中复制投影历史的上下文记忆实例。
   */
  useProjectedHistoryFrom(source: ContextMemory): void {
    this.clear();
    this.pushHistory(...trimTrailingOpenToolExchange(source.project(source.history)));
  }

  /**
   * 中断恢复后完成上下文状态的最终处理。
   *
   * 会话中断时仍在等待中的工具调用会被关闭，并附带一条错误结果，
   * 警告模型该工具可能未完成执行。这可防止模型误以为被中断的操作
   * 已成功完成。
   */
  finishResume(): void {
    const interruptedToolCallIds = [...this.pendingToolResultIds];
    this.openSteps.clear();
    if (interruptedToolCallIds.length === 0) return;

    for (const toolCallId of interruptedToolCallIds) {
      this.appendLoopEvent({
        type: 'tool.result',
        parentUuid: toolCallId,
        toolCallId,
        result: {
          output: TOOL_INTERRUPTED_ON_RESUME_OUTPUT,
          isError: true,
        },
      });
    }
  }

  /**
   * 处理循环记录事件并相应地更新上下文。
   *
   * 这是将 Agent 流式输出接入上下文的主要入口。事件按类型分派：
   *
   * - `step.begin` — 打开一个新的助手消息占位符。
   * - `step.end` — 关闭该步骤，根据 Provider 报告的用量更新 token 计数，
   *   并刷出所有延迟消息。
   * - `content.part` — 向当前打开步骤的助手消息追加一个内容部分
   *   （文本、工具使用块等）。
   * - `tool.call` — 在当前打开的助手消息上记录一个工具调用请求，
   *   并将该工具调用 ID 标记为待处理。
   * - `tool.result` — 将工具结果作为 tool 角色消息追加，并从待处理
   *   集合中移除该工具调用 ID。
   *
   * @param event - 要处理的循环事件。
   * @throws {Error} 如果 `content.part` 或 `tool.call` 引用了未知的步骤 UUID。
   */
  appendLoopEvent(event: LoopRecordedEvent): void {
    this.agent.records.logRecord({
      type: 'context.append_loop_event',
      event,
    });
    switch (event.type) {
      case 'step.begin': {
        const message: ContextMessage = {
          role: 'assistant',
          content: [],
          toolCalls: [],
        };
        this.pushHistory(message);
        this.openSteps.set(event.uuid, message);
        return;
      }
      case 'step.end': {
        const openStep = this.openSteps.get(event.uuid);
        this.openSteps.delete(event.uuid);
        if (event.usage !== undefined) {
          const openStepIndex = openStep === undefined ? -1 : this._history.indexOf(openStep);
          const coveredCount =
            openStepIndex === -1 ? this._history.length : openStepIndex + 1;
          const totalUsage =
            event.usage.inputCacheRead +
            event.usage.inputCacheCreation +
            event.usage.inputOther +
            event.usage.output;
          if (totalUsage > 0) {
            this._tokenCount = totalUsage;
          } else {
            // The provider reported zero usage (e.g. content filter). Do not
            // overwrite the accumulated context token count with 0; add an
            // estimate for the newly covered messages so the invariant between
            // _tokenCount and tokenCountCoveredMessageCount stays intact.
            const previousCoveredCount = this.tokenCountCoveredMessageCount;
            this._tokenCount += estimateTokensForMessages(
              this._history.slice(previousCoveredCount, coveredCount),
            );
          }
          this.tokenCountCoveredMessageCount = coveredCount;
        }
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
      case 'content.part': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) {
          throw new Error(
            `Received content_part for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        openStep.content.push(event.part);
        return;
      }
      case 'tool.call': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) {
          throw new Error(
            `Received tool_call for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        openStep.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
        });
        this.pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        const message = createToolMessage(event.toolCallId, toolResultOutputForModel(event.result));
        this.pushHistory({
          ...message,
          role: 'tool',
          isError: event.result.isError,
        });
        this.pendingToolResultIds.delete(event.toolCallId);
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
    }
  }

  /**
   * 向上下文追加一条完整的消息。
   *
   * 如果工具交换仍在进行中（存在待返回的结果），消息会被延迟发送，
   * 在交换关闭时自动刷出。这保证了工具调用与其结果之间不会出现
   * 不相关的消息。
   *
   * @param message - 要追加的上下文消息。
   */
  appendMessage(message: ContextMessage): void {
    this.agent.records.logRecord({
      type: 'context.append_message',
      message,
    });
    if (this.hasOpenToolExchange()) {
      this.deferredMessages.push(message);
      return;
    }
    this.pushHistory(message);
  }

  /** 当所有待返回的工具结果到齐后，将排队的延迟消息刷入历史记录。 */
  private flushDeferredMessagesIfToolExchangeClosed(): void {
    if (this.pendingToolResultIds.size > 0 || this.deferredMessages.length === 0) {
      return;
    }
    this.pushHistory(...this.deferredMessages);
    this.deferredMessages = [];
  }

  /** 历史记录的尾部是否包含一个未关闭的工具交换（有待返回的结果）。 */
  private hasOpenToolExchange(): boolean {
    return this.pendingToolResultIds.size > 0;
  }

  /**
   * 向内部历史追加一条或多条消息，并通知所有相关子系统
   * （重放构建器、后台任务投递跟踪、助手消息时间戳跟踪）。
   */
  private pushHistory(...messages: ContextMessage[]): void {
    this._history.push(...messages);
    for (const message of messages) {
      if (message.role === 'assistant') {
        this._lastAssistantAt = this.agent.records.restoring?.time ?? Date.now();
      }
      if (message.origin?.kind === 'background_task') {
        this.agent.background.markDeliveredNotification(message.origin);
      }
      this.agent.replayBuilder.push({
        type: 'message',
        message,
      });
    }
  }
}

/**
 * 为模型格式化工具结果，将错误和空输出包裹在 XML 状态标记中，
 * 以便模型能清晰区分成功结果、失败和空响应。
 *
 * 同时处理字符串输出和多部分内容数组。对于错误的字符串输出，
 * 前置 `<system>ERROR:` 标记。空输出会收到
 * `<system>Tool output is empty.` 标记。
 */
function toolResultOutputForModel(result: ExecutableToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    return isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output];
  }
  return output;
}

/** 检查字符串输出是否实质上为空（零长度或仅为 "Tool output is empty." 哨兵值）。 */
function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

/**
 * 判断一条上下文消息是否代表"真正的"用户提示词 —
 * 即计入撤销限制的提示词。
 *
 * 系统注入、压缩摘要和后台任务通知被排除在外。技能激活仅在
 * 用户通过斜杠命令触发时才计入（由模型触发或嵌套在其他技能中
 * 的不计入）。
 */
function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  return false;
}

/**
 * 格式化用户友好的错误消息，解释撤销请求为何无法完全满足 —
 * 原因可能是请求的次数超过了可用的提示词数量，或者遇到了压缩边界。
 */
function formatUndoUnavailableMessage(
  requestedCount: number,
  undoableCount: number,
  stoppedAtCompaction: boolean,
): string {
  const reason = stoppedAtCompaction ? ' after the last compaction' : '';
  return `Cannot undo ${formatPromptCount(requestedCount)}; only ${formatPromptCount(undoableCount)} can be undone in the active context${reason}.`;

  function formatPromptCount(count: number): string {
    return `${String(count)} ${count === 1 ? 'prompt' : 'prompts'}`;
  }
}

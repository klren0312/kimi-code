/**
 * @module compaction/full
 *
 * 完整（基于 LLM 的）压缩实现。这是主要的压缩路径：将对话历史的前缀
 * 连同摘要指令发送给模型，然后用返回的摘要替换该前缀。
 *
 * 压缩循环支持：
 * - **多轮压缩** — 如果单轮未能释放足够空间，策略会重新评估并自动触发下一轮。
 * - **带退避的重试** - 瞬态提供者错误最多重试 {@link MAX_COMPACTION_RETRY_ATTEMPTS} 次。
 * - **溢出恢复** — 如果摘要提示词本身溢出上下文窗口，
 *   压缩前缀会通过 {@link CompactionStrategy.reduceCompactOnOverflow} 逐步缩小。
 * - **取消** — 当用户中断或 agent 轮次结束时可中止压缩。
 * - **前置/后置钩子** - 插件作者可通过 `PreCompact` / `PostCompact` 钩子事件
 *   观察并响应压缩。
 */

import {
  ErrorCodes,
  KimiError,
  isKimiError,
  toKimiErrorPayload,
} from '#/errors';
import {
  APIEmptyResponseError,
  isRetryableGenerateError,
  type GenerateResult,
  type TokenUsage,
  APIContextOverflowError,
  createUserMessage,
} from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { isAbortError } from '../../loop/errors';
import {
  retryBackoffDelays,
  sleepForRetry,
} from '../../loop/retry';
import { renderPrompt } from '../../utils/render-prompt';
import {
  estimateTokens,
  estimateTokensForMessages,
} from '../../utils/tokens';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '../../utils/completion-budget';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import { renderTodoList, type TodoItem } from '../../tools/builtin/state/todo-list';
import type { CompactionBeginData, CompactionResult } from './types';
import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
  type CompactionStrategy,
} from './strategy';

/** 单轮压缩的最大重试次数。 */
export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

/**
 * 当 LLM 的压缩响应在生成完整摘要之前被截断（finish reason 为 `truncated`）时抛出。
 * 这会触发溢出式恢复，缩小压缩前缀。
 */
class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

/**
 * 编排基于 LLM 的 agent 对话历史压缩。
 *
 * 生命周期：
 * 1. 调用 {@link begin}（手动或通过自动压缩检查）启动后台压缩工作器。
 * 2. agent 循环调用 {@link beforeStep} / {@link afterStep} 检查压缩是否应阻塞下一次 LLM 调用。
 * 3. 完成后，工作器用摘要替换压缩前缀，发送遥测数据，并触发 `PostCompact` 钩子。
 *
 * 同一时间最多只能有一个压缩在进行中；压缩期间的后续 `begin` 调用为空操作。
 */
export class FullCompaction {
  /** 当前 agent 轮次中已完成的压缩轮数。 */
  protected compactionCountInTurn = 0;
  /** 当前进行中的压缩状态，空闲时为 `null`。 */
  protected compacting: {
    abortController: AbortController;
    promise: Promise<void>;
    blockedByTurn: boolean;
  } | null = null;
  protected readonly strategy: CompactionStrategy;

  /**
   * @param agent - 所属 agent，其历史和 LLM 提供者将用于摘要生成。
   * @param strategy - 可选的自定义策略；默认为根据 agent 的模型能力和 `kimiConfig`
   *   配置的 {@link DefaultCompactionStrategy}。
   */
  constructor(
    protected readonly agent: Agent,
    strategy?: CompactionStrategy,
  ) {
    this.strategy =
      strategy ??
      new DefaultCompactionStrategy(
        () => agent.config.modelCapabilities.max_context_tokens,
        {
          ...DEFAULT_COMPACTION_CONFIG,
          reservedContextSize:
            agent.kimiConfig?.loopControl?.reservedContextSize ??
            DEFAULT_COMPACTION_CONFIG.reservedContextSize,
        }
      );
  }

  /** 是否有一轮压缩正在进行中。 */
  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  /**
   * 启动新一轮压缩。对于手动压缩，每轮计数器会重置以确保用户至少有一次尝试；
   * 对于自动压缩，计数器递增并受 {@link CompactionStrategy.maxCompactionPerTurn} 限制。
   *
   * 会话回放期间，压缩被记录但不执行。
   */
  begin(data: Readonly<CompactionBeginData>): void {
    if (this.compacting) return;
    if (data.source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    if (this.compactionCountInTurn > this.strategy.maxCompactionPerTurn) return;
    if (this.agent.records.restoring) {
      this.agent.replayBuilder.push({
        type: 'compaction',
        instruction: data.instruction,
      });
      return;
    }
    const compactedCount = this.strategy.computeCompactCount(this.agent.context.history, data.source);
    if (compactedCount === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No prefix that can be compacted in current history.');
    }
    this.agent.records.logRecord({
      type: 'full_compaction.begin',
      ...data,
    });
    this.agent.emitEvent({
      type: 'compaction.started',
      trigger: data.source,
      instruction: data.instruction,
    });
    const abortController = new AbortController();
    this.compacting = {
      abortController,
      promise: this.compactionWorker(abortController.signal, data, compactedCount),
      blockedByTurn: false,
    };
  }

  /**
   * 中止进行中的压缩（如有）。中止信号传播到 LLM 调用，工作器的 promise 被丢弃（不等待）。
   */
  cancel(): void {
    this.agent.replayBuilder.patchLast('compaction', {
      result: 'cancelled',
    });
    if (!this.compacting) return;
    this.agent.records.logRecord({
      type: 'full_compaction.cancel',
    });
    this.compacting.abortController.abort();
    this.compacting = null;
    this.agent.emitEvent({ type: 'compaction.cancelled' });
  }

  /**
   * 压缩工作器所有轮次成功完成时调用。清除进行中状态以便 agent 循环继续。
   */
  markCompleted() {
    this.agent.records.logRecord({
      type: 'full_compaction.complete',
    });
    this.compacting = null;
  }

  /** 委托给 agent 上下文以包含待处理消息的 token 数。 */
  private get tokenCountWithPending(): number {
    return this.agent.context.tokenCountWithPending;
  }

  /** 在新轮次开始时重置每轮压缩计数器。 */
  resetForTurn(): void {
    this.compactionCountInTurn = 0;
  }

  /**
   * 处理提供者的上下文溢出错误。如果没有正在进行的压缩，会立即启动一个。
   * 然后阻塞直到压缩完成（因为溢出意味着循环无法在不释放空间的情况下继续）。
   */
  async handleOverflowError(signal: AbortSignal, error: unknown) {
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) throw error;
    // 对溢出错误始终阻塞
    await this.block(signal);
  }

  /**
   * 每个 agent 步骤之前调用。如果超过阈值则触发自动压缩，
   * 如果同时超过阻塞阈值则阻塞。
   */
  async beforeStep(signal: AbortSignal): Promise<void> {
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending)) {
      await this.block(signal);
    }
  }

  /**
   * 每个 agent 步骤之后调用。仅当策略的触发和阻塞比率之间存在间隔时
   * （允许异步压缩在后台启动而不阻塞），才重新检查压缩。
   */
  async afterStep(): Promise<void> {
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
    // 步骤之后不阻塞
  }

  /**
   * 检查是否应启动自动压缩。如果压缩已在进行中或刚刚启动，返回 `true`。
   */
  private checkAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
    if (!this.strategy.shouldCompact(this.tokenCountWithPending)) return false;
    return this.beginAutoCompaction(throwOnLimit);
  }

  /**
   * 如果没有正在进行的压缩且未达到每轮限制，启动自动压缩。
   * 当 `throwOnLimit` 为 `true` 且超出限制时，抛出 {@link ErrorCodes.CONTEXT_OVERFLOW}
   * 以向用户暴露问题，而非静默失败。
   */
  private beginAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new KimiError(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    this.begin({ source: 'auto', instruction: undefined });
    return this.compacting !== null;
  }

  /**
   * 等待进行中的压缩，连接中止信号取消，以便在 agent 轮次中断时也取消压缩。
   */
  private async block(signal: AbortSignal): Promise<void> {
    const active = this.compacting;
    if (active) {
      active.blockedByTurn = true;
      signal.addEventListener('abort', () => {
        if (this.compacting === active) {
          this.cancel();
        }
      });
      this.agent.emitEvent({
        type: 'compaction.blocked',
        turnId: this.agent.turn.currentId,
      });
      await active.promise;
    }
  }

  /**
   * 运行一轮或多轮的主压缩工作器。每轮之后检查是否需要释放更多空间；
   * 如果需要则启动下一轮。成功时将摘要应用到上下文并记录遥测数据。
   * 失败时取消压缩，根据轮次是否被阻塞来决定重新抛出错误或作为非致命事件发出。
   */
  private async compactionWorker(
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
    compactedCount: number,
  ): Promise<void> {
    try {
      const finalResult = {
        summary: '',
        compactedCount: 1,
        tokensBefore: 0,
        tokensAfter: 0,
      };

      for (let round = 1; ; round++) {
        const result = await this.compactionRound(round, signal, data, compactedCount);
        if (!result) return;

        finalResult.summary = result.summary;
        finalResult.compactedCount += result.compactedCount - 1;
        finalResult.tokensBefore += result.tokensBefore - finalResult.tokensAfter;
        finalResult.tokensAfter = result.tokensAfter;

        if (result.tokensBefore - result.tokensAfter < 1024) break;
        if (!this.strategy.shouldBlock(result.tokensAfter)) break;
        compactedCount = this.strategy.computeCompactCount(this.agent.context.history, data.source);
        if (compactedCount === 0) break;
      }
      this.markCompleted();
      this.agent.emitEvent({ type: 'compaction.completed', result: finalResult });
      await this.agent.injection.injectGoal();
      this.triggerPostCompactHook(data, finalResult);
    } catch (error) {
      if (isAbortError(error)) return;
      const blockedByTurn = this.compacting?.blockedByTurn === true;
      this.cancel();
      this.agent.log.error('compaction failed', { error });
      if (blockedByTurn) {
        throw error;
      }
      this.agent.emitEvent({
        type: 'error',
        ...toKimiErrorPayload(error),
      });
    }
  }

  /**
   * 执行单轮压缩：渲染摘要提示词，带重试逻辑调用 LLM，验证响应，
   * 并将摘要应用到 agent 上下文。如果压缩期间历史被修改（例如撤回操作），
   * 返回 `undefined` 表示应放弃本轮。
   */
  private async compactionRound(
    round: number,
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
    initialCompactedCount: number,
  ) {
    const startedAt = Date.now();
    const originalHistory = [...this.agent.context.history];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;
    try {
      let compactedCount = initialCompactedCount;

      await this.triggerPreCompactHook(data, tokensBefore, signal);

      const model = this.agent.config.model;
      const provider = applyCompletionBudget({
        provider: this.agent.config.provider,
        budget: resolveCompletionBudget({
          reservedContextSize: this.agent.kimiConfig?.loopControl?.reservedContextSize,
        }),
        capability: this.agent.config.modelCapabilities,
      });

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let usage: TokenUsage | null;
      let summary: string;
      while (true) {
        const messagesToCompact = originalHistory.slice(0, compactedCount);
        const messages = [
          ...this.agent.context.project(messagesToCompact),
          createUserMessage(renderPrompt(compactionInstructionTemplate, { customInstruction: data.instruction ?? '' })),
        ];
        try {
          const response = await this.agent.generate(
            provider,
            this.agent.config.systemPrompt,
            [...this.agent.tools.loopTools],
            messages,
            undefined,
            { signal },
          );
          if (response.finishReason === 'truncated') {
            throw new CompactionTruncatedError();
          }
          usage = response.usage;
          summary = extractCompactionSummary(response);
          break;
        } catch (error) {
          if (
            error instanceof APIContextOverflowError ||
            error instanceof CompactionTruncatedError ||
            error instanceof APIEmptyResponseError // 例如仅思考
          ) {
            compactedCount = this.strategy.reduceCompactOnOverflow(messagesToCompact);
          }
          else if (!isRetryableGenerateError(error)) {
            throw error;
          }
          if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          await sleepForRetry(delays[retryCount]!, signal);
          retryCount += 1;
        }
      }

      if (usage !== null) {
        this.agent.usage.record(model, usage);
      }

      const newHistory = this.agent.context.history;
      for (let i = 0; i < originalHistory.length; i++) {
        if (newHistory[i] !== originalHistory[i]) {
          // 压缩期间历史变更，可能由撤回操作引起
          this.cancel();
          return undefined;
        }
      }

      summary = this.postProcessSummary(summary);

      const recent = originalHistory.slice(compactedCount);
      const tokensAfter = estimateTokens(summary) + estimateTokensForMessages(recent);

      const result: CompactionResult = {
        summary,
        compactedCount,
        tokensBefore,
        tokensAfter,
      };

      this.agent.telemetry.track('compaction_finished', {
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        duration: Date.now() - startedAt,
        compactedCount: result.compactedCount,
        retryCount,
        round,
        ...usage,
        ...data,
      });
      this.agent.context.applyCompaction(result);
      return result;
    } catch (error) {
      if (isAbortError(error)) return;
      this.agent.telemetry.track('compaction_failed', {
        ...data,
        tokensBefore,
        duration: Date.now() - startedAt,
        round,
        retryCount,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      if (isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED) throw error;
      throw new KimiError(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
    }
  }

  /** 触发 `PreCompact` 钩子，允许插件准备或否决。 */
  private async triggerPreCompactHook(
    data: Readonly<CompactionBeginData>,
    tokenCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.agent.hooks?.trigger('PreCompact', {
      matcherValue: data.source,
      signal,
      inputData: {
        trigger: data.source,
        tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  /** 触发 `PostCompact` 钩子（即发即忘）以通知插件。 */
  private triggerPostCompactHook(
    data: Readonly<CompactionBeginData>,
    result: CompactionResult,
  ): void {
    void this.agent.hooks?.fireAndForgetTrigger('PostCompact', {
      matcherValue: data.source,
      inputData: {
        trigger: data.source,
        estimatedTokenCount: result.tokensAfter,
      },
    });
  }

  /**
   * 将当前 TODO 列表追加到压缩摘要中，使待处理任务在压缩后存活并
   * 在后续轮次中对 agent 保持可见。
   */
  private postProcessSummary(summary: string): string {
    const storeData = this.agent.tools.storeData();
    const todos = (storeData['todo'] as readonly TodoItem[] | undefined) ?? [];
    if (todos.length === 0) {
      return summary;
    }
    const todoMarkdown = renderTodoList(todos, '## TODO List');
    return `${summary.trim()}\n\n${todoMarkdown}`;
  }
}

/**
 * 从 LLM 的压缩响应中提取文本内容。处理纯字符串和多部分内容响应。
 * 如果响应不包含文本（例如仅思考响应），抛出 {@link APIEmptyResponseError}，
 * 这会触发溢出恢复路径。
 */
function extractCompactionSummary(response: GenerateResult): string {
  const summary =
    typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

  if (summary.trim().length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }
  return summary;
}

/**
 * 基于 Kosong 的循环 `LLM` 接口实现。
 *
 * 将新的 `loop/llm.ts` 契约桥接到 kosong `generate()` 流式 API：
 *
 *   - kosong 的每部分 `onMessagePart` 转发到循环的每增量回调
 *     （`onTextDelta`、`onThinkDelta`、`onToolCallDelta`）。
 *   - 循环的每块回调（`onTextPart`、`onThinkPart`）仅在 kosong 流排空后触发，
 *     遍历合并后的 `result.message.content`。完成的块在 WAL 接缝处着陆，
 *     原始增量从不如此。
 *   - kosong 的完成原因作为 provider 诊断保留。循环从规范化的响应形状
 *     而非 provider 的完成原因拼写中派生循环控制。
 */

import {
  emptyUsage,
  generate as kosongGenerate,
  isRetryableGenerateError,
  type ChatProvider,
  type GenerateCallbacks,
  type Message,
  type ModelCapability,
  type StreamedMessagePart,
} from '@moonshot-ai/kosong';

import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LLMStreamTiming,
} from '../../loop';
import {
  applyCompletionBudget,
  type CompletionBudgetConfig,
} from '../../utils/completion-budget';
import type { GenerateOptionsWithRequestLogFields } from '../llm-request-logger';

/** kosong `generate()` 函数的类型，用于依赖注入。 */
export type GenerateFn = typeof kosongGenerate;

/** 构造 {@link KosongLLM} 实例的配置。 */
export interface KosongLLMConfig {
  /** 处理实际 LLM API 调用的 kosong chat 提供商。 */
  readonly provider: ChatProvider;
  /** 预置到每次对话的系统提示词。 */
  readonly systemPrompt: string;
  /** 可选的模型能力描述符（如最大上下文窗口、工具支持）。 */
  readonly capability?: ModelCapability | undefined;
  /**
   * 可选的 kosong `generate()` 入口点覆盖。允许 Agent 宿主（及其测试工具）
   * 注入脚本化的生成器，而无需替换整个 LLM 实现。
   */
  readonly generate?: GenerateFn | undefined;
  /**
   * 从 agent/provider 设置中解析的补全预算配置。
   * 最终上限应用于每个请求。
   */
  readonly completionBudgetConfig?: CompletionBudgetConfig | undefined;
}

/**
 * 基于 Kosong 的循环 `LLM` 接口实现。
 *
 * 将高层 `LLM.chat()` 契约桥接到 kosong `generate()` 流式 API。
 * 处理每请求的补全预算、流式计时仪器，以及在流排空后将合并的内容部分
 * 重放到每块回调（保持 WAL 追加顺序）。
 */
export class KosongLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;

  private readonly provider: ChatProvider;
  private readonly generate: GenerateFn;
  private readonly completionBudgetConfig: CompletionBudgetConfig | undefined;

  constructor(config: KosongLLMConfig) {
    this.provider = config.provider;
    this.modelName = config.provider.modelName;
    this.systemPrompt = config.systemPrompt;
    this.capability = config.capability;
    this.generate = config.generate ?? kosongGenerate;
    this.completionBudgetConfig = config.completionBudgetConfig;
  }

  /**
   * 执行单个 LLM 聊天请求。将补全预算应用于 provider 的浅克隆
   * （以便重试复用原始的），通过每增量回调流式传输增量，
   * 然后在流完成后将合并的内容部分重放到每块回调。
   * 返回包含工具调用、使用量和流式计时的组装响应。
   */
  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    let requestStartedAt = Date.now();
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    const markRequestStart = (): void => {
      requestStartedAt = Date.now();
    };
    const markStreamEnd = (): void => {
      streamEndedAt = Date.now();
    };
    const markStreamOutput = (): void => {
      firstChunkAt ??= Date.now();
    };
    const callbacks = buildKosongCallbacks(params, markStreamOutput);

    // 计算并应用每请求的补全预算到一个临时浅克隆上。
    // `effectiveProvider` 限于此调用局部，不会写回 `this.provider`，
    // 因此重试（在更高层处理）继续使用相同的长期 provider/client。
    const effectiveProvider = applyCompletionBudget({
      provider: this.provider,
      budget: this.completionBudgetConfig,
      capability: this.capability,
    });
    const options: GenerateOptionsWithRequestLogFields = {
      signal: params.signal,
      onRequestStart: markRequestStart,
      onStreamEnd: markStreamEnd,
      requestLogFields: params.requestLogFields,
    };

    const result = await this.generate(
      effectiveProvider,
      this.systemPrompt,
      [...params.tools],
      params.messages,
      callbacks,
      options,
    );

    // 在流排空后将合并的内容部分重放到循环的每块回调。
    // 这保持了 WAL 追加顺序，并防止上游流在消息中途中止时
    // 着陆部分内容。
    if (params.onTextPart !== undefined || params.onThinkPart !== undefined) {
      for (const part of result.message.content) {
        if (part.type === 'text' && params.onTextPart !== undefined) {
          await params.onTextPart(part);
        } else if (part.type === 'think' && params.onThinkPart !== undefined) {
          await params.onThinkPart(part);
        }
      }
    }

    const response: LLMChatResponse = {
      toolCalls: [...result.message.toolCalls],
      providerFinishReason: result.finishReason ?? undefined,
      rawFinishReason: result.rawFinishReason ?? undefined,
      usage: result.usage ?? emptyUsage(),
      streamTiming:
        firstChunkAt === undefined
          ? undefined
          : buildStreamTiming(requestStartedAt, firstChunkAt, streamEndedAt),
    };

    return response;
  }

  /**
   * 委托给 kosong 的错误分类器以确定错误是否为瞬态
   * （如速率限制、连接重置），以及是否应重试请求。
   */
  isRetryableError(error: unknown): boolean {
    return isRetryableGenerateError(error);
  }
}

/**
 * 从三个挂钟时间戳计算流式计时指标。如果流尚未结束，
 * 使用 `Date.now()` 作为回退，确保调用方始终获得非负持续时间。
 */
function buildStreamTiming(
  requestStartedAt: number,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
): LLMStreamTiming {
  const outputEndedAt = streamEndedAt ?? Date.now();
  return {
    firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
}

/**
 * 构建 kosong `GenerateCallbacks` 对象，将 kosong 的流式事件桥接到
 * 循环的每增量回调（`onTextDelta`、`onThinkDelta`、`onToolCallDelta`）。
 *
 * 工具调用增量需要特殊处理，因为 kosong 可能在提供 toolCallId 和 name 的
 * 对应 `function` 事件之前发出 `tool_call_part` 事件。待处理的增量被缓冲在
 * `pendingIndexedToolCallDeltas` 中，直到身份信息到达。
 */
function buildKosongCallbacks(
  params: LLMChatParams,
  markStreamOutput: () => void,
): GenerateCallbacks {
  type ToolCallIdentity = { readonly toolCallId: string; readonly name: string };
  type BufferedToolCallDelta = { readonly argumentsPart?: string | undefined };

  const toolCallIdentities = new Map<number | string, ToolCallIdentity>();
  const pendingIndexedToolCallDeltas = new Map<number | string, BufferedToolCallDelta[]>();
  let lastToolCallIdentity: ToolCallIdentity | undefined;

  const emitToolCallDelta = (delta: {
    toolCallId: string;
    name: string;
    argumentsPart?: string;
  }): void => {
    if (params.onToolCallDelta === undefined) return;
    params.onToolCallDelta(delta);
  };

  return {
    onMessagePart: (part: StreamedMessagePart) => {
      markStreamOutput();
      if (part.type === 'text') {
        if (params.onTextDelta === undefined) return;
        params.onTextDelta(part.text);
        return;
      }
      if (part.type === 'think') {
        if (params.onThinkDelta === undefined) return;
        params.onThinkDelta(part.think);
        return;
      }
      if (part.type === 'function') {
        const identity = { toolCallId: part.id, name: part.name };
        lastToolCallIdentity = identity;
        if (part._streamIndex !== undefined) {
          toolCallIdentities.set(part._streamIndex, identity);
        }
        emitToolCallDelta({
          toolCallId: part.id,
          name: part.name,
          ...(part.arguments !== null ? { argumentsPart: part.arguments } : {}),
        });
        if (part._streamIndex !== undefined) {
          const pendingDeltas = pendingIndexedToolCallDeltas.get(part._streamIndex);
          if (pendingDeltas !== undefined) {
            pendingIndexedToolCallDeltas.delete(part._streamIndex);
            for (const delta of pendingDeltas) {
              emitToolCallDelta({
                toolCallId: identity.toolCallId,
                name: identity.name,
                ...delta,
              });
            }
          }
        }
        return;
      }
      if (part.type === 'tool_call_part') {
        const argumentsPart = part.argumentsPart;
        const delta = argumentsPart !== null ? { argumentsPart } : {};
        if (part.index !== undefined) {
          const identity = toolCallIdentities.get(part.index);
          if (identity === undefined) {
            const pendingDeltas = pendingIndexedToolCallDeltas.get(part.index) ?? [];
            pendingDeltas.push(delta);
            pendingIndexedToolCallDeltas.set(part.index, pendingDeltas);
            return;
          }
          emitToolCallDelta({
            toolCallId: identity.toolCallId,
            name: identity.name,
            ...delta,
          });
          return;
        }
        const identity = lastToolCallIdentity;
        if (identity === undefined) return;
        emitToolCallDelta({
          toolCallId: identity.toolCallId,
          name: identity.name,
          ...delta,
        });
      }
    },
  };
}

/**
 * 向对话历史前置系统消息。当调用方需要包含系统提示词的完整消息数组时使用
 * （例如用于不单独接受系统提示词的提供商）。
 */
export function buildMessagesWithSystem(systemPrompt: string, history: Message[]): Message[] {
  return [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }], toolCalls: [] },
    ...history,
  ];
}

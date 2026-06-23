import { APIEmptyResponseError } from './errors';
import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from './message';
import type { ChatProvider, FinishReason, GenerateOptions, StreamedMessage } from './provider';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

/** ToolCall 的快照，不包含内部的 `_streamIndex` 路由字段。 */
type StoredToolCall = Omit<ToolCall, '_streamIndex'>;

/**
 * 单次 {@link generate} 调用的结果。
 *
 * 包含完全组装的助手 {@link message}、可选的提供者分配的 {@link id}，
 * 以及 token {@link usage} 统计。
 */
export interface GenerateResult {
  /** 提供者分配的响应标识符，如果不可用则为 `null`。 */
  readonly id: string | null;
  /** 完全组装的助手消息，包含合并后的内容部分和工具调用。 */
  readonly message: Message;
  /** 此次生成的 token 用量，如果未报告则为 `null`。 */
  readonly usage: TokenUsage | null;
  /**
   * 提供者报告的标准化完成原因，如果未发出 finish_reason
   * （例如流在最终事件之前被中断）则为 `null`。
   */
  readonly finishReason: FinishReason | null;
  /**
   * 原始的提供者特定 finish_reason 字符串，按原样保留。
   * 如果提供者未发出则为 `null`。
   */
  readonly rawFinishReason: string | null;
}

export interface GenerateCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  /**
   * 在流排空后，对每个完全组装的工具调用触发一次，按工具调用
   * 在最终助手消息中出现的顺序。
   *
   * 工具调用被故意延迟到流完成之后：并行工具调用的流可能会在
   * 不同调用之间交错参数增量（例如 tc0-header → tc1-header →
   * tc0-args → tc1-args），因此在流中途触发会导致分发一个
   * 参数只解析了一半的工具并触发 toolParseError。
   */
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
}

/**
 * 通过从给定提供者流式传输来生成一条助手消息。
 *
 * 消息的部分在流式传输过程中被合并：连续的兼容部分（例如
 * TextPart + TextPart、ToolCall + ToolCallPart）被就地合并，
 * 因此返回的消息始终包含完全组装的部分。
 *
 * **工具调用的完成**通过合并边界推断（一个不可合并的下一个部分
 * 将待处理的工具调用刷新到 `message.toolCalls` 中）以及流结束
 * 推断。提供者适配器将原生的"完成"信号翻译为此统一形式；
 * 生成循环永远不会看到单独的完成事件。
 *
 * @param provider - 用于生成的聊天提供者。
 * @param systemPrompt - 预置到请求中的系统级指令。
 * @param tools - 模型可能调用的工具定义。
 * @param history - 作为上下文发送的对话历史。
 * @param callbacks - 可选的流式回调。
 * @param options - 可选的每次调用设置（例如 {@link AbortSignal}）。
 *
 * @throws {DOMException} 名称为 `"AbortError"`，当 `options.signal` 在
 *   流式传输之前或期间被中止时。
 * @throws {APIEmptyResponseError} 当响应不包含内容和工具调用，
 *   或仅包含思考内容而没有文本或工具调用时。
 */
export async function generate(
  provider: ChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerateResult> {
  const message: Message = { role: 'assistant', content: [], toolCalls: [] };
  let pendingPart: StreamedMessagePart | null = null;

  // 从提供者流式索引（例如 OpenAI Chat 的 `index`、Responses 的
  // `item_id`）到 `message.toolCalls` 内部位置的映射。用于将来自
  // 并行工具调用的交错参数增量路由到正确的调用。
  const toolCallIndexMap = new Map<number | string, number>();

  // 预检中止检查：如果调用方的信号已中止，我们必须完全不发出
  // 提供者请求。不自行遵守 `signal` 的提供者否则会发出一个
  // 调用方已明确取消的网络调用。
  if (options?.signal?.aborted) {
    throwAbortError();
  }

  options?.onRequestStart?.();
  const stream = await provider.generate(systemPrompt, tools, history, options);

  // 等待后中止检查：`provider.generate()` 可能在注意到飞行中中止
  // 之前就已解析。立即拒绝而不是排空流。
  await throwIfAborted(options?.signal, stream);

  for await (const part of stream) {
    await throwIfAborted(options?.signal, stream);

    // 通知原始部分回调（深拷贝以避免别名修改）。
    if (callbacks?.onMessagePart !== undefined) {
      await callbacks.onMessagePart(deepCopyPart(part));
      await throwIfAborted(options?.signal, stream);
    }

    // 基于索引的并行工具调用参数增量路由。
    // 当 ToolCallPart 到达时，如果其索引指向的工具调用不是当前
    // 待处理的那个，则直接将其追加到 message.toolCalls 中正确的
    // ToolCall，而不是依赖顺序合并。这防止了并行调用之间的
    // 参数交叉污染。
    if (
      isToolCallPart(part) &&
      part.index !== undefined &&
      !isPendingToolCallAtIndex(pendingPart, part.index)
    ) {
      const arrayIdx = toolCallIndexMap.get(part.index);
      if (arrayIdx !== undefined) {
        const target = message.toolCalls[arrayIdx];
        if (target !== undefined && part.argumentsPart !== null) {
          target.arguments =
            target.arguments === null
              ? part.argumentsPart
              : target.arguments + part.argumentsPart;
        }
        continue;
      }
      // 未知索引 — 回退到顺序逻辑作为安全网。
    }

    if (pendingPart === null) {
      pendingPart = part;
    } else if (!mergeInPlace(pendingPart, part)) {
      // 无法合并 — 刷新待处理部分并开始新的部分。
      // 对于并行工具调用，当新的 ToolCall 头到达而上一个
      // ToolCall 仍在待处理状态时会发生这种情况；刷新将
      // 上一个工具调用最终确定到 `message.toolCalls` 中。
      flushPart(message, pendingPart, toolCallIndexMap);
      pendingPart = part;
    }
  }

  await throwIfAborted(options?.signal, stream);
  options?.onStreamEnd?.();

  // 刷新最后一个待处理部分。
  if (pendingPart !== null) {
    flushPart(message, pendingPart, toolCallIndexMap);
  }
  if (message.content.length === 0 && message.toolCalls.length === 0) {
    throw new APIEmptyResponseError(
      'The API returned an empty response (no content, no tool calls).' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  // 仅包含思考的响应（无实际文本、无工具调用）视为不完整。
  const hasThink = message.content.some((p) => p.type === 'think');
  const hasText = message.content.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const hasToolCalls = message.toolCalls.length > 0;

  if (hasThink && !hasText && !hasToolCalls) {
    throw new APIEmptyResponseError(
      'The API returned a response containing only thinking content ' +
        'without any text or tool calls. This usually indicates the ' +
        'stream was interrupted or the output token budget was exhausted ' +
        'during reasoning.' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  // 对每个完全组装的工具调用触发 onToolCall，按最终顺序。
  if (callbacks?.onToolCall !== undefined) {
    for (const toolCall of message.toolCalls) {
      await throwIfAborted(options?.signal, stream);
      await callbacks.onToolCall(toolCall);
    }
  }

  return {
    id: stream.id,
    message,
    usage: stream.usage,
    finishReason: stream.finishReason,
    rawFinishReason: stream.rawFinishReason,
  };
}

type CancelableStream = StreamedMessage & {
  cancel?: () => unknown;
  return?: () => unknown;
};

function throwAbortError(): never {
  throw new DOMException('The operation was aborted.', 'AbortError');
}

async function cancelStream(stream: StreamedMessage): Promise<void> {
  const cancelable = stream as CancelableStream;

  try {
    await cancelable.cancel?.();
  } catch {}

  try {
    await cancelable.return?.();
  } catch {}
}

async function throwIfAborted(signal?: AbortSignal, stream?: StreamedMessage): Promise<void> {
  if (!signal?.aborted) {
    return;
  }

  if (stream !== undefined) {
    await cancelStream(stream);
  }

  throwAbortError();
}

/** 当 `pending` 是 _streamIndex 等于 `index` 的 ToolCall 时返回 `true`。 */
function isPendingToolCallAtIndex(
  pending: StreamedMessagePart | null,
  index: number | string,
): pending is ToolCall {
  return pending !== null && isToolCall(pending) && pending._streamIndex === index;
}

/**
 * 将一个完全合并的部分追加到消息中。
 *
 * - ContentPart -> message.content
 * - ToolCall    -> message.toolCalls（`_streamIndex` 路由键被注册到
 *                  映射表中，并在存储前被剥离）。
 * - ToolCallPart -> 被忽略（没有匹配的待处理调用的孤立增量）
 */
function flushPart(
  message: Message,
  part: StreamedMessagePart,
  toolCallIndexMap: Map<number | string, number>,
): void {
  if (isContentPart(part)) {
    message.content.push(part);
    return;
  }
  if (isToolCall(part)) {
    const streamIndex = part._streamIndex;
    const stored: StoredToolCall = {
      type: 'function',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
      extras: part.extras,
    };
    const ordinal = message.toolCalls.length;
    message.toolCalls.push(stored as ToolCall);
    if (streamIndex !== undefined) {
      toolCallIndexMap.set(streamIndex, ordinal);
    }
  }
  // ToolCallPart：孤立的增量 — 静默忽略。
}

function formatFinishReasonHint(stream: StreamedMessage): string {
  if (stream.finishReason === null && stream.rawFinishReason === null) return '';

  const raw =
    stream.rawFinishReason === null ? '' : `, rawFinishReason=${stream.rawFinishReason}`;
  const filteredHint =
    stream.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';

  return ` Provider stop details: finishReason=${stream.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

/**
 * 生成 StreamedMessagePart 的浅拷贝。
 *
 * 这是有意最小化的：我们只需要对 `mergeInPlace` 修改的可变
 * 字符串字段（text、think、arguments）进行隔离。
 */
function deepCopyPart(part: StreamedMessagePart): StreamedMessagePart {
  return structuredClone(part);
}

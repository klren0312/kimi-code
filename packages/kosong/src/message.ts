export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string; // 提供者特定的推理签名
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string | undefined };
}

/**
 * {@link Message} 中的单个内容片段。
 *
 * 此联合类型涵盖文本、模型推理（"think"）、图片、音频和视频。
 * 提供者在 {@link ChatProvider.generate} 期间将这些转换为
 * 其原生的内容块格式。
 */
export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

export interface ToolCall {
  type: 'function';
  id: string;
  name: string;
  arguments: string | null;
  extras?: Record<string, unknown>;
  /**
   * 提供者特定的流式索引，用于将参数增量路由到正确的并行工具调用。
   * 由流式提供者（OpenAI Chat Completions 的 `index`、Responses API 的
   * `item_id`）设置。由 {@link generate} 内部使用，在 ToolCall 存储到
   * Message 之前会被剥离。
   *
   * @internal
   */
  _streamIndex?: number | string;
}

/** 工具调用参数的流式增量。 */
export interface ToolCallPart {
  type: 'tool_call_part';
  argumentsPart: string | null;
  /**
   * 提供者特定的索引，用于将此流式增量路由到正确的并行工具调用。
   * OpenAI Chat Completions（`index`）和 Responses API
   * （`item_id`/`output_index`）使用此字段。当缺少此字段时，
   * 增量将追加到最近一次看到的 ToolCall（单工具调用回退方案）。
   */
  index?: number | string;
}

/**
 * {@link StreamedMessage} 的异步迭代器产出的单个块。
 *
 * 在流式传输期间，生成循环接收一系列这样的部分，并就地合并
 * 兼容的连续部分（例如 TextPart + TextPart），使最终的
 * {@link Message} 包含完全组装的内容。
 *
 * 工具调用的完成通过合并边界推断（一个不可合并的下一个部分
 * 会刷新待处理的工具调用）以及流结束推断。提供者适配器负责
 * 将其原生的"完成"信号翻译为此形状；它们不会发出单独的完成事件。
 */
export type StreamedMessagePart = ContentPart | ToolCall | ToolCallPart;

/**
 * 对话中的单条消息。
 *
 * 消息携带一个 {@link role}（system、user、assistant 或 tool）、
 * 一组 {@link ContentPart} 内容块，以及可选的 {@link ToolCall} 条目。
 * 工具结果消息设置 {@link toolCallId} 以与发起的调用关联。
 */
export interface Message {
  /** 消息发送者的角色。 */
  readonly role: Role;
  /** 可选的发送者显示名称（某些提供者使用）。 */
  readonly name?: string;
  /** 有序的内容部分（文本、图片、思维等）。 */
  readonly content: ContentPart[];
  /** 助手在此消息中请求的工具调用。 */
  readonly toolCalls: ToolCall[];
  /** 对于 `tool` 角色消息，此结果对应的工具调用 ID。 */
  readonly toolCallId?: string;
  /** 当为 `true` 时，表示消息未完全接收（例如流被中断）。 */
  readonly partial?: boolean;
}

/** 检查流式部分是否为 ContentPart（text、think、image_url、audio_url、video_url）。 */
export function isContentPart(part: StreamedMessagePart): part is ContentPart {
  const t = part.type;
  return (
    t === 'text' || t === 'think' || t === 'image_url' || t === 'audio_url' || t === 'video_url'
  );
}

/** 检查流式部分是否为 ToolCall。 */
export function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

/** 检查流式部分是否为 ToolCallPart（流式参数增量）。 */
export function isToolCallPart(part: StreamedMessagePart): part is ToolCallPart {
  return part.type === 'tool_call_part';
}

/**
 * 将 `source` 就地合并到 `target` 中，用于流式累加。
 *
 * 支持的组合：
 * - TextPart + TextPart -> 拼接文本
 * - ThinkPart + ThinkPart -> 拼接思维（如果 target.encrypted 已设置则拒绝）
 * - ToolCall + ToolCallPart -> 追加参数
 *
 * **并行工具调用的路由**：当 OpenAI（或兼容的）API 并行流式传输
 * 多个工具调用时，参数增量可能在不同调用之间交错。为处理这种情况，
 * {@link generate} 通过 {@link ToolCallPart.index} 可选字段
 * （镜像提供者的流式索引）将 ToolCallPart 路由到正确的待处理 ToolCall，
 * 而不是依赖顺序合并。当待处理部分与传入部分匹配时，此函数仍作为
 * 回退方案执行顺序合并。
 *
 * 如果执行了合并返回 `true`，否则返回 `false`。
 */
export function mergeInPlace(target: StreamedMessagePart, source: StreamedMessagePart): boolean {
  // TextPart + TextPart
  if (target.type === 'text' && source.type === 'text') {
    target.text += source.text;
    return true;
  }

  // ThinkPart + ThinkPart
  if (target.type === 'think' && source.type === 'think') {
    if (target.encrypted !== undefined) {
      return false;
    }
    target.think += source.think;
    if (source.encrypted !== undefined) {
      target.encrypted = source.encrypted;
    }
    return true;
  }

  // ToolCall + ToolCallPart
  if (target.type === 'function' && source.type === 'tool_call_part') {
    if (source.argumentsPart !== null) {
      target.arguments =
        target.arguments === null
          ? source.argumentsPart
          : target.arguments + source.argumentsPart;
    }
    return true;
  }

  return false;
}

/**
 * 从消息的内容部分中提取拼接后的文本。
 *
 * @param message 要从中提取消息的文本。
 * @param sep 文本部分之间的分隔符。默认为空字符串。
 */
export function extractText(message: Message, sep: string = ''): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join(sep);
}

/**
 * @deprecated 请改用 `extractText`。
 */
export function getTextContent(message: Message): string {
  return extractText(message);
}

/** 创建一个包含单个文本部分的简单用户消息。 */
export function createUserMessage(content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: content }],
    toolCalls: [],
  };
}

/** 从内容部分和可选的工具调用创建助手消息。 */
export function createAssistantMessage(content: ContentPart[], toolCalls?: ToolCall[]): Message {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls ?? [],
  };
}

/** 创建工具结果消息。 */
export function createToolMessage(toolCallId: string, output: string | ContentPart[]): Message {
  const content: ContentPart[] =
    typeof output === 'string' ? [{ type: 'text', text: output }] : output;
  return {
    role: 'tool',
    content,
    toolCalls: [],
    toolCallId,
  };
}

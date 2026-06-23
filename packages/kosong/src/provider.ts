import type { Message, StreamedMessagePart, VideoURLPart } from './message';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

/**
 * 跨提供者使用的标准化思维努力级别。
 *
 * 高于 `high` 的值是提供者/模型特定的，当原生 API 没有匹配的级别时，
 * 适配器可能会将其限制。OpenAI 将 `max` 映射到其 `xhigh` 上限；
 * Kimi 和 Gemini 将 `xhigh`/`max` 限制在 `high`；Anthropic
 * 仅在部分模型上支持 `xhigh`/`max`，否则限制为 `high`。
 */
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * 标准化的完成原因信号，指示生成停止的原因。
 *
 * 每个提供者的原生停止值都会映射到这些值之一，未映射的原始字符串
 * 保存在 `rawFinishReason` 中作为逃生通道。`null` 表示提供者未
 * 发出 finish_reason（例如流在最终事件之前被截断）。
 *
 * - `'completed'`：正常完成（OpenAI `'stop'`、Anthropic
 *   `'end_turn'` / `'stop_sequence'`、Gemini `'STOP'`）。
 * - `'tool_calls'`：生成暂停，以便调用方可以分发工具调用并将其
 *   结果反馈。注意 OpenAI Responses API 和 Google GenAI 在此处
 *   报告 `'completed'`；只有 Chat Completions 风格的提供者和
 *   Anthropic 会显示专用值。
 * - `'truncated'`：token 预算耗尽（OpenAI `'length'`、Anthropic
 *   `'max_tokens'`、Gemini `'MAX_TOKENS'`、Responses `'max_output_tokens'`）。
 * - `'filtered'`：内容过滤器或安全策略阻止了响应。
 * - `'paused'`：Anthropic 特定的 `'pause_turn'`。
 * - `'other'`：已识别但不属于上述类别的非空原因。
 */
export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

/**
 * 由单个 LLM 响应产生的消息片段的异步可迭代流。
 *
 * 消费者使用 `for await..of` 迭代流以接收
 * {@link StreamedMessagePart} 块。迭代完成后，
 * {@link id}、{@link usage}、{@link finishReason} 和
 * {@link rawFinishReason} 属性反映提供者报告的最终值。
 */
export interface StreamedMessage {
  [Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart>;
  /** 提供者分配的响应标识符，如果不可用则为 `null`。 */
  readonly id: string | null;
  /** Token 用量统计，在流完成后填充。 */
  readonly usage: TokenUsage | null;
  /**
   * 标准化的完成原因，在流完成后填充。
   *
   * 如果提供者未发出 finish_reason（例如流在最终事件到达之前
   * 被中断），则为 `null`。
   */
  readonly finishReason: FinishReason | null;
  /**
   * 原始的提供者特定 finish_reason 字符串，按原样保留，作为
   * 需要原始线路值的调用方的逃生通道。
   *
   * 如果提供者未发出 finish_reason，则为 `null`。
   */
  readonly rawFinishReason: string | null;
}

/**
 * 可以转发给单个 {@link ChatProvider.generate} 调用的选项。
 */
export interface ProviderRequestAuth {
  /** 为此特定提供者请求解析的 Bearer/API token。 */
  apiKey?: string;
  /** 请求级别的头信息。这些会覆盖构造函数级别的默认头信息。 */
  headers?: Record<string, string>;
}

export interface GenerateOptions {
  /**
   * 一个 {@link AbortSignal}，当被中止时，请求取消正在进行的
   * generate 调用。接受信号的提供者会将其转发给底层的 HTTP 客户端；
   * {@link generate | generate()} 中的生成循环也会在流式部分之间
   * 检查该信号。
   */
  signal?: AbortSignal;
  /**
   * 请求级别的提供者认证。宿主应在每次请求/重试之前立即解析此值，
   * 以确保提供者永远不会保留可变的凭据状态。
   */
  auth?: ProviderRequestAuth;
  /**
   * 宿主端的插桩钩子，在调用提供者适配器的 generate 调用之前立即触发。
   */
  onRequestStart?: () => void;
  /**
   * 宿主端的插桩钩子，在提供者流完全排空之后、在后处理组装好的
   * 响应之前触发。
   */
  onStreamEnd?: () => void;
}

/**
 * 内存中的视频字节数据，用于需要上传文件引用（而非内联数据 URL）
 * 的提供者。
 */
export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string | undefined;
}

/**
 * LLM 聊天提供者的统一接口。
 *
 * 每个提供者实现（Kimi、OpenAI、Anthropic、Google GenAI 等）
 * 将通用的 {@link Message} / {@link Tool} 类型转换为提供者特定的
 * 线路格式，流式返回 {@link StreamedMessage}，并暴露配置辅助方法
 * 如 {@link withThinking}。
 */
export interface ChatProvider {
  /** 提供者后端的短标识符（例如 `"kimi"`、`"anthropic"`）。 */
  readonly name: string;
  /** 传递给上游 API 的模型名称（例如 `"moonshot-v1-auto"`）。 */
  readonly modelName: string;
  /** 当前的思维努力级别，如果未配置思维则为 `null`。 */
  readonly thinkingEffort: ThinkingEffort | null;
  /**
   * 向 LLM 发送对话并返回流式响应。
   *
   * @param systemPrompt - 预置到请求中的系统级指令。
   * @param tools - 模型可能调用的工具定义。
   * @param history - 对话历史（用户、助手、工具消息）。
   * @param options - 可选的每次调用设置，如 {@link AbortSignal}。
   */
  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage>;
  /** 返回此提供者的浅拷贝，设置给定的思维努力级别。 */
  withThinking(effort: ThinkingEffort): ChatProvider;
  /**
   * 返回此提供者的浅拷贝，将每次请求的完成预算限制为
   * `maxCompletionTokens`。为可选方法，因为并非每个后端都受益于
   * 客户端计算的上限。
   *
   * 实现不得在返回的克隆上修改或替换内部 HTTP 客户端——克隆应
   * 与原始实例共享传输状态。参见 `KimiChatProvider._clone()` 了解原因。
   */
  withMaxCompletionTokens?(maxCompletionTokens: number): ChatProvider;
  /** 上传视频并返回可发送给此提供者的内容部分。 */
  uploadVideo?(input: string | VideoUploadInput, options?: GenerateOptions): Promise<VideoURLPart>;
}

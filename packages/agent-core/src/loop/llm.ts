/**
 * 无状态循环使用的模型能力 LLM 契约。
 *
 * 不可变的 `LLM` 对象拥有提供者/模型元数据、能力元数据
 * 和系统提示词。其他宿主关注点通过单独的接口注入。
 */

import type {
  FinishReason,
  Message,
  ModelCapability,
  TextPart,
  ThinkPart,
  TokenUsage,
  Tool,
  ToolCall,
} from '@moonshot-ai/kosong';

export interface ToolCallDelta {
  readonly toolCallId: string;
  readonly name?: string | undefined;
  readonly argumentsPart?: string | undefined;
}

export interface LLMRequestLogFields {
  readonly turnStep: string;
  readonly attempt?: string;
}

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
}

export interface LLMChatParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  requestLogFields?: LLMRequestLogFields;
  onTextDelta?: ((delta: string) => void) | undefined;
  onThinkDelta?: ((delta: string) => void) | undefined;
  onToolCallDelta?: ((delta: ToolCallDelta) => void) | undefined;
  /**
   * 每个完成的文本块触发一次。相对于 `onTextDelta` 是累加的——
   * delta 仍然按块逐个触发以支持 UI 流式渲染。
   * 适配器会等待返回的 Promise 以保持转录追加顺序。
   * 持久化转录写入仅接收已完成的块。
   */
  onTextPart?: ((part: TextPart) => Promise<void> | void) | undefined;
  /**
   * 每个完成的思考块触发一次。相对于 `onThinkDelta` 是累加的——
   * delta 仍然按块逐个触发以支持 UI 流式渲染。
   * 适配器会等待返回的 Promise 以保持转录追加顺序。
   * 持久化转录写入仅接收已完成的块。
   */
  onThinkPart?: ((part: ThinkPart) => Promise<void> | void) | undefined;
}

export interface LLMChatResponse {
  toolCalls: ToolCall[];
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  usage: TokenUsage;
  streamTiming?: LLMStreamTiming;
}

export interface LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;
  isRetryableError?(error: unknown): boolean;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}

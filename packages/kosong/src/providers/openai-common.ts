import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from '#/errors';
import { extractText } from '#/message';
import type { ContentPart, Message } from '#/message';
import type { FinishReason, ThinkingEffort } from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIError as OpenAIAPIError,
  OpenAIError,
} from 'openai';
export interface OpenAIContentPart {
  type: string;
  text?: string | undefined;
  image_url?: { url: string; id?: string | null } | undefined;
  audio_url?: { url: string; id?: string | null } | undefined;
  video_url?: { url: string; id?: string | null } | undefined;
}

/**
 * 将 kosong 的 `ContentPart` 转换为 OpenAI 兼容的内容部件。
 * 对于 think 部件返回 `null`（作为 reasoning_content 单独处理）。
 */
export function convertContentPart(part: ContentPart): OpenAIContentPart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      // think 部件作为 reasoning_content 单独处理——此处跳过。
      return null;
    case 'image_url':
      return {
        type: 'image_url',
        image_url:
          part.imageUrl.id === undefined
            ? { url: part.imageUrl.url }
            : { url: part.imageUrl.url, id: part.imageUrl.id },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audio_url:
          part.audioUrl.id === undefined
            ? { url: part.audioUrl.url }
            : { url: part.audioUrl.url, id: part.audioUrl.id },
      };
    case 'video_url':
      return {
        type: 'video_url',
        video_url:
          part.videoUrl.id === undefined
            ? { url: part.videoUrl.url }
            : { url: part.videoUrl.url, id: part.videoUrl.id },
      };
    default:
      throw new Error(`Unknown content part type: ${(part as ContentPart).type}`);
  }
}
export interface OpenAIToolParam {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * 将 kosong 的 `Tool` 转换为 OpenAI 工具格式。
 */
export function toolToOpenAI(tool: Tool): OpenAIToolParam {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
// `terminated` 是 undici 用于标识 SSE/HTTP 响应体流在中途断开的签名
// （在 Node 原生 fetch 处理长推理流时常见）。它表现为原始的 `TypeError: terminated`，
// 因此必须在此处将其识别为传输层连接失败。
const NETWORK_RE = /network|connection|connect|disconnect|terminated/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

function classifyBaseApiError(message: string): ChatProviderError {
  if (TIMEOUT_RE.test(message)) {
    return new APITimeoutError(message);
  }
  if (NETWORK_RE.test(message)) {
    return new APIConnectionError(message);
  }
  return new ChatProviderError(`Error: ${message}`);
}

/**
 * 将 OpenAI SDK 错误（或原始 Error）转换为 kosong 的 `ChatProviderError`。
 */
export function convertOpenAIError(error: unknown): ChatProviderError {
  if (error instanceof ChatProviderError) {
    return error;
  }
  // v6: APIConnectionTimeoutError 继承自 APIConnectionError，先检查超时
  if (error instanceof OpenAITimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof OpenAIConnectionError) {
    return new APIConnectionError(error.message);
  }
  // 带有状态码的 APIError => 状态错误
  if (error instanceof OpenAIAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(error.status, error.message, reqId);
  }
  // 没有状态码且没有 body 的基础 APIError => 传输层失败。
  // 当错误有 body 时（例如来自服务器的 SSE 错误事件），
  // 跳过启发式判断以避免误分类服务端错误。
  if (
    error instanceof OpenAIAPIError &&
    error.constructor === OpenAIAPIError &&
    error.error === undefined
  ) {
    return classifyBaseApiError(error.message);
  }
  if (error instanceof OpenAIError) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  // 原始的非 SDK 错误（例如当流式响应体在中途断开时 undici 抛出的
  // `TypeError: terminated`）在流迭代期间不会被 OpenAI SDK 包装。
  // 将其通过相同的传输层启发式路由，使真正的连接失败变为可重试，
  // 而非致命的通用错误。
  if (error instanceof Error) {
    return classifyBaseApiError(error.message);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}
/** 函数类型工具调用的形状（守卫函数使用的子集）。 */
export interface FunctionToolCallShape {
  type: 'function';
  id: string;
  function: { name: string; arguments: string | null };
}

/**
 * 类型守卫：将工具调用联合类型收窄为函数类型变体。
 * 适用于 OpenAI SDK 的 `ChatCompletionMessageToolCall` 以及
 * 任何携带 `{ type: string }` 的对象。
 */
export function isFunctionToolCall<T extends { type: string }>(
  tc: T,
): tc is T & FunctionToolCallShape {
  return tc.type === 'function';
}
/**
 * 将 kosong 的 `ThinkingEffort` 映射为 OpenAI 的 `reasoning_effort` 字符串。
 */
export function thinkingEffortToReasoningEffort(effort: ThinkingEffort): string | undefined {
  switch (effort) {
    case 'off':
      return undefined;
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    default:
      throw new Error(`Unknown thinking effort: ${String(effort)}`);
  }
}

/**
 * 将 OpenAI 的 `reasoning_effort` 字符串反向映射为 kosong 的 `ThinkingEffort`。
 */
export function reasoningEffortToThinkingEffort(
  reasoning: string | undefined,
): ThinkingEffort | null {
  if (reasoning === undefined || reasoning === null) {
    return null;
  }
  switch (reasoning) {
    case 'low':
    case 'minimal':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'xhigh';
    case 'none':
      return 'off';
    default:
      return 'off';
  }
}
/**
 * 从 OpenAI 兼容的 usage 对象中提取 `TokenUsage`。
 */
export function extractUsage(usage: unknown): TokenUsage | null {
  if (usage === null || usage === undefined || typeof usage !== 'object') {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const promptTokens = typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0;
  const completionTokens = typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0;

  let cached = 0;
  // Moonshot 私有字段：顶层 cached_tokens
  if (typeof u['cached_tokens'] === 'number') {
    cached = u['cached_tokens'];
  } else if (
    typeof u['prompt_tokens_details'] === 'object' &&
    u['prompt_tokens_details'] !== null
  ) {
    const details = u['prompt_tokens_details'] as Record<string, unknown>;
    if (typeof details['cached_tokens'] === 'number') {
      cached = details['cached_tokens'];
    }
  }

  return {
    inputOther: promptTokens - cached,
    output: completionTokens,
    inputCacheRead: cached,
    inputCacheCreation: 0,
  };
}
/**
 * 将 OpenAI Chat Completions 风格的 `finish_reason` 字符串标准化为
 * 统一的 {@link FinishReason} 枚举。
 *
 * 由 Kimi 和 OpenAI Legacy 适配器共同使用，因为它们共享 Chat Completions 线路格式。
 * 当上游值缺失或为 `null` 时返回 `{ finishReason: null, rawFinishReason: null }`，
 * 以便调用方统一处理"无信号"情况。
 *
 * 映射关系：
 * - `'stop'` → `'completed'`
 * - `'tool_calls'` → `'tool_calls'`
 * - `'function_call'` → `'tool_calls'`（旧版别名）
 * - `'length'` → `'truncated'`
 * - `'content_filter'` → `'filtered'`
 * - 其他非 null 字符串 → `'other'`
 */
export function normalizeOpenAIFinishReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'stop':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'tool_calls':
    case 'function_call':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'length':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'content_filter':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}
/**
 * 工具角色消息内容的转换策略。
 *
 * - `'extract_text'`：将所有内容部件展平为单个文本字符串
 *   （某些提供商要求工具结果为纯文本）。
 * - `null`：将内容部件转换为标准 OpenAI 内容部件数组。
 */
export type ToolMessageConversion = 'extract_text' | null;

/**
 * 用于工具结果中无法放入工具消息本身、而作为后续用户消息重新附加的
 * 媒体内容的共享文案。
 */
export const TOOL_RESULT_MEDIA_PROMPT = 'Attached media from tool result:';
export const TOOL_RESULT_MEDIA_PLACEHOLDER = '(see attached media)';

/** 既非纯文本也非推理内容的内容部件。 */
export function isMediaPart(part: ContentPart): boolean {
  return part.type !== 'text' && part.type !== 'think';
}

/**
 * 根据选定的策略转换工具角色消息内容。
 */
export function convertToolMessageContent(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  if (conversion === 'extract_text') {
    return extractText(message);
  }
  return message.content
    .map((p) => convertContentPart(p))
    .filter((p): p is OpenAIContentPart => p !== null);
}

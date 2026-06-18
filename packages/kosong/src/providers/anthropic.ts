import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from '#/errors';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import Anthropic, {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicConnectionError,
  AnthropicError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
} from '@anthropic-ai/sdk';
import type {
  Tool as AnthropicTool,
  ContentBlockParam,
  MessageCreateParams,
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageStartEvent,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

import { mergeRequestHeaders, resolveAuthBackedClient } from './request-auth';
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
  type ToolCallIdPolicy,
} from './tool-call-id';

/**
 * 将 Anthropic 的 `stop_reason` 字符串标准化为统一的
 * {@link FinishReason} 枚举。
 *
 * 数据来源：`message.stop_reason`（非流式）或最后一个 `message_delta`
 * 事件的 `delta.stop_reason`（流式）。
 */
function normalizeAnthropicStopReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'max_tokens':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'tool_use':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'pause_turn':
      return { finishReason: 'paused', rawFinishReason: raw };
    case 'refusal':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}
export interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  /** 使用流式 API。默认为 true。设为 false 可使用非流式（测试/回退）。 */
  stream?: boolean | undefined;
  /**
   * 显式声明模型是否支持自适应思考
   * （`thinking: { type: 'adaptive' }`），覆盖基于模型名称的版本推断。
   * 适用于自定义端点，其模型名称不包含可解析的 Claude 版本信息。
   * 留空则从模型名称自动推断。
   */
  adaptiveThinking?: boolean | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
}

interface AnthropicGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?: MessageCreateParams['thinking'] | undefined;
  output_config?: MessageCreateParams['output_config'] | undefined;
  betaFeatures?: string[] | undefined;
}

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const OPUS_VERSION_RE = /opus[.-](\d+)[.-](\d{1,2})(?!\d)/;
const ADAPTIVE_MIN_VERSION = { major: 4, minor: 6 } as const;
const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

/**
 * 按版本划分的默认输出上限，数据来源于 Anthropic Messages API 模型文档
 * （platform.claude.com/docs/en/about-claude/models/overview）。
 * 值为文档记录的同步 Messages-API 最大值——我们发送完整的上限值，
 * 因为 Claude 4 + 交错思考会与加密推理共享此预算，低于文档上限的
 * 值可能会导致 `tool_use` 执行过程中被静默截断。
 *
 * 键格式为 `<family>-<major>[-<minor>]`。查找时先尝试最精确的键，
 * 然后回退到仅含 family/major 的条目，因此未识别的次版本号
 * （如未来的 `opus-4-10`）将使用该系列的基线值，而非通用回退值。
 */
const CEILING_BY_FAMILY_VERSION: Readonly<Record<string, number>> = {
  // Claude Fable 5 文档记录的输出上限为 128k。
  'fable-5': 128000,
  // Claude Opus 按次版本号划分。4.6 和 4.7 将上限提升至 128k；
  // 4.5 为 64k；4.1 及带日期的 4.0 版本保持在 32k。
  'opus-4-7': 128000,
  'opus-4-6': 128000,
  'opus-4-5': 64000,
  'opus-4-1': 32000,
  'opus-4-0': 32000,
  'opus-4': 32000,
  // Claude Sonnet 4.x：4.0 / 4.5 / 4.6 文档记录的上限均为 64k。
  'sonnet-4-6': 64000,
  'sonnet-4-5': 64000,
  'sonnet-4-0': 64000,
  'sonnet-4': 64000,
  // Claude Haiku 4.5 为 64k；仅含系列的条目使未来的带日期 4.x
  // Haiku 版本保持相同的上限。
  'haiku-4-5': 64000,
  'haiku-4': 64000,
  // Claude 3.5 / 3.7 文档记录的上限为 8192（标准端点）。
  'opus-3-5': 8192,
  'sonnet-3-5': 8192,
  'sonnet-3-7': 8192,
  'haiku-3-5': 8192,
  // 初代 Claude 3 系列。
  'opus-3': 4096,
  'sonnet-3': 4096,
  'haiku-3': 4096,
};

const FALLBACK_MAX_TOKENS = 32000;

type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';

interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number | null;
}

// 系列优先格式："opus-4-7"、"sonnet-4.6"、"haiku-4-5-20251001"、
// "fable-5"（单一版本组件——Fable 标识符不含次版本号）。
// 版本号限制为 1–2 位数字，后跟非数字前瞻断言，以确保
// 8 位日期后缀（如 `-20251001`）不会被误解析为版本组件。
const FAMILY_FIRST_RE =
  /(opus|sonnet|haiku|fable)[-._](\d{1,2})(?!\d)(?:[-._](\d{1,2})(?!\d))?/;
// 旧版版本优先格式："3-5-sonnet"、"3.7.opus"——用于较旧的
// Anthropic 模型标识符及 Claude 3.x 的 Bedrock 变体。
const VERSION_FIRST_RE = /(\d{1,2})[-._](\d{1,2})[-._](opus|sonnet|haiku)/;
// 基础 Claude 3 的裸系列格式（无次版本号）："3-opus"、"3.haiku"。
const BARE_FAMILY_RE = /(\d{1,2})[-._](opus|sonnet|haiku)/;

/**
 * 从模型标识符中提取 Claude 系列和版本号。
 *
 * 设计为能够兼容各供应商的命名变体：
 * 供应商前缀（`anthropic.`、`aws/`、`openrouter/`、
 * `online-`）、后缀（日期戳如 `-20251001`、构建标签如
 * `-construct`、`-v1:0`），以及系列和版本组件之间的
 * `.` 与 `-` 分隔符差异。
 *
 * 当标识符不包含 Claude 标记或无法识别的系列/版本时返回 `null`，
 * 此时解析器应使用覆盖值或 {@link FALLBACK_MAX_TOKENS} 作为回退。
 */
function parseClaudeVersion(model: string): ClaudeVersion | null {
  return parseClaudeFamilyVersion(model, true);
}

function parseClaudeAliasVersion(model: string): ClaudeVersion | null {
  return parseClaudeFamilyVersion(model, false);
}

function parseClaudeFamilyVersion(model: string, requireClaudeMarker: boolean): ClaudeVersion | null {
  const normalized = model.toLowerCase();
  // 防止在非 Claude 模型上出现误匹配，这些模型可能恰好包含
  // 类似 `opus-4-7` 的子字符串（如以检查点命名的微调模型）。
  // Anthropic 提供者可能仍被配置为连接非 Claude 端点，
  // 若无此防护，我们会悄悄将 Claude 上限应用于无关模型。
  if (requireClaudeMarker && !normalized.includes('claude')) return null;

  const familyFirst = FAMILY_FIRST_RE.exec(normalized);
  if (familyFirst !== null) {
    return {
      family: familyFirst[1] as ClaudeFamily,
      major: Number.parseInt(familyFirst[2]!, 10),
      minor: familyFirst[3] !== undefined ? Number.parseInt(familyFirst[3], 10) : null,
    };
  }
  const versionFirst = VERSION_FIRST_RE.exec(normalized);
  if (versionFirst !== null) {
    return {
      major: Number.parseInt(versionFirst[1]!, 10),
      minor: Number.parseInt(versionFirst[2]!, 10),
      family: versionFirst[3] as ClaudeFamily,
    };
  }
  const bare = BARE_FAMILY_RE.exec(normalized);
  if (bare !== null) {
    return {
      major: Number.parseInt(bare[1]!, 10),
      minor: null,
      family: bare[2] as ClaudeFamily,
    };
  }
  return null;
}

function lookupClaudeCeiling(version: ClaudeVersion): number | undefined {
  const { family, major, minor } = version;
  if (minor !== null) {
    const exact = CEILING_BY_FAMILY_VERSION[`${family}-${major}-${minor}`];
    if (exact !== undefined) return exact;
  }
  return CEILING_BY_FAMILY_VERSION[`${family}-${major}`];
}

/**
 * 解析 Anthropic 请求的默认 `max_tokens`。
 *
 * 优先级：
 *   1. 调用方提供的 `override`（如来自 harness 配置的
 *      `models.<alias>.maxOutputSize`）——当存在时予以接受，
 *      以便用户有意降低预算（便于在测试中强制截断）或
 *      对尚未识别的模型提高上限。
 *   2. 当模型标识符可解析为已知的 Claude 系列 + 版本时，
 *      override 会被限制在文档记录的 Messages-API 上限内，
 *      确保不会发送服务器会拒绝的值。
 *   3. 无 override 且无法识别版本时，回退到
 *      {@link FALLBACK_MAX_TOKENS}。
 */
export function resolveDefaultMaxTokens(model: string, override?: number): number {
  const parsed = parseClaudeVersion(model);
  const ceiling = parsed === null ? undefined : lookupClaudeCeiling(parsed);
  if (ceiling === undefined) {
    return override ?? FALLBACK_MAX_TOKENS;
  }
  return override === undefined ? ceiling : Math.min(override, ceiling);
}

function parseVersion(match: RegExpExecArray): { major: number; minor: number } {
  const majorRaw = match[1];
  const minorRaw = match[2];
  if (majorRaw === undefined || minorRaw === undefined) {
    throw new Error('Model version regex did not capture major and minor versions.');
  }
  return { major: Number.parseInt(majorRaw, 10), minor: Number.parseInt(minorRaw, 10) };
}

function versionAtLeast(
  version: { major: number; minor: number },
  minimum: { major: number; minor: number },
): boolean {
  return (
    version.major > minimum.major ||
    (version.major === minimum.major && version.minor >= minimum.minor)
  );
}

function supportsAdaptiveThinking(model: string): boolean {
  const version = parseClaudeAliasVersion(model);
  if (version === null) {
    return false;
  }
  // 缺少次版本号表示是裸系列-主版本标识符："claude-fable-5"（5.0 ≥ 4.6，
  // 仅自适应模式）或 "claude-opus-4"（4.0 < 4.6，基于预算模式）。
  return versionAtLeast(
    { major: version.major, minor: version.minor ?? 0 },
    ADAPTIVE_MIN_VERSION,
  );
}

function isOpus47(model: string): boolean {
  const match = OPUS_VERSION_RE.exec(model.toLowerCase());
  if (match === null) {
    return false;
  }
  const version = parseVersion(match);
  return version.major === 4 && version.minor === 7;
}

function isFableModel(model: string): boolean {
  return parseClaudeAliasVersion(model)?.family === 'fable';
}

function supportsEffortParam(model: string, adaptive: boolean): boolean {
  if (adaptive) {
    return true;
  }
  const normalized = model.toLowerCase();
  return normalized.includes('opus-4-5') || normalized.includes('opus-4.5');
}

function clampEffort(effort: ThinkingEffort, model: string, adaptive: boolean): ThinkingEffort {
  if (effort === 'off') {
    return effort;
  }
  if (effort === 'xhigh' && !isOpus47(model) && !isFableModel(model)) {
    return 'high';
  }
  if (effort === 'max' && !adaptive) {
    return 'high';
  }
  return effort;
}

function budgetTokensForEffort(effort: ThinkingEffort): number {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 32_000;
    case 'off':
    case 'xhigh':
    case 'max':
      throw new Error(`Unsupported budget-based thinking effort: ${effort}`);
  }
  throw new Error(`Unknown thinking effort: ${String(effort)}`);
}
const CACHE_CONTROL = { type: 'ephemeral' as const };

type CacheableBlock = ContentBlockParam & { cache_control?: { type: 'ephemeral' } };

function shouldPreserveUnsignedThinking(model: string): boolean {
  return parseClaudeAliasVersion(model) === null;
}

/**
 * 支持 cache_control 注入的内容块类型。
 */
const CACHEABLE_TYPES = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = lastMessage.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const lastBlock = content.at(-1) as CacheableBlock | undefined;
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

/**
 * 检查 MessageParam 是否为内容完全由 `tool_result` 块组成的用户消息。
 *
 * 用于检测需要在发送到 Anthropic 接口之前合并的相邻纯工具结果消息。
 * 根据 Messages API 并行工具调用规范，所有响应并行 `tool_use` 调用的
 * `tool_result` 块必须位于同一条用户消息中——将它们拆分到连续的用户消息中
 * 会在严格的 Anthropic 兼容后端上失败（HTTP 400），并在 api.anthropic.com
 * 上静默降级并行工具使用。
 */
function isToolResultOnly(message: MessageParam): boolean {
  if (message.role !== 'user') return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block.type === 'tool_result');
}
interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; data: string; media_type: string } | { type: 'url'; url: string };
  cache_control?: { type: 'ephemeral' };
}

// Messages API 没有音频或视频输入的表示形式。与其静默丢弃这些部分
// （模型甚至不知道附件的存在），不如发出一个占位文本块，
// 以便模型能够感知到缺失。连续的同类部分会折叠为单个占位符。
const OMITTED_MEDIA_PLACEHOLDER = {
  audio_url: '(audio omitted: not supported by this provider)',
  video_url: '(video omitted: not supported by this provider)',
} as const;

const SUPPORTED_B64_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function imageUrlPartToAnthropic(url: string): AnthropicImageBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ChatProviderError(`Invalid data URL for image: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_MEDIA_TYPES.has(mediaType)) {
      throw new ChatProviderError(
        `Unsupported media type for base64 image: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', data, media_type: mediaType },
    };
  }
  return {
    type: 'image',
    source: { type: 'url', url },
  };
}
interface AnthropicToolParam extends AnthropicTool {
  cache_control?: { type: 'ephemeral' } | null;
}

function convertTool(tool: Tool): AnthropicToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool['input_schema'],
  };
}
function toolResultToBlock(toolCallId: string, content: ContentPart[]): ToolResultBlockParam {
  const blocks: Array<TextBlockParam | AnthropicImageBlock> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url));
    } else if (part.type === 'audio_url' || part.type === 'video_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder });
      }
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: blocks,
  } as ToolResultBlockParam;
}
function convertMessage(message: Message, model: string): MessageParam {
  const role = message.role;

  // system 角色 -> 用 <system>...</system> 包裹的用户消息
  if (role === 'system') {
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return {
      role: 'user',
      content: [{ type: 'text', text: `<system>${text}</system>` }],
    };
  }

  // tool 角色 -> 用户消息中的 ToolResultBlockParam
  if (role === 'tool') {
    if (message.toolCallId === undefined) {
      throw new ChatProviderError('Tool message missing `toolCallId`.');
    }
    const block = toolResultToBlock(message.toolCallId, message.content);
    return { role: 'user', content: [block as ContentBlockParam] };
  }

  // user 或 assistant
  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text } satisfies TextBlockParam);
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'think') {
      // ThinkPart -> ThinkingBlockParam。
      //
      // 有签名：带签名发出该块。api.anthropic.com 要求有效签名并始终提供，
      // 因此来源于 Anthropic 的历史记录始终走此分支。
      //
      // 无签名：仍然保留思考内容，*不带* `signature` 字段发出。
      // Anthropic 兼容后端（如 Kimi）在流式传输思考内容时不提供 signature_delta，
      // 但会拒绝思考内容缺失的工具调用轮次
      // （"thinking is enabled but reasoning_content is missing"）。
      // 此处丢弃思考内容是导致这些后端多步工具使用失败的原因。
      // Claude 模型会拒绝无签名的思考块，因此仅对非 Claude 的
      // Anthropic 兼容模型保留无签名思考内容。无文本的无签名部分
      // 不携带任何信息，因此会被跳过。
      if (part.encrypted !== undefined) {
        blocks.push({
          type: 'thinking',
          thinking: part.think,
          signature: part.encrypted,
        } satisfies ThinkingBlockParam);
      } else if (part.think !== '' && shouldPreserveUnsignedThinking(model)) {
        blocks.push({ type: 'thinking', thinking: part.think } as unknown as ThinkingBlockParam);
      }
    } else if (part.type === 'audio_url' || part.type === 'video_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder } satisfies TextBlockParam);
      }
    }
  }

  // 工具调用 -> ToolUseBlockParam
  if (message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      let toolInput: Record<string, unknown> = {};
      if (tc.arguments) {
        try {
          const parsed: unknown = JSON.parse(tc.arguments);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            toolInput = parsed as Record<string, unknown>;
          } else {
            throw new ChatProviderError('Tool call arguments must be a JSON object.');
          }
        } catch (error) {
          if (error instanceof ChatProviderError) throw error;
          throw new ChatProviderError('Tool call arguments must be valid JSON.');
        }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: toolInput,
      } satisfies ToolUseBlockParam);
    }
  }

  return { role: role, content: blocks };
}
export function convertAnthropicError(error: unknown): ChatProviderError {
  // 在检查连接错误之前先检查超时（APIConnectionTimeoutError 继承自 APIConnectionError）
  if (error instanceof AnthropicTimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof AnthropicConnectionError) {
    return new APIConnectionError(error.message);
  }
  // 带状态码的 APIError => 状态错误
  if (error instanceof AnthropicAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(error.status, error.message, reqId);
  }
  if (error instanceof AnthropicError) {
    return new ChatProviderError(`Anthropic error: ${error.message}`);
  }
  if (error instanceof Error) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}
class AnthropicStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage = {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(response: unknown, isStream: boolean) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response as AsyncIterable<MessageStreamEvent>);
    } else {
      this._iter = this._convertNonStreamResponse(
        response as {
          id: string;
          stop_reason?: string | null;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          content: Array<{
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
        },
      );
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureStopReason(raw: string | null | undefined): void {
    const normalized = normalizeAnthropicStopReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    this._usage = {
      inputOther: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      inputCacheRead: usage.cache_read_input_tokens ?? 0,
      inputCacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
  }

  private async *_convertNonStreamResponse(response: {
    id: string;
    stop_reason?: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      data?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  }): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    this._extractUsage(response.usage);
    this._captureStopReason(response.stop_reason);

    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          if (block.text !== undefined) {
            yield { type: 'text', text: block.text };
          }
          break;
        case 'thinking':
          yield block.signature !== undefined
            ? { type: 'think' as const, think: block.thinking ?? '', encrypted: block.signature }
            : { type: 'think' as const, think: block.thinking ?? '' };
          break;
        case 'redacted_thinking':
          yield block.data !== undefined
            ? { type: 'think' as const, think: '', encrypted: block.data }
            : { type: 'think' as const, think: '' };
          break;
        case 'tool_use':
          yield {
            type: 'function',
            id: block.id ?? crypto.randomUUID(),
            name: block.name ?? '',
            arguments: block.input !== undefined ? JSON.stringify(block.input) : null,
          } satisfies ToolCall;
          break;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<MessageStreamEvent>,
  ): AsyncGenerator<StreamedMessagePart> {
    const toolUseBlockIndexes = new Set<number>();

    try {
      for await (const event of response) {
        const evt = event as unknown as Record<string, unknown>;
        const eventType = evt['type'] as string;

        if (eventType === 'message_start') {
          const startEvt = evt as unknown as RawMessageStartEvent;
          this._id = startEvt.message.id;
          this._extractUsage(
            startEvt.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            },
          );
        } else if (eventType === 'content_block_start') {
          const blockEvt = evt as unknown as RawContentBlockStartEvent;
          const block = blockEvt.content_block;
          const blockIndex = blockEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (block.type) {
            case 'text':
              yield { type: 'text', text: block.text };
              break;
            case 'thinking':
              yield { type: 'think', think: block.thinking };
              break;
            case 'redacted_thinking':
              yield {
                type: 'think',
                think: '',
                encrypted: (block as unknown as { data: string }).data,
              };
              break;
            case 'tool_use':
              toolUseBlockIndexes.add(blockIndex);
              yield {
                type: 'function',
                id: block.id,
                name: block.name,
                arguments: '',
                // 携带 Anthropic 块索引，以便并行 tool_use 块的
                // 交错 input_json_delta 数据块能被生成循环
                // 正确路由到对应的 ToolCall。
                _streamIndex: blockIndex,
              } satisfies ToolCall;
              break;
          }
        } else if (eventType === 'content_block_delta') {
          const deltaEvt = evt as unknown as RawContentBlockDeltaEvent;
          const delta = deltaEvt.delta;
          const blockIndex = deltaEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (delta.type) {
            case 'text_delta':
              yield { type: 'text', text: delta.text };
              break;
            case 'thinking_delta':
              yield { type: 'think', think: delta.thinking };
              break;
            case 'input_json_delta':
              yield {
                type: 'tool_call_part',
                argumentsPart: delta.partial_json,
                // 携带 Anthropic 块索引，以便此 delta 被路由到
                // 匹配的 ToolCall（支持并行 tool_use）。
                index: blockIndex,
              };
              break;
            case 'signature_delta':
              yield {
                type: 'think',
                think: '',
                encrypted: delta.signature,
              };
              break;
          }
        } else if (eventType === 'content_block_stop') {
          // 无操作：生成循环从下一个非合并部分（通常是下一个
          // content_block_start）或流结束推断工具调用完成。
          // 因此 Anthropic 的块边界在适配器内部处理，
          // 而非向上传递。
        } else if (eventType === 'message_delta') {
          // 从 delta 更新用量
          const deltaUsage = (evt as { usage?: Record<string, unknown> }).usage;
          if (deltaUsage !== undefined) {
            if (typeof deltaUsage['output_tokens'] === 'number') {
              this._usage.output = deltaUsage['output_tokens'];
            }
            if (typeof deltaUsage['cache_read_input_tokens'] === 'number') {
              this._usage.inputCacheRead = deltaUsage['cache_read_input_tokens'];
            }
            if (typeof deltaUsage['cache_creation_input_tokens'] === 'number') {
              this._usage.inputCacheCreation = deltaUsage['cache_creation_input_tokens'];
            }
            if (typeof deltaUsage['input_tokens'] === 'number') {
              this._usage.inputOther = deltaUsage['input_tokens'];
            }
          }
          // 终止 `stop_reason` 存在于此响应最后一个 `message_delta` 事件的
          // `delta.stop_reason` 中。在此处捕获。
          //
          // 显式接受 `null`：如果键存在，我们将值（包括 null）转发给
          // `_captureStopReason`，它会将其映射为 `{null, null}`。
          // 仅当键缺失时才跳过捕获。这避免了在显式 null 重置后
          // 过期的先前捕获值仍然保留的问题。
          const messageDeltaPayload = (evt as { delta?: Record<string, unknown> }).delta;
          if (messageDeltaPayload !== undefined && 'stop_reason' in messageDeltaPayload) {
            this._captureStopReason(
              messageDeltaPayload['stop_reason'] as string | null | undefined,
            );
          }
        }
        // message_stop：无需操作
      }
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }
}
export class AnthropicChatProvider implements ChatProvider {
  readonly name: string = 'anthropic';

  private _model: string;
  private _stream: boolean;
  private _client: Anthropic | undefined;
  private _generationKwargs: AnthropicGenerationKwargs;
  private _metadata: Record<string, string> | undefined;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string | null> | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => Anthropic) | undefined;
  private _adaptiveThinking: boolean | undefined;
  private _explicitMaxTokens: boolean;

  constructor(options: AnthropicOptions) {
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._metadata = options.metadata;
    this._adaptiveThinking = options.adaptiveThinking;
    this._apiKey =
      options.apiKey === undefined || options.apiKey.length === 0 ? undefined : options.apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
    this._explicitMaxTokens = options.defaultMaxTokens !== undefined;
    this._generationKwargs = {
      max_tokens: resolveDefaultMaxTokens(options.model, options.defaultMaxTokens),
      betaFeatures: options.betaFeatures ?? [INTERLEAVED_THINKING_BETA],
    };
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinkingConfig = this._generationKwargs.thinking;
    if (thinkingConfig === undefined || thinkingConfig === null) {
      return null;
    }
    if (thinkingConfig.type === 'disabled') {
      return 'off';
    }
    if (thinkingConfig.type === 'adaptive') {
      const effort = this._generationKwargs.output_config?.effort;
      if (effort === undefined || effort === null) {
        return 'high';
      }
      switch (effort) {
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
        case 'max':
          return effort;
      }
    }
    // 基于预算模式
    const budget = (thinkingConfig as { budget_tokens?: number }).budget_tokens ?? 0;
    if (budget <= 1024) {
      return 'low';
    }
    if (budget <= 4096) {
      return 'medium';
    }
    return 'high';
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...this._generationKwargs,
    };
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    // 构建 system 参数
    const system: TextBlockParam[] | undefined = systemPrompt
      ? [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: CACHE_CONTROL,
          } as TextBlockParam,
        ]
      : undefined;

    // 转换消息，将连续的纯工具结果用户消息合并为单条用户消息
    // （Anthropic 并行工具调用规范）。
    const messages: MessageParam[] = [];
    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      ANTHROPIC_TOOL_CALL_ID_POLICY,
    );
    for (const msg of normalizedHistory) {
      const converted = convertMessage(msg, this._model);
      const last = messages.at(-1);
      if (last !== undefined && isToolResultOnly(last) && isToolResultOnly(converted)) {
        last.content = [
          ...(last.content as ContentBlockParam[]),
          ...(converted.content as ContentBlockParam[]),
        ];
      } else {
        messages.push(converted);
      }
    }

    // 在最后一条消息的最后一个内容块上注入 cache_control（在合并之后执行，
    // 使其落在合并后用户消息的最后一个 tool_result 块上）。
    injectCacheControlOnLastBlock(messages);

    // 构建生成参数（不包括 betaFeatures）
    const kwargs: Record<string, unknown> = {};
    if (this._generationKwargs.max_tokens !== undefined) {
      kwargs['max_tokens'] = this._generationKwargs.max_tokens;
    }
    if (this._generationKwargs.temperature !== undefined) {
      kwargs['temperature'] = this._generationKwargs.temperature;
    }
    if (this._generationKwargs.top_k !== undefined) {
      kwargs['top_k'] = this._generationKwargs.top_k;
    }
    if (this._generationKwargs.top_p !== undefined) {
      kwargs['top_p'] = this._generationKwargs.top_p;
    }
    // Fable 会拒绝显式的 `disabled` 思考配置（返回 HTTP 400，
    // 与接受该配置的 Opus 4.7/4.8 不同），因此改为省略该字段。
    // 注意：Fable 上实际上无法关闭思考功能——自适思始终开启，
    // 省略 `thinking` 字段仍然会使用自适应思考。
    const thinking = this._generationKwargs.thinking;
    if (thinking !== undefined && !(thinking.type === 'disabled' && isFableModel(this._model))) {
      kwargs['thinking'] = thinking;
    }
    if (this._generationKwargs.output_config !== undefined) {
      kwargs['output_config'] = this._generationKwargs.output_config;
    }

    // 构建 beta 请求头
    const betas = this._generationKwargs.betaFeatures ?? [];
    const extraHeaders: Record<string, string> = {};
    if (betas.length > 0) {
      extraHeaders['anthropic-beta'] = betas.join(',');
    }

    // 转换工具
    const anthropicTools: AnthropicToolParam[] = tools.map((t) => convertTool(t));
    if (anthropicTools.length > 0) {
      const lastTool = anthropicTools.at(-1);
      if (lastTool !== undefined) {
        lastTool.cache_control = CACHE_CONTROL;
      }
    }

    // 构建创建参数
    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      ...kwargs,
    };

    if (system !== undefined) {
      createParams['system'] = system;
    }

    if (anthropicTools.length > 0) {
      createParams['tools'] = anthropicTools;
    }

    if (this._metadata !== undefined) {
      createParams['metadata'] = this._metadata;
    }

    const requestOptions: Record<string, unknown> = {};
    const headers = mergeRequestHeaders(extraHeaders, options?.auth?.headers);
    if (headers !== undefined) {
      requestOptions['headers'] = headers;
    }
    if (options?.signal) {
      requestOptions['signal'] = options.signal;
    }
    const finalRequestOptions = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
    const client = this._createClient(options?.auth);

    if (this._stream) {
      // 使用原始 Messages 流而非 SDK 的 MessageStream 辅助器。
      // 该辅助器在每个数据块上重新解析累积的 input_json_delta 缓冲区，
      // 对于大型流式工具参数这会变成同步的 O(n^2) 操作。
      try {
        const stream = await client.messages.create(
          { ...createParams, stream: true } as unknown as MessageCreateParamsStreaming,
          finalRequestOptions,
        );
        return new AnthropicStreamedMessage(stream, true);
      } catch (error: unknown) {
        throw convertAnthropicError(error);
      }
    }

    // 非流式回退
    try {
      const response = await client.messages.create(
        { ...createParams, stream: false } as unknown as MessageCreateParams,
        finalRequestOptions,
      );
      return new AnthropicStreamedMessage(response, false);
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): Anthropic {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => this._buildClient(this._requireApiKey(a)),
    );
  }

  private _requireApiKey(auth: ProviderRequestAuth | undefined): string {
    const apiKey = auth?.apiKey ?? this._apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ChatProviderError(
        'AnthropicChatProvider: apiKey is required. Provide it via constructor options, options.auth.apiKey on each request, or an OAuth login. The Anthropic adapter does not read shell API-key environment variables.',
      );
    }
    return apiKey;
  }

  private _anthropicCustomHeaderEnvNames(): string[] {
    const customHeaders = process.env['ANTHROPIC_CUSTOM_HEADERS'];
    if (customHeaders === undefined || customHeaders.length === 0) return [];

    const names: string[] = [];
    for (const line of customHeaders.split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex < 0) continue;

      const name = line.slice(0, colonIndex).trim().toLowerCase();
      if (name.length > 0) names.push(name);
    }
    return names;
  }

  private _buildDefaultHeaders(apiKey: string): Record<string, string | null> {
    const defaultHeaders: Record<string, string | null> = { authorization: null };
    for (const name of this._anthropicCustomHeaderEnvNames()) {
      defaultHeaders[name] = null;
    }
    for (const [name, value] of Object.entries(this._defaultHeaders ?? {})) {
      defaultHeaders[name.toLowerCase()] = value;
    }
    defaultHeaders['x-api-key'] = apiKey;
    return defaultHeaders;
  }

  // 我们将 Anthropic SDK 纯粹用作连接任意 Anthropic 兼容端点的传输层
  // （`baseUrl` 可指向任何位置）。如果使用默认配置，SDK 会从 shell 环境
  // 自动发现凭据（ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL、
  // ANTHROPIC_CUSTOM_HEADERS），即使设置了显式 apiKey，也会将
  // 带外的 bearer/headers 泄漏给第三方端点。因此我们硬禁用所有自动发现通道。
  // 这些 `null`——以及 _buildDefaultHeaders 中的 null 化 headers——并非
  // 冗余：移除它们会重新引入凭据泄漏。回归测试覆盖：
  // test/e2e/anthropic-adapter.test.ts。
  private _buildClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: this._baseUrl ?? null,
      defaultHeaders: this._buildDefaultHeaders(apiKey),
    });
  }

  withThinking(effort: ThinkingEffort): AnthropicChatProvider {
    // 一次性解析：显式的 `adaptiveThinking` 选项覆盖基于模型名称的
    // 版本推断，使自定义端点可以选择启用/禁用。
    const adaptive = this._adaptiveThinking ?? supportsAdaptiveThinking(this._model);

    if (effort === 'off') {
      let newBetas = [...(this._generationKwargs.betaFeatures ?? [])];
      if (adaptive) {
        newBetas = newBetas.filter((b) => b !== INTERLEAVED_THINKING_BETA);
      }
      const clone = this._withGenerationKwargs({
        thinking: { type: 'disabled' },
        betaFeatures: newBetas,
      });
      delete clone._generationKwargs.output_config;
      return clone;
    }

    const effectiveEffort = clampEffort(effort, this._model, adaptive);
    if (effectiveEffort === 'off') {
      throw new Error('Non-off thinking effort unexpectedly clamped to off.');
    }

    let newBetas = [...(this._generationKwargs.betaFeatures ?? [])];

    if (adaptive) {
      newBetas = newBetas.filter((b) => b !== INTERLEAVED_THINKING_BETA);
      return this._withGenerationKwargs({
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: effectiveEffort },
        betaFeatures: newBetas,
      });
    }

    const kwargs: Partial<AnthropicGenerationKwargs> = {
      thinking: { type: 'enabled', budget_tokens: budgetTokensForEffort(effectiveEffort) },
      betaFeatures: newBetas,
    };
    if (supportsEffortParam(this._model, adaptive)) {
      kwargs.output_config = { effort: effectiveEffort };
    } else {
      kwargs.output_config = undefined;
    }
    const clone = this._withGenerationKwargs(kwargs);
    if (!supportsEffortParam(this._model, adaptive)) {
      delete clone._generationKwargs.output_config;
    }
    return clone;
  }

  withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    return this._withGenerationKwargs(kwargs);
  }

  withMaxCompletionTokens(maxCompletionTokens: number): AnthropicChatProvider {
    const requestedCap = resolveDefaultMaxTokens(this._model, maxCompletionTokens);
    const existingCap = this._generationKwargs.max_tokens;
    const clone = this._withGenerationKwargs({
      max_tokens:
        existingCap === undefined || this._explicitMaxTokens
          ? existingCap ?? requestedCap
          : Math.min(existingCap, requestedCap),
    });
    clone._explicitMaxTokens = this._explicitMaxTokens;
    return clone;
  }

  private _withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    if ('max_tokens' in kwargs) {
      clone._explicitMaxTokens = kwargs.max_tokens !== undefined;
    }
    return clone;
  }

  private _clone(): AnthropicChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as AnthropicChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}

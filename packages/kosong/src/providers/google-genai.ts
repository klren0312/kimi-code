import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from '#/errors';
import type { Message, StreamedMessagePart, ToolCall } from '#/message';
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
import { ApiError as GoogleApiError, GoogleGenAI as GenAIClient } from '@google/genai';

import { requireProviderApiKey, resolveAuthBackedClient } from './request-auth';

/**
 * 将 Google GenAI (Gemini) 的 `finishReason` 值归一化为统一的
 * {@link FinishReason} 枚举。
 *
 * 数据来源：`candidates[0].finishReason`（流式和非流式均适用——
 * SDK 会自动归一化）。Gemini 不会发出 `tool_calls` 风格的原因值；
 * 工具调用通过 `parts[].functionCall` 返回，即使模型产生了函数调用，
 * `finishReason` 仍为 `'completed'`。
 */
function normalizeGoogleGenAIFinishReason(raw: unknown): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  // SDK 通常返回一个纯字符串，但较早版本会将其包装在类似枚举的对象中。
  // 同时接受两种形式，并转为大写以匹配文档中的常量。其他任何值
  // 都会退化为"无信号"，避免发出无意义的 `[object Object]` 原始值。
  let rawString: string;
  if (typeof raw === 'string') {
    rawString = raw.toUpperCase();
  } else if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
    rawString = String(raw).toUpperCase();
  } else {
    return { finishReason: null, rawFinishReason: null };
  }
  if (rawString === 'FINISH_REASON_UNSPECIFIED' || rawString === '') {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (rawString) {
    case 'STOP':
      return { finishReason: 'completed', rawFinishReason: rawString };
    case 'MAX_TOKENS':
      return { finishReason: 'truncated', rawFinishReason: rawString };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { finishReason: 'filtered', rawFinishReason: rawString };
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
    case 'LANGUAGE':
      return { finishReason: 'other', rawFinishReason: rawString };
    default:
      return { finishReason: 'other', rawFinishReason: rawString };
  }
}
export interface GoogleGenAIOptions {
  apiKey?: string | undefined;
  model: string;
  vertexai?: boolean | undefined;
  project?: string | undefined;
  location?: string | undefined;
  stream?: boolean | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => GenAIClient;
}

export interface GoogleGenAIGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking_config?: ThinkingConfig | undefined;
  [key: string]: unknown;
}

interface ThinkingConfig {
  include_thoughts?: boolean;
  thinking_budget?: number;
  thinking_level?: string;
}
interface GoogleFunctionDeclaration {
  name: string;
  description: string;
  parameters_json_schema: Record<string, unknown>;
}

interface GoogleTool {
  function_declarations: GoogleFunctionDeclaration[];
}

function toolToGoogleGenAI(tool: Tool): GoogleTool {
  return {
    function_declarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters_json_schema: tool.parameters,
      },
    ],
  };
}
interface GoogleContent {
  role: string;
  parts: GooglePart[];
}

interface GooglePart {
  text?: string;
  function_call?: { name: string; args: Record<string, unknown> };
  function_response?: {
    name: string;
    response: Record<string, string>;
    parts: unknown[];
  };
  thought_signature?: string;
  [key: string]: unknown;
}

function toolCallIdToName(toolCallId: string, toolNameById: Map<string, string>): string {
  const name = toolNameById.get(toolCallId);
  if (name !== undefined) return name;
  // 后备方案：此 provider 生成的 id 格式为
  // "{tool_name}_{id_suffix}"，其中 `tool_name` 本身可能包含
  // 下划线（例如 `fetch_image`），`id_suffix` 是末尾的单个
  // 不含下划线的标记（如随机十六进制 / UUID 片段）。我们通过
  // 显式匹配来去除最后的 "_<suffix>" 段——如果按第一个下划线
  // 分割会将多词工具名如 `fetch_image_<id>` 截断为 `fetch`。
  const match = /^(.+)_[^_]+$/.exec(toolCallId);
  return match?.[1] ?? toolCallId;
}

/**
 * 将 data URL 或 HTTP URL 转换为 Google GenAI 内联/文件数据部分。
 * - data: URL 被解析为 { inlineData: { mimeType, data } }
 * - http(s): URL 使用 { fileData: { fileUri, mimeType } }
 */
function convertMediaUrl(
  url: string,
  fallbackMimeType: string,
):
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } } {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
    }
    const meta = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const colonIndex = meta.indexOf(':');
    const semiIndex = meta.indexOf(';');
    const mimeType =
      colonIndex !== -1 && semiIndex !== -1
        ? meta.slice(colonIndex + 1, semiIndex)
        : fallbackMimeType;
    return { inlineData: { mimeType, data } };
  }
  // 对于 HTTP(S) URL，尝试从扩展名猜测 MIME 类型
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) mimeType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) mimeType = 'image/gif';
    else if (pathname.endsWith('.webp')) mimeType = 'image/webp';
    else if (pathname.endsWith('.mp3') || pathname.endsWith('.mpeg')) mimeType = 'audio/mpeg';
    else if (pathname.endsWith('.wav')) mimeType = 'audio/wav';
    else if (pathname.endsWith('.ogg')) mimeType = 'audio/ogg';
  } catch {
    // URL 解析失败，使用后备值
  }
  return { fileData: { fileUri: url, mimeType } };
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return new Promise(() => {
      // 未提供信号时，故意永不结算。
    });
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

function messageToGoogleGenAI(message: Message): GoogleContent {
  if (message.role === 'tool') {
    throw new ChatProviderError(
      'Tool messages must be converted via messagesToGoogleGenAIContents.',
    );
  }

  // GoogleGenAI 使用 "model" 代替 "assistant"
  const role = message.role === 'assistant' ? 'model' : message.role;
  const parts: GooglePart[] = [];

  // 处理内容部分
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push({ text: part.text });
        break;
      case 'think':
        // 跳过思考部分（合成内容）
        break;
      case 'image_url':
        parts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        parts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        parts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
    }
  }

  // 处理工具调用
  for (const toolCall of message.toolCalls) {
    let args: Record<string, unknown> = {};
    if (toolCall.arguments) {
      try {
        const parsed: unknown = JSON.parse(toolCall.arguments);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          throw new ChatProviderError('Tool call arguments must be a JSON object.');
        }
      } catch (error) {
        if (error instanceof ChatProviderError) throw error;
        throw new ChatProviderError('Tool call arguments must be valid JSON.');
      }
    }

    const functionCallPart: GooglePart = {
      function_call: {
        name: toolCall.name,
        args,
      },
    };

    // 如果可用则恢复 thought_signature
    if (toolCall.extras && 'thought_signature_b64' in toolCall.extras) {
      functionCallPart['thought_signature'] = toolCall.extras['thought_signature_b64'] as string;
    }

    parts.push(functionCallPart);
  }

  return { role, parts };
}

/**
 * 将工具消息转换为 Google GenAI parts 列表。
 *
 * 返回一个携带文本输出的 `functionResponse` part，后跟独立的媒体 parts
 * （`inlineData` / `fileData`）用于工具结果中的任何图片/音频/视频内容。
 * 这样可以保留多模态工具输出，使下一轮 Gemini/Vertex 能够看到它们——
 * 如果只返回文本，会静默丢弃媒体数据，破坏依赖图片或音频的工具链。
 */
function toolMessageToFunctionResponseParts(
  message: Message,
  toolNameById: Map<string, string>,
): GooglePart[] {
  if (message.role !== 'tool') {
    throw new ChatProviderError('Expected a tool message.');
  }
  if (message.toolCallId === undefined) {
    throw new ChatProviderError('Tool response is missing `toolCallId`.');
  }

  // 分离文本输出和媒体部分
  let textOutput = '';
  const mediaParts: GooglePart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        if (part.text) textOutput += part.text;
        break;
      case 'image_url':
        mediaParts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        mediaParts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        mediaParts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
      case 'think':
        // 跳过——通过推理通道单独处理。
        break;
    }
  }

  const functionResponsePart: GooglePart = {
    function_response: {
      name: toolCallIdToName(message.toolCallId, toolNameById),
      response: { output: textOutput },
      parts: [],
    },
  };

  return [functionResponsePart, ...mediaParts];
}

export function messagesToGoogleGenAIContents(messages: Message[]): GoogleContent[] {
  const contents: GoogleContent[] = [];
  const toolNameById = new Map<string, string>();

  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message === undefined) break;

    if (message.role === 'system') {
      // Google GenAI 的 `Content.role` 只接受 "user" 或 "model"，因此
      // 历史记录中的系统消息（例如来自会话恢复或跨 provider 迁移）
      // 会被 API 拒绝。通过将内容包装在 `<system>` 标签中并附加为
      // user 轮次来保留内容——与 Anthropic provider 的行为一致。
      // 专用的顶层 `systemPrompt` 仍单独流入 `system_instruction`；
      // 只有历史系统消息会经过这里。
      const text = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text.length > 0) {
        contents.push({
          role: 'user',
          parts: [{ text: `<system>${text}</system>` }],
        });
      }
      i += 1;
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      contents.push(messageToGoogleGenAI(message));
      const expectedToolCallIds: string[] = [];
      for (const toolCall of message.toolCalls) {
        toolNameById.set(toolCall.id, toolCall.name);
        expectedToolCallIds.push(toolCall.id);
      }

      // 收集连续的工具消息
      let j = i + 1;
      const toolMessages: Message[] = [];
      while (j < messages.length) {
        const toolMsg = messages[j];
        if (toolMsg === undefined || toolMsg.role !== 'tool') break;
        toolMessages.push(toolMsg);
        j += 1;
      }

      if (toolMessages.length > 0) {
        // 对工具结果进行排序以匹配 assistant 消息中工具调用的顺序，
        // 并拒绝不完整/重复/意外的结果。
        // Gemini/Vertex 期望下一个 user 轮次包含与前面函数调用
        // 匹配的函数响应集合。
        const toolMsgById = new Map<string, Message>();
        const seenToolCallIds = new Set<string>();
        for (const toolMsg of toolMessages) {
          if (toolMsg.toolCallId === undefined) {
            throw new ChatProviderError('Tool response is missing `toolCallId`.');
          }
          if (seenToolCallIds.has(toolMsg.toolCallId)) {
            throw new ChatProviderError(`Duplicate tool response for id: ${toolMsg.toolCallId}`);
          }
          seenToolCallIds.add(toolMsg.toolCallId);
          toolMsgById.set(toolMsg.toolCallId, toolMsg);
        }

        const sortedToolMessages: Message[] = [];
        for (const expectedId of expectedToolCallIds) {
          const msg = toolMsgById.get(expectedId);
          if (msg === undefined) {
            throw new ChatProviderError(`Missing tool responses for ids: ${expectedId}`);
          }
          sortedToolMessages.push(msg);
          toolMsgById.delete(expectedId);
        }
        if (toolMsgById.size > 0) {
          throw new ChatProviderError(
            `Unexpected tool responses for ids: ${JSON.stringify([...toolMsgById.keys()])}`,
          );
        }

        // 将所有工具结果打包到单个 user Content 中。
        // 每个工具结果可能展开为多个 parts（functionResponse +
        // 用于图片/音频/视频输出的媒体 parts）。
        const parts: GooglePart[] = [];
        for (const toolMsg of sortedToolMessages) {
          parts.push(...toolMessageToFunctionResponseParts(toolMsg, toolNameById));
        }
        contents.push({ role: 'user', parts });
        i = j;
        continue;
      }

      i += 1;
      continue;
    }

    if (message.role === 'tool') {
      // 没有前置 assistant 消息的工具消息
      const parts: GooglePart[] = toolMessageToFunctionResponseParts(message, toolNameById);
      contents.push({ role: 'user', parts });
      i += 1;
      continue;
    }

    contents.push(messageToGoogleGenAI(message));
    i += 1;
  }

  return contents;
}
export class GoogleGenAIStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: AsyncIterable<Record<string, unknown>> | Record<string, unknown>,
    isStream: boolean,
    signal?: AbortSignal,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<Record<string, unknown>>,
        signal,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as Record<string, unknown>, signal);
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

  private _captureFinishReason(response: Record<string, unknown>): void {
    const candidates = response['candidates'] as unknown[] | undefined;
    if (!candidates || candidates.length === 0) {
      return;
    }
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (first === undefined) {
      return;
    }
    const raw = first['finishReason'] ?? first['finish_reason'];
    if (raw === undefined) {
      return;
    }
    const normalized = normalizeGoogleGenAIFinishReason(raw);
    // 仅在获得确定性信号时才覆盖——流式传输的早期块可能包含
    // `FINISH_REASON_UNSPECIFIED`（模型仍在生成），我们将其视为
    // "尚未确定"。
    if (normalized.finishReason !== null || normalized.rawFinishReason !== null) {
      this._finishReason = normalized.finishReason;
      this._rawFinishReason = normalized.rawFinishReason;
    }
  }

  /** 从单个（非流式）GenerateContentResponse 中提取 parts。 */
  private _extractChunkParts(response: Record<string, unknown>): StreamedMessagePart[] {
    const parts: StreamedMessagePart[] = [];

    const candidates = response['candidates'] as unknown[] | undefined;
    for (const candidate of candidates ?? []) {
      const cand = candidate as Record<string, unknown>;
      const content = cand['content'] as Record<string, unknown> | undefined;
      const contentParts = content?.['parts'] as unknown[] | undefined;
      if (!contentParts) continue;

      for (const part of contentParts) {
        const p = part as Record<string, unknown>;
        if (p['thought'] === true && p['text']) {
          parts.push({ type: 'think', think: p['text'] as string });
        } else if (p['text']) {
          parts.push({ type: 'text', text: p['text'] as string });
        } else if (p['functionCall'] || p['function_call']) {
          const fc = (p['functionCall'] ?? p['function_call']) as Record<string, unknown>;
          const name = fc['name'] as string;
          if (!name) continue;
          const id_ = (fc['id'] as string) ?? crypto.randomUUID();
          const toolCallId = `${name}_${id_}`;
          const thoughtSigB64 = p['thoughtSignature'] ?? p['thought_signature'];
          parts.push({
            type: 'function',
            id: toolCallId,
            name,
            arguments: fc['args'] ? JSON.stringify(fc['args']) : '{}',
            ...(thoughtSigB64
              ? { extras: { thought_signature_b64: thoughtSigB64 as string } }
              : {}),
          } satisfies ToolCall);
        }
      }
    }

    return parts;
  }

  /** 从响应块中提取用量元数据。 */
  private _extractUsage(response: Record<string, unknown>): void {
    const usageMetadata = response['usageMetadata'] as Record<string, unknown> | undefined;
    if (usageMetadata) {
      const promptTokenCount =
        typeof usageMetadata['promptTokenCount'] === 'number'
          ? usageMetadata['promptTokenCount']
          : 0;
      const cachedContentTokenCount =
        typeof usageMetadata['cachedContentTokenCount'] === 'number'
          ? usageMetadata['cachedContentTokenCount']
          : 0;
      this._usage = {
        inputOther: Math.max(promptTokenCount - cachedContentTokenCount, 0),
        output: (usageMetadata['candidatesTokenCount'] as number) ?? 0,
        inputCacheRead: cachedContentTokenCount,
        inputCacheCreation: 0,
      };
    }
  }

  /** 从响应块中提取响应 ID。 */
  private _extractId(response: Record<string, unknown>): void {
    if (response['responseId'] !== undefined) {
      this._id = response['responseId'] as string;
    }
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    // 辅助函数保持精简，以便 TypeScript 的控制流收窄不会在
    // 反复检查信号的调用点将 `signal.aborted` 收窄为
    // `false | undefined`。
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private async *_convertNonStreamResponse(
    response: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    this._throwIfAborted(signal);
    this._extractUsage(response);
    this._extractId(response);
    this._captureFinishReason(response);
    for (const part of this._extractChunkParts(response)) {
      this._throwIfAborted(signal);
      yield part;
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const chunk of response) {
        // 在每个块边界检查中止信号，以便传入 AbortSignal 的用户
        // 能及时看到取消生效，尽管 Google GenAI SDK 不会将其
        // 转发到底层 fetch。
        this._throwIfAborted(signal);
        this._extractUsage(chunk);
        this._extractId(chunk);
        this._captureFinishReason(chunk);
        for (const part of this._extractChunkParts(chunk)) {
          this._throwIfAborted(signal);
          yield part;
        }
      }
    } catch (error: unknown) {
      // 保留 AbortError 身份，以便重试/生成循环能够将其
      // 与临时性 provider 错误区分开来。
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }
}
const NETWORK_RE = /network|connection|connect|disconnect|fetch failed/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

/**
 * 将 Google GenAI SDK 错误（或原始 Error）转换为 kosong 的 `ChatProviderError`。
 */
export function convertGoogleGenAIError(error: unknown): ChatProviderError {
  // Google SDK 导出的 ApiError 携带 HTTP 状态码
  if (error instanceof GoogleApiError) {
    return normalizeAPIStatusError(error.status, error.message);
  }
  if (error instanceof Error) {
    const msg = error.message;
    // 超时优先于网络错误（超时也是一种连接问题）
    if (TIMEOUT_RE.test(msg)) {
      return new APITimeoutError(msg);
    }
    // 网络/fetch 错误（例如 TypeError: fetch failed）
    if (NETWORK_RE.test(msg) || (error instanceof TypeError && msg.includes('fetch'))) {
      return new APIConnectionError(msg);
    }
    // 尝试从未知错误格式中提取状态码
    const statusCode = (error as { code?: number }).code;
    if (typeof statusCode === 'number') {
      return normalizeAPIStatusError(statusCode, msg);
    }
    return new ChatProviderError(`GoogleGenAI error: ${msg}`);
  }
  return new ChatProviderError(`GoogleGenAI error: ${String(error)}`);
}
export class GoogleGenAIChatProvider implements ChatProvider {
  readonly name: string = 'google_genai';

  private _model: string;
  private _client: GenAIClient | undefined;
  private _generationKwargs: GoogleGenAIGenerationKwargs;
  private _vertexai: boolean;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _project: string | undefined;
  private _location: string | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => GenAIClient) | undefined;

  constructor(options: GoogleGenAIOptions) {
    this._model = options.model;
    this._vertexai = options.vertexai ?? false;
    this._stream = options.stream ?? true;
    this._generationKwargs = {};

    const apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._project = options.project;
    this._location = options.location;
    this._clientFactory = options.clientFactory;
    this._client =
      this._vertexai || this._apiKey !== undefined ? this._buildClient(this._apiKey) : undefined;
  }

  private _buildClient(apiKey: string | undefined): GenAIClient {
    return new GenAIClient({
      apiKey,
      ...(this._vertexai
        ? {
            vertexai: true,
            project: this._project,
            location: this._location,
          }
        : {}),
    });
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinkingConfig = this._generationKwargs.thinking_config;
    if (thinkingConfig === undefined) return null;

    // 对于使用 thinking_level 的 gemini-3 模型
    if (thinkingConfig.thinking_level !== undefined) {
      switch (thinkingConfig.thinking_level) {
        case 'MINIMAL':
          // MINIMAL + 抑制思考输出是 Gemini 3 中 'off' 的编码方式，
          // 因为它没有真正的"禁用"级别。
          return thinkingConfig.include_thoughts === false ? 'off' : 'low';
        case 'LOW':
          return 'low';
        case 'MEDIUM':
          return 'medium';
        case 'HIGH':
          return 'high';
        default:
          return null;
      }
    }

    // 对于使用 thinking_budget 的其他模型
    if (thinkingConfig.thinking_budget !== undefined) {
      if (thinkingConfig.thinking_budget === 0) return 'off';
      if (thinkingConfig.thinking_budget <= 1024) return 'low';
      if (thinkingConfig.thinking_budget <= 4096) return 'medium';
      return 'high';
    }

    return null;
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
    // 如果调用方已中止则短路——Google GenAI SDK 不会原生处理
    // 信号，因此必须手动检查。
    if (options?.signal?.aborted === true) {
      throw createAbortError();
    }

    const contents = messagesToGoogleGenAIContents(history);

    const config: Record<string, unknown> = {
      ...this._generationKwargs,
      system_instruction: systemPrompt,
      ...(tools.length > 0 ? { tools: tools.map((t) => toolToGoogleGenAI(t)) } : {}),
    };

    try {
      const client = this._createClient(options?.auth);
      const models = client.models as unknown as {
        generateContent(params: Record<string, unknown>): Promise<unknown>;
        generateContentStream(params: Record<string, unknown>): Promise<AsyncGenerator>;
      };

      const params = { model: this._model, contents, config };

      // Google GenAI SDK 不接受 AbortSignal，因此必须将初始 SDK 请求
      // 与调用方的中止信号进行竞争。一旦获得响应/流对象，下面的包装器
      // 会在每个块边界继续检查信号。
      if (this._stream) {
        const stream = await Promise.race([
          models.generateContentStream(params),
          abortPromise(options?.signal),
        ]);
        return new GoogleGenAIStreamedMessage(
          stream as AsyncIterable<Record<string, unknown>>,
          true,
          options?.signal,
        );
      }

      const response = await Promise.race([
        models.generateContent(params),
        abortPromise(options?.signal),
      ]);
      return new GoogleGenAIStreamedMessage(
        response as Record<string, unknown>,
        false,
        options?.signal,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): GenAIClient {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        // Vertex AI 认证通过 google-auth-library 服务凭证流转，
        // 而非请求作用域的 apiKey，且 @google/genai SDK 没有
        // 逐请求的 header 通道——因此在 vertexai 模式下，`auth.apiKey`
        // 和 `auth.headers` 都不会被传播。需要请求作用域凭证的
        // 调用方应改为将服务帐户指向正确的主体。
        if (this._vertexai) return this._buildClient(this._apiKey);
        return this._buildClient(requireProviderApiKey('GoogleGenAIChatProvider', a, this._apiKey));
      },
    );
  }

  withThinking(effort: ThinkingEffort): GoogleGenAIChatProvider {
    const thinkingConfig: ThinkingConfig = { include_thoughts: true };

    if (this._model.includes('gemini-3')) {
      // Gemini 3 模型使用 thinking_level（MINIMAL/LOW/MEDIUM/HIGH）。
      // SDK 不提供"禁用"级别，因此 'off' 映射为 MINIMAL 并抑制
      // 思考输出——这是可用的最低思考强度。
      switch (effort) {
        case 'off':
          thinkingConfig.thinking_level = 'MINIMAL';
          thinkingConfig.include_thoughts = false;
          break;
        case 'low':
          thinkingConfig.thinking_level = 'LOW';
          break;
        case 'medium':
          thinkingConfig.thinking_level = 'MEDIUM';
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinkingConfig.thinking_level = 'HIGH';
          break;
      }
    } else {
      switch (effort) {
        case 'off':
          thinkingConfig.thinking_budget = 0;
          thinkingConfig.include_thoughts = false;
          break;
        case 'low':
          thinkingConfig.thinking_budget = 1024;
          thinkingConfig.include_thoughts = true;
          break;
        case 'medium':
          thinkingConfig.thinking_budget = 4096;
          thinkingConfig.include_thoughts = true;
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinkingConfig.thinking_budget = 32_000;
          thinkingConfig.include_thoughts = true;
          break;
      }
    }

    return this.withGenerationKwargs({ thinking_config: thinkingConfig });
  }

  withGenerationKwargs(kwargs: GoogleGenAIGenerationKwargs): GoogleGenAIChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(maxCompletionTokens: number): GoogleGenAIChatProvider {
    return this.withGenerationKwargs({ max_output_tokens: maxCompletionTokens });
  }

  private _clone(): GoogleGenAIChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as GoogleGenAIChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}

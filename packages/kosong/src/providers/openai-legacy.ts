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
import OpenAI from 'openai';

import {
  convertContentPart,
  convertOpenAIError,
  convertToolMessageContent,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
  reasoningEffortToThinkingEffort,
  thinkingEffortToReasoningEffort,
  toolToOpenAI,
} from './openai-common';
import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from './chat-completions-stream';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from './request-auth';
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
  type ToolCallIdPolicy,
} from './tool-call-id';

// 入站：按优先级顺序扫描；第一个匹配的字符串值生效。出站：第一个
// 条目同时作为将 ThinkPart 序列化回的默认字段。两侧都可被 provider
// 配置上的显式 `reasoningKey` 覆盖。
const KNOWN_REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'] as const;
const DEFAULT_OUTBOUND_REASONING_KEY = KNOWN_REASONING_KEYS[0];
const OPENAI_CHAT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

function extractReasoningContent(
  source: unknown,
  explicitKey: string | undefined,
): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export interface OpenAILegacyOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningKey?: string | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

export interface OpenAILegacyGenerationKwargs {
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  [key: string]: unknown;
}
interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | undefined;
  tool_calls?: OpenAIToolCallOut[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  [key: string]: unknown;
}

interface OpenAIToolCallOut {
  type: string;
  id: string;
  function: { name: string; arguments: string | null };
}

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

function completionTokenKwargs(
  model: string,
  maxCompletionTokens: number,
): OpenAILegacyGenerationKwargs {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxCompletionTokens }
    : { max_tokens: maxCompletionTokens };
}

function normalizeGenerationKwargs(
  model: string,
  source: OpenAILegacyGenerationKwargs,
): OpenAILegacyGenerationKwargs {
  const kwargs = { ...source };
  if (usesMaxCompletionTokens(model)) {
    if (kwargs.max_completion_tokens === undefined && kwargs.max_tokens !== undefined) {
      kwargs.max_completion_tokens = kwargs.max_tokens;
    }
    delete kwargs.max_tokens;
  }
  return kwargs;
}

function convertMessage(
  message: Message,
  reasoningKey: string | undefined,
  toolMessageConversion: ToolMessageConversion,
): OpenAIMessage {
  let reasoningContent = '';
  const nonThinkParts: ContentPart[] = [];

  for (const part of message.content) {
    if (part.type === 'think') {
      reasoningContent += part.think;
    } else {
      nonThinkParts.push(part);
    }
  }

  // 构建 OpenAI 消息。
  const result: OpenAIMessage = { role: message.role };

  if (message.role === 'tool') {
    // OpenAI Chat Completions 的 `tool` 消息只接受文本内容。
    // 任何非文本内容部分（image_url、audio_url、video_url）都会被
    // API 以 400 拒绝。检测多模态工具输出，在这种情况下强制走
    // `extract_text` 路径，忽略调用方的 `toolMessageConversion` 设置。
    // 对于纯文本工具结果，遵循配置的策略（如果未设置则退回到
    // 默认的内容部分数组）。
    const hasNonTextPart = message.content.some((p) => p.type !== 'text' && p.type !== 'think');
    const effectiveConversion: ToolMessageConversion = hasNonTextPart
      ? 'extract_text'
      : toolMessageConversion;

    if (effectiveConversion !== null) {
      result.content = convertToolMessageContentForChat(message, effectiveConversion);
    } else {
      // 未配置转换的纯文本工具结果：通过通用内容部分路径序列化，
      // 使单文本消息成为纯字符串。
      const firstPart = nonThinkParts[0];
      if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
        result.content = firstPart.text;
      } else if (nonThinkParts.length > 0) {
        result.content = nonThinkParts
          .map((p) => convertContentPart(p))
          .filter((p): p is OpenAIContentPart => p !== null);
      }
    }
  } else {
    // content：如果是单个文本则序列化为字符串，否则为数组
    const firstPart = nonThinkParts[0];
    if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
      result.content = firstPart.text;
    } else if (nonThinkParts.length > 0) {
      result.content = nonThinkParts
        .map((p) => convertContentPart(p))
        .filter((p): p is OpenAIContentPart => p !== null);
    }
  }

  if (message.name !== undefined) {
    result.name = message.name;
  }

  if (message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((tc) => ({
      type: tc.type,
      id: tc.id,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  // 将思考内容回传给服务器。默认使用事实标准 `reasoning_content`
  // 字段，以便 OpenAI 兼容的推理模型（DeepSeek、Qwen、
  // One API 网关）无需逐 provider 配置即可工作。不识别该字段的
  // 服务器会忽略它；需要特定字段的服务器可通过显式
  // `reasoningKey` 覆盖。
  if (reasoningContent) {
    result[reasoningKey ?? DEFAULT_OUTBOUND_REASONING_KEY] = reasoningContent;
  }

  return result;
}

// Chat Completions 没有基于 url 的音频/视频内容部分（只有 base64
// `input_audio`），因此与图片不同，它们不能作为用户输入重新附加。
// 改为在工具消息文本中内联注明已省略。
const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function convertToolMessageContentForChat(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  const content = convertToolMessageContent(message, conversion);
  if (typeof content !== 'string') {
    return content;
  }
  const lines: string[] = content.length > 0 ? [content] : [];
  if (message.content.some((part) => part.type === 'audio_url')) {
    lines.push(OMITTED_AUDIO_PLACEHOLDER);
  }
  if (message.content.some((part) => part.type === 'video_url')) {
    lines.push(OMITTED_VIDEO_PLACEHOLDER);
  }
  if (lines.length === 0 && message.content.some((part) => part.type === 'image_url')) {
    return TOOL_RESULT_MEDIA_PLACEHOLDER;
  }
  return lines.join('\n');
}

function toolResultImageParts(message: Message): OpenAIContentPart[] {
  const images: OpenAIContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== 'image_url') continue;
    const converted = convertContentPart(part);
    if (converted !== null) {
      images.push(converted);
    }
  }
  return images;
}

function appendToolResultMediaMessage(
  messages: OpenAIMessage[],
  pendingToolResultMedia: OpenAIContentPart[],
): void {
  if (pendingToolResultMedia.length === 0) return;
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: TOOL_RESULT_MEDIA_PROMPT }, ...pendingToolResultMedia],
  });
  pendingToolResultMedia.length = 0;
}

function convertHistoryMessages(
  history: readonly Message[],
  reasoningKey: string | undefined,
  toolMessageConversion: ToolMessageConversion,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const pendingToolResultMedia: OpenAIContentPart[] = [];

  for (const msg of history) {
    if (msg.role !== 'tool') {
      appendToolResultMediaMessage(messages, pendingToolResultMedia);
    }
    messages.push(convertMessage(msg, reasoningKey, toolMessageConversion));
    if (msg.role === 'tool') {
      pendingToolResultMedia.push(...toolResultImageParts(msg));
    }
  }

  appendToolResultMediaMessage(messages, pendingToolResultMedia);
  return messages;
}
export class OpenAILegacyStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
    reasoningKey: string | undefined,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
        reasoningKey,
      );
    } else {
      this._iter = this._convertNonStreamResponse(
        response as OpenAI.Chat.ChatCompletion,
        reasoningKey,
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

  private _captureFinishReason(raw: string | null | undefined): void {
    const normalized = normalizeOpenAIFinishReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private async *_convertNonStreamResponse(
    response: OpenAI.Chat.ChatCompletion,
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    if (response.usage) {
      this._usage = extractUsage(response.usage) ?? null;
    }
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    // 推理内容：设置了显式 key 时遵循它，否则扫描事实标准字段集，
    // 使手写配置无需额外设置即可工作。
    const reasoning = extractReasoningContent(message, reasoningKey);
    if (reasoning) {
      yield { type: 'think', think: reasoning } satisfies StreamedMessagePart;
    }

    if (message.content) {
      yield { type: 'text', text: message.content } satisfies StreamedMessagePart;
    }

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (!isFunctionToolCall(toolCall)) continue;
        yield {
          type: 'function',
          id: toolCall.id || crypto.randomUUID(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        } satisfies ToolCall;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    reasoningKey: string | undefined,
  ): AsyncGenerator<StreamedMessagePart> {
    const bufferedToolCalls = new Map<number | string, BufferedChatCompletionToolCall>();

    try {
      for await (const chunk of response) {
        if (chunk.id) {
          this._id = chunk.id;
        }

        if (chunk.usage) {
          this._usage = extractUsage(chunk.usage) ?? null;
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        // 当块携带 finish_reason 时捕获它。Chat Completions 仅在
        // 给定选择的最后一个块上设置该值。
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        // 推理内容：设置了显式 key 时遵循它，否则扫描事实标准字段集，
        // 使手写配置无需额外设置即可工作。
        const reasoning = extractReasoningContent(delta, reasoningKey);
        if (reasoning) {
          yield { type: 'think', think: reasoning } satisfies StreamedMessagePart;
        }

        // 文本内容
        if (delta.content) {
          yield { type: 'text', text: delta.content } satisfies StreamedMessagePart;
        }

        // 工具调用——在每个 yield 的 part 上保留 `index`，以便生成循环
        // 能够路由来自并行工具调用的交错参数增量。
        for (const toolCall of delta.tool_calls ?? []) {
          for (const part of convertChatCompletionStreamToolCall(toolCall, bufferedToolCalls)) {
            yield part;
          }
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }
}
export class OpenAILegacyChatProvider implements ChatProvider {
  readonly name: string = 'openai';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _reasoningKey: string | undefined;
  private _reasoningEffort: string | undefined;
  private _generationKwargs: OpenAILegacyGenerationKwargs;
  private _toolMessageConversion: ToolMessageConversion;
  private _client: OpenAI | undefined;
  private _httpClient: unknown;
  private _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;

  constructor(options: OpenAILegacyOptions) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = options.stream ?? true;
    // 将空白/纯空格的 reasoningKey 归一化为未设置。ModelAliasSchema
    // 接受 `z.string().optional()`，因此 config.toml 中的
    // `reasoning_key = ""` 会禁用默认字段扫描，并通过空属性名
    // 路由读写操作。
    const normalizedReasoningKey = options.reasoningKey?.trim();
    this._reasoningKey =
      normalizedReasoningKey !== undefined && normalizedReasoningKey.length > 0
        ? normalizedReasoningKey
        : undefined;
    this._reasoningEffort = undefined;
    this._generationKwargs =
      options.maxTokens !== undefined ? completionTokenKwargs(this._model, options.maxTokens) : {};
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return reasoningEffortToThinkingEffort(this._reasoningEffort);
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...normalizeGenerationKwargs(this._model, this._generationKwargs),
    };
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const messages: OpenAIMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      OPENAI_CHAT_TOOL_CALL_ID_POLICY,
    );
    messages.push(
      ...convertHistoryMessages(normalizedHistory, this._reasoningKey, this._toolMessageConversion),
    );

    const kwargs: Record<string, unknown> = normalizeGenerationKwargs(
      this._model,
      this._generationKwargs,
    );

    // 确定 reasoning_effort
    let reasoningEffort: string | undefined = this._reasoningEffort;

    // 当历史记录中包含 ThinkPart 但未显式配置推理时，自动启用
    // reasoning_effort。这可以防止某些 API（如 One API）在消息包含
    // reasoning_content 时要求 reasoning_effort 导致的服务器验证错误。
    // 当调用方已通过 withGenerationKwargs 固定 reasoning_effort 时跳过——
    // 否则其值会在下面被静默覆盖。
    // 参见：https://github.com/MoonshotAI/kimi-code/issues/1616
    if (reasoningEffort === undefined && kwargs['reasoning_effort'] === undefined) {
      const hasThinkPart = history.some((message) =>
        message.content.some((part) => part.type === 'think'),
      );
      if (hasThinkPart) {
        reasoningEffort = 'medium';
      }
    }

    // 从 kwargs 中移除 undefined 值
    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    // 构建 create 参数
    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      stream: this._stream,
      ...kwargs,
    };

    if (tools.length > 0) {
      createParams['tools'] = tools.map((t) => toolToOpenAI(t));
    }

    if (this._stream) {
      createParams['stream_options'] = { include_usage: true };
    }

    if (reasoningEffort !== undefined) {
      createParams['reasoning_effort'] = reasoningEffort;
    }

    try {
      const client = this._createClient(options?.auth);
      const response = (await client.chat.completions.create(
        createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      return new OpenAILegacyStreamedMessage(response, this._stream, this._reasoningKey);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): OpenAILegacyChatProvider {
    const reasoningEffort = thinkingEffortToReasoningEffort(effort);
    const clone = this._clone();
    clone._reasoningEffort = reasoningEffort;
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAILegacyGenerationKwargs): OpenAILegacyChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(maxCompletionTokens: number): OpenAILegacyChatProvider {
    return this.withGenerationKwargs(completionTokenKwargs(this._model, maxCompletionTokens));
  }

  private _clone(): OpenAILegacyChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAILegacyChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) =>
        this._buildClient(requireProviderApiKey('OpenAILegacyChatProvider', a, this._apiKey), a),
    );
  }

  private _buildClient(apiKey: string, auth?: ProviderRequestAuth): OpenAI {
    const clientOpts: Record<string, unknown> = {
      apiKey,
      baseURL: this._baseUrl,
    };
    const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, auth?.headers);
    if (defaultHeaders !== undefined) {
      clientOpts['defaultHeaders'] = defaultHeaders;
    }
    if (this._httpClient !== undefined) {
      clientOpts['httpClient'] = this._httpClient;
    }
    return new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
  }
}

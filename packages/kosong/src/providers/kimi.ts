import { normalizeKimiToolSchema } from './kimi-schema';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
  VideoUploadInput,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import OpenAI from 'openai';

import { KimiFiles } from './kimi-files';
import {
  convertChatCompletionStreamToolCall,
  type BufferedChatCompletionToolCall,
} from './chat-completions-stream';
import {
  convertContentPart,
  convertOpenAIError,
  extractUsage,
  isFunctionToolCall,
  normalizeOpenAIFinishReason,
  type OpenAIContentPart,
  type OpenAIToolParam,
  reasoningEffortToThinkingEffort,
  toolToOpenAI,
} from './openai-common';
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
export interface KimiOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  stream?: boolean | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  generationKwargs?: GenerationKwargs | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

export interface GenerationKwargs {
  /**
   * 旧版补全预算别名。Moonshot Kimi API 仍然接受 `max_tokens`，
   * 但对于推理模型，它与 `reasoning_content` 共享预算，较小的值
   * 可能导致返回 200 响应但没有 `content`。推荐使用
   * `max_completion_tokens`。当两者同时设置时 `max_completion_tokens`
   * 优先；此提供商通过仅在传输中发送 `max_completion_tokens` 来规范化。
   */
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  reasoning_effort?: string | undefined;
  prompt_cache_key?: string | undefined;
  extra_body?: ExtraBody;
}

export interface ThinkingConfig {
  type?: 'enabled' | 'disabled';
  keep?: unknown;
  [key: string]: unknown;
}

export interface ExtraBody {
  thinking?: ThinkingConfig;
  [key: string]: unknown;
}
const KIMI_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};
interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | undefined;
  tool_calls?: OpenAIToolCallOut[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  reasoning_content?: string | undefined;
}

interface OpenAIToolCallOut {
  type: string;
  id: string;
  function: { name: string; arguments: string | null };
  extras?: Record<string, unknown> | undefined;
}

function isEffectivelyEmptyContent(parts: ContentPart[]): boolean {
  for (const part of parts) {
    if (part.type !== 'text') return false;
    if (part.text.trim() !== '') return false;
  }
  return true;
}

function convertMessage(message: Message): OpenAIMessage {
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
  const hasToolCalls = message.toolCalls.length > 0;
  const shouldOmitContent =
    message.role === 'assistant' && hasToolCalls && isEffectivelyEmptyContent(nonThinkParts);

  if (!shouldOmitContent) {
    // content：如果只有单个文本部分则序列化为字符串，否则为数组
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

  if (hasToolCalls) {
    result.tool_calls = message.toolCalls.map((tc) => {
      const mapped: OpenAIToolCallOut = {
        type: tc.type,
        id: tc.id,
        function: { name: tc.name, arguments: tc.arguments },
      };
      if (tc.extras !== undefined) {
        mapped.extras = tc.extras;
      }
      return mapped;
    });
  }

  if (message.toolCallId !== undefined) {
    result.tool_call_id = message.toolCallId;
  }

  if (reasoningContent) {
    result.reasoning_content = reasoningContent;
  }

  return result;
}
function convertTool(tool: Tool): OpenAIToolParam {
  if (tool.name.startsWith('$')) {
    // Kimi 内置函数以 `$` 开头
    return {
      type: 'builtin_function',
      function: { name: tool.name },
    };
  }
  const converted = toolToOpenAI(tool);
  return {
    ...converted,
    function: {
      ...converted.function,
      parameters: normalizeKimiToolSchema(tool.parameters),
    },
  };
}
/**
 * 从流式传输的数据块中提取用量信息。Moonshot 可能会在 `choices[0].usage`
 * 中放置用量数据，作为顶层 `usage` 字段的补充。
 */
export function extractUsageFromChunk(
  chunk: Record<string, unknown>,
): Record<string, unknown> | null {
  // 顶层 usage
  if (
    chunk['usage'] !== null &&
    chunk['usage'] !== undefined &&
    typeof chunk['usage'] === 'object'
  ) {
    return chunk['usage'] as Record<string, unknown>;
  }
  // choices[0].usage（Moonshot 私有字段）
  const choices = chunk['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const firstChoice = choices[0] as Record<string, unknown> | undefined;
  if (firstChoice === undefined) {
    return null;
  }
  const choiceUsage = firstChoice['usage'];
  if (choiceUsage !== null && choiceUsage !== undefined && typeof choiceUsage === 'object') {
    return choiceUsage as Record<string, unknown>;
  }
  return null;
}

class KimiStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isStream: boolean,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as OpenAI.Chat.ChatCompletion);
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
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    if (response.usage) {
      this._usage = extractUsage(response.usage) ?? null;
    }
    this._captureFinishReason(response.choices[0]?.finish_reason ?? null);

    const message = response.choices[0]?.message;
    if (!message) return;

    // reasoning_content（Moonshot 私有字段）
    const rc = (message as unknown as Record<string, unknown>)['reasoning_content'];
    if (typeof rc === 'string' && rc) {
      yield { type: 'think', think: rc } satisfies StreamedMessagePart;
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
  ): AsyncGenerator<StreamedMessagePart> {
    const bufferedToolCalls = new Map<number | string, BufferedChatCompletionToolCall>();

    try {
      for await (const chunk of response) {
        if (chunk.id) {
          this._id = chunk.id;
        }

        // 从数据块中提取用量信息（支持顶层和 choices[0].usage 两种位置）
        const rawChunk = chunk as unknown as Record<string, unknown>;
        const rawUsage = extractUsageFromChunk(rawChunk);
        if (rawUsage) {
          this._usage = extractUsage(rawUsage) ?? null;
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        // 当数据块携带 finish_reason 时捕获它。Chat Completions API 仅在
        // 给定选项的最终数据块中设置它，但防御性地在每个非空值上重新捕获
        // 可确保即使上游重新发出也能获取最新信号。
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          this._captureFinishReason(choice.finish_reason);
        }

        const delta = choice.delta;

        // reasoning_content（Moonshot 私有字段）
        const rc = (delta as unknown as Record<string, unknown>)['reasoning_content'];
        if (typeof rc === 'string' && rc) {
          yield { type: 'think', think: rc } satisfies StreamedMessagePart;
        }

        // 文本内容
        if (delta.content) {
          yield { type: 'text', text: delta.content } satisfies StreamedMessagePart;
        }

        // 工具调用——在每个 yield 的部分上保留 `index`，以便生成循环可以
        // 路由来自并行工具调用的交错参数增量。
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
export class KimiChatProvider implements ChatProvider {
  readonly name: string = 'kimi';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string;
  private _defaultHeaders: Record<string, string> | undefined;
  private _generationKwargs: GenerationKwargs;
  private _client: OpenAI | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;
  private _files: KimiFiles | undefined;

  constructor(options: KimiOptions) {
    const apiKey = options.apiKey ?? process.env['KIMI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? process.env['KIMI_BASE_URL'] ?? 'https://api.moonshot.ai/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._generationKwargs = { ...options.generationKwargs };
    this._client =
      this._apiKey === undefined
        ? undefined
        : new OpenAI({
            apiKey: this._apiKey,
            baseURL: this._baseUrl,
            defaultHeaders: this._defaultHeaders,
          });
  }

  get modelName(): string {
    return this._model;
  }

  /**
   * Kimi/Moonshot 的文件上传客户端。
   *
   * 使用此接口上传视频（将来支持其他媒体类型）到文件服务，
   * 并获取可嵌入聊天消息的内容部分。
   */
  get files(): KimiFiles {
    this._files ??= new KimiFiles({
      apiKey: this._apiKey,
      baseUrl: this._baseUrl,
      defaultHeaders: this._defaultHeaders,
      clientFactory: this._clientFactory,
    });
    return this._files;
  }

  uploadVideo(input: string | VideoUploadInput, options?: GenerateOptions) {
    return this.files.uploadVideo(input, options);
  }

  get thinkingEffort(): ThinkingEffort | null {
    return reasoningEffortToThinkingEffort(this._generationKwargs.reasoning_effort);
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...this._generationKwargs,
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
    const normalizedHistory = normalizeToolCallIdsForProvider(history, KIMI_TOOL_CALL_ID_POLICY);
    for (const msg of normalizedHistory) {
      messages.push(convertMessage(msg));
    }

    const kwargs: Record<string, unknown> = {
      ...this._generationKwargs,
    };

    // 从 kwargs 中移除 undefined 值
    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    // 将旧版 `max_tokens` 别名规范化为 Kimi 首选的 `max_completion_tokens`。
    // 当两者同时设置时，`max_completion_tokens` 优先（已在 Moonshot 线上
    // API 确认）。当两者都未设置时，不发送上限——上游循环负责根据当前输入
    // 大小和模型上下文窗口进行钳制。
    if (
      kwargs['max_completion_tokens'] === undefined &&
      kwargs['max_tokens'] !== undefined
    ) {
      kwargs['max_completion_tokens'] = kwargs['max_tokens'];
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete kwargs['max_tokens'];

    const { extra_body: extraBody, ...requestKwargs } = kwargs;

    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      stream: this._stream,
      ...requestKwargs,
      ...(extraBody as Record<string, unknown> | undefined),
    };

    if (tools.length > 0) {
      createParams['tools'] = tools.map((t) => convertTool(t));
    }

    if (this._stream) {
      createParams['stream_options'] = { include_usage: true };
    }

    try {
      const client = this._createClient(options?.auth);
      // 使用 unknown 进行类型断言，因为我们传入了 Moonshot 私有字段
      // （reasoning_effort、thinking），这些在 OpenAI 类型定义中不存在。
      const response = (await client.chat.completions.create(
        createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      return new KimiStreamedMessage(response, this._stream);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): KimiChatProvider {
    const thinking: ThinkingConfig = {
      type: effort === 'off' ? 'disabled' : 'enabled',
    };
    let reasoningEffort: string | undefined;
    switch (effort) {
      case 'off':
        reasoningEffort = undefined;
        break;
      case 'low':
        reasoningEffort = 'low';
        break;
      case 'medium':
        reasoningEffort = 'medium';
        break;
      case 'high':
      case 'xhigh':
      case 'max':
        reasoningEffort = 'high';
        break;
    }
    return this._withGenerationKwargs({ reasoning_effort: reasoningEffort }).withExtraBody({
      thinking,
    });
  }

  withGenerationKwargs(kwargs: GenerationKwargs): KimiChatProvider {
    return this._withGenerationKwargs(kwargs);
  }

  withMaxCompletionTokens(maxCompletionTokens: number): KimiChatProvider {
    return this._withGenerationKwargs({ max_completion_tokens: maxCompletionTokens });
  }

  withExtraBody(extraBody: ExtraBody): KimiChatProvider {
    const oldExtra = this._generationKwargs.extra_body ?? {};
    const merged: ExtraBody = { ...oldExtra, ...extraBody };
    const oldThinking = oldExtra.thinking;
    const newThinking = extraBody.thinking;
    if (oldThinking !== undefined && newThinking !== undefined) {
      merged.thinking = { ...oldThinking, ...newThinking };
    }
    return this._withGenerationKwargs({ extra_body: merged });
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, a?.headers);
        return new OpenAI({
          apiKey: requireProviderApiKey('KimiChatProvider', a, this._apiKey),
          baseURL: this._baseUrl,
          defaultHeaders,
        });
      },
    );
  }

  private _withGenerationKwargs(kwargs: GenerationKwargs): KimiChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): KimiChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as KimiChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    // 不与克隆实例共享已缓存的 KimiFiles 实例；让其在首次访问时惰性重建。
    clone._files = undefined;
    // `_client` 故意与原始实例共享。每步预算钳制（参见 KosongLLM.chatOnce）
    // 依赖于此克隆操作的轻量性。如果未来变更引入了用全新构建的客户端替换
    // `clone._client`（并关闭旧客户端）的重试路径，原始实例的 `_client` 将
    // 变成指向已关闭 socket 的悬挂引用。保持 `_client` 共享且构造后永不变更；
    // 需要真正的新客户端时应构建新的 KimiChatProvider。
    return clone;
  }
}

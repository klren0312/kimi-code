import {
  APIContextOverflowError,
  APIProviderRateLimitError,
  ChatProviderError,
  isContextOverflowErrorCode,
} from '#/errors';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import { extractText } from '#/message';
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

import { usesOpenAIResponsesDeveloperRole } from './capability-registry';
import {
  convertOpenAIError,
  isMediaPart,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
  reasoningEffortToThinkingEffort,
  thinkingEffortToReasoningEffort,
} from './openai-common';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from './request-auth';
import {
  normalizeToolCallIdsForProvider,
  sanitizeOpenAIResponsesCallId,
  type ToolCallIdPolicy,
} from './tool-call-id';

/**
 * 将 Responses API 的 status / incomplete_details 规范化为统一的
 * {@link FinishReason} 枚举。
 *
 * 注意：Responses API 没有 `tool_calls` 风格的状态。当响应以
 * `function_call` 项内联完成时，status 仍为 `'completed'`；调用方
 * 通过 `message.toolCalls.length` 检测工具调用，而非通过 finishReason。
 */
function normalizeResponsesFinishReason(
  status: string | null | undefined,
  incompleteReason: string | null | undefined,
): { finishReason: FinishReason | null; rawFinishReason: string | null } {
  if (status === null || status === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  if (status === 'completed') {
    return { finishReason: 'completed', rawFinishReason: 'completed' };
  }
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') {
      return { finishReason: 'truncated', rawFinishReason: 'max_output_tokens' };
    }
    if (incompleteReason === 'content_filter') {
      return { finishReason: 'filtered', rawFinishReason: 'content_filter' };
    }
    return {
      finishReason: 'other',
      rawFinishReason: incompleteReason ?? 'incomplete',
    };
  }
  if (status === 'failed') {
    return { finishReason: 'other', rawFinishReason: 'failed' };
  }
  return { finishReason: null, rawFinishReason: null };
}

type RawObject = Record<string, unknown>;
const OPENAI_RESPONSES_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeOpenAIResponsesCallId(id, 64),
  maxLength: 64,
};

type ResponseOutputItemView =
  | {
      type: 'message';
      content: RawObject[];
    }
  | {
      type: 'function_call';
      itemId?: string;
      callId?: string;
      name?: string;
      arguments?: string | null;
    }
  | {
      type: 'reasoning';
      encryptedContent?: string;
      summary: RawObject[];
    }
  | {
      type: 'other';
    };

function asRawObject(value: unknown): RawObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as RawObject;
}

function readStringField(object: RawObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function hasOwn(object: RawObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readNullableStringField(object: RawObject, key: string): string | null | undefined {
  const value = object[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(object: RawObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === 'number' ? value : undefined;
}

function readObjectField(object: RawObject, key: string): RawObject | undefined {
  return asRawObject(object[key]) ?? undefined;
}

function readObjectArrayField(object: RawObject, key: string): RawObject[] | undefined {
  const value = object[key];
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const objectItem = asRawObject(item);
    return objectItem === null ? [] : [objectItem];
  });
}

function failResponsesDecode(context: string, detail: string): never {
  throw new ChatProviderError(`OpenAI Responses decode error: ${context} ${detail}`);
}

function requireStringField(object: RawObject, key: string, context: string): string {
  const value = readStringField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, 'must be a string.');
  }
  return value;
}

function requireObjectField(object: RawObject, key: string, context: string): RawObject {
  const value = readObjectField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, 'must be an object.');
  }
  return value;
}

function readResponseOutputItem(
  value: unknown,
  context: string,
): ResponseOutputItemView {
  const item = asRawObject(value);
  if (item === null) {
    failResponsesDecode(context, 'must be an object.');
  }

  const type = requireStringField(item, 'type', context);

  if (type === 'message') {
    return {
      type,
      content: readObjectArrayField(item, 'content') ?? [],
    };
  }

  if (type === 'function_call') {
    return {
      type,
      itemId: readStringField(item, 'id'),
      callId: readStringField(item, 'call_id'),
      name: readStringField(item, 'name'),
      arguments: readNullableStringField(item, 'arguments'),
    };
  }

  if (type === 'reasoning') {
    return {
      type,
      encryptedContent: readStringField(item, 'encrypted_content'),
      summary: readObjectArrayField(item, 'summary') ?? [],
    };
  }

  return { type: 'other' };
}

function responseStreamIndex(
  itemId: string | undefined,
  outputIndex: number | undefined,
): string | number | undefined {
  return itemId ?? outputIndex;
}

function formatResponseStreamIndex(streamIndex: string | number | undefined): string {
  return streamIndex === undefined ? '<unindexed>' : String(streamIndex);
}

function requireFunctionCallName(item: { name?: string }): string {
  if (item.name === undefined) {
    throw new ChatProviderError('OpenAI Responses function_call item is missing a name.');
  }
  return item.name;
}

function functionCallId(callId: string | undefined): string {
  return callId === undefined || callId.length === 0 ? crypto.randomUUID() : callId;
}

function formatResponsesErrorEvent(
  code: string | null,
  message: string,
  param: string | null,
): string {
  const codeText = code ?? 'unknown';
  const paramText = param === null ? '' : ` (param: ${param})`;
  return `${codeText}: ${message}${paramText}`;
}

function errorFromOpenAIResponsesEvent(
  prefix: string,
  code: string | null,
  message: string,
  param: string | null,
): ChatProviderError {
  const formatted = formatResponsesErrorEvent(code, message, param);
  const fullMessage = `${prefix}: ${formatted}`;
  if (isContextOverflowErrorCode(code)) {
    return new APIContextOverflowError(400, fullMessage);
  }
  if (code === 'rate_limit_exceeded') {
    return new APIProviderRateLimitError(fullMessage);
  }
  return new ChatProviderError(fullMessage);
}

function parseNestedGatewayStreamError(message: string):
  | {
      code: string | null;
      message: string;
      param: string | null;
    }
  | undefined {
  const marker = 'received error while streaming:';
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) return undefined;

  const jsonText = message.slice(markerIndex + marker.length).trim();
  if (jsonText.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  const error = asRawObject(parsed);
  if (error === null) return undefined;

  const nestedMessage = readStringField(error, 'message');
  if (nestedMessage === undefined) return undefined;

  return {
    code: readNullableStringField(error, 'code') ?? null,
    message: nestedMessage,
    param: readNullableStringField(error, 'param') ?? null,
  };
}

function malformedStreamErrorEvent(message: string): ChatProviderError {
  const nested = parseNestedGatewayStreamError(message);
  if (nested !== undefined) {
    return errorFromOpenAIResponsesEvent(
      'OpenAI Responses malformed stream error',
      nested.code,
      nested.message,
      nested.param,
    );
  }

  return errorFromOpenAIResponsesEvent(
    'OpenAI Responses malformed stream error',
    null,
    message,
    null,
  );
}

function readResponsesFailedResponseError(response: RawObject):
  | {
      code: string | null;
      message: string;
    }
  | undefined {
  const error = readObjectField(response, 'error');
  if (error !== undefined) {
    const code = readNullableStringField(error, 'code') ?? 'unknown';
    const message = readStringField(error, 'message') ?? 'no message';
    return { code, message };
  }
  return undefined;
}

function formatResponsesFailedResponse(response: RawObject): string {
  const error = readResponsesFailedResponseError(response);
  if (error !== undefined) {
    return formatResponsesErrorEvent(error.code, error.message, null);
  }

  const incompleteDetails = readObjectField(response, 'incomplete_details');
  const reason =
    incompleteDetails === undefined ? undefined : readStringField(incompleteDetails, 'reason');
  return reason === undefined
    ? 'Unknown error (no error details in response)'
    : `incomplete: ${reason}`;
}

export interface OpenAIResponsesOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  maxOutputTokens?: number | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

export interface OpenAIResponsesGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  reasoning_effort?: string | undefined;
  [key: string]: unknown;
}
interface ResponseInputItem {
  [key: string]: unknown;
}

interface ResponseToolParam {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}
// Responses API 没有视频输入类型，且仅 mp3/wav 音频可以作为
// input_file 数据内联。将此类内容降级为占位文本，以便模型仍能
// 得知存在附件，而不是静默丢失。
const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: unsupported audio format)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function contentPartsToInputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({
          type: 'input_image',
          detail: 'auto',
          image_url: part.imageUrl.url,
        });
        break;
      case 'audio_url': {
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        items.push(mapped ?? { type: 'input_text', text: OMITTED_AUDIO_PLACEHOLDER });
        break;
      }
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        // 作为推理项单独处理。
        break;
    }
  }
  return items;
}

function contentPartsToOutputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      items.push({ type: 'output_text', text: part.text, annotations: [] });
    }
  }
  return items;
}

function messageContentToFunctionOutputItems(content: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({ type: 'input_image', image_url: part.imageUrl.url });
        break;
      case 'audio_url': {
        // 工具结果可以合法包含音频（例如 TTS 工具返回生成的语音）。
        // 用户消息路径已通过 `mapAudioUrlToInputItem` 编码音频；
        // 如果此处不做相同处理，工具返回的音频将在下一轮被丢弃。
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        items.push(mapped ?? { type: 'input_text', text: OMITTED_AUDIO_PLACEHOLDER });
        break;
      }
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        // 作为推理项单独处理。
        break;
    }
  }
  return items;
}

function mapAudioUrlToInputItem(url: string): unknown {
  if (url.startsWith('data:audio/')) {
    try {
      const parts = url.split(',', 2);
      if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
      const header = parts[0];
      const b64 = parts[1];
      const subtypePart = header.split('/')[1];
      if (subtypePart === undefined) return null;
      const [subtypeHead = ''] = subtypePart.split(';');
      const subtype = subtypeHead.toLowerCase();
      const ext =
        subtype === 'mp3' || subtype === 'mpeg' ? 'mp3' : subtype === 'wav' ? 'wav' : null;
      if (ext === null) return null;
      return { type: 'input_file', file_data: b64, filename: `inline.${ext}` };
    } catch {
      return null;
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'input_file', file_url: url };
  }
  return null;
}

function convertMessage(
  message: Message,
  modelName: string,
  toolMessageConversion: ToolMessageConversion,
): ResponseInputItem[] {
  let role: string = message.role;
  if (usesOpenAIResponsesDeveloperRole(modelName) && role === 'system') {
    role = 'developer';
  }

  // tool 角色 -> function_call_output
  if (role === 'tool') {
    const callId = message.toolCallId ?? '';
    let output: string | unknown[];
    if (toolMessageConversion === 'extract_text') {
      // 针对拒绝结构化 function_call_output 的后端使用纯字符串输出。
      // 媒体部分由 `convertHistoryMessages` 作为用户消息重新附加；
      // 当结果不包含任何文本时，引导模型查看该后续消息。
      const text = extractText(message);
      output =
        text.length === 0 && message.content.some(isMediaPart)
          ? TOOL_RESULT_MEDIA_PLACEHOLDER
          : text;
    } else {
      output = messageContentToFunctionOutputItems(message.content);
    }
    return [
      {
        call_id: callId,
        output,
        type: 'function_call_output',
      },
    ];
  }

  const result: ResponseInputItem[] = [];

  // 处理内容部分
  if (message.content.length > 0) {
    const pendingParts: ContentPart[] = [];

    const flushPendingParts = (): void => {
      if (pendingParts.length === 0) return;
      if (role === 'assistant') {
        result.push({
          content: contentPartsToOutputItems(pendingParts),
          role,
          type: 'message',
        });
      } else {
        result.push({
          content: contentPartsToInputItems(pendingParts),
          role,
          type: 'message',
        });
      }
      pendingParts.length = 0;
    };

    let i = 0;
    const n = message.content.length;
    while (i < n) {
      const part = message.content[i];
      if (part === undefined) break;
      if (part.type === 'think') {
        // 先刷新已积累的非推理部分
        flushPendingParts();
        // 聚合具有相同 `encrypted` 值的连续 ThinkPart
        const encryptedValue = part.encrypted;
        const summaries: unknown[] = [{ type: 'summary_text', text: part.think || '' }];
        i += 1;
        while (i < n) {
          const nextPart = message.content[i];
          if (nextPart === undefined) break;
          if (nextPart.type !== 'think') break;
          if (nextPart.encrypted !== encryptedValue) break;
          summaries.push({ type: 'summary_text', text: nextPart.think || '' });
          i += 1;
        }
        result.push({
          summary: summaries,
          type: 'reasoning',
          encrypted_content: encryptedValue,
        });
      } else {
        pendingParts.push(part);
        i += 1;
      }
    }

    // 处理剩余的尾部非推理部分
    flushPendingParts();
  }

  // 处理工具调用
  for (const toolCall of message.toolCalls) {
    result.push({
      arguments: toolCall.arguments ?? '{}',
      call_id: toolCall.id,
      name: toolCall.name,
      type: 'function_call',
    });
  }

  return result;
}

function convertTool(tool: Tool): ResponseToolParam {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

/**
 * 转换历史消息，在 `extract_text` 将工具输出展平为纯字符串时
 * 缓冲工具结果中的媒体内容。缓冲的媒体项在每组连续工具消息之后
 * 作为单条用户消息重新附加——与 OpenAI Chat Completions 提供者
 * 的行为一致。
 */
function convertHistoryMessages(
  history: readonly Message[],
  modelName: string,
  toolMessageConversion: ToolMessageConversion,
): unknown[] {
  const input: unknown[] = [];
  const pendingToolResultMedia: unknown[] = [];

  const flushPendingMedia = (): void => {
    if (pendingToolResultMedia.length === 0) return;
    input.push({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: TOOL_RESULT_MEDIA_PROMPT },
        ...pendingToolResultMedia,
      ],
    });
    pendingToolResultMedia.length = 0;
  };

  for (const msg of history) {
    if (msg.role !== 'tool') {
      flushPendingMedia();
    }
    input.push(...convertMessage(msg, modelName, toolMessageConversion));
    if (msg.role === 'tool' && toolMessageConversion === 'extract_text') {
      pendingToolResultMedia.push(
        ...messageContentToFunctionOutputItems(msg.content.filter(isMediaPart)),
      );
    }
  }

  flushPendingMedia();
  return input;
}
export class OpenAIResponsesStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(response: unknown, isStream: boolean) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response as AsyncIterable<RawObject>);
    } else {
      this._iter = this._convertNonStreamResponse(response as RawObject);
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

  private _captureFinishReasonFromResponse(response: RawObject): void {
    const status = readNullableStringField(response, 'status');
    const incomplete = readObjectField(response, 'incomplete_details');
    const incompleteReason = incomplete ? readStringField(incomplete, 'reason') : null;
    const normalized = normalizeResponsesFinishReason(status, incompleteReason);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: RawObject): void {
    const inputTokens = readNumberField(usage, 'input_tokens') ?? 0;
    const outputTokens = readNumberField(usage, 'output_tokens') ?? 0;
    const details = readObjectField(usage, 'input_tokens_details');
    const cached = details ? (readNumberField(details, 'cached_tokens') ?? 0) : 0;
    this._usage = {
      inputOther: inputTokens - cached,
      output: outputTokens,
      inputCacheRead: cached,
      inputCacheCreation: 0,
    };
  }

  private async *_convertNonStreamResponse(
    response: RawObject,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = readStringField(response, 'id') ?? null;
    const usage = readObjectField(response, 'usage');
    if (usage !== undefined) {
      this._extractUsage(usage);
    }
    this._captureFinishReasonFromResponse(response);

    const output = readObjectArrayField(response, 'output');
    if (output === undefined) return;

    for (const item of output) {
      const outputItem = readResponseOutputItem(item, 'response.output item');

      if (outputItem.type === 'message') {
        for (const contentItem of outputItem.content) {
          if (contentItem['type'] === 'output_text') {
            const text = readStringField(contentItem, 'text');
            if (text !== undefined) {
              yield { type: 'text', text };
            }
          }
        }
      } else if (outputItem.type === 'function_call') {
        yield {
          type: 'function',
          id: functionCallId(outputItem.callId),
          name: requireFunctionCallName(outputItem),
          arguments: outputItem.arguments ?? null,
        } satisfies ToolCall;
      } else if (outputItem.type === 'reasoning') {
        for (const summary of outputItem.summary) {
          const text = readStringField(summary, 'text');
          if (text === undefined) continue;
          const thinkPart: StreamedMessagePart = {
            type: 'think',
            think: text,
          };
          if (outputItem.encryptedContent !== undefined) {
            (thinkPart as { encrypted: string }).encrypted = outputItem.encryptedContent;
          }
          yield thinkPart;
        }
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<RawObject>,
  ): AsyncGenerator<StreamedMessagePart> {
    const functionCallArgumentsByIndex = new Map<number | string, string>();
    let unindexedFunctionCallArguments: string | undefined;

    const hasFunctionCallArguments = (streamIndex: number | string | undefined): boolean =>
      streamIndex === undefined
        ? unindexedFunctionCallArguments !== undefined
        : functionCallArgumentsByIndex.has(streamIndex);

    const getFunctionCallArguments = (streamIndex: number | string | undefined): string =>
      streamIndex === undefined
        ? (unindexedFunctionCallArguments as string)
        : functionCallArgumentsByIndex.get(streamIndex)!;

    const setFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsValue: string,
    ): void => {
      if (streamIndex === undefined) {
        unindexedFunctionCallArguments = argumentsValue;
      } else {
        functionCallArgumentsByIndex.set(streamIndex, argumentsValue);
      }
    };

    const appendFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsPart: string,
      context: string,
    ): void => {
      if (!hasFunctionCallArguments(streamIndex)) {
        failResponsesDecode(
          context,
          `received function-call arguments for unknown stream index ${formatResponseStreamIndex(streamIndex)}.`,
        );
      }
      setFunctionCallArguments(
        streamIndex,
        getFunctionCallArguments(streamIndex) + argumentsPart,
      );
    };

    const yieldFinalArgumentsSuffix = function* (
      streamIndex: number | string | undefined,
      finalArguments: string,
      context: string,
    ): Generator<StreamedMessagePart> {
      if (!hasFunctionCallArguments(streamIndex)) {
        failResponsesDecode(
          context,
          `received final function-call arguments for unknown stream index ${formatResponseStreamIndex(streamIndex)}.`,
        );
      }

      const accumulatedArguments = getFunctionCallArguments(streamIndex);
      if (finalArguments === accumulatedArguments) {
        return;
      }

      if (!finalArguments.startsWith(accumulatedArguments)) {
        throw new ChatProviderError(
          `OpenAI Responses final function-call arguments for stream index ${formatResponseStreamIndex(
            streamIndex,
          )} do not match the streamed argument deltas.`,
        );
      }

      const suffix = finalArguments.slice(accumulatedArguments.length);
      setFunctionCallArguments(streamIndex, finalArguments);
      if (suffix.length === 0) {
        return;
      }

      const part: StreamedMessagePart = {
        type: 'tool_call_part',
        argumentsPart: suffix,
      };
      if (streamIndex !== undefined) {
        (part as { index: number | string }).index = streamIndex;
      }
      yield part;
    };

    try {
      for await (const chunk of response) {
        const type = readStringField(chunk, 'type');
        if (type === undefined) {
          if (!hasOwn(chunk, 'type')) {
            const message = readStringField(chunk, 'message');
            if (message !== undefined) {
              throw malformedStreamErrorEvent(message);
            }
          }
          failResponsesDecode('stream event.type', 'must be a string.');
        }

        switch (type) {
          case 'response.output_text.delta':
            yield { type: 'text', text: requireStringField(chunk, 'delta', type) };
            break;
          case 'response.created':
          case 'response.in_progress': {
            const responseObject = requireObjectField(chunk, 'response', type);
            // 初始事件携带 Responses API 的 `response.id`。在此记录它，
            // 以便在流完成之前检查 `stream.id` 的调用方看到的是实际的
            // 响应 ID，而非后续的输出项标识符。
            const respId = readStringField(responseObject, 'id');
            if (respId !== undefined) {
              this._id = respId;
            }
            break;
          }
          case 'response.output_item.added': {
            const item = readResponseOutputItem(chunk['item'], `${type}.item`);
            const outputIndex = readNumberField(chunk, 'output_index');
            // 注意：此处的 `item.id` 是输出项标识符，而非
            // Responses API 的 `response.id`。不要覆盖 `this._id`——
            // 这会破坏真实的响应 ID（或对没有 `item.id` 的工具调用项
            // 将其留为 undefined）。
            if (item.type === 'function_call') {
              // Responses API 通过 `item_id` 路由流式参数增量，
              // 该值与 output_item.added 上的 `item.id` 匹配。
              // 保留它以便生成循环能正确分发跨并行函数调用的
              // 交错增量。
              const streamIndex = responseStreamIndex(item.itemId, outputIndex);
              setFunctionCallArguments(streamIndex, item.arguments ?? '');
              const tc: ToolCall = {
                type: 'function',
                id: functionCallId(item.callId),
                name: requireFunctionCallName(item),
                arguments: item.arguments ?? null,
              };
              if (streamIndex !== undefined) {
                tc._streamIndex = streamIndex;
              }
              yield tc;
            }
            break;
          }
          case 'response.output_item.done': {
            const item = readResponseOutputItem(chunk['item'], `${type}.item`);
            const outputIndex = readNumberField(chunk, 'output_index');
            // 与 output_item.added 相同：`item.id` 不是响应 ID。
            if (item.type === 'reasoning') {
              const thinkPart: StreamedMessagePart = { type: 'think', think: '' };
              if (item.encryptedContent !== undefined) {
                (thinkPart as { encrypted: string }).encrypted = item.encryptedContent;
              }
              yield thinkPart;
            } else if (item.type === 'function_call' && typeof item.arguments === 'string') {
              const streamIndex = responseStreamIndex(item.itemId, outputIndex);
              yield* yieldFinalArgumentsSuffix(streamIndex, item.arguments, type);
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            // `item_id` 唯一标识此增量所属的 function_call 输出项；
            // 将其用作流索引。
            const streamIndex = responseStreamIndex(
              readStringField(chunk, 'item_id'),
              readNumberField(chunk, 'output_index'),
            );
            const argumentsPart = requireStringField(chunk, 'delta', type);
            const part: StreamedMessagePart = {
              type: 'tool_call_part',
              argumentsPart,
            };
            appendFunctionCallArguments(streamIndex, argumentsPart, type);
            if (streamIndex !== undefined) {
              (part as { index: number | string }).index = streamIndex;
            }
            yield part;
            break;
          }
          case 'response.function_call_arguments.done': {
            const functionArguments = requireStringField(chunk, 'arguments', type);
            const streamIndex = responseStreamIndex(
              readStringField(chunk, 'item_id'),
              readNumberField(chunk, 'output_index'),
            );
            yield* yieldFinalArgumentsSuffix(streamIndex, functionArguments, type);
            break;
          }
          case 'response.reasoning_summary_part.added':
            yield { type: 'think', think: '' };
            break;
          case 'response.reasoning_summary_text.delta':
            yield { type: 'think', think: requireStringField(chunk, 'delta', type) };
            break;
          case 'response.completed':
          case 'response.incomplete': {
            const responseObject = requireObjectField(chunk, 'response', type);
            // 最终事件确认 Responses API 的 `response.id`。
            // 优先使用它，以防 API 对其进行了修正。
            const respId = readStringField(responseObject, 'id');
            if (respId !== undefined) {
              this._id = respId;
            }
            const usage = readObjectField(responseObject, 'usage');
            if (usage !== undefined) {
              this._extractUsage(usage);
            }
            this._captureFinishReasonFromResponse(responseObject);
            break;
          }
          case 'error': {
            const message = requireStringField(chunk, 'message', type);
            throw errorFromOpenAIResponsesEvent(
              'OpenAI Responses stream error',
              readNullableStringField(chunk, 'code') ?? null,
              message,
              readNullableStringField(chunk, 'param') ?? null,
            );
          }
          case 'response.failed': {
            const responseObject = requireObjectField(chunk, 'response', type);
            const error = readResponsesFailedResponseError(responseObject);
            if (error !== undefined) {
              throw errorFromOpenAIResponsesEvent(
                'OpenAI Responses response.failed',
                error.code,
                error.message,
                null,
              );
            }
            throw new ChatProviderError(
              `OpenAI Responses response.failed: ${formatResponsesFailedResponse(responseObject)}`,
            );
          }
          default:
            // 未知的未来事件类型不携带我们当前需要消费的数据。
            break;
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }
}
export class OpenAIResponsesChatProvider implements ChatProvider {
  readonly name: string = 'openai-responses';

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _generationKwargs: OpenAIResponsesGenerationKwargs;
  private _toolMessageConversion: ToolMessageConversion;
  private _client: OpenAI | undefined;
  private _httpClient: unknown;
  private _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;

  constructor(options: OpenAIResponsesOptions) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = true; // Responses API 始终支持流式传输
    this._generationKwargs = {};
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;

    if (options.maxOutputTokens !== undefined) {
      this._generationKwargs.max_output_tokens = options.maxOutputTokens;
    }

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
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
    const input: unknown[] = [];

    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      OPENAI_RESPONSES_TOOL_CALL_ID_POLICY,
    );
    input.push(
      ...convertHistoryMessages(normalizedHistory, this._model, this._toolMessageConversion),
    );

    const kwargs: Record<string, unknown> = { ...this._generationKwargs };
    const reasoningEffort = kwargs['reasoning_effort'] as string | undefined;
    delete kwargs['reasoning_effort'];

    if (reasoningEffort !== undefined) {
      kwargs['reasoning'] = {
        effort: reasoningEffort,
        summary: 'auto',
      };
      kwargs['include'] = ['reasoning.encrypted_content'];
    }

    // 移除 undefined 值
    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    try {
      const client = this._createClient(options?.auth);
      const createParams: Record<string, unknown> = {
        model: this._model,
        input,
        tools: tools.map((t) => convertTool(t)),
        store: false,
        stream: this._stream,
        ...kwargs,
      };
      if (systemPrompt) {
        createParams['instructions'] = systemPrompt;
      }

      if (
        !('responses' in client) ||
        typeof (client as { responses?: { create?: unknown } }).responses?.create !== 'function'
      ) {
        throw new Error(
          'OpenAI SDK version does not support Responses API. Upgrade to >=4.x with responses support.',
        );
      }

      const response = await (
        client.responses as {
          create(params: unknown, opts?: unknown): Promise<unknown>;
        }
      ).create(createParams, options?.signal ? { signal: options.signal } : undefined);
      return new OpenAIResponsesStreamedMessage(response, this._stream);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): OpenAIResponsesChatProvider {
    const reasoningEffort = thinkingEffortToReasoningEffort(effort);
    const clone = this._clone();
    clone._generationKwargs = {
      ...clone._generationKwargs,
      reasoning_effort: reasoningEffort,
    };
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAIResponsesGenerationKwargs): OpenAIResponsesChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(maxCompletionTokens: number): OpenAIResponsesChatProvider {
    return this.withGenerationKwargs({ max_output_tokens: maxCompletionTokens });
  }

  private _clone(): OpenAIResponsesChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAIResponsesChatProvider,
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
        this._buildClient(requireProviderApiKey('OpenAIResponsesChatProvider', a, this._apiKey), a),
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

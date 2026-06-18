import * as fs from 'node:fs';
import * as path from 'node:path';
import { Blob, File } from 'node:buffer';

import { ChatProviderError } from '#/errors';
import type { VideoURLPart } from '#/message';
import type { ProviderRequestAuth, VideoUploadInput } from '#/provider';
import type OpenAI from 'openai';
import OpenAIClient from 'openai';

import { convertOpenAIError } from './openai-common';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from './request-auth';

export interface KimiUploadOptions {
  auth?: ProviderRequestAuth;
  signal?: AbortSignal;
}

export interface KimiFilesOptions {
  apiKey?: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

/**
 * Kimi 专用的文件上传客户端。
 *
 * 封装底层 OpenAI 兼容的 `files.create` API，将视频上传至 Moonshot 的文件服务，
 * 并返回适合在聊天消息中使用的 {@link VideoURLPart} 值。
 *
 * `KimiFiles` 实例通常通过 {@link KimiChatProvider.files} 获取。
 */
export class KimiFiles {
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string;
  private readonly _defaultHeaders: Record<string, string> | undefined;
  private readonly _client: OpenAI | undefined;
  private readonly _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;

  constructor(options: KimiFilesOptions) {
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client =
      options.apiKey === undefined || options.apiKey.length === 0
        ? undefined
        : new OpenAIClient({
            apiKey: options.apiKey,
            baseURL: options.baseUrl,
            defaultHeaders: options.defaultHeaders,
          });
  }

  /**
   * 将视频文件上传到 Kimi/Moonshot 以供聊天消息使用。
   *
   * 接受本地文件系统路径或内存中的 {@link VideoUploadInput}。
   * 返回一个 {@link VideoURLPart}，通过 Moonshot 文件 id 引用已上传的文件。
   *
   * @param input - 本地路径字符串或 `{ data, mimeType }` 对象。
   * @returns 一个 `VideoURLPart`，其 `url` 通过 Moonshot 文件 id 引用已上传的文件
   *          （例如 `ms://<file-id>`）。
   * @throws {ChatProviderError} 如果输入不是视频或上传失败。
   */
  async uploadVideo(
    input: string | VideoUploadInput,
    options?: KimiUploadOptions,
  ): Promise<VideoURLPart> {
    let file: unknown;

    if (typeof input === 'string') {
      // 预先验证路径，使调用方能获得清晰的同步式错误，
      // 而不是上传管线返回的通用流错误。
      if (!fs.existsSync(input)) {
        throw new ChatProviderError(`Video file not found: ${input}`);
      }
      const filename = path.basename(input);
      // 根据文件扩展名推断 MIME 类型，并拒绝任何非已知视频类型。
      // 若不做此检查，传入非视频文件（例如 `note.txt`）的调用方仍会请求上传 API，
      // 并收到令人困惑的服务器错误；在此处提前暴露问题可保持 API 契约的严谨性，
      // 并与 `VideoUploadInput` 分支的行为保持一致。
      const mimeType = guessMimeTypeFromExt(filename);
      if (mimeType === undefined || !mimeType.startsWith('video/')) {
        throw new ChatProviderError(
          `KimiFiles.uploadVideo: file extension does not indicate a video type: ${filename}`,
        );
      }
      // 将文件读入内存并包装为 File/Blob。此处避免使用 `fs.createReadStream`，
      // 因为在 `uploadVideo` 返回后若流仍处于打开状态，会与调用方删除源文件的操作产生竞争
      // （在使用临时目录的测试中也很常见）。
      const data = await fs.promises.readFile(input);
      const blob = new Blob([new Uint8Array(data)], { type: mimeType });
      file = new File([blob], filename, { type: mimeType });
    } else {
      if (!input.mimeType.startsWith('video/')) {
        throw new ChatProviderError(`Expected a video mime type, got ${input.mimeType}`);
      }
      const filename = input.filename ?? guessFilename(input.mimeType);
      // OpenAI SDK 的 `Uploadable` 接受类 File 对象。此处通过标准 Web `File` 构造函数
      // 创建（Node 20+ 中可用）。
      // `Blob` 和 `File` 在 Node 20+ 中作为全局对象可用。通过 `Uint8Array` 转换
      // 可在 Node 和 DOM lib 上下文中满足 `BlobPart` 要求。
      const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
      const blob = new Blob([bytes], { type: input.mimeType });
      file = new File([blob], filename, { type: input.mimeType });
    }

    let uploaded: { id: string };
    try {
      const client = this._createClient(options?.auth);
      uploaded = (await client.files.create(
        {
          file: file as never,
          purpose: 'video' as never,
        },
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as { id: string };
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }

    return {
      type: 'video_url',
      videoUrl: {
        url: `ms://${uploaded.id}`,
        id: uploaded.id,
      },
    };
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, a?.headers);
        return new OpenAIClient({
          apiKey: requireProviderApiKey('KimiFiles.uploadVideo', a, this._apiKey),
          baseURL: this._baseUrl,
          defaultHeaders,
        });
      },
    );
  }
}

/**
 * 根据视频 MIME 类型猜测上传文件名。
 * 对于未知类型，回退为 `upload.bin`。
 */
function guessFilename(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType.toLowerCase()] ?? 'bin';
  return `upload.${ext}`;
}

const MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
};

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]),
);

/**
 * 根据文件扩展名猜测 MIME 类型。仅识别 {@link MIME_TO_EXT} 中列出的视频类型；
 * 否则返回 `undefined`。
 */
function guessMimeTypeFromExt(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext];
}

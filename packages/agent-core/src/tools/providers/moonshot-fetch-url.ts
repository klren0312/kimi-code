/**
 * MoonshotFetchURLProvider — 宿主端 UrlFetcher。
 *
 * 流程：
 *   1. 尝试 Moonshot coding-fetch 服务（POST {url}，窄范围 token
 *      提供者的 Bearer 令牌，Accept: text/markdown，宿主提供的 headers）。
 *   2. Moonshot 200 → 将 body 作为 `extracted` 内容返回（服务端已
 *      提取页面主文本）。
 *   3. 任何 Moonshot 失败 ——非 200、网络错误或 token 刷新失败
 *      ——→ 委托给 `localFallback`，转发其内容类型，使 LLM 在
 *      服务不可用时仍能获得结果。
 *   4. 若 localFallback 也抛出异常 → 传播该错误。
 */

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../builtin';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean | undefined }): Promise<string>;
}

export interface MoonshotFetchURLProviderOptions {
  tokenProvider?: BearerTokenProvider;
  apiKey?: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  customHeaders?: Record<string, string>;
  localFallback: UrlFetcher;
  fetchImpl?: typeof fetch;
}

export class MoonshotFetchURLProvider implements UrlFetcher {
  private readonly tokenProvider: BearerTokenProvider | undefined;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly customHeaders: Record<string, string>;
  private readonly localFallback: UrlFetcher;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MoonshotFetchURLProviderOptions) {
    this.tokenProvider = options.tokenProvider;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.customHeaders = options.customHeaders ?? {};
    this.localFallback = options.localFallback;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async fetch(url: string, options?: { toolCallId?: string }): Promise<UrlFetchResult> {
    try {
      const content = await this.fetchViaMoonshot(url, options?.toolCallId);
      // 服务返回的是已从页面提取的文本。
      return { content, kind: 'extracted' };
    } catch {
      // 即使调用方未传入 options，也转发一个显式对象，
      // 使下游消费者始终看到定义的第二个参数。
      return this.localFallback.fetch(url, options ?? {});
    }
  }

  private async fetchViaMoonshot(
    url: string,
    toolCallId: string | undefined,
  ): Promise<string> {
    const bodyJson = JSON.stringify({ url });

    const response = await this.post(bodyJson, toolCallId);

    if (response.status !== 200) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // 忽略 ——状态码本身就足以提供回退路径所需的信息。
      }
      throw new HttpFetchError(
        response.status,
        `Moonshot fetch request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    return response.text();
  }

  private async post(bodyJson: string, toolCallId: string | undefined): Promise<Response> {
    const accessToken = await this.resolveApiKey();
    return this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'text/markdown',
        'Content-Type': 'application/json',
        ...(toolCallId !== undefined && toolCallId.length > 0
          ? { 'X-Msh-Tool-Call-Id': toolCallId }
          : {}),
        ...this.customHeaders,
      },
      body: bodyJson,
    });
  }

  private async resolveApiKey(): Promise<string> {
    if (this.tokenProvider !== undefined) {
      try {
        const token = await this.tokenProvider.getAccessToken();
        if (token.trim().length > 0) {
          return token;
        }
        if (this.apiKey !== undefined && this.apiKey.length > 0) {
          return this.apiKey;
        }
      } catch (error) {
        if (this.apiKey !== undefined && this.apiKey.length > 0) {
          return this.apiKey;
        }
        throw error;
      }
    }
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      return this.apiKey;
    }
    throw new Error('Moonshot fetch service is not configured: missing API key or token provider.');
  }
}

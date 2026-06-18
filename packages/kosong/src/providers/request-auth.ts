import { ChatProviderError } from '#/errors';
import type { ProviderRequestAuth } from '#/provider';

export function requireProviderApiKey(
  providerName: string,
  auth: ProviderRequestAuth | undefined,
  defaultApiKey?: string,
): string {
  const apiKey = auth?.apiKey ?? defaultApiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ChatProviderError(
      `${providerName}: apiKey is required. Provide it via the constructor options, the provider's API-key environment variable, options.auth.apiKey on each request, or an OAuth login.`,
    );
  }
  return apiKey;
}

export function mergeRequestHeaders(
  defaultHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (defaultHeaders !== undefined) {
    Object.assign(merged, defaultHeaders);
  }
  if (requestHeaders !== undefined) {
    Object.assign(merged, requestHeaders);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * 解析单次 provider 请求使用的 SDK 客户端，应用每个 provider 适配器
 * 共享的标准优先级：
 *
 * 1. 如果提供了 `clientFactory`，则委托给它（它接收每次请求的
 *    {@link ProviderRequestAuth}，默认为 `{}`）。
 * 2. 否则，如果不需要按请求鉴权且已缓存了构造时的客户端，
 *    则复用缓存的实例。
 * 3. 否则，调用 `build(auth)` 为本次请求构建一个新客户端——
 *    通常使用 `requireProviderApiKey` 加 `mergeRequestHeaders`。
 *
 * 注意：当提供了按请求的 `auth`（如每次调用前解析的 OAuth bearer token）时，
 * 步骤 3 会被触发，每次请求都会构造一个全新的 SDK 客户端。这是有意为之——
 * 它确保短期凭据不会进入任何长期共享状态，并避免在可变客户端上并发请求的
 * 竞态问题。代价是 SDK 客户端内部的连接池/keep-alive 状态在 OAuth 路径上
 * 无法跨请求复用。对于当前的 agent-CLI 工作负载（每轮步骤一次 LLM 调用），
 * 这完全没问题；如果未来宿主需要高吞吐量的按请求鉴权，显而易见的优化方案
 * 是用一个以 `(apiKey, headers 摘要)` 为键的小型 LRU。
 */
export function resolveAuthBackedClient<TClient>(
  state: {
    readonly cachedClient: TClient | undefined;
    readonly clientFactory: ((auth: ProviderRequestAuth) => TClient) | undefined;
  },
  auth: ProviderRequestAuth | undefined,
  build: (auth: ProviderRequestAuth | undefined) => TClient,
): TClient {
  if (state.clientFactory !== undefined) {
    return state.clientFactory(auth ?? {});
  }
  if (auth === undefined && state.cachedClient !== undefined) {
    return state.cachedClient;
  }
  return build(auth);
}

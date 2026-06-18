/**
 * MCP HTTP 服务器的进程级 OAuth 编排器。
 *
 * 服务为每个服务器/资源拥有一个 {@link McpOAuthClientProvider}，
 * 并调解合成的 `mcp__<server>__authenticate` 工具流程：
 *
 *  1. `getProvider(serverName, serverUrl)` 返回缓存的提供方。
 *     `HttpMcpClient` 将此传递给 `StreamableHTTPClientTransport.authProvider`，
 *     仅在服务器未配置静态 bearer token **且**提供方已存储该服务器 URL 的
 *     token 时——首次连接缺乏 token 时完全跳过提供方，使 401 作为
 *     `UnauthorizedError` 从传输层呈现，而非被进行中的 `auth()` 尝试吞没。
 *  2. `beginAuthorization(serverName, serverUrl)` 启动一次性本地回调监听器，
 *     在提供方上设置重定向 URL，并驱动 SDK `auth()` 编排器向前直到呈现
 *     授权 URL。返回该 URL 加一个 `complete()` 回调，该回调在用户完成
 *     浏览器流程后完成代码交换。
 *  3. `complete()` 成功解析后，提供方已在磁盘上有 token；调用方（合成工具）
 *     驱动管理器级别的 `reconnect` 以将合成工具替换为真实的 MCP 工具。
 */

import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { startCallbackServer, type CallbackServer } from './callback-server';
import { McpOAuthClientProvider } from './provider';
import { JsonFileStore, mcpCredentialsDir, mcpOAuthStoreKey } from './store';

export interface McpOAuthServiceOptions {
  /** 存储后端；提供时覆盖 `kimiHomeDir`。 */
  readonly store?: JsonFileStore;
  /** 解析后的 Kimi home；凭据默认为 `<kimiHomeDir>/credentials/mcp/`。 */
  readonly kimiHomeDir?: string;
  /** 覆盖 DCR `client_name` 中嵌入的标签。 */
  readonly clientLabel?: string;
}

export interface BeginAuthorizationOptions {
  /** 覆盖 DCR 注册请求中嵌入的 `client_name`。 */
  readonly clientLabel?: string;
}

export interface BeginAuthorizationResult {
  /** 用户必须在浏览器中打开的授权 URL。 */
  readonly authorizationUrl: URL;
  /**
   * 等待 OAuth 回调，验证 `state`，用代码交换 token，并通过提供方持久化。
   * 成功时解析；在中止、超时或认证服务器错误时拒绝。
   */
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /**
   * 拆除回调监听器而不完成流程。可安全重复调用；
   * 由 `complete()` 自动调用。
   */
  cancel(): Promise<void>;
}

export class McpOAuthService {
  private readonly store: JsonFileStore;
  private readonly clientLabel: string | undefined;
  private readonly providers = new Map<string, McpOAuthClientProvider>();

  constructor(options: McpOAuthServiceOptions = {}) {
    this.store =
      options.store ??
      new JsonFileStore(
        options.kimiHomeDir === undefined ? undefined : mcpCredentialsDir(options.kimiHomeDir),
      );
    this.clientLabel = options.clientLabel;
  }

  /** 返回 `serverName` + `serverUrl` 的缓存提供方，首次使用时构造。 */
  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = new McpOAuthClientProvider({
        serverName,
        serverUrl,
        store: this.store,
        clientLabel: this.clientLabel,
      });
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  /** 当提供方已为此服务器/资源标识持久化 token 时返回 true。 */
  hasTokens(serverName: string, serverUrl: string | URL): boolean {
    return this.getProvider(serverName, serverUrl).tokens() !== undefined;
  }

  /**
   * 驱动 SDK `auth()` 编排器足够远以呈现授权 URL。调用方负责显示该 URL
   *（通常通过合成认证工具），然后等待 `complete()` 完成代码交换。
   */
  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    const provider = options.clientLabel === undefined
      ? this.getProvider(serverName, serverUrl)
      : new McpOAuthClientProvider({
          serverName,
          serverUrl,
          store: this.store,
          clientLabel: options.clientLabel,
        });
    if (options.clientLabel !== undefined) {
      this.providers.set(provider.storeKey, provider);
    }

    provider.resetFlow();

    let callbackServer: CallbackServer;
    try {
      callbackServer = await startCallbackServer();
    } catch (error) {
      throw wrapAuthError('failed to start OAuth callback listener', error);
    }

    provider.setRedirectUrl(new URL(callbackServer.redirectUri));

    let authorizationUrl: URL | undefined;
    try {
      const result = await auth(provider as OAuthClientProvider, { serverUrl });
      if (result !== 'REDIRECT') {
        // Token 已经有效（如未过期的刷新）。无需操作。
        await callbackServer.close();
        throw new AlreadyAuthorizedError(serverName);
      }
      authorizationUrl = provider.takeAuthorizationUrl();
      if (authorizationUrl === undefined) {
        throw new Error('OAuth provider did not capture an authorization URL');
      }
    } catch (error) {
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
      if (error instanceof AlreadyAuthorizedError) throw error;
      throw wrapAuthError(`failed to start OAuth flow for "${serverName}"`, error);
    }

    let settled = false;
    const cancel = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    const complete: BeginAuthorizationResult['complete'] = async (opts = {}) => {
      if (settled) {
        throw new Error('OAuth flow already completed or cancelled');
      }
      try {
        const { code, state } = await callbackServer.waitForCode({
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        const expectedState = provider.expectedState();
        if (expectedState !== undefined && state !== expectedState) {
          throw new Error('OAuth state mismatch — possible CSRF; refusing token exchange');
        }
        const finalResult = await auth(provider as OAuthClientProvider, {
          serverUrl,
          authorizationCode: code,
        });
        if (finalResult !== 'AUTHORIZED') {
          throw new Error(`OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`);
        }
      } catch (error) {
        await cancel();
        throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
      }
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    return { authorizationUrl, complete, cancel };
  }

  /**
   * 清除服务器的已存储凭据。使用 `'all'` 在用户显式退出登录后；
   * 使用 `'tokens'` 强制重新认证同时保留注册的 DCR 客户端。
   */
  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): void {
    this.getProvider(serverName, serverUrl).invalidateCredentials(scope);
  }
}

/** 当已存储的 token 已满足服务器要求时由 `beginAuthorization` 抛出。 */
export class AlreadyAuthorizedError extends Error {
  constructor(serverName: string) {
    super(`"${serverName}" is already authorized; no browser flow needed`);
    this.name = 'AlreadyAuthorizedError';
  }
}

function wrapAuthError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    const wrapped = new Error(`${prefix}: ${error.message}`);
    wrapped.cause = error;
    return wrapped;
  }
  return new Error(`${prefix}: ${String(error)}`);
}

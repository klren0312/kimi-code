/**
 * 由每个 MCP 服务器的 JSON 文件支持的 `OAuthClientProvider` 实现。
 *
 * 每个服务器/资源标识一个提供方实例。该提供方：
 *  - 将 OAuth token、注册的 DCR 客户端信息和发现状态持久化到
 *    `<KIMI_CODE_HOME>/credentials/mcp/<key>-*.json`
 *   （模式 0600；默认 home 为 `~/.kimi-code`）。
 *  - 当 SDK 调用 `redirectToAuthorization` 时捕获授权 URL——
 *    {@link McpOAuthService} 在第一次 `auth()` 调用返回 `'REDIRECT'` 后
 *    读取该字段。
 *  - 在内存中保存 PKCE 验证器和 OAuth `state`（每个提供方同一时间
 *    只有一个流程；调用方通过服务串行化）。
 *
 * 提供方**不**打开浏览器或运行服务器。服务是编排器；
 * 提供方是持久化 + 流程状态垫片。
 */

import { randomBytes } from 'node:crypto';

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { JsonFileStore, canonicalMcpOAuthResource, mcpOAuthStoreKey } from './store';

const TOKENS_SUFFIX = '-tokens.json';
const CLIENT_SUFFIX = '-client.json';
const DISCOVERY_SUFFIX = '-discovery.json';
// 仅在 SDK 在正常传输启动期间探测认证且没有活跃的回调监听器时使用。
// 交互式登录用真实 URL 覆盖它。
const PASSIVE_REDIRECT_URI = 'http://127.0.0.1:3118/callback';

export interface McpOAuthProviderOptions {
  /** MCP 服务器的友好名称；用于 DCR `client_name`。 */
  readonly serverName: string;
  /** 用于隔离此服务器条目凭据的规范资源标识。 */
  readonly serverUrl: string | URL;
  /** 用于持久化的 JSON 存储。测试注入内存目录。 */
  readonly store: JsonFileStore;
  /** 嵌入 DCR `client_name` 的标识（"kimi-code (server)"）。 */
  readonly clientLabel?: string;
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  readonly storeKey: string;
  readonly serverUrl: string;
  private readonly store: JsonFileStore;
  private readonly clientLabel: string;
  private _redirectUrl: URL | undefined;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _lastAuthorizationUrl: URL | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.store = options.store;
    this.clientLabel = options.clientLabel ?? `kimi-code (${options.serverName})`;
  }

  // ── 流程作用域状态，由 McpOAuthService 在调用 auth() 前设置 ────

  setRedirectUrl(url: URL): void {
    this._redirectUrl = url;
  }

  /** 从最近一次 `redirectToAuthorization` 调用捕获的 URL。 */
  takeAuthorizationUrl(): URL | undefined {
    const url = this._lastAuthorizationUrl;
    this._lastAuthorizationUrl = undefined;
    return url;
  }

  /** 为最近一次流程生成的 OAuth `state` 值，用于回调验证。 */
  expectedState(): string | undefined {
    return this._state;
  }

  resetFlow(): void {
    this._redirectUrl = undefined;
    this._codeVerifier = undefined;
    this._state = undefined;
    this._lastAuthorizationUrl = undefined;
  }

  // ── OAuthClientProvider ─────────────────────────────────────────────────

  get redirectUrl(): string | URL {
    return this.effectiveRedirectUri();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.effectiveRedirectUri()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.clientLabel,
    };
  }

  state(): string {
    this._state ??= randomBytes(16).toString('hex');
    return this._state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.read<OAuthClientInformationFull>(`${this.storeKey}${CLIENT_SUFFIX}`);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.write(`${this.storeKey}${CLIENT_SUFFIX}`, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read<OAuthTokens>(`${this.storeKey}${TOKENS_SUFFIX}`);
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.write(`${this.storeKey}${TOKENS_SUFFIX}`, tokens);
  }

  redirectToAuthorization(url: URL): void {
    // 为编排器捕获 URL 而非实际打开浏览器。合成认证工具将其呈现给模型，
    // 以便用户可以按自己的节奏完成流程。
    this._lastAuthorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new Error('McpOAuthClientProvider: PKCE code verifier not initialized');
    }
    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.write(`${this.storeKey}${DISCOVERY_SUFFIX}`, state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.read<OAuthDiscoveryState>(`${this.storeKey}${DISCOVERY_SUFFIX}`);
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') {
      this._codeVerifier = undefined;
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      this.store.remove(`${this.storeKey}${TOKENS_SUFFIX}`);
    }
    if (scope === 'client' || scope === 'all') {
      this.store.remove(`${this.storeKey}${CLIENT_SUFFIX}`);
    }
    if (scope === 'discovery' || scope === 'all') {
      this.store.remove(`${this.storeKey}${DISCOVERY_SUFFIX}`);
    }
    if (scope === 'all') {
      this._codeVerifier = undefined;
    }
  }

  private effectiveRedirectUri(): string {
    if (this._redirectUrl !== undefined) {
      return this._redirectUrl.toString();
    }
    const registered = registeredRedirectUri(this.clientInformation());
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !('redirect_uris' in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}

/** `AuthSummaryService` — `IAuthSummaryService` 的实现。 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { KimiConfig } from '../../config';
import type { AuthSummary } from '@moonshot-ai/protocol';
import { createManagedAuthFacade, type ServicesAuthFacade } from '../auth/managedAuth';
import { IEnvironmentService } from '../environment/environment';
import { ICoreProcessService } from '../coreProcess/coreProcess';
import {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthModelNotResolvedError,
} from './authSummary';

/** OAuth 托管 provider 的线路名称（`@moonshot-ai/kimi-code-oauth` 的 `KIMI_CODE_PROVIDER_NAME`）。 */
const MANAGED_PROVIDER_NAME = 'managed:kimi-code';

export class AuthSummaryService
  extends Disposable
  implements IAuthSummaryService {
  readonly _serviceBrand: undefined;

  private readonly _authFacade: ServicesAuthFacade;

  constructor(
    @IEnvironmentService private readonly env: IEnvironmentService,
    @ICoreProcessService private readonly core: ICoreProcessService,
  ) {
    super();
    this._authFacade = createManagedAuthFacade(env);
  }

  async get(): Promise<AuthSummary> {
    const config = await this._readConfig();
    const providers = config.providers ?? {};
    const providers_count = Object.keys(providers).length;
    const default_model = nonEmpty(config.defaultModel);

    let managed_provider: AuthSummary['managed_provider'] = null;
    if (providers[MANAGED_PROVIDER_NAME] !== undefined) {
      const hasToken = await this._hasCachedToken(MANAGED_PROVIDER_NAME);
      managed_provider = {
        name: MANAGED_PROVIDER_NAME,
        status: hasToken ? 'authenticated' : 'unauthenticated',
      };
    }

    const ready =
      providers_count >= 1 &&
      default_model !== null &&
      (managed_provider === null || managed_provider.status !== 'revoked');

    return { ready, providers_count, default_model, managed_provider };
  }

  async ensureReady(modelOverride?: string): Promise<void> {
    const config = await this._readConfig();
    const providers = config.providers ?? {};
    if (Object.keys(providers).length === 0) {
      throw new AuthProvisioningRequiredError();
    }

    const modelId = modelOverride ?? config.defaultModel;
    if (modelId === undefined || modelId === '') {
      throw new AuthModelNotResolvedError(undefined);
    }

    const alias = config.models?.[modelId];
    if (alias === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const providerName = alias.provider ?? config.defaultProvider;
    if (providerName === undefined || providerName === '') {
      throw new AuthModelNotResolvedError(modelId);
    }

    const providerConfig = providers[providerName];
    if (providerConfig === undefined) {
      throw new AuthModelNotResolvedError(modelId, providerName);
    }

    // 凭据存在性检查：api_key（配置或环境变量），或缓存的 OAuth token。
    // 此处有意不探测实时 OAuth 刷新 — 该路径是响应式的。仅做静态门控。
    const hasInlineKey = nonEmpty(providerConfig.apiKey) !== null;
    if (hasInlineKey) return;

    if (providerConfig.oauth !== undefined) {
      const hasToken = await this._hasCachedToken(providerName);
      if (hasToken) return;
      throw new AuthTokenMissingError(providerName);
    }

    // 没有内联 key，没有 oauth 引用。仍可能是通过环境变量提供的 key —
    // 在最小可用版本中做保守门控；使用环境变量 key 的调用方可在配置中设置
    // apiKey="${VAR}" 来绕过。40111 的验收测试 fixture 使用"无 api_key 的
    // 手动 provider"，会走到此处。
    throw new AuthTokenMissingError(providerName);
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }

  /* ----------------------------- 内部方法 ---------------------------- */

  private async _readConfig(): Promise<KimiConfig> {
    // `reload: true` 强制 KimiCore 在返回前重新从磁盘读取 `config.toml`。
    // 对认证探针路径至关重要：`OAuthService`（工具包的 provisioning）和
    // `IProviderService` 未来的 RW 端点通过 `writeConfigFile` 写入磁盘，
    // 但 KimiCore 的 `this.config` 仅在有东西明确请求 `reload` 时才刷新。
    // 若无此标志，`GET /v1/auth` 在首次登录后的整个 daemon 生命周期内
    // 都会保持 `ready:false`。
    return this.core.rpc.getKimiConfig({ reload: true });
  }

  private async _hasCachedToken(providerName: string): Promise<boolean> {
    try {
      const token = await this._authFacade.getCachedAccessToken(providerName);
      return typeof token === 'string' && token.trim().length > 0;
    } catch {
      // FileTokenStorage 在凭据目录或文件不可读时抛出异常；
      // 将任何失败视为"无 token"，使调用方不会因临时文件系统错误而阻塞。
      return false;
    }
  }
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// 在全局单例注册表中自注册。所有构造函数依赖通过
// `@I…` 注入（@IEnvironmentService / @ICoreProcessService）；
// `staticArguments = []`。`supportsDelayedInstantiation = false` 保留
// 当前反向释放语义。
registerSingleton(IAuthSummaryService, AuthSummaryService, InstantiationType.Delayed);

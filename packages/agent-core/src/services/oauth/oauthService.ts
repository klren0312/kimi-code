/**
 * `OAuthService` — `IOAuthService` 的实现。
 */

import { Disposable, DisposableMap, InstantiationType, registerSingleton } from '../../di';
import type { IDisposable } from '../../di';
import {
  DeviceCodeTimeoutError,
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  type DeviceAuthorization,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthFlowStatus,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';
import { ulid } from 'ulid';

import { createManagedAuthFacade, type ServicesAuthFacade } from '../auth/managedAuth';
import { IEnvironmentService } from '../environment/environment';
import { IOAuthService } from './oauth';

/**
 * 一次进行中（或最近完成的）设备码流程。存储在 `OAuthService._flows`
 *（`DisposableMap`）中，因此：
 *   - `_flows.set(provider, newState)` 自动 dispose 被取代者
 *   - `_flows.deleteAndDispose(provider)`（从 GC 定时器调用）清理终态条目的残留状态
 *   - 服务级 `super.dispose()` 遍历每个条目的 `dispose()`，而非旧的
 *     `override dispose()` 中手写的 for 循环。
 *
 * `dispose()` 是幂等的，仅在流程仍在 pending 时中止控制器——终态流程已从底层
 * promise 返回，再次中止只会产生无意义的空操作。
 */
class FlowState implements IDisposable {
  status: OAuthFlowStatus = 'pending';
  resolvedAt?: number;
  errorMessage?: string;
  gcTimer?: NodeJS.Timeout;
  private _disposed = false;

  constructor(
    readonly flowId: string,
    readonly provider: string,
    readonly deviceAuth: DeviceAuthorization,
    /** 解析后的剩余秒数（可能与 `deviceAuth.expiresIn` 不同，如果其为 null）。 */
    readonly expiresInSec: number,
    readonly startedAt: number,
    readonly expiresAt: number,
    readonly controller: AbortController,
  ) {}

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.gcTimer !== undefined) {
      clearTimeout(this.gcTimer);
      this.gcTimer = undefined;
    }
    if (this.status === 'pending') {
      try {
        this.controller.abort();
      } catch {
        // 忽略
      }
    }
  }
}

/** 终态流程在 GC 前的保留时间。 */
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

export class OAuthService extends Disposable implements IOAuthService {
  readonly _serviceBrand: undefined;

  private readonly _authFacade: ServicesAuthFacade;
  private readonly _flows: DisposableMap<string, FlowState>;

  constructor(@IEnvironmentService private readonly env: IEnvironmentService) {
    super();
    this._flows = this._register(new DisposableMap<string, FlowState>());
    this._authFacade = createManagedAuthFacade(env);
  }

  /** @internal 仅测试用工厂方法，注入 mock facade。 */
  static _createForTest(env: IEnvironmentService, facade: ServicesAuthFacade): OAuthService {
    const svc = new (OAuthService as any)(env) as OAuthService;
    (svc as any)._authFacade = facade;
    return svc;
  }

  async startLogin(providerName?: string): Promise<OAuthFlowStart> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;

    // 取代任何现有的待处理流程。
    const existing = this._flows.get(name);
    if (existing !== undefined && existing.status === 'pending') {
      existing.controller.abort();
      this._setTerminal(existing, 'cancelled');
    }

    const flowId = `oauth_${ulid()}`;
    const controller = new AbortController();

    // 通过 deferred 捕获设备授权信息。managed auth facade 恰好调用一次
    // `onDeviceCode`，然后开始轮询。我们在回调内部 resolve deferred，
    // 以便此方法在 URL 已知时即可返回——远早于轮询完成。
    let resolveAuth: (d: DeviceAuthorization) => void;
    let rejectAuth: (e: unknown) => void;
    const authPromise = new Promise<DeviceAuthorization>((resolve, reject) => {
      resolveAuth = resolve;
      rejectAuth = reject;
    });

    // 后台登录——不要 await。传入控制器的 signal，以便 `cancelLogin()`
    // 和取代路径能在轮询中途中断。
    const loginPromise = this._authFacade.login(name, {
      signal: controller.signal,
      onDeviceCode: (auth) => {
        resolveAuth(auth);
      },
    });

    // 捕获同步失败（设备授权请求本身在 `onDeviceCode` 触发前失败）
    // 通过竞态登录 promise。
    loginPromise.catch((err) => {
      rejectAuth(err);
    });

    let deviceAuth: DeviceAuthorization;
    try {
      deviceAuth = await authPromise;
    } catch (err) {
      // OAuth 主机或网络在获取设备码之前出错。
      // 此时尚未注册流程状态；直接向 REST 处理器报告错误 → 50001。
      const msg = err instanceof Error ? err.message : String(err);
      throw new OAuthError(`failed to start device flow: ${msg}`);
    }

    const startedAt = Date.now();
    // `expiresIn` 是服务端报告的，可能为 null（RFC 8628 §3.2 允许省略）。
    // 回退到 `OAuthManager.login` 强制执行的本地 15 分钟预算，
    // 以确保我们向客户端展示的 `expires_at` 不会超过实际截止时间。
    const expiresInSec = deviceAuth.expiresIn ?? 15 * 60;
    const state = new FlowState(
      flowId,
      name,
      deviceAuth,
      expiresInSec,
      startedAt,
      startedAt + expiresInSec * 1000,
      controller,
    );
    this._flows.set(name, state);

    // 连接后台 promise 的终态转换。根据错误类 + 消息进行分支——映射关系见文件头。
    loginPromise.then(
      () => this._handleSuccess(state),
      (err) => this._handleFailure(state, err),
    );

    return {
      flow_id: flowId,
      provider: name,
      verification_uri: deviceAuth.verificationUri,
      verification_uri_complete: deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri,
      user_code: deviceAuth.userCode,
      expires_in: expiresInSec,
      interval: deviceAuth.interval,
      status: 'pending',
      expires_at: new Date(state.expiresAt).toISOString(),
    };
  }

  getFlow(providerName?: string): OAuthFlowSnapshot | undefined {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const state = this._flows.get(name);
    if (state === undefined) return undefined;
    return this._toSnapshot(state);
  }

  async cancelLogin(providerName?: string): Promise<OAuthLoginCancelResponse> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const state = this._flows.get(name);
    if (state === undefined) {
      // 完全没有流程 → 视为"已取消"（幂等）。
      return { cancelled: false, status: 'cancelled' };
    }
    if (state.status !== 'pending') {
      return { cancelled: false, status: state.status };
    }
    state.controller.abort();
    this._setTerminal(state, 'cancelled');
    return { cancelled: true, status: 'cancelled' };
  }

  async logout(providerName?: string): Promise<OAuthLogoutResponse> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    // 同时取消任何进行中的流程，使下一次 `GET /v1/auth` 看到干净的状态。
    const pending = this._flows.get(name);
    if (pending !== undefined && pending.status === 'pending') {
      pending.controller.abort();
      this._setTerminal(pending, 'cancelled');
    }
    const result = await this._authFacade.logout(name);
    return { logged_out: true, provider: result.providerName };
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }

  /* ----------------------------- 内部实现 ---------------------------- */

  private _handleSuccess(state: FlowState): void {
    if (state.status !== 'pending') return; // 已取消/已被取代
    this._setTerminal(state, 'authenticated');
  }

  private _handleFailure(state: FlowState, err: unknown): void {
    if (state.status !== 'pending') return; // 已取消/已被取代

    const status = classifyFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    state.errorMessage = message;
    this._setTerminal(state, status);
  }

  private _setTerminal(state: FlowState, status: OAuthFlowStatus): void {
    if (state.status === status) return;
    state.status = status;
    state.resolvedAt = Date.now();
    // 调度 GC。如果新流程先取代此条目，取代路径执行 `_flows.set(name, newState)`
    // 会自动 dispose 此条目——其 `dispose()` 在定时器触发前清除 `gcTimer`，
    // 因此回调可以依赖"此状态仍是当前映射条目"，无需相等性检查。
    if (state.gcTimer !== undefined) clearTimeout(state.gcTimer);
    state.gcTimer = setTimeout(() => {
      const current = this._flows.get(state.provider);
      // 双保险：即使 dispose() 在覆盖时清除了定时器，仍保留身份检查，
      // 以防定时器在 clearTimeout 生效前已入队。
      if (current === state) this._flows.deleteAndDispose(state.provider);
    }, TERMINAL_RETENTION_MS);
    // 不要仅为 GC 保持进程存活。
    state.gcTimer.unref?.();
  }

  private _toSnapshot(state: FlowState): OAuthFlowSnapshot {
    const snap: OAuthFlowSnapshot = {
      flow_id: state.flowId,
      provider: state.provider,
      status: state.status,
      verification_uri: state.deviceAuth.verificationUri,
      verification_uri_complete:
        state.deviceAuth.verificationUriComplete ?? state.deviceAuth.verificationUri,
      user_code: state.deviceAuth.userCode,
      expires_in: state.expiresInSec,
      expires_at: new Date(state.expiresAt).toISOString(),
      interval: state.deviceAuth.interval,
    };
    if (state.resolvedAt !== undefined) {
      (snap as { resolved_at?: string }).resolved_at = new Date(
        state.resolvedAt,
      ).toISOString();
    }
    if (state.errorMessage !== undefined) {
      (snap as { error_message?: string }).error_message = state.errorMessage;
    }
    return snap;
  }
}

/**
 * 将后台登录 promise 抛出的错误映射为终态。
 *
 * - `DeviceCodeTimeoutError` → 'expired'（15 分钟预算耗尽）
 * - `OAuthError` 消息以 'Login aborted' 开头 → 'cancelled'
 *  （我们自己的 AbortController 触发或工具包的 signal 路径）
 * - `OAuthError` 消息包含 'denied' → 'denied'（用户拒绝）
 * - 其他 → 'denied'（合并"拒绝"和"通用失败"；`error_message` 字段携带诊断详情供 UI 使用）
 */
function classifyFailure(err: unknown): OAuthFlowStatus {
  if (err instanceof DeviceCodeTimeoutError) return 'expired';
  if (err instanceof OAuthError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('aborted')) return 'cancelled';
    if (msg.includes('denied')) return 'denied';
    return 'denied';
  }
  return 'denied';
}

// 在全局单例注册表中自行注册。所有构造函数依赖均通过 `@I…` 注入
//（仅 @IEnvironmentService）；`staticArguments = []`。
// `supportsDelayedInstantiation = false` 保持当前的反向 dispose 语义。
registerSingleton(IOAuthService, OAuthService, InstantiationType.Delayed);

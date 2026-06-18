/**
 * `CoreProcessService` — `ICoreProcessService` 的实现。
 */

import { createRPC, KimiCore } from '../../rpc';
import { Disposable, registerSingleton, SyncDescriptor } from '../../di';
import type { CoreAPI, CoreRPC, SDKAPI } from '../../rpc';
import type { OAuthTokenProviderResolver } from '../../session/provider-manager';
import {
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';

import { createManagedAuthFacade } from '../auth/managedAuth';
import { BridgeClientAPI } from './coreProcessClient';
import { IApprovalService } from '../approval/approval';
import { IEnvironmentService } from '../environment/environment';
import { IEventService } from '../event/event';
import { ILogService } from '../logger/logger';
import { IQuestionService } from '../question/question';
import { ICoreProcessService, type CoreProcessServiceOptions } from './coreProcess';

export class CoreProcessService extends Disposable implements ICoreProcessService {
  readonly _serviceBrand: undefined;

  /**
   * 面向服务的 RPC 句柄。这是对已 resolve 的 `RPCMethods<CoreAPI>` 的 `Proxy`，
   * 使调用方无需自行 await 一个 promise — `core.rpc.createSession({...})`
   * 直接返回 `Promise<SessionSummary>`。dispose 后，代理上的每个方法调用都会 reject。
   */
  public readonly rpc: CoreRPC;

  /**
   * 进程内的 `KimiCore` 实例。保持私有，使 daemon 侧代码无法获取它
   * 并绕过对等服务间接层。
   */
  private readonly _core: KimiCore;

  /**
   * 解析为已解析 RPC 方法的 promise。`rpc` 代理在每次分发时 await 此值
   *（开销低 — 受控 promise 在第二次调用时同步 resolve）。
   */
  private readonly _coreRpcPromise: Promise<CoreRPC>;

  /**
   * 缓存的就绪信号。当前以"SDK 侧 RPC 已绑定"作为就绪标记；
   * 当 `KimiCore.pluginsReady` 公开暴露后，可在此处组合它们。
   */
  private readonly _ready: Promise<void>;

  constructor(
    options: CoreProcessServiceOptions,
    @IEnvironmentService env: IEnvironmentService,
    @IEventService eventService: IEventService,
    @IApprovalService approvalService: IApprovalService,
    @IQuestionService questionService: IQuestionService,
    @ILogService logService: ILogService,
  ) {
    super();

    // 1. 构建进程内 RPC 对。Left/Right 有类型约束；`coreRpc` 是 KimiCore
    //    接收的函数，`sdkRpc` 是我们满足的一侧。
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();

    // 默认接入 OAuth token 解析器。不设此项的话，KimiCore 的
    // `ProviderManager.resolveAuth` 看到 `resolveOAuthTokenProvider === undefined`
    // 会合成一个始终抛出 `AUTH_LOGIN_REQUIRED` 的闭包 — 即使成功的
    // device-code 登录已将新 token 持久化到磁盘。daemon 的 `/auth` 就绪探针
    // 是不同的代码路径（凭据存储的文件存在性检查），因此仍显示绿色；
    // 故障仅在 prompt 轮次内部暴露，表现为 `turn.step.started` 之后的
    // `auth.login_required` 错误。我们通过使用与 KimiCore 相同的
    // home + config 路径默认构造一个托管认证 facade，并将其
    // `resolveOAuthTokenProvider` 传入核心来弥合此差距。调用方
    //（例如 node-sdk 测试）仍可通过 `options.resolveOAuthTokenProvider` 覆盖。
    const resolveOAuthTokenProvider: OAuthTokenProviderResolver =
      options.resolveOAuthTokenProvider ??
      CoreProcessService._defaultOAuthTokenResolver(env.homeDir, env.configPath);

    // 默认接入 Kimi 请求头（User-Agent + X-Msh-* 设备标识）。不设此项的话，
    // KimiCore 的出站 fetch 携带默认的 Node fetch User-Agent，托管
    // Kimi-for-Coding 端点会以 40340（"仅适用于 Coding Agents
    // 如 Kimi CLI、Claude Code、…"）拒绝。与 `SDKRpcClient` 为进程内 TUI 路径
    //（node-sdk 的 sdk-rpc-client.ts）所做的接线方式一致。
    // 调用方提供的 `kimiRequestHeaders` 始终优先；缺失时从 `options.identity`
    // 合成。两者都不传（无 identity、无 headers）的宿主仍可构造 —
    // 但其请求会触发 40340 门控。
    const kimiRequestHeaders: Record<string, string> | undefined =
      options.kimiRequestHeaders ??
      CoreProcessService._defaultKimiRequestHeaders(env.homeDir, options.identity);

    // `appVersion` 写入 Session 记录（`app_version`）和工具调用上下文。
    // 优先显式值 > identity.version，使调用方在需要时可指定不同的值。
    const appVersion: string | undefined =
      options.appVersion ?? options.identity?.version;

    // 2. 构造核心。KimiCore 的构造函数将自身接入 `coreRpc` 并暴露
    //    `this.sdk: Promise<SDKRPC>` 用于反向通信。
    this._core = new KimiCore(coreRpc, {
      ...options,
      homeDir: env.homeDir,
      configPath: env.configPath,
      kimiRequestHeaders,
      appVersion,
      resolveOAuthTokenProvider,
    });

    // 3. 使用路由到对等服务的 BridgeClientAPI 满足 SDK 侧。
    //    sdkRpc 返回 Promise<RPCMethods<CoreAPI>> — 这些是包内服务
    //    将在其上进行分发的方法。
    const clientApi = new BridgeClientAPI({
      eventService,
      approvalService,
      questionService,
      logService,
    });
    this._coreRpcPromise = sdkRpc(clientApi);

    // 4. 就绪条件是"RPC 对两侧均已绑定"。插件加载在 KimiCore 的构造函数内
    //    进行且会自愈（worker 捕获错误而非暴露；参见 core-impl.ts:170-172）。
    this._ready = this._coreRpcPromise.then(() => undefined);

    // 5. 构建分发代理。代理上的每个方法先 await 已解析的 RPC 方法再转发。
    //    dispose 后，分发会立即 reject。
    this.rpc = this._buildRpcProxy();
  }

  async ready(): Promise<void> {
    return this._ready;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    // KimiCore 当前未暴露 dispose() — 当它有时，会在 super.dispose() 之前
    // await/调用它。目前，释放服务会翻转 _disposed 标志，使未来的 rpc.* 调用
    // 在到达 KimiCore 之前 reject。
    super.dispose();
  }

  private _buildRpcProxy(): CoreRPC {
    const rpcPromise = this._coreRpcPromise;
    const isDisposedRef = () => this._store.isDisposed;

    // 此处在编译时不知道具体的方法集（CoreAPI 是结构化接口；
    // `RPCMethods<CoreAPI>` 是映射类型）。Proxy 让我们拦截每个属性访问
    // 并返回一个 await 底层 RPC 后转发的函数。
    return new Proxy({} as CoreRPC, {
      get(_target, prop) {
        // Symbol / 内置属性（Symbol.toPrimitive、then-able 探测等）
        // 不应被 RPC 分发。
        if (typeof prop !== 'string') return undefined;
        // 返回函数保持 `typeof rpc.foo === 'function'` 为真，
        // 下游代码可能会探测此属性。
        return (...args: unknown[]) => {
          if (isDisposedRef()) {
            return Promise.reject(new Error('CoreProcessService has been disposed'));
          }
          return rpcPromise.then((methods) => {
            const fn = (methods as unknown as Record<string, unknown>)[prop];
            if (typeof fn !== 'function') {
              return Promise.reject(
                new Error(`CoreProcessService.rpc.${prop} is not a function`),
              );
            }
            return (fn as (...args: unknown[]) => unknown)(...args);
          });
        };
      },
    });
  }

  /**
   * 从与 KimiCore 内部解析的相同 home + config 路径构建默认的
   * `resolveOAuthTokenProvider`。与 `SDKRpcClient` 在
   * `packages/node-sdk/src/sdk-rpc-client.ts` 中的默认值一致，
   * 使 daemon 和 SDK 运行时在都使用同一个 `~/.kimi-code` 时共享 OAuth 凭据。
   *
   * 以 `static` 暴露，使测试无需运行完整的 agent-core 轮次即可验证接线。
   */
  static _defaultOAuthTokenResolver(
    homeDir: string,
    configPath: string,
  ): OAuthTokenProviderResolver {
    const facade = createManagedAuthFacade({ homeDir, configPath });
    return facade.resolveOAuthTokenProvider;
  }

  /**
   * 从 `options.identity` 构建默认的 `kimiRequestHeaders`，使出站
   * `User-Agent` + 设备标识头将此进程标识为真正的 Coding Agent 宿主
   *（例如 `kimi-code-cli/<ver>`）。不设这些头的话，托管 Kimi-for-Coding
   * 端点会以 40340 拒绝。
   *
   * 未提供 identity 时返回 `undefined` — 为通过 `options.kimiRequestHeaders`
   * 显式传入头的宿主保留先前约定（或完全不与托管端点通信的遗留调用方/测试）。
   *
   * `homeDir` 解析与 KimiCore 一致，使每个设备的 id（首次调用时在
   * `<homeDir>/device_id` 处铸造并缓存）位于 KimiCore 触及的所有内容的
   * 相同根目录下。
   *
   * 以 `static` 暴露，使测试无需启动服务即可验证接线。
   */
  static _defaultKimiRequestHeaders(
    homeDir: string,
    identity?: KimiHostIdentity,
  ): Record<string, string> | undefined {
    if (identity === undefined) return undefined;
    return createKimiDefaultHeaders({
      homeDir,
      ...identity,
    });
  }
}

// 在全局单例注册表中自注册。构造函数签名为
// `(options, @IEnvironmentService, @IEventService, @IApprovalService,
//  @IQuestionService, @ILogService)` — 首位 `options` 槽是纯数据包，
// 因此使用 `[{}]` 作为合理默认值注册。daemon 侧的 `start.ts` 通过
// `services.set(ICoreProcessService, new SyncDescriptor(CoreProcessService,
// [opts.coreProcessOptions ?? {}], false))` 覆盖此描述符。
// 后注册的优先 — 在注册表级别和 `ServiceCollection` 级别均如此。
// `supportsDelayedInstantiation = false` 保留当前反向释放语义。
registerSingleton(
  ICoreProcessService,
  new SyncDescriptor(CoreProcessService, [{} as CoreProcessServiceOptions], false),
);

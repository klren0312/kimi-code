/**
 * `CoreProcessService` — services 包拥有的进程内 RPC 适配器。内部流程：
 *
 *   1. `createRPC<CoreAPI, SDKAPI>()` 生成一对 `[coreRpc, sdkRpc]`
 *      `RPCClient` 函数（packages/agent-core/src/rpc/client.ts:31-103）。
 *   2. `new KimiCore(coreRpc, options)` — 使用 core 侧 RPC 客户端构造核心
 *     （通过 `coreRpc` 调用 SDK 侧）。
 *   3. `sdkRpc(new BridgeClientAPI({ ... }))` — 使用一个 `BridgeClientAPI`
 *      实例满足 RPC 对的 SDK 侧，其 `SDKAPI` 方法路由到 DI 解析的对等服务。
 *      返回 `Promise<RPCMethods<CoreAPI>>` — 下游服务（`SessionService`、
 *      `PromptService`、…）通过下方的代理进行分发的 core RPC 方法。
 *
 * 结果被包装为一个小型 `SDKRpcClient` 形状的代理，使服务实现获得 SDK 风格的
 * RPC 人机工程。该代理作为 `rpc` 暴露给包内消费者；公共包 barrel 不会
 * 重新导出 `SDKRpcClientBase`，因此 daemon 侧代码保持一个抽象层的距离。
 *
 * 生命周期：
 *   - `ready()` 在 `KimiCore` 插件/配置加载和 SDK 侧 RPC 绑定都完成后 resolve。
 *     构造是急切的（Singleton 模式）；等待 `ready()` 是发起 RPC 调用前的安全门控。
 *   - `dispose()` 是幂等的。翻转内部标志使未来的 `rpc` 方法分发在到达 `KimiCore`
 *     之前抛出，然后遍历 `Disposable` 子栈。`KimiCore` 自身目前没有 `dispose()` —
 *     当它有时，会在此处接入。
 *
 * 角色：跨进程适配器 — 参见 `packages/services/AGENTS.md`。
 */

import { createDecorator } from '../../di';
import type { CoreRPC, KimiCoreOptions } from '../../rpc';
import { type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

export interface CoreProcessServiceOptions extends KimiCoreOptions {
  /**
   * 宿主机身份标识（产品名 + 版本）。设置且 `kimiRequestHeaders` 未提供时，
   * 适配器默认将 `createKimiDefaultHeaders({ homeDir, ...identity })` 接入 KimiCore，
   * 使上游看到 `User-Agent: <product>/<version>` + `X-Msh-Platform: …`。
   * 不设此项的话，托管 Kimi-for-Coding 端点会因默认 fetch User-Agent
   * 不匹配任何已知 coding-agent 产品而返回 40340（"仅适用于 Coding Agents"）。
   *
   * `identity.version` 同时用于 `appVersion`，使 session 记录携带宿主
   * CLI 版本 — 与 node-sdk 中 `SDKRpcClient` 的接线方式相同。
   *
   * 调用方仍可传入显式 `kimiRequestHeaders`（或 `appVersion`）来覆盖；
   * 显式值优先。
   */
  readonly identity?: KimiHostIdentity;
}

export interface ICoreProcessService {
  readonly _serviceBrand: undefined;

  /** Core RPC 方法。服务实现通过 `core.rpc.createSession(...)` 等方式调用。 */
  readonly rpc: CoreRPC;

  /**
   * 在 `KimiCore` 完全构造且进程内 RPC 的 SDK 侧绑定完成后 resolve。
   * 重复调用返回缓存的 promise。
   */
  ready(): Promise<void>;

  /**
   * 拆卸适配器。dispose 后，`rpc.<method>(...)` 在到达 `KimiCore` 之前
   * 以 "core process disposed" 错误 reject。幂等操作。
   */
  dispose(): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ICoreProcessService = createDecorator<ICoreProcessService>('coreProcessService');

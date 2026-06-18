/**
 * `IOAuthService` — 面向守护进程的设备码登录编排。
 *
 * 将 OAuth 工具包的 `login({onDeviceCode})` 回调形状桥接为 REST 资源：
 * 前端 POST 启动、同步获取 `verification_uri`、然后轮询 GET 端点
 * 获取状态转换，同时守护进程在后台轮询 OAuth 主机。
 *
 * **每个 provider 一次进行中的流程**。第二次启动会先取消现有待处理流程
 *（将其转为 `'cancelled'`），然后生成新的 `flow_id`。已完成的流程在内存中
 * 保留 5 分钟，使前端最后一次轮询能到达终态；之后被 GC，`getFlow()`
 * 返回 `undefined`。
 *
 * **无客户端耦合**。守护进程不检测前端退出/WS 断连。清理路径：
 *   1. 15 分钟上游超时（DeviceCodeTimeoutError → 'expired'）
 *   2. 显式 `cancelLogin()`（→ 'cancelled'）
 *   3. 同 provider 新流程取代（→ 'cancelled'）
 *
 * **令牌 + 配置** 通过工具包的供应路径落地：成功时，`managed:kimi-code`
 * provider + models 条目写入 `config.toml`，缓存的令牌保存到凭据。
 * 前端后续：调用 `GET /v1/auth` 确认 `ready: true`。
 *
 * **架构**：
 *
 *   POST /v1/oauth/login
 *     │
 *     ▼
 *   startLogin()  ──┐
 *                   │  managed auth facade login 在后台运行
 *                   ▼                                  │
 *           ┌─ onDeviceCode(auth) ◄────────────────────┘  （触发一次）
 *           │       │
 *           │       └─ resolve 一个捕获验证 URL 的 deferred
 *           │
 *           ▼
 *      REST 处理器立即返回 OAuthFlowStart
 *
 *                   与此同时，后台 facade.login() 持续轮询...
 *
 *           ┌─ resolve KimiAuthLoginResult     →  flow status = 'authenticated'
 *           │                                    +  config.toml 已供应
 *           │                                    +  令牌已保存到凭据
 *           │
 *           └─ reject 为以下之一：
 *                    DeviceCodeTimeoutError  →  'expired'
 *                    OAuthError("denied")    →  'denied'
 *                    OAuthError("aborted")   →  'cancelled'
 *                    other                   →  'denied'（通用失败）
 *
 *   GET /v1/oauth/login  →  getFlow()  →  内存状态快照
 *
 * **每个 provider 一次进行中的流程**：startLogin 通过中止 AbortController
 * + 将状态翻转为 'cancelled' 来替换同 provider 的现有待处理流程，
 * 然后生成新的 flow_id。
 *
 * **GC**：每次终态转换后触发 5 分钟定时器；定时器触发时删除条目。
 * 待处理流程无 GC——它们存活到上游 15 分钟 device_code TTL 过期
 * + facade.login 以 `DeviceCodeTimeoutError` resolve。
 */

import { createDecorator } from '../../di';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';

export interface IOAuthService {
  readonly _serviceBrand: undefined;

  /**
   * 启动 `providerName`（默认 `'managed:kimi-code'`）的设备码流程。
   * 同步请求设备授权（1-2 次 OAuth 主机往返），启动后台轮询，
   * 返回验证 URL + flow_id。
   *
   * 启动前取消同 provider 的任何现有待处理流程。
   */
  startLogin(providerName?: string): Promise<OAuthFlowStart>;

  /**
   * 获取 `providerName` 当前流程状态的快照。未启动流程（或终态 5 分钟后被 GC）
   * 时返回 `undefined`。
   */
  getFlow(providerName?: string): OAuthFlowSnapshot | undefined;

  /**
   * 取消待处理的流程。幂等：取消终态流程返回
   * `{cancelled: false, status: <current>}` 而非抛出异常。
   */
  cancelLogin(providerName?: string): Promise<OAuthLoginCancelResponse>;

  /**
   * 登出——删除已存储的令牌 + 移除 managed provider 的 `apply` 配置条目
  *（provider + models）。此后 `GET /v1/auth` 翻转为 `ready: false`。
   */
  logout(providerName?: string): Promise<OAuthLogoutResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IOAuthService = createDecorator<IOAuthService>('oauthService');

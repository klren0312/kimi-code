/**
 * `PromptService` — 协议形状的 REST 表面与 agent-core 的 `prompt` / `steer` / `cancel` RPC 之间的适配器。
 *
 * **三项职责**：
 *
 *   1. **提交/列出队列**：验证会话存在性，生成 ULID `prompt_id`，
 *      派生 `user_message_id`（使响应匹配 SCHEMAS §5），并立即启动 prompt
 *      或将其追加到每会话守护进程队列。agent-core 从内部同步流式推送事件；
 *      事件通过事件服务到达 WS 订阅者。
 *
 *   2. **生命周期观察**：在构造函数中通过 `IEventService.onDidPublish(handler)`
 *     （VSCode 风格的访问器，返回 `IDisposable`）订阅事件服务。用于：
 *      - 捕获 `turn.started` → 记录 `promptId ↔ turnId` 映射（以便后续 abort
 *        能将正确的数字 `turnId` 传给 `core.rpc.cancel({turnId})`）。
 *      - 捕获 prompt 顶层 turn 的 `turn.ended` → 合成 `prompt.completed`
 *       （reason='completed' 或 'failed'）或 `prompt.aborted`（reason='cancelled'）
 *        事件。事件服务随后广播这些事件。agent-core 的事件联合体中没有
 *        prompt 级别的类型。
 *      VSCode 风格的访问器 `onDidComplete: Event<...>` /
 *      `onDidAbort: Event<...>` 也被暴露，以便调用方无需过滤原始事件流
 *      即可观察类型化的合成事件。
 *
 *   3. **引导/中止**：`steer` 移除队列中的 prompt 并通过 `core.rpc.steer`
 *      将其内容注入活跃 turn，匹配 TUI 的 Ctrl-S 路径。`abort` 对 prompt id
 *      进行存在性检查并分发 `core.rpc.cancel({sessionId, agentId:'main', turnId?})`。
 *      幂等：对已完成/已中止 prompt 的后续 abort 返回
 *      `PromptAlreadyCompletedError`（→ 信封代码 40903，
 *      `data: {aborted: false}`，按 REST.md §3.5）。
 *
 * **prompt_id ↔ turnId 映射**：
 * - 守护进程在提交时生成 `prompt_<ULID>`。这是守护进程专有 id；agent-core 不知晓。
 * - `turn.started.turnId: number` 是 agent-core 侧的对应值。在提交后的首次
 *   `turn.started` 时，为会话的活跃 prompt 关联 `promptId ↔ turnId`。
 *   同一会话上无中间提交的后续 `turn.started` 事件是嵌套 turn——不重置映射。
 * - 在匹配顶层 turn（turnId 等于原始映射）的 `turn.ended` 时，合成生命周期事件
 *   并清除 `activePromptId`。
 *
 * **队列**：实现维护一个活跃的 `Map<sessionId, PromptState>` 加每会话 FIFO 队列。
 * 当非终态 prompt 存在时的第二次提交返回 status=`queued`；当顶层活跃 turn 结束时，
 * 守护进程启动下一个队列中的 prompt。
 *
 * **`user_message_id` 派生**：SCHEMAS §5 要求提交响应中包含 `user_message_id`。
 * 当完整消息历史适配器可用时，消息 id 为 `msg_{sessionId}_{6位索引}`。
 * 我们尚不知新用户消息的索引（它将在 prompt 执行期间追加到历史中）。
 * 在 agent-core 内联暴露"新消息 id"之前，我们从 prompt id 本身合成 id
 * ——`msg_{sessionId}_pending_{promptId}`。当 agent-core 暴露按消息存储后，
 * 可用真实的按消息 id 替代。
 *
 * **防腐层**：仅从 `@moonshot-ai/agent-core` 导入仅类型 `Event` / `TurnStartedEvent` 等。
 * 运行时调用通过 `ICoreProcessService.rpc.<method>`。生命周期合成通过
 * `IEventService.publish` 发出事件（也是守护进程侧接口；不触及 agent-core）。
 */

import { createDecorator } from '../../di';
import type { Event } from '../../base/common/event';
import type {
  PromptListResponse,
  PromptSubmission,
  PromptStatus,
  PromptSteerResult,
  PromptSubmitResult,
} from '@moonshot-ai/protocol';

export interface PromptAbortResult {
  /** 仅当此调用执行了取消操作时为 true（对幂等的已完成情况返回 false）。 */
  aborted: boolean;
  /** 中止时的每会话 seq（仅供参考）。 */
  at_seq?: number;
}

/**
 * `applyAgentState` 接受的部分运行时控制集合。镜像每会话影子跟踪的四个字段
 *（`model`、`thinking`、`permission_mode`、`plan_mode`），对应协议的线协议词汇。
 * 每个键都是可选的：只有存在的键才会差量分发 setter。
 *
 * 由 `PromptService.submit`（当调用方在请求体中携带按 turn 覆盖时）和
 * `SessionService.update`（当 `POST /v1/sessions/{sid}/profile` 补丁 `agent_config` 时）使用。
 */
export interface AgentStatePatch {
  model?: string;
  thinking?: string;
  permission_mode?: string;
  plan_mode?: boolean;
  swarm_mode?: boolean;
  goal_objective?: string;
  goal_control?: 'pause' | 'resume' | 'cancel';
}

/**
 * `applyAgentState` 调用的来源。`'prompt'` 是 `POST /prompts` 请求体覆盖路径；
 * `'meta'` 是 `POST /sessions/{sid}/profile` 路径的遗留源标签。记录在
 * `PromptDispatchLogEntry.source` 中，使调试界面能将每个分发的 setter 归因到
 * 触发端点，而无需调用方自行交错日志条目。
 */
export type AgentStateSource = 'prompt' | 'meta';

export interface IPromptService {
  readonly _serviceBrand: undefined;

  /**
   * `GET /v1/sessions/{sid}/prompts` — 返回当前守护进程 prompt 调度视图：
   * 一个活跃 prompt，加上等待当前 turn 完成或 steer 操作的队列 prompt。
   */
  list(sid: string): Promise<PromptListResponse>;

  /**
   * `POST /v1/sessions/{sid}/prompts` — 提交 prompt 执行。
   *
   * 未知 `sid` 时抛出 `SessionNotFoundError`（→ 40401）。
   * 会话空闲时返回 status=`running`，另一个 prompt 活跃时返回 status=`queued`。
   */
  submit(sid: string, body: PromptSubmission): Promise<PromptSubmitResult>;

  /**
   * 为会话启动 BTW 侧通道 agent。返回分叉的 agent id；
   * 调用方使用 `PromptSubmission.agent_id` 提交后续 prompt。
   */
  startBtw(sid: string): Promise<string>;

  /**
   * `POST /v1/sessions/{sid}/prompts/{pid}:steer` 和集合
   * `POST /v1/sessions/{sid}/prompts:steer` — 移除队列中的 prompt 并
   * 通过 agent-core steer 将其内容注入活跃 turn。
   *
   * 未知 `sid` 时抛出 `SessionNotFoundError`（→ 40401）。
   * 当任何 pid 不在队列中时抛出 `PromptNotFoundError`（→ 40402）。
   */
  steer(sid: string, promptIds: readonly string[]): Promise<PromptSteerResult>;

  /**
   * `POST /v1/sessions/{sid}/prompts/{pid}:abort` — 取消进行中或队列中的 prompt。
   *
   * 对活跃 prompt，发出 `core.rpc.cancel` 并合成 `prompt.aborted` 事件。
   * 对队列中的 prompt，从队列中移除并合成 `prompt.aborted`，不向 agent-core 分发。
   *
   * 按 REST.md §3.5：中止已完成的 prompt 返回 `PromptAlreadyCompletedError`
  *（→ 40903，`data.aborted: false`）。幂等调用（同一 id，多次中止）折叠为
   * 单次取消 RPC + 后续调用返回 40903。
   *
   * 未知 `sid` 时抛出 `SessionNotFoundError`（→ 40401）。
   * 当 `pid` 在 `sid` 中既非活跃也非队列时抛出 `PromptNotFoundError`（→ 40402）。
   */
  abort(sid: string, pid: string): Promise<PromptAbortResult>;

  /**
   * `POST /v1/sessions/{sid}:abort` — 无需 prompt_id 即可取消会话中正在运行的内容。
   *
   * 如果 `IPromptService` 有活跃 prompt，委托给 `abort()` 以发出正常的
   * 合成 `prompt.aborted` 事件。否则调用 `core.rpc.cancel({ sessionId, agentId: 'main' })`
   *（不含 `turnId`），取消任何活跃的 agent-core turn（包括技能激活）。
   *
   * 发出取消 RPC 时返回 `{ aborted: true }`，会话空闲时返回 `{ aborted: false }`。
   * 未知 `sid` 时抛出 `SessionNotFoundError`（→ 40401）。
   */
  abortBySession(sid: string): Promise<PromptAbortResult>;

  /**
   * 返回会话当前活跃的守护进程 prompt_id（如有）。会话空闲或活跃 prompt
   * 已完成/中止时返回 `undefined`。快照路由用于向重连客户端暴露权威 id。
   */
  getCurrentPromptId(sid: string): string | undefined;

  /**
   * 向会话的影子应用部分运行时控制补丁，对任何不同的字段差量分发
   * 匹配的 `core.rpc.*` setter。由 `submit`（按 turn 覆盖路径）和
   * `SessionService.update`（POST /sessions/{sid}/profile 路径）使用。
   *
   * 未知 `sid` 时抛出 `SessionNotFoundError`（→ 40401）。抛出底层 setter
   * 抛出的任何错误。幂等：以等于影子的值调用是空操作（零分发日志条目）。
   *
   * `promptId` 记录在每个追加的分发日志条目上，以便调试界面能将 setter 归因
   * 到触发它们的 prompt。对非 prompt 调用方（`/profile` 路径）传 `undefined`
   * ——条目的 `promptId` 将为空字符串。
   */
  applyAgentState(
    sid: string,
    patch: AgentStatePatch,
    source: AgentStateSource,
    promptId?: string,
  ): Promise<void>;

  /**
   * VSCode 风格的 `prompt.completed` 合成事件访问器。当顶层 `turn.ended`
   *（reason='completed'|'failed'）被合成为 prompt 生命周期事件时，
   * 监听器在 `bus.publish(synth)` 之前同步触发。
   *
   * 返回 `IDisposable`。拥有者通过
   * `Disposable._register(svc.onDidComplete(handler))` 保存。
   */
  readonly onDidComplete: Event<SyntheticPromptCompletedEvent>;

  /**
   * VSCode 风格的 `prompt.aborted` 合成事件访问器。与 `onDidComplete`
   * 相同的 `IDisposable` 契约。当顶层 `turn.ended`（reason='cancelled'）
   * 或 abort RPC 合成 prompt 生命周期事件时，监听器在 `bus.publish(synth)` 之前触发。
   */
  readonly onDidAbort: Event<SyntheticPromptAbortedEvent>;

  /**
   * 读取会话当前的运行时控制影子（如已初始化）。返回副本，
   * 调用方无法修改内部状态。
   */
  getAgentStateSnapshot(sid: string): AgentStateSnapshot | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPromptService = createDecorator<IPromptService>('promptService');

/**
 * 哨兵错误——REST → 40901 `session.busy`。携带活跃 prompt id，以便路由层
 * 将其包含在 `details` 中。
 */
export class SessionBusyError extends Error {
  readonly sessionId: string;
  readonly activePromptId: string;
  constructor(sessionId: string, activePromptId: string) {
    super(`session ${sessionId} is busy (prompt ${activePromptId} in flight)`);
    this.name = 'SessionBusyError';
    this.sessionId = sessionId;
    this.activePromptId = activePromptId;
  }
}

/**
 * 哨兵错误——REST → 40402 `prompt.not_found`。
 */
export class PromptNotFoundError extends Error {
  readonly sessionId: string;
  readonly promptId: string;
  constructor(sessionId: string, promptId: string) {
    super(`prompt ${promptId} does not exist in session ${sessionId}`);
    this.name = 'PromptNotFoundError';
    this.sessionId = sessionId;
    this.promptId = promptId;
  }
}

/**
 * 哨兵错误——REST → 40903 `prompt.already_completed`。携带 prompt id 和标志，
 * 以便路由层在非零代码情况下仍能发出文档化的 `data: {aborted: false}` 信封。
 */
export class PromptAlreadyCompletedError extends Error {
  readonly sessionId: string;
  readonly promptId: string;
  constructor(sessionId: string, promptId: string) {
    super(`prompt ${promptId} in session ${sessionId} is already completed`);
    this.name = 'PromptAlreadyCompletedError';
    this.sessionId = sessionId;
    this.promptId = promptId;
  }
}

export interface SyntheticPromptSubmittedEvent {
  readonly type: 'prompt.submitted';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: PromptStatus;
  readonly content: PromptSubmission['content'];
  readonly createdAt: string;
}

/**
 * `prompt.completed` 合成事件结构。匹配 agent-core `Event` 类型约定
 * （`AgentEvent & { agentId, sessionId }`），使其可通过现有的
 * `IEventService` 路径流转。`type` 字符串命名空间为 `prompt.*`
 * （不属于 agent-core 的联合类型——参见服务头部注释）。
 */
export interface SyntheticPromptCompletedEvent {
  readonly type: 'prompt.completed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed';
}

/**
 * `prompt.aborted` 合成事件结构。
 */
export interface SyntheticPromptAbortedEvent {
  readonly type: 'prompt.aborted';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}

export interface SyntheticPromptSteeredEvent {
  readonly type: 'prompt.steered';
  readonly agentId: string;
  readonly sessionId: string;
  readonly activePromptId: string;
  readonly promptIds: readonly string[];
  readonly content: PromptSubmission['content'];
  readonly steeredAt: string;
}

/**
 * 每会话四个无状态 prompt 控制的影子。通过
 * `PromptService._agentStateForTest(sid)` 暴露，仅供调试路由和
 * 单元测试使用；不属于日常表面的一部分。
 */
export interface AgentStateSnapshot {
  model?: string;
  thinking?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
}

/**
 * 每当 `PromptService._applyAgentState` 实际向 `core.rpc.*` 发出 setter RPC 时，
 * 追加到每会话环形缓冲区的单条分发记录。两个 prompt 之间缺少条目证明
 * 影子抑制了冗余调用——使测试能够断言"状态保持"与"setter 重新分发"，
 * 因为仅凭 WS 帧无法区分两者。
 */
export interface PromptDispatchLogEntry {
  /** setter 解析后立即捕获的 ISO-8601 时间戳。 */
  readonly ts: string;
  /** 执行的 setter 类型。 */
  readonly kind:
    | 'setModel'
    | 'setThinking'
    | 'setPermission'
    | 'enterPlan'
    | 'cancelPlan'
    | 'enterSwarm'
    | 'exitSwarm'
    | 'createGoal'
    | 'pauseGoal'
    | 'resumeGoal'
    | 'cancelGoal';
  /** 传递给 setter 的原始负载（必要时由调用方脱敏 sessionId）。 */
  readonly payload: Record<string, unknown>;
  /**
   * 此分发所关联的 prompt id。在 `submit()` 顶部生成，使 setter RPC 和
   * 最终的 `core.rpc.prompt(...)` 携带相同的 id。当分发来自
   * `/sessions/{sid}/profile` 路径（无 prompt 上下文）时为空字符串。
   */
  readonly promptId: string;
  /**
   * 触发分发的端点——`'prompt'` 表示 `POST /sessions/{sid}/prompts` 的请求体覆盖，
   * `'meta'` 表示 `POST /sessions/{sid}/profile` 的补丁。使调试界面
   * （`GET /debug/prompts/{sid}/dispatch-log`）和单元/e2e 测试能够
   * 将每个 setter 归因到触发它的请求，无需额外传递日志。
   */
  readonly source: AgentStateSource;
}

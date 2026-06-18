/**
 * 后台任务子系统的核心类型定义。
 *
 * 本模块定义了每个后台任务必须满足的契约：
 * - {@link BackgroundTask}：具体任务类实现的接口
 * - {@link BackgroundTaskSink}：管理器在启动时传递给任务的回调接口
 * - 状态枚举和信息类型，供 UI、持久化层和通知系统使用
 *
 * 类型层次结构刻意保持窄小——三种任务类型（process、agent、question）通过 `kind` 字段
 * 进行区分——以便管理器、持久化和通知代码可以进行模式匹配，而无需耦合到具体类的内部实现。
 */

import type { AgentBackgroundTaskInfo } from './agent-task';
import type { ProcessBackgroundTaskInfo } from './process-task';
import type { QuestionBackgroundTaskInfo } from './question-task';

/**
 * 后台任务的生命周期状态。
 *
 * `'running'` 是唯一的非终态。其他所有值均为终态；
 * 一旦任务到达其中某个状态，将不再发生转换（管理器在 `settleTask` 中强制执行此幂等性）。
 */
export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

/**
 * 表示已完成任务的状态集合。
 *
 * 管理器使用此集合来短路重复的结算尝试，并决定何时应 resolve 等待者。`'lost'` 仅用于
 * 协调：从磁盘加载的、在上一次 CLI 进程退出时仍处于 `'running'` 状态的任务，会在
 * `reconcile()` 过程中被重新分类为 `'lost'`。
 */
export const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

/**
 * 具体任务可以主动结算进入的状态值。
 *
 * 不包括 `'running'`（非终态）和 `'lost'`（仅用于协调；任务代码不会产生此状态）。
 * 用作 {@link BackgroundTaskSettlement} 中的 `status` 字段。
 */
export type BackgroundTaskSettlementStatus = 'completed' | 'failed' | 'timed_out' | 'killed';

/**
 * 任务在完成时通过 `sink.settle()` 传递的结算载荷。
 *
 * 结算是任务声明自身终态的方式。管理器记录状态、持久化、触发终态通知，
 * 并 resolve 所有等待者。`stopReason` 是可选的，通常仅在 `'failed'` 或
 * `'killed'` 结果时设置。
 */
export interface BackgroundTaskSettlement {
  readonly status: BackgroundTaskSettlementStatus;
  /** 终态的人类可读原因（如有）。 */
  readonly stopReason?: string;
}

/**
 * 每个任务信息快照共享的基础字段。
 *
 * 具体的任务类型通过特定于类型的字段进行扩展（例如进程任务的 `pid`，
 * 代理任务的 `agentId`）。管理器通过 `toInfo()` 构造这些快照，
 * 并将其传递到 UI、持久化和通知子系统。
 */
export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  /** 描述此任务功能的简短人类可读标签。 */
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  /** 任务向管理器注册时的 Unix 时间戳（毫秒）。 */
  readonly startedAt: number;
  /** 任务到达终态时的 Unix 时间戳（毫秒），仍在运行时为 `null`。 */
  readonly endedAt: number | null;
  /** 终态的人类可读原因（如有）。 */
  readonly stopReason?: string;
  /** 抑制此任务的自动终态通知/提醒。 */
  readonly terminalNotificationSuppressed?: boolean;
  /** 注册时提供的截止时间；通过任务信息暴露。 */
  readonly timeoutMs?: number;
}

/**
 * 所有任务信息类型的可区分联合。
 *
 * 消费者可以对 `kind` 进行 switch 来访问特定于类型的字段，而无需向下转型。
 */
export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;

/**
 * 管理器传递给任务 `start()` 方法的回调接口。
 *
 * sink 是任务与管理器之间的唯一通信通道：
 * - `signal`：管理器在调用 `stop()` 时中止的取消信号
 * - `appendOutput`：将任务输出流式传输到管理器的环形缓冲区和磁盘日志
 * - `settle`：声明任务的终态（仅一次）
 *
 * 这种设计实现了控制反转：任务拥有执行逻辑，但管理器拥有生命周期、
 * 输出缓冲和持久化。
 */
export interface BackgroundTaskSink {
  readonly signal: AbortSignal;
  /** 向任务的环形缓冲区和持久化日志追加一块输出。 */
  appendOutput(chunk: string): void;
  /** 声明任务的终态。必须恰好调用一次。 */
  settle(settlement: BackgroundTaskSettlement): Promise<boolean>;
}

/**
 * 每个具体后台任务必须实现的契约。
 *
 * 管理器在注册后调用 `start()`，传入一个 {@link BackgroundTaskSink}，
 * 任务使用它来流式传输输出和声明终态。`forceStop()` 是一个可选的
 * 升级钩子，在 SIGTERM 宽限期过期后调用。`toInfo()` 生成
 * UI 和持久化层使用的特定于类型的信息快照。
 *
 * 具体实现：
 * - {@link ProcessBackgroundTask}：封装一个 KaosProcess (bash)
 * - {@link AgentBackgroundTask}：封装一个子代理完成 promise
 * - {@link QuestionBackgroundTask}：封装一个交互式问题流程
 */
export interface BackgroundTask {
  /** 用于生成任务 ID 的前缀（例如 `'bash'`、`'agent'`、`'question'`）。 */
  readonly idPrefix: string;
  /** 任务信息联合的区分字段。 */
  readonly kind: BackgroundTaskInfo['kind'];
  /** 描述此任务功能的简短人类可读标签。 */
  readonly description: string;
  /** 可选的截止时间（毫秒）。管理器通过超时逻辑强制执行此限制。 */
  readonly timeoutMs?: number;

  /**
   * 开始执行任务。管理器在注册后立即调用。
   *
   * 任务必须在返回的 promise resolve（或 reject）之前恰好调用一次 `sink.settle()`。
   * 输出在可用时通过 `sink.appendOutput()` 流式传输。任务应监听 `sink.signal` 以处理取消。
   */
  start(sink: BackgroundTaskSink): void | Promise<void>;
  /**
   * 强制终止的升级钩子。当 SIGTERM 宽限期（5 秒）过期且任务仍未结算时，由管理器调用。
   * 实现应发送 SIGKILL 或等效信号。可选——无法强制停止的任务可以省略此方法。
   */
  forceStop?(): Promise<void>;
  /**
   * 将特定于类型的字段合并到基础信息快照中。管理器使用预填充的
   * {@link BackgroundTaskInfoBase} 调用此方法；实现将其自身的字段
   * 扩展到顶部并返回可区分联合成员。
   */
  toInfo(base: BackgroundTaskInfoBase): BackgroundTaskInfo;
}

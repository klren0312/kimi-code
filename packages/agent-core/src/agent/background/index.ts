/**
 * BackgroundManager — 管理 Agent 的后台任务。
 *
 * 跟踪后台 Bash 任务和后台子 Agent 任务。
 *
 * 每个任务拥有唯一 ID，将 stdout+stderr 捕获到环形缓冲区，
 * 并支持状态查询、输出检索和停止操作。
 *
 * 具体任务类负责执行细节；管理器负责任务注册、生命周期状态、
 * 持久化、输出和通知。
 */

import { randomBytes } from 'node:crypto';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../..';
import { errorMessage } from '../../loop/errors';
import { resettableTimeoutOutcome, timeoutOutcome, type ResettableTimeoutPromise } from '../../utils/promise';
import { escapeXml, escapeXmlAttr } from '../../utils/xml-escape';
import type { BackgroundTaskOrigin } from '../context';
import { renderNotificationXml } from '../context/notification-xml';
import { type BackgroundTaskPersistence } from './persist';
import {
  TERMINAL_STATUSES,
  type BackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSettlement,
  type BackgroundTaskStatus,
} from './task';

// ── Types ────────────────────────────────────────────────────────────

/**
 * `'lost'` 是仅用于对账的终端状态。从磁盘加载的、在启动时被标记为 `running`
 * 但没有活跃 KaosProcess（之前 CLI 进程已崩溃）的任务会被重新分类为 lost。
 */
export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export { AgentBackgroundTask } from './agent-task';
export type { AgentBackgroundTaskInfo } from './agent-task';
export { ProcessBackgroundTask } from './process-task';
export type { ProcessBackgroundTaskInfo } from './process-task';
export { QuestionBackgroundTask } from './question-task';
export type { QuestionBackgroundTaskInfo } from './question-task';
export { BackgroundTaskPersistence } from './persist';
export type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './task';

interface ManagedTask {
  /** 由 `generateTaskId()` 生成的唯一任务 ID。 */
  readonly taskId: string;
  /** 具体的任务实现（进程、Agent 或问题）。 */
  readonly task: BackgroundTask;
  /** 内存中的输出块环形缓冲区（超出容量时丢弃最旧的块）。 */
  readonly outputChunks: string[];
  /** 已观察到的总 UTF-8 字节数，包括从活跃环形缓冲区丢弃的块。 */
  outputSizeBytes: number;
  /** 当前生命周期状态。 */
  status: BackgroundTaskStatus;
  /** Normalized registration options. Current mutable state stays on ManagedTask. */
  readonly options: RegisterBackgroundTaskOptions;
  readonly startedAt: number;
  /** 任务到达终端状态时的 Unix 时间戳（毫秒），或 `null`。 */
  endedAt: number | null;
  /** Foreground tool call release signal, present only for non-detached starts. */
  foregroundRelease?: ControlledPromise<ForegroundTaskReleaseReason>;
  /** Resettable deadline timer; reset on detach to apply `detachTimeoutMs`. */
  timeoutHandle?: ResettableTimeoutPromise<TerminalOutcome>;
  /** User/tool stop request. */
  readonly stop: ControlledPromise<StopRequest>;
  /** Resolved once manager has finalized the task. */
  readonly terminal: ControlledPromise<void>;
  /** Human-readable reason for the terminal status, when available. */
  stopReason?: string | undefined;
  /** 抑制此任务的自动终端通知/提醒。 */
  terminalNotificationSuppressed?: boolean | undefined;
  /** 管理器拥有且具体任务观察的取消信号。 */
  readonly abortController: AbortController;
  persistWriteQueue: Promise<void>;
  /** 序列化输出日志追加以保持顺序。 */
  outputWriteQueue: Promise<void>;
  /**
   * Full output buffered in memory while a foreground task has not yet
   * persisted to disk. Flushed to `output.log` (in order, ahead of the live
   * stream) when the task detaches or spills, then released.
   */
  pendingOutput: string[];
  pendingOutputBytes: number;
  /**
   * Whether `output.log` writes have begun. True from the start for tasks
   * registered already-detached; flipped on detach or memory-bound spill for
   * foreground tasks. Until then output stays in `pendingOutput`.
   */
  outputPersistStarted: boolean;
}

/**
 * 每个任务在内存环形缓冲区中保留的最大输出字节数。
 * 超出时丢弃最旧的块。
 *
 * 环形缓冲区是一个轻量级的尾部视图，仅用于 `/tasks` UI 和终端通知——
 * 它有意丢弃旧输出以限制内存。它不是权威的完整输出：
 * 完整的、永不截断的日志位于磁盘上的 `<sessionDir>/tasks/<id>/output.log`。
 * 需要任务输出的调用方应使用 `getOutputSnapshot()`，
 * 它会在可用时读取持久化日志。
 */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;

const SIGTERM_GRACE_MS = 5_000;
const USER_INTERRUPT_REASON = 'Interrupted by user';

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * 生成 `{prefix}-{8个base36字符}` 格式的 ID。
 *
 * `randomBytes(8) % 36` 有轻微的模偏差（256 % 36 = 4），
 * 但在 8 字符后缀上产生约 36^8 ≈ 2.8e12 个不同 ID，
 * 对于每会话任务 ID 来说唯一性已足够。
 */
function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `${kind}-${suffix}`;
}

/**
 * 任务输出的快照，由 TaskOutput UI 组件使用。
 *
 * 当任务注册了输出会话目录且 `output.log` 已实际创建时，优先使用持久化日志
 * （完整且永不截断）；对于没有会话目录或输出尚未写入磁盘的任务，
 * 回退到内存环形缓冲区。
 */
export interface BackgroundTaskOutputSnapshot {
  /** 磁盘输出日志的绝对路径（已附加持久化时）。 */
  readonly outputPath?: string;
  /** 任务已产生的总 UTF-8 输出字节数（权威值，永不截断）。 */
  readonly outputSizeBytes: number;
  /** `preview` 字符串中的字节数。 */
  readonly previewBytes: number;
  /** 预览是否为较大输出的尾部片段。 */
  readonly truncated: boolean;
  /** 当预览从持久化日志读取时为 `true`（完整来源）。 */
  readonly fullOutputAvailable: boolean;
  /** 预览内容（输出尾部，受 `maxPreviewBytes` 限制）。 */
  readonly preview: string;
}

function emptyOutputSnapshot(): BackgroundTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

/**
 * 当任务到达终端状态时传递给 Agent 上下文的通知负载。
 * 由 `renderNotificationXml()` 渲染为 XML 并注入对话中，
 * 以便 Agent 可以对任务结果做出反应。
 */
type BackgroundTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  /** Agent(resume=...) 接受的子 Agent ID。进程任务省略此字段。 */
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

/**
 * 将内容、来源和通知对象打包在一起，以便管理器可以在单个调用中
 * 转向（活跃任务）或追加（恢复任务）通知。
 */
interface BackgroundTaskNotificationContext {
  readonly content: readonly ContentPart[];
  readonly origin: BackgroundTaskOrigin;
  readonly notification: BackgroundTaskNotification;
}

export interface RegisterBackgroundTaskOptions {
  /**
   * When false, the task is tracked by the manager but a foreground tool call
   * is still waiting for it. It can later be detached through RPC.
   */
  readonly detached?: boolean;
  /** Deadline owned by BackgroundManager. `0` and `undefined` do not arm a timer. */
  readonly timeoutMs?: number;
  /**
   * When set, detaching a foreground task resets its deadline to this value
   * (counted from the detach moment). Lets a command started with a short
   * foreground timeout run longer once it is moved to the background.
   */
  readonly detachTimeoutMs?: number;
  /** Foreground caller signal. Ignored for tasks created already detached. */
  readonly signal?: AbortSignal;
}

export type ForegroundTaskReleaseReason = 'detached' | 'terminal';

interface StopRequest {
  readonly reason?: string;
  readonly abortReason?: unknown;
}

type TerminalOutcome =
  | { readonly kind: 'worker'; readonly settlement: BackgroundTaskSettlement }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'stop'; readonly request: StopRequest };

// ── Manager ──────────────────────────────────────────────────────────

/**
 * Agent 会话中所有后台任务的中央注册表和生命周期管理器。
 *
 * 职责：
 * - **注册**：分配唯一 ID，强制执行最大运行任务限制
 * - **生命周期**：启动任务，处理停止（SIGTERM → 宽限期 → SIGKILL），结算终端状态
 * - **输出**：维护内存环形缓冲区并委托磁盘持久化记录完整日志
 * - **持久化**：将任务状态写入磁盘，以便 CLI 重启时可恢复丢失的任务
 * - **通知**：将终端任务摘要注入 Agent 上下文并触发钩子
 * - **对账**：在启动时加载持久化任务并将运行中但已死亡的任务重新分类为 `'lost'`
 *
 * 具体任务类负责执行细节；管理器负责其他一切。
 */
export class BackgroundManager {
  private readonly tasks = new Map<string, ManagedTask>();
  /**
   * 幽灵任务：对账期间从磁盘加载的、没有活跃 KaosProcess 的任务。
   * 它们以 `lost` 状态出现在 `list()` / `getTask()` 中，
   * 以便用户看到崩溃/重启前正在运行的任务。
   */
  private readonly ghosts = new Map<string, BackgroundTaskInfo>();

  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();

  constructor(
    private readonly agent: Agent,
    private readonly persistence?: BackgroundTaskPersistence,
  ) { }

  private fireTerminalEffects(entry: ManagedTask): void {
    if (!this.isDetached(entry)) return;
    const info = this.toInfo(entry);
    void this.notifyBackgroundTask(info).catch(() => { });
    this.emitTaskTerminated(info);
  }

  private emitTaskStarted(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.started', info });
    this.agent.telemetry.track('background_task_created', {
      kind: info.kind === 'process' ? 'bash' : info.kind,
    });
  }

  private emitTaskTerminated(info: BackgroundTaskInfo): void {
    this.agent.emitEvent({ type: 'background.task.terminated', info });
    this.agent.telemetry.track('background_task_completed', {
      kind: info.kind,
      duration: info.endedAt !== null ? info.endedAt - info.startedAt : null,
      status: info.status,
    });
  }

  private assertCanRegister(startedInBackground: boolean): void {
    const maxRunningTasks = this.agent.kimiConfig?.background?.maxRunningTasks;
    if (maxRunningTasks === undefined) return;
    if (!startedInBackground) return;
    if (this.activeBackgroundAdmissionCount() < maxRunningTasks) return;
    throw new Error('Too many background tasks are already running.');
  }

  private activeBackgroundAdmissionCount(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (!TERMINAL_STATUSES.has(entry.status) && this.startedInBackground(entry)) count++;
    }
    return count;
  }

  private startedInBackground(entry: ManagedTask): boolean {
    return entry.options.detached !== false;
  }

  private isDetached(entry: ManagedTask): boolean {
    return entry.foregroundRelease === undefined;
  }

  registerTask(task: BackgroundTask, options: RegisterBackgroundTaskOptions = {}): string {
    const detached = options.detached ?? true;
    const timeoutMs = options.timeoutMs ?? task.timeoutMs;
    const entryOptions: RegisterBackgroundTaskOptions = {
      detached,
      timeoutMs,
      detachTimeoutMs: options.detachTimeoutMs,
      signal: detached ? undefined : options.signal,
    };
    this.assertCanRegister(detached);
    const taskId = generateTaskId(task.idPrefix);
    const entry: ManagedTask = {
      taskId,
      task,
      outputChunks: [],
      outputSizeBytes: 0,
      status: 'running',
      options: entryOptions,
      startedAt: Date.now(),
      endedAt: null,
      foregroundRelease: detached ? undefined : createControlledPromise(),
      stop: createControlledPromise(),
      terminal: createControlledPromise(),
      abortController: new AbortController(),
      persistWriteQueue: Promise.resolve(),
      outputWriteQueue: Promise.resolve(),
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputPersistStarted: detached,
    };
    this.tasks.set(taskId, entry);
    void this.runTaskLifecycle(entry);

    // Initial persistence (snapshot at start). Foreground tasks defer all
    // persistence until they detach (or spill) — see appendOutput / detach /
    // finalizeTask — so ordinary commands leave nothing undiscoverable on disk.
    if (this.isDetached(entry)) {
      void this.persistLive(entry);
      this.emitTaskStarted(this.toInfo(entry));
    }

    return taskId;
  }

  /** 获取特定任务的信息。回退到对账幽灵任务。 */
  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry !== undefined) {
      return this.toInfo(entry);
    }
    return this.ghosts.get(taskId);
  }

  /**
   * 列出任务，可选择仅筛选活跃任务。
   *
   * 当 `activeOnly=false` 时，包含对账幽灵任务（来自之前 CLI 进程的丢失任务），
   * 以便用户看到在重启后幸存的任务。仅活跃模式从不显示幽灵任务（它们是终端状态）。
   */
  list(activeOnly = true, limit?: number): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      const info = this.toInfo(entry);
      if (!this.shouldListTask(info, activeOnly)) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) return result;
    }
    if (!activeOnly) {
      for (const ghost of this.ghosts.values()) {
        if (!this.shouldListTask(ghost, activeOnly)) continue;
        result.push(ghost);
        if (limit !== undefined && result.length >= limit) return result;
      }
    }
    return result;
  }

  private shouldListTask(info: BackgroundTaskInfo, activeOnly: boolean): boolean {
    if (!TERMINAL_STATUSES.has(info.status)) return true;
    if (activeOnly) return false;
    return info.detached !== false;
  }

  /**
   * 返回 TaskOutput 使用的输出快照。
   *
   * 当任务注册了输出会话目录且 `output.log` 实际已创建时，优先使用持久化日志，
   * 因为它们是完整的、永不截断的来源。分离的管理器、在会话目录附加前注册的任务
   * 以及没有持久化日志的静默任务会回退到活跃环形缓冲区。
   */
  async getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<BackgroundTaskOutputSnapshot> {
    if (this.getTask(taskId) === undefined) return emptyOutputSnapshot();

    await this.tasks.get(taskId)?.outputWriteQueue;

    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const persistence = this.persistence;
    if (persistence !== undefined && (await persistence.taskOutputExists(taskId))) {
      const outputSizeBytes = await persistence.taskOutputSizeBytes(taskId);
      const previewOffset = Math.max(0, outputSizeBytes - previewLimit);
      const previewBytes = outputSizeBytes - previewOffset;
      const preview = await persistence.readTaskOutputBytes(taskId, previewOffset, previewBytes);
      return {
        outputPath: persistence.taskOutputFile(taskId),
        outputSizeBytes,
        previewBytes,
        truncated: previewOffset > 0,
        fullOutputAvailable: true,
        preview,
      };
    }

    const entry = this.tasks.get(taskId);
    if (entry === undefined) return emptyOutputSnapshot();

    const available = Buffer.from(entry.outputChunks.join(''), 'utf-8');
    const previewBytes = Math.min(previewLimit, available.byteLength, entry.outputSizeBytes);
    const previewOffset = available.byteLength - previewBytes;
    return {
      outputSizeBytes: entry.outputSizeBytes,
      previewBytes,
      truncated: entry.outputSizeBytes > previewBytes,
      fullOutputAvailable: false,
      preview: available.subarray(previewOffset).toString('utf-8'),
    };
  }

  /**
   * 读取任务的完整输出，可选择截断为最后 `tail` 个字符。
   * 委托给 `getOutputSnapshot()` 以优先使用持久化日志而非环形缓冲区。
   */
  async readOutput(taskId: string, tail?: number): Promise<string> {
    const output = (await this.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)).preview;
    if (tail !== undefined && tail < output.length) {
      return output.slice(-tail);
    }
    return output;
  }

  /**
   * 阻止任务发送自动终端通知。
   * 当用户已通过其他方式看到结果时很有用。
   * 持久化抑制标志以在 CLI 重启后保持。
   */
  async suppressTerminalNotification(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined || entry.terminalNotificationSuppressed === true) return;
    entry.terminalNotificationSuppressed = true;
    await this.persistLive(entry);
  }

  detach(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return this.ghosts.get(taskId);
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);
    const foregroundRelease = entry.foregroundRelease;
    if (foregroundRelease === undefined) return this.toInfo(entry);

    entry.foregroundRelease = undefined;
    if (entry.options.detachTimeoutMs !== undefined) {
      entry.timeoutHandle?.reset(entry.options.detachTimeoutMs);
    }
    try {
      entry.task.onDetach?.();
    } catch {
      /* detach has already succeeded; hooks must not make RPC fail */
    }
    // Flush buffered pre-detach output to disk before the live stream resumes,
    // so output.log stays the complete, in-order record.
    this.startOutputPersist(entry);
    void this.persistLive(entry);
    this.emitTaskStarted(this.toInfo(entry));
    foregroundRelease.resolve('detached');
    return this.toInfo(entry);
  }

  persistOutput(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return;
    this.startOutputPersist(entry);
  }

  /** Stop a running task. SIGTERM → 5s grace → SIGKILL. */
  async stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    // 在此共享边界规范化：每个公共停止路径（TaskStop 工具、SDK/RPC）
    // 都经过此处，因此空白或仅含空格的原因绝不应被记录为空 stopReason。
    const trimmedReason = reason?.trim();
    const stopReason =
      trimmedReason === undefined || trimmedReason.length === 0 ? undefined : trimmedReason;
    // 终端任务直接短路。
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    entry.stopReason = stopReason;
    entry.abortController.abort(stopReason);
    entry.stop.resolve({ reason: stopReason });
    await entry.terminal;
    return this.toInfo(entry);
  }

  /** 停止所有运行中的任务。返回每个被停止或已是终端状态的任务的信息。 */
  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const taskIds = Array.from(this.tasks.keys());
    const results = await Promise.all(taskIds.map((taskId) => this.stop(taskId, reason)));
    return results.filter((info): info is BackgroundTaskInfo => info !== undefined);
  }

  /**
   * 等待任务到达终端状态。
   * 若已到达终端状态则立即返回。超时时间为 `timeoutMs`。
   */
  async wait(taskId: string, timeoutMs = 30_000): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return this.toInfo(entry);
    }

    if (timeoutMs <= 0) {
      return this.toInfo(entry);
    }
    const timeout = timeoutOutcome(timeoutMs, undefined);
    await Promise.race([entry.terminal, timeout]).finally(() => timeout.clear());

    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
    }
    return this.toInfo(entry);
  }

  /**
   * Wait until a foreground task either detaches from the current tool call or
   * reaches a terminal state. Detached tasks return immediately.
   */
  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) {
      await entry.persistWriteQueue;
      return 'terminal';
    }
    if (this.isDetached(entry)) return 'detached';

    const foregroundRelease = entry.foregroundRelease;
    const reason = await Promise.race([
      foregroundRelease,
      entry.terminal.then(() => 'terminal' as const),
    ]);
    if (reason === 'terminal') {
      await entry.persistWriteQueue;
    }
    return reason;
  }

  // ── persistence + reconcile ────────────────────────────────────────

  /**
   * 将持久化的任务记录加载到幽灵映射中。不执行对账
   * （在 `loadFromDisk()` 之后调用 `reconcile()`）。幂等；
   * 后续调用覆盖幽灵映射。
   */
  async loadFromDisk(): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    this.ghosts.clear();
    const persisted = await persistence.listTasks();
    for (const t of persisted) {
      // 跳过已作为活跃进程存在的 ID——活跃进程优先。
      if (this.tasks.has(t.taskId)) continue;
      this.ghosts.set(t.taskId, t);
    }
  }

  /**
   * 对账已加载的幽灵任务。任何状态为 `running` 的幽灵任务
   * 被重新分类为 `lost`（其之前的 CLI 进程未写入终端状态就退出了）。
   * 更新磁盘记录并返回丢失的任务快照，以便调用方发出面向用户的通知。
   */
  private async markLoadedTasksLost(): Promise<readonly BackgroundTaskInfo[]> {
    const lostInfo: BackgroundTaskInfo[] = [];
    const persistence = this.persistence;
    for (const [id, info] of this.ghosts) {
      // 非终端状态的幽灵任务即为丢失。
      if (TERMINAL_STATUSES.has(info.status)) continue;
      const updated: BackgroundTaskInfo = {
        ...info,
        status: 'lost',
        endedAt: info.endedAt ?? Date.now(),
      };
      this.ghosts.set(id, updated);
      if (persistence !== undefined) {
        await persistence.writeTask(updated);
      }
      lostInfo.push(updated);
    }
    return lostInfo;
  }

  async reconcile(): Promise<void> {
    const lostInfo = await this.markLoadedTasksLost();
    for (const info of lostInfo) {
      this.emitTaskTerminated(info);
    }
    await this.restoreBackgroundTaskNotifications();
  }

  /**
   * 持久化活跃 ManagedTask 的当前状态。从 `registerTask()` 和
   * 生命周期 finally 块中调用。除非已附加持久化，否则为空操作。
   */
  private persistLive(entry: ManagedTask): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return Promise.resolve();
    const info = this.toInfo(entry);
    entry.persistWriteQueue = entry.persistWriteQueue
      .then(() => persistence.writeTask(info))
      .catch(() => { });
    return entry.persistWriteQueue;
  }

  /**
   * 将输出块追加到内存环形缓冲区并持久化到磁盘。
   * 当环形缓冲区超过 `MAX_OUTPUT_BYTES` 时丢弃最旧的块以限制内存使用。
   * 持久化写入通过 `outputWriteQueue` 序列化以保持顺序。
   */
  private appendOutput(entry: ManagedTask, chunk: string): void {
    entry.outputSizeBytes += Buffer.byteLength(chunk, 'utf-8');
    entry.outputChunks.push(chunk);
    // 强制输出上限：超出容量时丢弃最旧的块。
    let total = entry.outputChunks.reduce((s, c) => s + c.length, 0);
    while (total > MAX_OUTPUT_BYTES && entry.outputChunks.length > 1) {
      const removed = entry.outputChunks.shift();
      if (removed === undefined) break;
      total -= removed.length;
    }

    if (this.persistence === undefined) return;

    // Foreground tasks keep their full output in memory and only touch disk
    // once they detach. A memory-bound spill begins disk persistence early so
    // a never-detached command can't grow the buffer without limit.
    if (!entry.outputPersistStarted) {
      entry.pendingOutput.push(chunk);
      entry.pendingOutputBytes += Buffer.byteLength(chunk, 'utf-8');
      if (entry.pendingOutputBytes > MAX_OUTPUT_BYTES) this.startOutputPersist(entry);
      return;
    }

    this.appendTaskOutput(entry, chunk);
  }

  /** Enqueue an `output.log` append, serialized per task. No-op when detached managers omit persistence. */
  private appendTaskOutput(entry: ManagedTask, chunk: string): void {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    entry.outputWriteQueue = entry.outputWriteQueue
      .then(() => persistence.appendTaskOutput(entry.taskId, chunk))
      .catch(() => { });
  }

  /**
   * Begin persisting `output.log` for a task that buffered while foreground.
   * Flushes the buffered pre-detach output first (in order, ahead of the live
   * stream) so the on-disk log stays complete, then releases the buffer.
   * Idempotent.
   */
  private startOutputPersist(entry: ManagedTask): void {
    if (entry.outputPersistStarted) return;
    entry.outputPersistStarted = true;
    if (entry.pendingOutput.length > 0) {
      this.appendTaskOutput(entry, entry.pendingOutput.join(''));
    }
    entry.pendingOutput = [];
    entry.pendingOutputBytes = 0;
  }

  private async restoreBackgroundTaskNotifications(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isBackgroundTaskTerminal(info.status)) continue;
      await this.restoreBackgroundTaskNotification(info);
    }
  }

  private async notifyBackgroundTask(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.turn.steer(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async restoreBackgroundTaskNotification(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.context.appendUserMessage(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async buildBackgroundTaskNotificationContext(
    info: BackgroundTaskInfo,
  ): Promise<BackgroundTaskNotificationContext | undefined> {
    if (info.detached === false) return undefined;
    if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
    const origin: BackgroundTaskOrigin = {
      kind: 'background_task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.deliveredNotificationKeys.has(key)) return;

    this.scheduledNotificationKeys.add(key);
    let output = await this.getOutputSnapshot(info.taskId, 0);
    if (!output.fullOutputAvailable) {
      output = await this.getOutputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
    }
    if (this.isTerminalNotificationSuppressed(info.taskId)) return undefined;
    const notification: BackgroundTaskNotification = {
      id: origin.notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Background ${info.kind} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildBackgroundTaskNotificationBody(info),
      children: backgroundTaskNotificationChildren(output),
    };
    const content = [
      {
        type: 'text',
        text: renderNotificationXml(notification),
      },
    ] as const;
    return { content, origin, notification };
  }

  private fireNotificationHook(notification: BackgroundTaskNotification): void {
    void this.agent.hooks?.fireAndForgetTrigger('Notification', {
      matcherValue: notification.type,
      inputData: {
        sink: 'context',
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      },
    });
  }

  /**
   * 将通知标记为已投递，以避免在下次对账或会话恢复时重复注入。
   * 在 Agent 上下文成功消费通知内容后调用。
   */
  markDeliveredNotification(origin: BackgroundTaskOrigin): void {
    this.deliveredNotificationKeys.add(notificationKey(origin));
  }

  private isTerminalNotificationSuppressed(taskId: string): boolean {
    return (
      this.tasks.get(taskId)?.terminalNotificationSuppressed === true ||
      this.ghosts.get(taskId)?.terminalNotificationSuppressed === true
    );
  }

  private async runTaskLifecycle(entry: ManagedTask): Promise<void> {
    const worker = createControlledPromise<BackgroundTaskSettlement>();
    let workerSettled = false;
    const settleWorker = (settlement: BackgroundTaskSettlement): boolean => {
      if (workerSettled) return false;
      workerSettled = true;
      worker.resolve(settlement);
      return true;
    };

    void Promise.resolve()
      .then(() => entry.task.start({
        signal: entry.abortController.signal,
        appendOutput: (chunk) => {
          this.appendOutput(entry, chunk);
        },
        settle: async (settlement) => settleWorker(settlement),
      }))
      .catch((error: unknown) => {
        settleWorker({
          status: entry.abortController.signal.aborted ? 'killed' : 'failed',
          stopReason: entry.abortController.signal.aborted ? undefined : errorMessage(error),
        });
      });

    const timeout = resettableTimeoutOutcome(entry.options.timeoutMs, { kind: 'timeout' as const });
    entry.timeoutHandle = timeout;
    const outcome = await Promise.race([
      worker.then((settlement): TerminalOutcome => ({ kind: 'worker', settlement })),
      timeout,
      entry.stop.then((request): TerminalOutcome => ({ kind: 'stop', request })),
      this.signalOutcome(entry),
    ]).finally(() => {
      timeout.clear();
      entry.timeoutHandle = undefined;
    });
    const settlement = await this.settlementForOutcome(entry, outcome, worker);
    await this.finalizeTask(entry, settlement);
  }

  private signalOutcome(entry: ManagedTask): Promise<TerminalOutcome> {
    const signal = entry.options.signal;
    if (signal === undefined) return new Promise<never>(() => {});
    const outcome = (): TerminalOutcome => ({
      kind: 'stop',
      request: { reason: USER_INTERRUPT_REASON, abortReason: signal.reason },
    });
    if (signal.aborted) return Promise.resolve(outcome());
    return new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          if (!this.isDetached(entry)) resolve(outcome());
        },
        { once: true },
      );
    });
  }

  private async settlementForOutcome(
    entry: ManagedTask,
    outcome: TerminalOutcome,
    worker: Promise<BackgroundTaskSettlement>,
  ): Promise<BackgroundTaskSettlement> {
    if (outcome.kind === 'worker') return outcome.settlement;

    const timedOut = outcome.kind === 'timeout';
    const stopReason = outcome.kind === 'stop' ? outcome.request.reason : undefined;
    let abortReason: unknown;
    if (timedOut) {
      abortReason = 'Timed out';
    } else if (outcome.kind === 'stop') {
      abortReason = outcome.request.abortReason ?? stopReason;
    }
    entry.stopReason = stopReason;
    entry.abortController.abort(abortReason);

    const graceTimeout = timeoutOutcome(SIGTERM_GRACE_MS, undefined);
    const workerAfterAbort = await Promise.race([
      worker,
      graceTimeout,
    ]).finally(() => graceTimeout.clear());

    if (
      outcome.kind === 'stop' &&
      workerAfterAbort !== undefined &&
      workerAfterAbort.status !== 'killed' &&
      workerAfterAbort.status !== 'timed_out'
    ) {
      return workerAfterAbort;
    }

    if (workerAfterAbort === undefined) {
      try {
        await entry.task.forceStop?.();
      } catch {
        /* ignore */
      }
    }

    return {
      status: timedOut ? 'timed_out' : 'killed',
      stopReason,
    };
  }

  private async finalizeTask(
    entry: ManagedTask,
    settlement: BackgroundTaskSettlement,
  ): Promise<void> {
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    // Persist the terminal record only when the task actually touched disk:
    // detached tasks, and foreground tasks that spilled past the in-memory
    // buffer. A foreground task whose output stayed in memory leaves nothing on
    // disk — release the buffer and skip persistence so it never accumulates as
    // an undiscoverable log.
    if (entry.outputPersistStarted) {
      await this.persistLive(entry);
    } else {
      entry.pendingOutput = [];
      entry.pendingOutputBytes = 0;
    }
    this.fireTerminalEffects(entry);
    entry.foregroundRelease?.resolve('terminal');
    entry.terminal.resolve();
  }

  /**
   * 从活跃的 managed task 构建完整的 {@link BackgroundTaskInfo} 快照，
   * 通过将基础字段与具体任务的 `toInfo()` 输出组合。
   */
  private toInfo(entry: ManagedTask): BackgroundTaskInfo {
    const base: BackgroundTaskInfoBase = {
      taskId: entry.taskId,
      description: entry.task.description,
      status: entry.status,
      detached: this.isDetached(entry),
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      terminalNotificationSuppressed: entry.terminalNotificationSuppressed,
      timeoutMs: entry.options.timeoutMs,
    };
    return entry.task.toInfo(base);
  }
}

function backgroundTaskNotificationChildren(
  output: BackgroundTaskOutputSnapshot,
): readonly string[] | undefined {
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function renderOutputFileBlock(outputPath: string, outputSizeBytes: number): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    '</output-file>',
  ].join('\n');
}

function renderOutputPreviewBlock(output: BackgroundTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

function notificationKey(origin: BackgroundTaskOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}

/** 为终端任务构建可读的通知正文。对 Agent 任务包含恢复说明。 */
function buildBackgroundTaskNotificationBody(info: BackgroundTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.stopReason
        ? `${info.description} ${info.status === 'killed' ? 'was killed' : info.status}: ${info.stopReason
        }.`
        : `${info.description} ${info.status}.`;

  if (info.kind !== 'agent') return baseLine;
  if (info.status === 'completed') return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}

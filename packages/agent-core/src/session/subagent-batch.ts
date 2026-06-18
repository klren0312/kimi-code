import { isProviderRateLimitError, type TokenUsage } from '@moonshot-ai/kosong';
import * as retry from 'retry';

import type {
  RunSubagentOptions,
  SpawnSubagentOptions,
  SubagentHandle,
} from './subagent-host';
import { isUserCancellation } from '../utils/abort';

/*
子代理批量调度契约：
正常阶段：
- 按输入顺序返回结果；空输入返回空列表。
- 立即启动最多 5 个任务，之后每 700ms 启动 1 个，直到队列中没有剩余任务；活跃任务不限制此增长。
- 启动优先级：速率限制后保存的代理 ID、显式恢复，然后是新生成。
- 就绪状态可以在尝试活跃期间报告。已就绪的正常启动为首次速率限制提供容量。
- 首次提供方速率限制会停止增长并进入速率限制阶段。

速率限制阶段：
- 提供方速率限制会在还有其他未完成工作时重新排队。保存代理 ID 用于同代理重试，发出挂起事件，并将任务重新排到队首；其自身的资格延迟为 3000ms、6000ms、12000ms，之后翻倍。
- 如果被速率限制的尝试是唯一未完成的任务，则直接使该任务失败，而不是永远挂起整个批次。
- 进入时容量等于已就绪的正常启动数，最小为 1；设置下次全局启动不早于 3000ms 后；然后容量缩减 1，最小为 1。后续速率限制缩减 1，最小为 1，每 2000ms 最多缩减一次。
- 每次通过最多启动 1 个任务：活跃尝试数必须低于容量，全局启动时间已到达，且任务资格已到达。选择第一个符合条件的排队任务，然后设置下次全局启动为当前时间加上当前间隔。如果被时间阻塞或启动后仍有排队任务，则在下一个启动/资格和下一个容量恢复的较早时间唤醒。

核心恢复规则：在速率限制阶段，如果队列中有工作且 3 分钟内没有发生提供方速率限制，容量增加 1，可立即启动一个更多任务。每个安静窗口仅发生一次；新的速率限制会重启该窗口。如果活跃尝试仍占满容量，则在下一个恢复时间唤醒。

结果和取消：
- 已完成、失败、已中止和超时的尝试占据其输入槽位；当所有槽位都有结果时，返回有序列表。任务超时仅使该任务失败，不会进入速率限制阶段或停止其他任务。
- 首个任务的信号是批次信号。用户取消保留现有结果，将已就绪或代理已知的未完成任务标记为已中止/已启动，将从未启动的任务标记为已中止/未启动。非用户取消则拒绝。
*/

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 3 * 60 * 1000;
const RATE_LIMIT_SUSPENDED_REASON = 'Provider rate limit; subagent requeued for retry.';

type BaseQueuedSubagentTask<T> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly swarmItem?: string;
  readonly runInBackground: boolean;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
};

export type SpawnQueuedSubagentTask<T = unknown> = BaseQueuedSubagentTask<T> & {
  readonly kind: 'spawn';
  readonly resumeAgentId?: undefined;
};

export type ResumeQueuedSubagentTask<T = unknown> = BaseQueuedSubagentTask<T> & {
  readonly kind: 'resume';
  readonly resumeAgentId: string;
};

export type QueuedSubagentTask<T = unknown> =
  | SpawnQueuedSubagentTask<T>
  | ResumeQueuedSubagentTask<T>;

export type SubagentResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type SubagentSuspendedEvent = {
  readonly task: QueuedSubagentTask;
  readonly agentId: string;
  readonly reason: string;
};

export type SubagentBatchLauncher = {
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  suspended?(event: SubagentSuspendedEvent): void;
};

type RateLimitedOutcome = {
  readonly type: 'rate_limited';
  readonly agentId: string;
  readonly error: string;
};

type AttemptOutcome<T> = SubagentResult<T> | RateLimitedOutcome;

type TaskState<T> = {
  readonly index: number;
  readonly task: QueuedSubagentTask<T>;
  agentId?: string;
  retryAgentId?: string;
  retryCount: number;
  retryReadyAt: number;
  started: boolean;
};

type ActiveAttempt<T> = {
  readonly state: TaskState<T>;
  readonly controller: AbortController;
  cleanup: () => void;
  ready: boolean;
  timedOut: boolean;
};

export class SubagentBatch<T> {
  private readonly states: Array<TaskState<T>>;
  private readonly pending: Array<TaskState<T>>;
  private readonly results: Array<SubagentResult<T> | undefined>;
  private readonly active = new Set<ActiveAttempt<T>>();
  private readonly controller = new AbortController();
  private readonly batchSignal: AbortSignal | undefined;
  private readonly batchAbortListener: () => void;
  private normalLaunchCount = 0;
  private normalLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private resolve: ((results: Array<SubagentResult<T>>) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private finished = false;
  private started = false;
  private rateLimitMode = false;
  private startedSuccessCount = 0;
  private rateLimitCapacity = 1;
  private lastRateLimitAt: number | undefined;
  private lastCapacityShrinkAt: number | undefined;
  private lastCapacityRecoveryAt: number | undefined;
  private globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
  private nextRateLimitLaunchAt = 0;

  constructor(
    private readonly launcher: SubagentBatchLauncher,
    tasks: readonly QueuedSubagentTask<T>[],
  ) {
    this.states = tasks.map((task, index) => ({
      index,
      task,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
    }));
    this.pending = [...this.states];
    this.results = Array.from({ length: tasks.length });
    this.batchSignal = tasks.find((task) => task.signal !== undefined)?.signal;
    this.batchAbortListener = () => {
      this.controller.abort(this.batchSignal?.reason);
      if (isUserCancellation(this.batchSignal?.reason)) {
        this.finishWithUserCancellation();
      } else {
        this.fail(this.batchSignal?.reason ?? new Error('Aborted'));
      }
    };
  }

  run(): Promise<Array<SubagentResult<T>>> {
    if (this.started) {
      throw new Error('SubagentBatch.run() can only be called once.');
    }
    this.started = true;

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      if (this.states.length === 0) {
        this.finish([]);
        return;
      }

      if (this.batchSignal?.aborted === true) {
        this.batchAbortListener();
        return;
      }

      this.batchSignal?.addEventListener('abort', this.batchAbortListener, { once: true });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.finished) return;
    if (this.finishIfComplete()) return;
    if (this.controller.signal.aborted) return;

    if (this.rateLimitMode) {
      this.scheduleRateLimitLaunch();
    } else {
      this.scheduleNormalLaunch();
    }
  }

  private scheduleNormalLaunch(): void {
    while (
      this.normalLaunchCount < INITIAL_LAUNCH_LIMIT &&
      this.pending.length > 0 &&
      !this.rateLimitMode
    ) {
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
    }

    if (
      this.pending.length === 0 ||
      this.rateLimitMode ||
      this.normalLaunchTimer !== undefined
    ) {
      return;
    }

    this.normalLaunchTimer = setTimeout(() => {
      this.normalLaunchTimer = undefined;
      if (this.finished || this.rateLimitMode || this.pending.length === 0) return;
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
      this.schedule();
    }, INITIAL_LAUNCH_INTERVAL_MS);
  }

  private scheduleRateLimitLaunch(): void {
    this.clearRateLimitTimer();
    if (this.pending.length === 0) return;

    const now = Date.now();
    this.recoverRateLimitCapacity(now);
    if (this.active.size >= this.rateLimitCapacity) {
      this.scheduleRateLimitWakeup(this.nextRateLimitCapacityRecoveryAt(), now);
      return;
    }

    const nextAllowedAt = Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt());
    const nextWakeupAt = Math.min(nextAllowedAt, this.nextRateLimitCapacityRecoveryAt());
    if (nextWakeupAt > now) {
      this.scheduleRateLimitWakeup(nextWakeupAt, now);
      return;
    }

    const pendingIndex = this.pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex === -1) return;

    const [state] = this.pending.splice(pendingIndex, 1);
    this.startAttempt(state!);
    this.nextRateLimitLaunchAt = now + this.globalRetryIntervalMs;
    this.scheduleNextRateLimitWakeup(now);
  }

  private startAttempt(state: TaskState<T>): void {
    if (this.finished || this.controller.signal.aborted) return;

    const attempt: ActiveAttempt<T> = {
      state,
      controller: new AbortController(),
      cleanup: () => {},
      ready: false,
      timedOut: false,
    };
    attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
    this.active.add(attempt);

    this.runAttempt(attempt).then(
      (outcome) => {
        this.handleAttemptOutcome(attempt, outcome);
      },
      (error) => {
        this.handleAttemptError(attempt, error);
      },
    );
  }

  private async runAttempt(attempt: ActiveAttempt<T>): Promise<AttemptOutcome<T>> {
    const task = attempt.state.task;
    const runOptions: RunSubagentOptions = {
      parentToolCallId: task.parentToolCallId,
      parentToolCallUuid: task.parentToolCallUuid,
      prompt: task.prompt,
      description: task.description,
      swarmIndex: task.swarmIndex,
      runInBackground: task.runInBackground,
      signal: attempt.controller.signal,
      onReady: () => {
        this.markAttemptReady(attempt);
      },
      suppressRateLimitFailureEvent: true,
    };

    let handle: SubagentHandle;
    try {
      attempt.controller.signal.throwIfAborted();
      if (attempt.state.retryAgentId !== undefined) {
        handle = await this.launcher.retry(attempt.state.retryAgentId, runOptions);
      } else if (task.kind === 'resume') {
        handle = await this.launcher.resume(task.resumeAgentId, runOptions);
      } else {
        const spawnOptions: SpawnSubagentOptions = {
          profileName: task.profileName,
          swarmItem: task.swarmItem,
          ...runOptions,
        };
        handle = await this.launcher.spawn(spawnOptions);
      }
    } catch (error) {
      return this.failedAttemptOutcome(attempt, error);
    }

    attempt.state.agentId = handle.agentId;
    try {
      const completion = await handle.completion;
      return {
        task,
        agentId: handle.agentId,
        status: 'completed',
        result: completion.result,
        usage: completion.usage,
      };
    } catch (error) {
      if (isProviderRateLimitError(error)) {
        return {
          type: 'rate_limited',
          agentId: handle.agentId,
          error: this.attemptErrorMessage(attempt, error, 'failed'),
        };
      }

      return this.failedAttemptOutcome(attempt, error);
    }
  }

  private failedAttemptOutcome(attempt: ActiveAttempt<T>, error: unknown): SubagentResult<T> {
    const status =
      attempt.controller.signal.aborted && isUserCancellation(attempt.controller.signal.reason)
        ? 'aborted'
        : 'failed';
    return {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status,
      state: attempt.state.agentId === undefined ? 'not_started' : 'started',
      error: this.attemptErrorMessage(attempt, error, status),
    };
  }

  private markAttemptReady(attempt: ActiveAttempt<T>): void {
    if (this.finished || attempt.ready || !this.active.has(attempt)) return;

    attempt.ready = true;
    attempt.state.started = true;
    if (!this.rateLimitMode) {
      this.startedSuccessCount += 1;
    }

    if (this.rateLimitMode) {
      this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
      this.nextRateLimitLaunchAt = Date.now() + this.globalRetryIntervalMs;
      this.schedule();
    }
  }

  private handleAttemptOutcome(attempt: ActiveAttempt<T>, outcome: AttemptOutcome<T>): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;

    if ('status' in outcome) {
      this.results[attempt.state.index] = outcome;
    } else if (this.isOnlyUnfinishedTask(attempt.state)) {
      this.results[attempt.state.index] = {
        task: attempt.state.task,
        agentId: outcome.agentId,
        status: 'failed',
        state: 'started',
        error: outcome.error,
      };
    } else {
      this.requeueRateLimited(attempt, outcome.agentId);
    }
    this.schedule();
  }

  private handleAttemptError(attempt: ActiveAttempt<T>, error: unknown): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;
    this.results[attempt.state.index] = {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    this.schedule();
  }

  private releaseAttempt(attempt: ActiveAttempt<T>): boolean {
    if (!this.active.delete(attempt)) return false;
    attempt.cleanup();
    return true;
  }

  private requeueRateLimited(attempt: ActiveAttempt<T>, agentId: string): void {
    const state = attempt.state;
    state.agentId = agentId;
    state.retryAgentId = agentId;
    this.launcher.suspended?.({
      task: state.task,
      agentId,
      reason: RATE_LIMIT_SUSPENDED_REASON,
    });

    const now = Date.now();
    this.lastRateLimitAt = now;
    state.retryCount += 1;
    const retryDelay = retry.createTimeout(Math.max(0, state.retryCount - 1), {
      minTimeout: RATE_LIMIT_RETRY_BASE_MS,
      maxTimeout: Number.POSITIVE_INFINITY,
      factor: RATE_LIMIT_RETRY_FACTOR,
      randomize: false,
    });
    state.retryReadyAt = now + retryDelay;
    this.pending.unshift(state);
    this.enterRateLimitMode(now);

    if (!attempt.ready) {
      this.globalRetryIntervalMs = Math.max(this.globalRetryIntervalMs * 2, retryDelay);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + this.globalRetryIntervalMs,
      );
    } else {
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
    }
  }

  private enterRateLimitMode(now: number): void {
    if (!this.rateLimitMode) {
      this.rateLimitMode = true;
      this.clearNormalTimer();
      this.rateLimitCapacity = Math.max(1, this.startedSuccessCount);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
      this.shrinkRateLimitCapacity(now, true);
      return;
    }

    this.shrinkRateLimitCapacity(now, false);
  }

  private shrinkRateLimitCapacity(now: number, force: boolean): void {
    if (
      !force &&
      this.lastCapacityShrinkAt !== undefined &&
      now - this.lastCapacityShrinkAt < RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
    ) {
      return;
    }

    this.rateLimitCapacity = Math.max(1, this.rateLimitCapacity - 1);
    this.lastCapacityShrinkAt = now;
  }

  private recoverRateLimitCapacity(now: number): void {
    const nextRecoveryAt = this.nextRateLimitCapacityRecoveryAt();
    if (nextRecoveryAt > now) return;

    this.rateLimitCapacity += 1;
    this.lastCapacityRecoveryAt = now;
    this.nextRateLimitLaunchAt = Math.min(this.nextRateLimitLaunchAt, now);
  }

  private nextRateLimitCapacityRecoveryAt(): number {
    if (this.pending.length === 0 || this.lastRateLimitAt === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    const latestCapacityChangeAt = Math.max(
      this.lastRateLimitAt,
      this.lastCapacityRecoveryAt ?? 0,
    );
    return latestCapacityChangeAt + RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
  }

  private scheduleRateLimitWakeup(wakeupAt: number, now: number): void {
    if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return;
    this.rateLimitLaunchTimer = setTimeout(() => {
      this.rateLimitLaunchTimer = undefined;
      this.schedule();
    }, wakeupAt - now);
  }

  private scheduleNextRateLimitWakeup(now: number): void {
    if (this.pending.length === 0) return;

    const nextWakeupAt =
      this.active.size >= this.rateLimitCapacity
        ? this.nextRateLimitCapacityRecoveryAt()
        : Math.min(
            Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt()),
            this.nextRateLimitCapacityRecoveryAt(),
          );

    this.scheduleRateLimitWakeup(nextWakeupAt, now);
  }

  private nextPendingReadyAt(): number {
    return this.pending.reduce((nextAt, state) => {
      return Math.min(nextAt, state.retryReadyAt);
    }, Number.POSITIVE_INFINITY);
  }

  private finishIfComplete(): boolean {
    if (this.results.every((result) => result !== undefined)) {
      this.finish(this.results);
      return true;
    }
    return false;
  }

  private isOnlyUnfinishedTask(state: TaskState<T>): boolean {
    return this.results.every((result, index) => index === state.index || result !== undefined);
  }

  private finishWithUserCancellation(): void {
    if (this.finished) return;

    this.finish(
      this.states.map((state) => {
        const result = this.results[state.index];
        if (result !== undefined) return result;

        if (state.started || state.agentId !== undefined) {
          return {
            task: state.task,
            agentId: state.agentId,
            status: 'aborted',
            state: 'started',
            error:
              'The user manually interrupted this subagent batch before this subagent finished.',
          };
        }

        return {
          task: state.task,
          status: 'aborted',
          state: 'not_started',
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        };
      }),
    );
  }

  private finish(results: Array<SubagentResult<T>>): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.resolve?.(results);
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.reject?.(error);
  }

  private cleanup(): void {
    this.batchSignal?.removeEventListener('abort', this.batchAbortListener);
    this.clearNormalTimer();
    this.clearRateLimitTimer();
    for (const attempt of this.active.values()) {
      attempt.cleanup();
    }
    this.active.clear();
  }

  private clearNormalTimer(): void {
    if (this.normalLaunchTimer !== undefined) clearTimeout(this.normalLaunchTimer);
    this.normalLaunchTimer = undefined;
  }

  private clearRateLimitTimer(): void {
    if (this.rateLimitLaunchTimer !== undefined) clearTimeout(this.rateLimitLaunchTimer);
    this.rateLimitLaunchTimer = undefined;
  }

  private linkAttemptSignals(attempt: ActiveAttempt<T>, task: QueuedSubagentTask<T>): () => void {
    const abortFromBatch = () => {
      attempt.controller.abort(this.controller.signal.reason);
    };
    const abortFromTask = () => {
      attempt.controller.abort(task.signal?.reason);
    };
    const timeout =
      task.timeout === undefined
        ? undefined
        : setTimeout(() => {
            attempt.timedOut = true;
            attempt.controller.abort(new Error('Aborted'));
          }, task.timeout);

    if (this.controller.signal.aborted) {
      abortFromBatch();
    } else if (task.signal?.aborted === true) {
      abortFromTask();
    } else {
      this.controller.signal.addEventListener('abort', abortFromBatch, { once: true });
      task.signal?.addEventListener('abort', abortFromTask, { once: true });
    }

    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      this.controller.signal.removeEventListener('abort', abortFromBatch);
      task.signal?.removeEventListener('abort', abortFromTask);
    };
  }

  private attemptErrorMessage(
    attempt: ActiveAttempt<T>,
    error: unknown,
    status: SubagentResult<T>['status'],
  ): string {
    if (attempt.timedOut && attempt.state.task.timeout !== undefined) {
      return 'Subagent timed out.';
    }
    if (status === 'aborted') return 'The user manually interrupted this subagent batch.';
    return error instanceof Error ? error.message : String(error);
  }
}

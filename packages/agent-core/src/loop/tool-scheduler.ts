/**
 * 单个模型步骤中工具调用的有状态执行调度器。
 *
 * 调度器仅负责执行顺序：
 *   - 资源访问不冲突的任务可以重叠执行
 *   - 资源访问冲突的任务等待冲突的活动任务完成
 *   - 完成的结果按提供者顺序返回
 *
 * 验证、钩子、事件构建和结果终结保留在 `tool-call.ts` 中。
 */

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';

import { ToolAccesses } from './tool-access';

// 调度器

export interface ToolCallTask<Result> {
  readonly accesses: ToolAccesses;
  readonly start: () => Promise<{ readonly result: Promise<Result> }>;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly result: ControlledPromise<Result>;
}

export class ToolScheduler<Result> {
  private readonly activeTasks: Array<ScheduledToolCallTask<Result>> = [];
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];

  add(task: ToolCallTask<Result>): Promise<Result> {
    const result = createControlledPromise<Result>();
    void result.catch(() => undefined);

    const scheduledTask: ScheduledToolCallTask<Result> = { ...task, result };
    if (this.isBlocked(task, this.queuedTasks)) {
      this.queuedTasks.push(scheduledTask);
    } else {
      this.start(scheduledTask);
    }

    return result;
  }

  private isBlocked(
    task: ToolCallTask<Result>,
    queuedBefore: readonly ToolCallTask<Result>[],
  ): boolean {
    return (
      this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore)
    );
  }

  private conflictsWithAny(
    task: ToolCallTask<Result>,
    candidates: readonly ToolCallTask<Result>[],
  ): boolean {
    return candidates.some((candidate) =>
      ToolAccesses.conflict(task.accesses, candidate.accesses),
    );
  }

  private start(task: ScheduledToolCallTask<Result>): void {
    this.activeTasks.push(task);
    let started: Promise<{ readonly result: Promise<Result> }>;
    try {
      started = task.start();
    } catch (error) {
      task.result.reject(error);
      this.finish(task);
      return;
    }

    void started
      .then(({ result }) => result)
      .then(task.result.resolve, task.result.reject)
      .finally(() => {
        this.finish(task);
      });
  }

  private finish(task: ScheduledToolCallTask<Result>): void {
    const index = this.activeTasks.indexOf(task);
    if (index >= 0) this.activeTasks.splice(index, 1);
    this.startQueuedTasks();
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (this.isBlocked(task, stillQueued)) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}

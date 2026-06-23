/**
 * `TaskService` — `ITaskService` 的实现。
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { BackgroundTask } from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { SessionNotFoundError } from '../session/session';
import {
  ITaskService,
  TaskNotFoundError,
  TaskAlreadyFinishedError,
  toProtocolTask,
  isTerminalStatus,
  type GetTaskOptions,
  type TaskListQuery,
} from './task';

const MAIN_AGENT_ID = 'main';
const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

export class TaskService extends Disposable implements ITaskService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sessionId: string, query: TaskListQuery): Promise<readonly BackgroundTask[]> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const all = raw.map((info) => toProtocolTask(sessionId, info));
    if (query.status !== undefined) {
      return all.filter((t) => t.status === query.status);
    }
    return all;
  }

  async get(
    sessionId: string,
    taskId: string,
    options?: GetTaskOptions,
  ): Promise<BackgroundTask> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }

    let output: { preview: string; bytes: number } | undefined;
    if (options?.withOutput) {
      const tailBytes = options.outputBytes ?? DEFAULT_TASK_OUTPUT_PREVIEW_BYTES;
      try {
        const preview = await this.core.rpc.getBackgroundOutput({
          sessionId,
          agentId: MAIN_AGENT_ID,
          taskId,
          tail: tailBytes,
        });
        if (preview.length > 0) {
          output = { preview, bytes: Buffer.byteLength(preview, 'utf-8') };
        }
      } catch {
        // 输出可能尚未可用，仅回退到任务元数据。
      }
    }

    return toProtocolTask(sessionId, found, output);
  }

  async cancel(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    await this._requireSession(sessionId);
    // 预取以便确定性地区分 40406（未找到）和 40904（已完成）场景 —
    // agent-core 的 `stopBackground` 是 fire-and-forget 调用，不会暴露此信息。
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }
    const wireStatus = toProtocolTask(sessionId, found).status;
    if (isTerminalStatus(wireStatus)) {
      throw new TaskAlreadyFinishedError(sessionId, taskId, wireStatus);
    }
    await this.core.rpc.stopBackground({
      sessionId,
      agentId: MAIN_AGENT_ID,
      taskId,
    });
    return { cancelled: true };
  }

  // --- 内部方法 ------------------------------------------------------------

  private async _requireSession(sessionId: string): Promise<void> {
    const all = await this.core.rpc.listSessions({});
    if (!all.some((s) => s.id === sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  private async _getAllRaw(
    sessionId: string,
  ): Promise<ReadonlyArray<Awaited<ReturnType<typeof this.core.rpc.getBackground>>[number]>> {
    try {
      return await this.core.rpc.getBackground({
        sessionId,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session 未加载，视为空列表。
      return [];
    }
  }
}

// 在全局单例注册表中自注册。所有构造函数依赖通过 `@I…` 注入；`staticArguments = []`。
// `supportsDelayedInstantiation = false` 保留当前反向释放语义。
registerSingleton(ITaskService, TaskService, InstantiationType.Delayed);

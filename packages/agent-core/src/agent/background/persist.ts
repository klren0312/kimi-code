/**
 * 后台任务持久化辅助工具。
 *
 * 每个任务存储在 `<sessionDir>/tasks/<taskId>.json`，以便 CLI 重启时
 * 可以列出之前运行中的任务（现已丢失）并发出终态通知。
 *
 * 基于 ID 的 JSON 层（写入 / 读取 / 列表）委托给 `createPerIdJsonStore`，
 * 该工具集中了原子写入 + 路径遍历保护的 readdir，供 cron / background 以及
 * 任何需要会话范围基于 ID 的 JSON 存储的场景使用。本类将后台特定的数据结构
 * 和 output.log 辅助方法组合在一起。
 */

import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from './task';

/**
 * 任务 ID 格式：`{prefix}-{8 位 [0-9a-z] 字符}`。
 *
 * 在派生任务路径之前严格验证，以防止路径遍历（`../`）或旧版 `bg_<hex>` 格式
 * 通过持久化层逃逸。前缀故意保持开放，以便新增任务类型时无需修改持久化层。
 */
const VALID_TASK_ID: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;

type PersistedTask = BackgroundTaskInfo;

type DiskPersistedTask = PersistedTask | LegacyPersistedTask;

function tasksDirOf(sessionDir: string): string {
  return join(sessionDir, 'tasks');
}

function taskOutputDir(sessionDir: string, taskId: string): string {
  if (!VALID_TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id: "${taskId}"`);
  }
  return join(tasksDirOf(sessionDir), taskId);
}

function taskOutputFile(sessionDir: string, taskId: string): string {
  return join(taskOutputDir(sessionDir, taskId), 'output.log');
}

/**
 * 处理后台任务的磁盘持久化。
 *
 * 每个任务的元数据存储为 JSON 文件，位于 `<sessionDir>/tasks/<taskId>.json`，
 * 输出日志位于 `<sessionDir>/tasks/<taskId>/output.log`。JSON 层委托给
 * {@link createPerIdJsonStore} 进行原子写入和路径遍历安全的读取。
 * 本类在此基础上添加了后台特定的 output.log 辅助方法和旧版格式迁移功能。
 */
export class BackgroundTaskPersistence {
  private readonly store: PerIdJsonStore<DiskPersistedTask>;

  /**
   * 创建一个作用于会话目录的持久化实例。
   * `tasks/` 子目录同时用于 JSON 元数据和输出日志。
   */
  constructor(private readonly sessionDir: string) {
    this.store = createPerIdJsonStore<DiskPersistedTask>({
      rootDir: sessionDir,
      subdir: 'tasks',
      idRegex: VALID_TASK_ID,
      isValid: isReadablePersistedTask,
      entityName: 'task id',
    });
  }

  /** 返回任务 `output.log` 文件的绝对路径。 */
  taskOutputFile(taskId: string): string {
    return taskOutputFile(this.sessionDir, taskId);
  }

  /** 原子写入任务的持久化状态。按需创建目录。 */
  async writeTask(task: PersistedTask): Promise<void> {
    await this.store.write(task.taskId, task);
  }

  /** 读取单个任务文件。缺失/损坏/无法识别时返回 undefined。 */
  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    const task = await this.store.read(taskId);
    return task === undefined ? undefined : normalizePersistedTask(task);
  }

  /**
   * 向任务的 `output.log` 文件追加一块输出。
   * 如果任务目录尚不存在，则创建该目录。
   */
  async appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    const path = this.taskOutputFile(taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, chunk, 'utf-8');
  }

  /**
   * 任务 `output.log` 的总字节大小。当日志尚不存在时返回 0
   * （任务未产生任何输出，或任务未知）。
   *
   * 这是权威的完整输出大小——与内存中的环形缓冲区不同，它永远不会被截断，
   * 因此调用者可以报告任务实际产生了多少输出。
   */
  async taskOutputSizeBytes(taskId: string): Promise<number> {
    try {
      const st = await stat(this.taskOutputFile(taskId));
      return st.size;
    } catch {
      return 0;
    }
  }

  /** 检查任务的 `output.log` 文件是否存在于磁盘上。 */
  async taskOutputExists(taskId: string): Promise<boolean> {
    try {
      return (await stat(this.taskOutputFile(taskId))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 读取任务 `output.log` 的一个字节窗口。
   *
   * 从字节 `offset` 开始读取最多 `maxBytes` 字节。超出 EOF 的窗口会截断到
   * 剩余内容；在 EOF 处或之后的 `offset` 返回空字符串。日志不存在时返回空字符串。
   *
   * 基于字节级别（而非行级别）的分页方式与完整日志在磁盘上的存储方式一致，
   * 因此调用者可以分页读取任意大小的日志，而无需将整个文件加载到内存中。
   */
  async readTaskOutputBytes(taskId: string, offset: number, maxBytes: number): Promise<string> {
    const start = Math.max(0, Math.trunc(offset));
    const limit = Math.max(0, Math.trunc(maxBytes));
    if (limit === 0) return '';
    let handle;
    try {
      handle = await open(this.taskOutputFile(taskId), 'r');
    } catch {
      return '';
    }
    try {
      const size = (await handle.stat()).size;
      if (start >= size) return '';
      const length = Math.min(limit, size - start);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.toString('utf-8', 0, bytesRead);
    } catch {
      return '';
    } finally {
      await handle.close();
    }
  }

  /**
   * 枚举会话的所有已持久化任务。
   *
   * 静默跳过以下情况：
   *   - 不匹配 `VALID_TASK_ID` 的文件名（杂散文件、旧版 `bg_*` 残留、部分写入的临时文件）；
   *   - 读取/解析失败的文件；
   *   - 既无法识别为当前 camelCase 格式也无法识别为旧版 snake_case 任务格式的记录。
   *
   * 旧版 snake_case 记录会在内存中被规范化为当前的 `BackgroundTaskInfo`。
   * 下一次生命周期/协调写入会将其以当前格式存储回来，因此兼容性是只读的，
   * 并且会趁机迁移，无需单独的迁移步骤。
   *
   * `writeTask` 使用原子临时文件+重命名，因此生产环境中真正的截断文件
   * 很少发生；如果确实发生，我们接受数据丢失，而不是发出一个除了文件名
   * 之外没有可恢复元数据的幽灵记录。
   */
  async listTasks(): Promise<readonly PersistedTask[]> {
    const tasks = await this.store.list();
    return tasks.map(normalizePersistedTask);
  }
}

function normalizePersistedTask(task: DiskPersistedTask): PersistedTask {
  if (isLegacyPersistedTask(task)) return legacyPersistedTaskToInfo(task);
  return {
    ...task,
    detached: task.detached ?? true,
  };
}

type LegacyBackgroundTaskStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'lost';

interface LegacyPersistedTask {
  readonly task_id: string;
  readonly command: string;
  readonly description: string;
  readonly pid: number;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly exit_code: number | null;
  readonly status: LegacyBackgroundTaskStatus;
  readonly timed_out?: boolean;
  readonly stop_reason?: string;
  readonly timeout_ms?: number;
  readonly agent_id?: string;
  readonly subagent_type?: string;
}

function legacyPersistedTaskToInfo(task: LegacyPersistedTask): PersistedTask {
  const status = legacyStatusToCurrent(task);
  const stopReason = optionalNonEmptyString(task.stop_reason);
  const timeoutMs = typeof task.timeout_ms === 'number' ? task.timeout_ms : undefined;
  const base = {
    taskId: task.task_id,
    description: task.description,
    status,
    detached: true,
    startedAt: task.started_at,
    endedAt: task.ended_at,
    stopReason,
    timeoutMs,
  };

  if (task.task_id.startsWith('agent-')) {
    return {
      ...base,
      kind: 'agent',
      agentId: optionalNonEmptyString(task.agent_id),
      subagentType: optionalNonEmptyString(task.subagent_type),
    };
  }

  return {
    ...base,
    kind: 'process',
    command: task.command,
    pid: task.pid,
    exitCode: task.exit_code,
  };
}

function legacyStatusToCurrent(task: LegacyPersistedTask): BackgroundTaskStatus {
  if (task.status === 'awaiting_approval') return 'running';
  if (task.status === 'failed' && task.timed_out === true) return 'timed_out';
  return task.status;
}

function isReadablePersistedTask(obj: unknown): obj is DiskPersistedTask {
  return (
    isRecord(obj) &&
    (typeof obj['taskId'] === 'string' || typeof obj['task_id'] === 'string')
  );
}

function isLegacyPersistedTask(task: DiskPersistedTask): task is LegacyPersistedTask {
  return 'task_id' in task;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

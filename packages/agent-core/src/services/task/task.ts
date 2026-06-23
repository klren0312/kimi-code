/**
 * `ITaskService` — 面向守护进程的后台任务查询层。
 *
 * 封装 `ICoreProcessService.rpc.{getBackground, stopBackground}`，将
 * `BackgroundTaskInfo`（驼峰式 + 毫秒时间戳 + agent-core 字面量集合）
 * 转换为 SCHEMAS §7 `BackgroundTask`（下划线式 + ISO 时间 + 规范字面量集合）。
 *
 * 适配器辅助函数（`toProtocolTask`、`isTerminalStatus`）在此文件中同位定义。
 *
 * **使用的 CoreAPI 表面**：
 *   - `core.rpc.getBackground({sessionId, agentId, activeOnly?, limit?})
 *      => readonly BackgroundTaskInfo[]`
 *    （packages/agent-core/src/rpc/core-api.ts:334 + WithSessionId+WithAgentId 注入）。
 *   - `core.rpc.stopBackground({sessionId, agentId, taskId, reason?})`
 *    （第 323 行）。
 *
 * **错误模型**：
 *   - 当任务 id 在会话中不存在时抛出 `TaskNotFoundError`（→ 40406）。
 *   - 当任务已达到终态（completed/failed/cancelled/timed_out/killed/lost）时
 *     抛出 `TaskAlreadyFinishedError`（→ 40904）。
 *
 * **防腐层**：仅从 `@moonshot-ai/agent-core` 导入 `createDecorator` 值和
 * `BackgroundTaskInfo` 类型。
 *
 * 参考映射表（任务 kind + status）：
 *
 *   kind:    process   → bash
 *            agent     → subagent
 *            question  → tool
 *
 *   status:  running   → running
 *            completed → completed
 *            failed    → failed
 *            timed_out → failed       （有损——stopReason 携带提示信息）
 *            killed    → cancelled
 *            lost      → failed       （有损）
 */

import { createDecorator } from '../../di';
import type { BackgroundTaskInfo } from '../../agent/background';
import type { BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus } from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// 适配器辅助函数（从 adapter/task-adapter.ts 迁移）
// ---------------------------------------------------------------------------

function mapKind(k: BackgroundTaskInfo['kind']): BackgroundTaskKind {
  switch (k) {
    case 'process':
      return 'bash';
    case 'agent':
      return 'subagent';
    case 'question':
      // SCHEMAS §7 没有 'question' 字面量；question 后台任务是由工具生成的流程
     //（Loop 作为 `Question` 工具执行的一部分运行），因此 'tool' 是最接近的规范字面量。
      return 'tool';
  }
}

function mapStatus(s: BackgroundTaskInfo['status']): BackgroundTaskStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      // SCHEMAS §7 没有 'timed_out' 字面量；折叠为 'failed'。
     // 可选的 `stop_reason`/`last_error` 字段会在 SCHEMAS 添加该字段时携带提示信息（已推迟）。
      return 'failed';
    case 'killed':
      return 'cancelled';
    case 'lost':
      return 'failed';
  }
}

const TERMINAL_WIRE_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: BackgroundTaskStatus): boolean {
  return TERMINAL_WIRE_STATUSES.has(status);
}

export interface TaskOutputSnapshot {
  readonly preview: string;
  readonly bytes: number;
}

export interface GetTaskOptions {
  readonly withOutput?: boolean;
  readonly outputBytes?: number;
}

export function toProtocolTask(
  sessionId: string,
  info: BackgroundTaskInfo,
  output?: TaskOutputSnapshot,
): BackgroundTask {
  const status = mapStatus(info.status);
  const createdIso = new Date(info.startedAt).toISOString();
  const base: BackgroundTask = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status,
    // Agent-core 没有单独的创建时间戳；我们从 startedAt 合成——
    // 运行中的任务通常在创建后立即启动。
    created_at: createdIso,
    started_at: createdIso,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    base.completed_at = new Date(info.endedAt).toISOString();
  }
  if (info.kind === 'process' && 'command' in info && typeof info.command === 'string') {
    base.command = info.command;
  }
  if (output !== undefined) {
    base.output_preview = output.preview;
    base.output_bytes = output.bytes;
  }
  return base;
}

// ---------------------------------------------------------------------------
// 接口 + 实现
// ---------------------------------------------------------------------------

export interface TaskListQuery {
  readonly status?: BackgroundTaskStatus;
}

export interface ITaskService {
  readonly _serviceBrand: undefined;

  /** 返回会话的（完整）后台任务列表。 */
  list(sessionId: string, query: TaskListQuery): Promise<readonly BackgroundTask[]>;

  /**
   * 返回单个后台任务。未找到时抛出 `TaskNotFoundError`（→ 40406）。
   *
   * 传入 `withOutput: true` 以在响应中包含任务捕获的输出
   *（`output_preview` / `output_bytes`）。`outputBytes` 将返回的预览
   * 限制为最后 N 字节；省略时使用服务端默认上限。
   */
  get(sessionId: string, taskId: string, options?: GetTaskOptions): Promise<BackgroundTask>;

  /**
   * 取消正在运行的任务。抛出：
   *   - `TaskNotFoundError`        → 40406
   *   - `TaskAlreadyFinishedError` → 40904（守护进程发出自定义信封，
   *     含 `data:{cancelled:false}`）
   */
  cancel(sessionId: string, taskId: string): Promise<{ cancelled: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITaskService = createDecorator<ITaskService>('taskService');

/**
 * 哨兵错误——守护进程路由映射为 `code: 40406 task.not_found`。
 */
export class TaskNotFoundError extends Error {
  readonly sessionId: string;
  readonly taskId: string;
  constructor(sessionId: string, taskId: string) {
    super(`task ${taskId} does not exist in session ${sessionId}`);
    this.name = 'TaskNotFoundError';
    this.sessionId = sessionId;
    this.taskId = taskId;
  }
}

/**
 * 哨兵错误——守护进程路由映射为 `code: 40904 task.already_finished`。
 * 信封的 `data` 形状为 `{ cancelled: false }`（REST.md §3.7 的幂等形状，
 * 沿袭 40903 + 40902 的先例）。
 */
export class TaskAlreadyFinishedError extends Error {
  readonly sessionId: string;
  readonly taskId: string;
  readonly currentStatus: BackgroundTaskStatus;
  constructor(sessionId: string, taskId: string, currentStatus: BackgroundTaskStatus) {
    super(`task ${taskId} already finished (status: ${currentStatus})`);
    this.name = 'TaskAlreadyFinishedError';
    this.sessionId = sessionId;
    this.taskId = taskId;
    this.currentStatus = currentStatus;
  }
}

void ITaskService;

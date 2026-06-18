/**
 * CronDeleteTool — 按 id 取消已调度的 cron 任务。
 *
 * 工具的职责有意地窄：验证 id 形态，请求会话存储删除条目，
 * 并报告是否实际删除了任何内容。调度器在下一次 `tick()` 自动
 * 感知删除，因为 `source: () => store.list()` 每次都会重新读取
 * — 没有需要保持同步的单独"取消订阅"握手。
 *
 * 为什么"未找到"报告为错误：
 *
 *   - 模型使用结果字符串决定是否跟进（例如确认给用户、重试或继续）。
 *     对空操作返回成功形式的消息会静默地教会模型 CronDelete 对缺失 id
 *     是幂等的，但它不是 — 下一次 `CronList` 仍会显示模型认为已删除的 id。
 *     展示 `isError: true` 让模型自我纠正（通常通过再次调用 `CronList`）。
 *
 * 为什么未找到分支不向管理器查询遥测：
 *
 *   - `cron_deleted` 记录实际状态变更。在未命中时发送会膨胀指标并破坏
 *     与 `cron_create`（在被拒绝的调度上从不触发）的对称性。该分支已通过
 *     工具调用遥测完全可观测。
 *
 * 此工具参与的刷新 cron 模式：
 *
 *   当 `CronList`（或已触发任务的来源）报告 `stale: true` 时，
 *   文档化的"刷新"流程是 `CronDelete(id)` 后跟使用相同 cron + prompt
 *   的新 `CronCreate`。这会重置 `createdAt`，清除 stale 标志，
 *   并以新任务 id 重新加入防群聚抖动抽签。文档字符串阐明了这一点，
 *   以便模型无需系统消息提示即可使用。
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import CRON_DELETE_DESCRIPTION from './cron-delete.md?raw';

// ── 常量 ────────────────────────────────────────────────────────

/**
 * 与 `SessionCronStore` 和磁盘持久层使用的相同 id 形态。
 * 在此重新检查使畸形 id 永远不会到达存储 — 该正则表达式是
 * 线上 id 格式的唯一真理来源，提前拒绝使错误消息贴近用户输入。
 */
const ID_PATTERN = /^[0-9a-f]{8}$/;

// ── 输入 schema ─────────────────────────────────────────────────────

export const CronDeleteInputSchema = z.object({
  id: z
    .string()
    .describe('The 8-hex cron job id returned by CronCreate / CronList.'),
});
export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;

// ── 实现 ───────────────────────────────────────────────────

export class CronDeleteTool implements BuiltinTool<CronDeleteInput> {
  readonly name = 'CronDelete' as const;
  readonly description = CRON_DELETE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronDeleteInputSchema,
  );

  constructor(private readonly manager: CronManager) {}

  resolveExecution(args: CronDeleteInput): ToolExecution {
    // 先做格式检查。存储无论如何会拒绝查找，但当消息明确指出约束
    // （"8 个小写十六进制字符"）而非通用的"未找到"时更具可操作性。
    if (!ID_PATTERN.test(args.id)) {
      return {
        isError: true,
        output: `Invalid cron job id ${JSON.stringify(
          args.id,
        )} — must be 8 lowercase hex characters.`,
      };
    }

    return {
      description: `Deleting cron ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        const removed = this.manager.removeTasks([args.id]);
        if (removed.length === 0) {
          // 未找到报告为错误，以便模型自我纠正 — 参见模块头部的理由。
          // 这里故意不发送 `cron_deleted`；该指标跟踪真实状态变更。
          return {
            isError: true,
            output: `No cron job with id ${args.id}.`,
          };
        }

        // 遥测通过管理器进行，使工具不接触 `manager.agent.telemetry`
        // — 与 `CronCreate` 使用 `emitScheduled` 对称。
        this.manager.emitDeleted(args.id);

        return {
          output: `Deleted cron job ${args.id}.`,
          isError: false,
        };
      },
    };
  }
}

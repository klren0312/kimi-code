/**
 * CronListTool — 枚举当前会话中已调度的 cron 任务。
 *
 * 只读且无副作用。输出镜像 `tools/background/task-list.ts` 使用的
 * `key: value\n---\n` 形状，以便 LLM 在"列出已调度工作"工具中
 * 看到一致的记录布局。
 *
 * 每条记录包含：
 *
 *   - `id`            — 8 位十六进制任务 id（CronDelete 也接受）。
 *   - `cron`          — 调度时的原始 5 字段表达式。
 *   - `humanSchedule` — 通过 `cronToHuman` 尽力生成的纯英文渲染；
 *                       表达式无法解析时回退到原始 `cron` 字符串。
 *   - `nextFireAt`    — 抖动后的本地 ISO 时间戳（带偏移），
 *                       或当 5 年窗口内无触发（或表达式畸形）时
 *                       为字面字符串 `null`。这与 `CronCreate` 报告的
 *                       抖动值相同，以便 LLM 无意外地推理防群聚偏移。
 *   - `recurring`     — 除非任务显式创建为 `recurring: false`，
 *                       否则为 `true`。
 *   - `ageDays`       — `(wallNow - createdAt) / day`，格式化为两位小数。
 *                       为 `stale` 标志和 LLM 的"是否还应运行？"
 *                       判断提供有用上下文。
 *   - `stale`         — 镜像 `CronManager.isStale(task)`；精确规则
 *                       见该方法（`recurring && age >= 7 天`，
 *                       受 `KIMI_CRON_NO_STALE` 控制）。
 *
 * 工具对畸形 cron 字符串永不抛异常。解析路径周围的防御性 try/catch
 * 使记录能以原始 `cron` 渲染，`humanSchedule` 回退等于 `cron`，
 * `nextFireAt: null` — 这对通过 `CronCreate`（有验证）的任务
 * 永远不会发生，但防御未来直接的 `store.add(...)` 插入。
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import {
  cronToHuman,
  parseCronExpression,
} from './cron-expr';
import { formatLocalIsoWithOffset } from './time-format';
import type { CronTask } from './types';
import CRON_LIST_DESCRIPTION from './cron-list.md?raw';

// ── 输入 schema ─────────────────────────────────────────────────────

/**
 * 无参数。严格模式使循环的 AJV 验证器拒绝意外的额外字段
 * （例如从 `TaskList` 借用的 `active_only`）而非静默忽略。
 */
export const CronListInputSchema = z.object({}).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;

// ── 常量 ────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// 将每个渲染的 prompt 限制在 200 UTF-8 字节，防止 50 个任务的列表
// 带有千字节级 prompt 时撑爆上下文窗口。
const PROMPT_PREVIEW_BYTES = 200;

function previewPrompt(prompt: string): string {
  const buf = Buffer.from(prompt, 'utf8');
  if (buf.byteLength <= PROMPT_PREVIEW_BYTES) return prompt;
  // 截取到 PROMPT_PREVIEW_BYTES。如果落在多字节序列内部，
  // 回退到最近的 UTF-8 字符边界（续字节以 10xxxxxx 开头）。
  let end = PROMPT_PREVIEW_BYTES;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${buf.subarray(0, end).toString('utf8')}…(truncated)`;
}

// ── 实现 ───────────────────────────────────────────────────

export class CronListTool implements BuiltinTool<CronListInput> {
  readonly name = 'CronList' as const;
  readonly description = CRON_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronListInputSchema,
  );

  constructor(private readonly manager: CronManager) {}

  resolveExecution(_args: CronListInput): ToolExecution {
    return {
      description: 'Listing scheduled cron jobs',
      approvalRule: this.name,
      execute: async () => {
        // 一次性快照存储并从管理器的时钟固定"当前时间" —
        // 将两次读取保持在同一个 execute() 调用内，保证 `ageDays`
        // 和 `nextFireAt` 列基于同一时刻计算，即使基准注入的
        // 时钟在两者之间前进。
        const tasks = this.manager.store.list();
        const nowMs = this.manager.clocks.wallNow();
        const records = tasks.map((t) => this.renderRecord(t, nowMs));
        const header = `cron_jobs: ${String(tasks.length)}`;
        if (records.length === 0) {
          return {
            output: `${header}\nNo cron jobs scheduled.`,
            isError: false,
          };
        }
        return {
          output: `${header}\n${records.join('\n---\n')}`,
          isError: false,
        };
      },
    };
  }

  private renderRecord(task: CronTask, nowMs: number): string {
    // `recurring: undefined` 是 cron 栈中规范的"默认重复"形状；
    // 只有显式的 `false` 才选择退出。
    const recurring = task.recurring !== false;

    // `ageDays` 纯为信息展示 — 非有限的年龄（例如配置错误的基准时钟
    // wallNow 返回 NaN）报告为 0.00，使该列保持可解析而非输出 "NaN"。
    const ageMs = nowMs - task.createdAt;
    const ageDays = Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0;

    const stale = this.manager.isStale(task);

    let humanSchedule = task.cron;
    let nextFireAtIso = 'null';
    try {
      const parsed = parseCronExpression(task.cron);
      humanSchedule = cronToHuman(parsed);
      // 委托给调度器，使渲染的 ISO 匹配调度器实际将要递送的内容
      // — 包括当前周期中待处理的抖动时隙。
      const nextFireMs = this.manager.getNextFireForTask(task.id);
      if (nextFireMs !== null) {
        nextFireAtIso = formatLocalIsoWithOffset(nextFireMs);
      }
    } catch {
      // 畸形 cron 字符串 — humanSchedule 保留原始表达式，nextFireAt 为 `null`。
      // 对通过 CronCreate（有验证）的任务永远不会发生，
      // 但防御直接存储插入（测试）。
    }

    return [
      `id: ${task.id}`,
      `cron: ${task.cron}`,
      `humanSchedule: ${humanSchedule}`,
      // JSON 序列化使嵌入的换行符变为 `\n` 转义，保持每条记录
      // 每行一个 `key: value` — 否则多行 prompt 会破坏逐记录解析器。
      `prompt: ${JSON.stringify(previewPrompt(task.prompt))}`,
      `nextFireAt: ${nextFireAtIso}`,
      `recurring: ${String(recurring)}`,
      `ageDays: ${ageDays.toFixed(2)}`,
      `stale: ${String(stale)}`,
    ].join('\n');
  }
}

/**
 * CronCreateTool — 调度一个 prompt 在未来的墙钟时间重新注入到当前会话，
 * 可以是一次性的（`recurring: false`）或按 cron 周期重复的
 * （`recurring: true`，默认）。
 *
 * 任务保存在 `SessionCronStore` 中，并通过 `CronManager.addTask` 镜像到
 * `<sessionDir>/cron/<id>.json`，因此 `kimi resume` 同一会话时会重新加载
 * 它们，调度器从上次中断处继续（停机期间错过的触发会合并为单次递送，
 * 带有 `coalescedCount`）。任务不会延续到全新会话。
 *
 * 工具本身是纯验证 + 记账；触发 / 合并 / 抖动逻辑在下一层的
 * `CronScheduler` 和上一层的 `CronManager` 中。此文件只知道：
 *
 *   1. 验证请求（开关、cron 解析、5 年窗口、会话上限、字节长度上限）；
 *   2. 将其添加到管理器（成功时直写磁盘）；
 *   3. 返回抖动后的 `nextFireAt` 和人类可读的调度信息供模型使用；
 *   4. 通过管理器发送 `cron_scheduled` 遥测事件（工具**不会**直接
 *      访问 `manager.agent.telemetry`）。
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { literalRulePattern } from '../support/rule-match';
import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
  type ParsedCronExpression,
} from './cron-expr';
import {
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from './jitter';
import { formatLocalIsoWithOffset } from './time-format';
import CRON_CREATE_DESCRIPTION from './cron-create.md?raw';

// ── 常量 ────────────────────────────────────────────────────────

/**
 * 会话级活跃 cron 任务数量上限。导出以便测试可以预填充存储
 * 而无需重新推导魔术数字。
 */
export const MAX_CRON_JOBS_PER_SESSION = 50;

/**
 * `prompt` 字节长度的硬上限（UTF-8）。上游 zod `.max(...)` 以
 * 代码单元计数，对多字节输入不足（`'汉'.length === 1` 但实际为 3 字节）；
 * 我们使用 `Buffer.byteLength` 重新检查，使预算反映模型最终看到的
 * 实际线上大小。
 */
const MAX_PROMPT_BYTES = 8 * 1024;

/**
 * 一次性（`recurring: false`）cron 首次触发允许的最大前向距离。
 * 典型的陷阱是按照工具文档锁定今天的日期/月份来设置"今天 X 点提醒我" —
 * 如果提交恰好在目标分钟之后几秒到达，`computeNextCronRun` 会将匹配
 * 滚到明年（约 365 天），仍在 5 年 `hasFireWithinYears` 窗口内，
 * 用户会收到迟到一年的通知而非错误。350 天足以捕获回滚（365 ± ε），
 * 同时为年初提交的"安排在年底"合法锁定留出空间。真正需要 11 个月以上
 * 一次性任务的用户，在 prompt 正文中使用自然语言日期比扩展 cron
 * 字段语义更合适。
 */
const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * 60 * 1000;

// ── 输入 schema ─────────────────────────────────────────────────────

export const CronCreateInputSchema = z.object({
  cron: z
    .string()
    .describe(
      '5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
    ),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PROMPT_BYTES)
    .describe('The prompt to enqueue at each fire time.'),
  recurring: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
    ),
});

export type CronCreateInput = z.Infer<typeof CronCreateInputSchema>;

// ── 输出结构（内部） ─────────────────────────────────────────

interface CronCreateOutput {
  readonly id: string;
  readonly cron: string;
  readonly humanSchedule: string;
  readonly recurring: boolean;
  readonly nextFireAt: number | null;
}

// ── 实现 ───────────────────────────────────────────────────

export class CronCreateTool implements BuiltinTool<CronCreateInput> {
  readonly name = 'CronCreate' as const;
  readonly description = CRON_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronCreateInputSchema,
  );

  constructor(private readonly manager: CronManager) {}

  resolveExecution(args: CronCreateInput): ToolExecution {
    // 1. 全局开关 — 先检查以便翻转的环境变量停止所有后续工作，
    //    包括可能对合法畸形输入抛异常的 cron 解析。
    if (process.env['KIMI_DISABLE_CRON'] === '1') {
      return {
        isError: true,
        output: 'Cron scheduling is disabled (KIMI_DISABLE_CRON=1).',
      };
    }

    // 2. 在解析之前规范化空白，使 `parsed.raw`（`cronToHuman` 对
    //    非模板形状回退使用）为单行形式。否则原始输入中的制表符/换行符
    //    会泄露到渲染的 `humanSchedule:` 行中，破坏每行一个键的工具输出格式。
    //    解析错误仍报告规范字段位置；只有空白被降级，语义不受影响。
    const normalizedCron = args.cron.trim().split(/\s+/).join(' ');

    // 3. 解析 cron 表达式。任何解析失败都是用户错误而非内部错误，
    //    因此原样展示消息 — 解析器已经注意命名了有问题的字段。
    let parsed: ParsedCronExpression;
    try {
      parsed = parseCronExpression(normalizedCron);
    } catch (err) {
      return {
        isError: true,
        output: `Invalid cron expression: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    // 4. 拒绝"合法但 5 年内不会触发" — 与调度器内部拒绝自旋的界限相同。
    //    `0 0 31 2 *` 是典型例子。精确的 `nowMs` 对此判断无关紧要
    //    （它只会改变搜索窗口不到 5 年），因此在准备时读取一次，
    //    在 `execute()` 内重新读取作为实际调度锚点。
    const nowAtPrepare = this.manager.clocks.wallNow();
    if (!hasFireWithinYears(parsed, 5, nowAtPrepare)) {
      return {
        isError: true,
        output: `Cron expression ${JSON.stringify(
          normalizedCron,
        )} has no fire within 5 years; refusing to schedule.`,
      };
    }

    // 5. 会话级上限 — 预检查。在 `execute()` 内重新检查，因为
    //    手动批准模式可能延迟执行足够久，使并行的 CronCreate 调用
    //    全部通过此门控，然后在插入时共同突破上限。
    if (this.manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
      return {
        isError: true,
        output: `Cron job cap reached (max ${String(
          MAX_CRON_JOBS_PER_SESSION,
        )} per session).`,
      };
    }

    // 6. 字节长度上限。zod 的 `.max()` 计算代码单元，这不是多字节
    //    prompt 实际需要的预算；Buffer.byteLength 检查使 8 KiB 意图精确。
    const byteLen = Buffer.byteLength(args.prompt, 'utf8');
    if (byteLen > MAX_PROMPT_BYTES) {
      return {
        isError: true,
        output: `Prompt exceeds ${String(
          MAX_PROMPT_BYTES,
        )} bytes (got ${String(byteLen)}).`,
      };
    }

    // `recurring` 在上游默认为 true；我们重新推导布尔值（而非信任
    // 默认后的参数）以匹配 cron 栈中其他地方使用的规范
    // "除非显式为否则为重复"约定。
    const recurring = args.recurring !== false;

    // 7. 一次性"滚到明年"防护。工具文档建议对"今天 X 点提醒我"
    //    锁定今天的日期/月份；如果提交恰好在目标分钟之后几秒到达，
    //    `computeNextCronRun` 返回明年的匹配，上面的 5 年窗口接受它，
    //    用户的提醒会晚一年触发。当首次理想触发超过约一年时拒绝 —
    //    对于 5 字段 cron 这只能意味着锁定日期今年已过。重复任务
    //    不受影响；它们会按预期重新触发。
    if (!recurring) {
      const firstFire = computeNextCronRun(parsed, nowAtPrepare);
      if (
        firstFire !== null &&
        firstFire - nowAtPrepare > ONE_SHOT_MAX_FUTURE_MS
      ) {
        return {
          isError: true,
          output: `One-shot cron ${JSON.stringify(
            normalizedCron,
          )} would not fire until ${formatLocalIsoWithOffset(
            firstFire,
          )} (more than a year out). If you meant "today" or a near date, the pinned day/month has already passed this year — pick a future date or use wildcards.`,
        };
      }
    }

    return {
      description: recurring
        ? `Scheduling cron ${normalizedCron}`
        : `Scheduling one-shot ${normalizedCron}`,
      // 将 `session` 批准范围限定到此精确负载。如果规则中不包含负载，
      // 单次批准的 CronCreate 会在会话剩余时间内授权任何未来的
      // 调度 prompt — 包括用户批准前从未见过的内容。
      // 与 Bash / Write / Edit 在字面规则模式中包含命令/路径的约定一致。
      approvalRule: literalRulePattern(
        this.name,
        JSON.stringify({
          cron: normalizedCron,
          prompt: args.prompt,
          recurring,
        }),
      ),
      execute: async () => {
        // 将调度锚定到执行时刻，而非准备时刻。手动批准模式可能使
        // resolveExecution() 和 execute() 相隔数分钟；使用过期的
        // `nowMs` 插入会让调度器将新的一次性任务视为已逾期，
        // 在下一次 tick 中触发并带有虚假的 `coalescedCount > 1`。
        const nowMs = this.manager.clocks.wallNow();

        // 根据实际存储大小重新检查会话上限，防止两个并发准备的
        // CronCreate 调用在都通过准备时检查后共同突破上限。
        if (this.manager.store.list().length >= MAX_CRON_JOBS_PER_SESSION) {
          return {
            isError: true,
            output: `Cron job cap reached (max ${String(
              MAX_CRON_JOBS_PER_SESSION,
            )} per session).`,
          };
        }

        const task = this.manager.addTask({
          cron: normalizedCron,
          prompt: args.prompt,
          recurring,
        });

        // 响应中用于展示的抖动后下次触发时间。`computeNextCronRun`
        // 在 5 年窗口内无触发时返回 `null`（上面已拒绝，但保持防御性 —
        // 抖动辅助函数届时无内容可偏移）。
        const ideal = computeNextCronRun(parsed, nowMs);
        const nextFireAt =
          ideal === null
            ? null
            : recurring
              ? jitteredNextCronRunMs(task, parsed, ideal)
              : oneShotJitteredNextCronRunMs(task, ideal);

        const humanSchedule = cronToHuman(parsed);

        // 遥测通过管理器进行，使工具不接触 `manager.agent.telemetry`。
        // CronDelete（P1.6）将使用对称的 `emitDeleted`。
        this.manager.emitScheduled(task);

        const output: CronCreateOutput = {
          id: task.id,
          cron: normalizedCron,
          humanSchedule,
          recurring,
          nextFireAt,
        };

        return {
          output: formatOutput(output),
          isError: false,
          message: `Scheduled cron ${task.id}`,
        };
      },
    };
  }
}

function formatOutput(o: CronCreateOutput): string {
  const lines = [
    `id: ${o.id}`,
    `cron: ${o.cron}`,
    `humanSchedule: ${o.humanSchedule}`,
    `recurring: ${String(o.recurring)}`,
    `nextFireAt: ${
      o.nextFireAt === null ? 'null' : formatLocalIsoWithOffset(o.nextFireAt)
    }`,
  ];
  return lines.join('\n');
}

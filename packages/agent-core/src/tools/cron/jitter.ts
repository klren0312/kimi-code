/**
 * 逐任务确定性抖动，用于 cron 触发时间。
 *
 * 存在的原因：如果每个用户都写 `0 9 * * *`（"每天早上 9 点"），
 * 那么每个 CLI 同时触发，上游 API 在 :00 看到惊群效应。我们通过
 * 将每个任务的理想触发时间偏移一个小的、**确定性的**逐任务偏移量
 * 来缓解，使给定任务总是落在相同的抖动点 — 重新调度和重启不会漂移，
 * 当设置 {@link KIMI_CRON_NO_JITTER} 时基准可复现性保持不变。
 *
 * 两种形式：
 *
 *   - **重复**：*向前*偏移周期的一部分（上限 10% 的周期，硬上限 15 分钟）。
 *     长周期任务（`0 9 * * *`，周期 1 天）达到 15 分钟上限；
 *     短周期任务（`*`/5 * * * *，周期 5 分钟）受 10% 规则限制。
 *
 *   - **一次性**：*提前*偏移（负方向），但仅当理想时间落在
 *     `:00` 或 `:30` — 这是模型选择整数而无特定意图的信号。
 *     上限提前 90 秒。其他分钟（`:07`、`:23`、…）原样通过，
 *     因为模型大概率指的就是那个确切时间。
 *
 * 函数对给定输入是纯的 — 无模块级缓存；哈希每次调用从 `task.id`
 * 重新计算。这以少量廉价算术操作换取任务重新调度时无需使
 * 隐藏状态失效的保证。
 */
import type { ParsedCronExpression } from './cron-expr';
import { computeNextCronRun } from './cron-expr';

/** {@link jitteredNextCronRunMs} / {@link oneShotJitteredNextCronRunMs} 的可调参数。 */
export interface JitterConfig {
  /** 重复偏移上限，作为 cron 周期的一部分（0..1）。 */
  readonly recurringMaxFractionOfPeriod: number;
  /** 重复偏移的绝对上限，毫秒。 */
  readonly recurringMaxMs: number;
  /** 一次性提前的绝对上限，毫秒。 */
  readonly oneShotMaxMs: number;
}

export const DEFAULT_CRON_JITTER_CONFIG: JitterConfig = {
  recurringMaxFractionOfPeriod: 0.1,
  recurringMaxMs: 15 * 60_000,
  oneShotMaxMs: 90_000,
};

const MS_PER_DAY = 24 * 60 * 60_000;
const MS_PER_MINUTE = 60_000;

/**
 * 将任务 id 映射到 `[0, 1)` 中的确定性分数。Cron 任务 id 是
 * 8 位十六进制字符（`/^[0-9a-f]{8}$/`），因此 `parseInt(id, 16)` /
 * `2^32` 恰好在范围内。对于非十六进制输入，回退到 djb2 风格的
 * 归约，使传递任意字符串 id 测试夹具的调用方仍能获得稳定分布。
 */
function fractionFromId(id: string): number {
  if (/^[0-9a-f]{8}$/i.test(id)) {
    const n = Number.parseInt(id, 16);
    if (Number.isFinite(n)) {
      // 2^32 保持结果严格 < 1。
      return n / 0x1_0000_0000;
    }
  }
  // djb2 归约 — 在 JS 中溢出安全（在 int32 上操作），
  // 对非十六进制测试 id 提供足够好的分布。
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  // 将有符号 int32 映射到 [0, 1)。
  const unsigned = hash >>> 0;
  return unsigned / 0x1_0000_0000;
}

function jitterDisabledByEnv(): boolean {
  return process.env['KIMI_CRON_NO_JITTER'] === '1';
}

/**
 * 对已计算的理想触发时间应用重复任务抖动。
 *
 * 偏移仅**向前**（≥ 0），受相对周期比例上限和绝对毫秒上限共同限制。
 * 通过向 {@link computeNextCronRun} 查询 `idealMs` *之后*的运行来
 * 发现周期；如果返回 `null`（合法但永不触发的表达式 — 应已被上游
 * 拒绝），回退到 24 小时假设，以便仍产生合理偏移而非扎堆在
 * 原始 `idealMs`。
 */
export function jitteredNextCronRunMs(
  task: { id: string; cron: string; recurring?: boolean },
  parsed: ParsedCronExpression,
  idealMs: number,
  config: JitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number {
  if (jitterDisabledByEnv()) {
    return idealMs;
  }
  const nextNext = computeNextCronRun(parsed, idealMs);
  const period =
    nextNext !== null && nextNext > idealMs ? nextNext - idealMs : MS_PER_DAY;
  const periodCap = period * config.recurringMaxFractionOfPeriod;
  const cap = Math.min(periodCap, config.recurringMaxMs);
  if (!(cap > 0)) {
    return idealMs;
  }
  const offset = cap * fractionFromId(task.id);
  return idealMs + offset;
}

/**
 * 对理想触发时间应用一次性提前抖动。
 *
 * 仅在整点的 `:00` 和 `:00` 和 `:30` 触发 — 这是模型最可能凭习惯
 * 选择的分钟标记。其他分钟原样通过，因此说"2:07 提醒我"的用户
 * 精确得到 2:07。偏移在 `[-oneShotMaxMs, 0)` 中；除非确定性哈希
 * 恰好落在 0 上（这没问题 — 只意味着此任务是支付完全延迟的不幸者），
 * 永远不会恰好为 0。
 *
 * 当确定性偏移会落在 `task.createdAt` 之前时，抖动预算不足以安全
 * 提前：先前版本截断到 `createdAt` 本身，但调度器条件 `now >= nextFireAt`
 * 会在下一次 tick 立即触发 — 对于典型的 08:59:30 创建的 `0 9 * * *`，
 * 这意味着在理想的 09:00 之前约 29 秒触发。我们改为跳过抖动并
 * 原样返回 `idealMs`；任务在理想时间触发，不更早。没有 `createdAt`
 * 的调用方（旧版测试夹具）得到未截断的提前值，保留了它们的先前行为。
 */
export function oneShotJitteredNextCronRunMs(
  task: { id: string; createdAt?: number | undefined },
  idealMs: number,
  config: JitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number {
  if (jitterDisabledByEnv()) {
    return idealMs;
  }
  // `idealMs % MS_PER_MINUTE === 0` 是 UTC 分钟边界检查。它与每个
  // 现代时区的本地分钟边界重合，因为所有偏移都是分钟对齐的 —
  // 当前没有亚分钟偏移。Cron 触发总是在整分钟，因此此门控几乎
  // 总是为 true；它保留作为对不在整分钟的测试合成 idealMs 值的防护。
  if (idealMs % MS_PER_MINUTE !== 0) {
    return idealMs;
  }
  const minuteOfHour = new Date(idealMs).getMinutes();
  if (minuteOfHour !== 0 && minuteOfHour !== 30) {
    return idealMs;
  }
  if (!(config.oneShotMaxMs > 0)) {
    return idealMs;
  }
  const offset = -config.oneShotMaxMs * fractionFromId(task.id);
  const shifted = idealMs + offset;
  // 预算不足时跳过抖动：先前版本截断到 `createdAt`，但 `now >= nextFireAt`
  // 会在下一次 tick 立即触发 — 对于 08:59:30 → 09:00 情况约提前 29 秒。
  // 返回 `idealMs` 保持触发按时，不更早。
  if (task.createdAt !== undefined && shifted < task.createdAt) {
    return idealMs;
  }
  return shifted;
}

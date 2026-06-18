/**
 * CronScheduler — 调度引擎。
 *
 * 这是 cron 栈的底层：它了解任务、时钟、抖动以及"REPL 是否空闲？"，
 * 但不了解 agent、工具、持久化、锁或文件系统。持久化由 `CronManager`
 * 通过写入逐 id JSON 文件在上层叠加；调度器保持无感知，以便其 tick 循环
 * 测试可以用纯内存 `source()` 运行。
 *
 * 值得保留在代码附近的设计笔记：
 *
 *   - **无直接墙钟读取。** 每次墙钟读取都通过 `clocks.wallNow()`。
 *     伴随的 `no-date-now.test.ts` 在文件级别强制执行此约束；
 *     绕过此抽象会破坏基准测试/测试的时钟注入。
 *
 *   - **`source()` 每次 tick 调用。** 它返回*当前*任务列表。调用方
 *     （管理器）通常将其连接到 `() => store.list()`，因此在 tick 之间
 *     创建/删除的任务会被自动拾取。保持 `source()` 廉价。
 *
 *   - **`isIdle()` 门控触发，而非状态更新。** 当 REPL 处于回合中时
 *     我们跳过触发 — 但我们不推进 `lastSeenAt`。下一个空闲 tick 会将
 *     任务视为仍然到期并触发，`coalescedCount` 反映间隙（让 LLM 知道
 *     用户交谈期间错过了 N 次理想触发）。
 *
 *   - **`coalescedCount` 语义。** 当睡眠/忙碌回合/系统暂停导致调度器
 *     错过多次理想触发时，我们恰好传递一次 `onFire` 调用并告知调用方
 *     合并了多少次理想触发。下限为 1 — 每次实际触发至少计为一次。
 *
 *   - **`inFlight` 在 tick 结束时清除。** `onFire` 是同步的（管理器
 *     的执行是发出即忘）。该集合仅用于防御同一调用栈内的重入 tick —
 *     理论上的担忧，但保险代价很低。
 *
 *   - **坏任务不会污染循环。** 每个任务的处理都被 try/catch 包裹；
 *     失败被吞掉（可选的 stderr 追踪受 `KIMI_CRON_DEBUG=1` 门控），
 *     一个损坏的 cron 表达式不会饿死其他任务。
 */

import type { ParsedCronExpression } from './cron-expr';
import { computeNextCronRun, parseCronExpression } from './cron-expr';
import type { ClockSources } from './clock';
import { jitteredNextCronRunMs, oneShotJitteredNextCronRunMs } from './jitter';
import type { CronTask } from './types';

export interface CronSchedulerOptions {
  /** 必需。墙钟 + 单调时钟源。 */
  readonly clocks: ClockSources;

  /**
   * 必需。返回实时任务列表（例如 `() => store.list()`）。
   * 每次 tick 调用 — 保持廉价。
   */
  readonly source: () => readonly CronTask[];

  /**
   * 必需。当任务触发时调用。`coalescedCount >= 1`；当调度器
   * 睡过多次理想触发时 > 1。
   */
  readonly onFire: (task: CronTask, ctx: { readonly coalescedCount: number }) => void;

  /**
   * 必需。当 REPL 空闲且调度器可以立即传递触发时返回 true。
   * 在活跃回合期间返回 false，避免在流中间抛出 cron 触发。
   * 为 false 时，tick 不触发即返回但不丢失任务 — 下一个空闲
   * tick 触发它们，coalescedCount 反映间隙。
   */
  readonly isIdle: () => boolean;

  /**
   * 可选。当全局 killswitch 开启时返回 true；tick() 短路为空操作。
   */
  readonly isKilled?: () => boolean;

  /**
   * 可选。当一次性任务触发并必须从存储中移除时调用。默认为空操作
   * （管理器负责）。
   */
  readonly removeOneShot?: (id: string) => void;

  /**
   * 可选。当重复任务成功触发后调用，附带最近一次理想触发的墙钟
   * 时间戳（其抖动传递刚刚完成）。管理器将其连接到
   * `store.markFired(id, ts)` + 逐 id JSON 写入，以便
   * `kimi resume` 不会重放触发。
   *
   * 发出即忘：调度器不等待持久化完成。一次性任务不调用此回调
   * （`removeOneShot` 路径处理它们）。
   */
  readonly onAdvanceCursor?: (taskId: string, lastFiredAt: number) => void;

  /**
   * 可选。自动 tick setInterval 的轮询间隔，毫秒。
   *   - undefined（默认）→ 1000ms。
   *   - 0 或 null → 不自动轮询。调用方手动驱动 tick()。
   *
   * 由 P1.8 用于连接 `KIMI_CRON_MANUAL_TICK=1` 以禁用定时器。
   */
  readonly pollIntervalMs?: number | null;
}

export interface CronScheduler {
  /** 开始自动 tick 循环。幂等 — 调用两次为空操作。 */
  start(): void;

  /**
   * 停止自动 tick 循环并清除所有进行中的簿记。幂等。
   */
  stop(): Promise<void>;

  /**
   * 同步运行一次检查周期。可在 start() 之前或 stop() 之后安全调用。
   */
  tick(): void;

  /**
   * 所有当前任务中最早理论（抖动后）下次触发时间，或无任务/无
   * 未来触发时返回 null。由 /cron 和外部监控使用。
   */
  getNextFireTime(): number | null;

  /**
   * 使用调度器内部 `lastSeenAt` 基线的单个任务抖动后下次触发时间。
   * 如果任务不在当前 `source()` 快照中或其表达式不产生未来触发
   * 则返回 null。由 CronList 使用，以便其渲染的 `nextFireAt` 与
   * 调度器实际传递的内容匹配，包括当前周期进行中的抖动槽位。
   */
  getNextFireForTask(taskId: string): number | null;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * 计算 coalescedCount 时尝试枚举的理想触发次数上限。1 分钟的 cron
 * 仍覆盖 10000 分钟（约 7 天）。超出时宁可报告 10000 也不空转 —
 * LLM 只需要数量级。
 */
const MAX_COALESCE_ITERATIONS = 10_000;

export function createCronScheduler(opts: CronSchedulerOptions): CronScheduler {
  const {
    clocks,
    source,
    onFire,
    isIdle,
    isKilled,
    removeOneShot,
    onAdvanceCursor,
    pollIntervalMs,
  } = opts;

  // 缓存已解析的 cron 表达式。以原始表达式字符串为键。
  // 每会话任务数很少，因此永不淘汰。
  const parsedCache = new Map<string, ParsedCronExpression>();

  // 每任务墙钟基线，用于"我们上次从哪里开始看"。现在通过
  // `task.lastFiredAt` 在 `kimi resume` 之间持久化：当调度器
  // 首次看到 `lastFiredAt` 已设置且不在未来的任务时，该时间戳
  // 播种此映射，以便 resume 不会合并重放已传递的重复触发。
  // 虚假的 `lastFiredAt > now`（时钟偏移/损坏存储）被忽略，
  // 调度器回退到 `createdAt`，匹配该任务的持久化前行为。
  const lastSeenAt = new Map<string, number>();

  // 跟踪在此调度器生命周期内已查询过 `lastFiredAt` 的任务 id，
  // 使上述播种在每个调度器实例中每个任务恰好执行一次。没有这个，
  // 会话*期间*游标已推进的任务在下次 tick 时其内存映射条目会被
  // 静默覆写回持久化的（较旧的）值。
  const seededFromDisk = new Set<string>();

  // 单个 tick 期间的防御性重入防护。
  const inFlight = new Set<string>();

  let timerHandle: ReturnType<typeof setInterval> | null = null;

  function getParsed(expr: string): ParsedCronExpression {
    const cached = parsedCache.get(expr);
    if (cached !== undefined) return cached;
    const parsed = parseCronExpression(expr);
    parsedCache.set(expr, parsed);
    return parsed;
  }

  function debugLog(message: string): void {
    if (process.env['KIMI_CRON_DEBUG'] === '1') {
      process.stderr.write(`[cron/scheduler] ${message}\n`);
    }
  }

  /**
   * 从 `baseMs` 开始计算任务的抖动后下次触发时间。
   * 当 cron 表达式在搜索预算内无未来触发（合法但永不触发的表达式）时
   * 返回 null。
   */
  function computeJitteredNext(
    task: CronTask,
    parsed: ParsedCronExpression,
    baseMs: number,
  ): number | null {
    const ideal = computeNextCronRun(parsed, baseMs);
    if (ideal === null) return null;
    if (task.recurring === false) {
      return oneShotJitteredNextCronRunMs(task, ideal);
    }
    return jitteredNextCronRunMs(task, parsed, ideal);
  }

  /**
   * 统计落在 \`(firstFireMs, nowMs]\` 区间内、且其**抖动后投递时间**
   * 也 ≤ \`nowMs\` 的理想触发次数。返回计数加上满足抖动到期测试的
   * 最后一次理想触发时间戳 — 调用方用作新的 \`lastSeenAt\` 基线，
   * 使下次调度周期仍能看到抖动投递滑过 \`nowMs\` 的后续触发。
   *
   * 仅针对 \`nowMs\` 计数（不重新应用抖动）会在抖动偏移将下一次
   * 理想触发推过调度器唤醒窗口的任务上多计；调用方随后将
   * \`lastSeenAt\` 推过该触发，抖动投递将永远不会发生。修复方式
   * 是在与投递路径相同的抖动上限制计数循环。
   *
   * 始终返回至少 1 — 每次实际触发即为一次出现。
   * 上限为 MAX_COALESCE_ITERATIONS 以防御失控循环；在间隔内产生
   * 超过 10 000 次触发的表达式是退化的，LLM 只需要数量级即可。
   */
  function countCoalesced(
    task: CronTask,
    parsed: ParsedCronExpression,
    firstFireMs: number,
    nowMs: number,
  ): { count: number; lastDueMs: number } {
    let count = 1;
    let cursor = firstFireMs;
    let lastDueMs = firstFireMs;
    while (count < MAX_COALESCE_ITERATIONS) {
      const next = computeNextCronRun(parsed, cursor);
      if (next === null) break;
      if (next > nowMs) break;
      // 调度器在抖动时间传递，而非理想时间。将抖动将其传递推过
      // `nowMs` 的理想触发计入会导致事件泄漏 — 调用方将
      // `lastSeenAt` 推进到超过它，下次 tick 永远无法重新拾取。
      const jitteredNext =
        task.recurring === false
          ? oneShotJitteredNextCronRunMs(task, next)
          : jitteredNextCronRunMs(task, parsed, next);
      if (jitteredNext > nowMs) break;
      count++;
      cursor = next;
      lastDueMs = next;
    }
    return { count, lastDueMs };
  }

  function tick(): void {
    if (isKilled?.() === true) return;
    if (!isIdle()) return;

    const tasks = source();
    if (tasks.length === 0) return;

    const now = clocks.wallNow();

    // 我们在 tick 结束时清除 inFlight；入口时的重入防护由下面的
    // `inFlight.has(id)` 跳过处理。
    try {
      for (const task of tasks) {
        try {
          if (inFlight.has(task.id)) continue;

          const parsed = getParsed(task.cron);

          // 此调度器实例首次看到此任务时，从持久化的
          // `task.lastFiredAt`（存在且合理时）播种 `lastSeenAt`。
          // 这是"resume 重放昨天已触发的 09:00 cron"的单行修复：
          // 不播种的话，下面的基线会回退到 `task.createdAt`，
          // `countCoalesced` 会将创建以来的每次理想触发视为仍到期。
          // 严格大于 `now` 的 `lastFiredAt` 被视为损坏（时钟偏移、
          // 基准环境设置错误）并忽略 — 永远不要足够信任存储的游标
          // 以至于*跳过*合法到期的触发。
          if (
            !seededFromDisk.has(task.id) &&
            task.lastFiredAt !== undefined &&
            Number.isFinite(task.lastFiredAt) &&
            task.lastFiredAt <= now &&
            !lastSeenAt.has(task.id)
          ) {
            lastSeenAt.set(task.id, task.lastFiredAt);
          }
          seededFromDisk.add(task.id);

          // 计算下一个理想触发的基线。对于新添加的任务这是其
          // createdAt；一旦触发（或看到它通过），推进到该时刻的
          // 墙钟，避免下次 tick 重复计入同一触发。
          const seen = lastSeenAt.get(task.id);
          const baseFromMs =
            seen !== undefined && seen > task.createdAt ? seen : task.createdAt;

          const nextFireAt = computeJitteredNext(task, parsed, baseFromMs);
          if (nextFireAt === null) continue;

          if (now < nextFireAt) continue;

          // 到期 — 从第一次理想触发开始计算 coalescedCount
          // （而非抖动的触发 — 抖动只移动传递点，不改变底层调度）。
          // 一次性任务在单次传递后被移除，必须始终报告
          // `coalescedCount: 1`；多事件语义对"在 X 时刻提醒我"
          // 被睡过的提醒无意义。
          const ideal = computeNextCronRun(parsed, baseFromMs);
          let coalescedCount = 1;
          let lastDueMs: number | null = null;
          if (task.recurring !== false && ideal !== null) {
            const result = countCoalesced(task, parsed, ideal, now);
            coalescedCount = Math.max(1, result.count);
            lastDueMs = result.lastDueMs;
          }

          inFlight.add(task.id);
          let delivered = false;
          try {
            onFire(task, { coalescedCount });
            delivered = true;
          } catch (error) {
            debugLog(
              `onFire threw for task ${task.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          if (!delivered) {
            // 保持 lastSeenAt/store 不变 — 下次 tick 会重新检测
            // 此任务为到期。持续抛出的 onFire 变为响亮重试而非
            // 静默丢失；管理器是负责消除持久化级失败的层，
            // 避免它们到达这里。
            continue;
          }

          if (task.recurring === false) {
            // 一次性：请求调用方移除并丢弃我们的记忆。
            try {
              removeOneShot?.(task.id);
            } catch (error) {
              debugLog(
                `removeOneShot threw for task ${task.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            lastSeenAt.delete(task.id);
            seededFromDisk.delete(task.id);
          } else {
            // 重复：将基线推进到抖动传递实际完成的最后一次理想
            // 触发（或如果未枚举理想触发则为 `now`）。使用*已传递的*
            // 时间戳（而非 `now`）使抖动将其传递推过 `now` 的任何
            // 较晚理想触发在下次 tick 仍可达。如果 `lastDueMs` 为
            // null（退化 cron / 无枚举理想），回退到 `now`，
            // 匹配原始行为。
            const advancedTo = lastDueMs ?? now;
            lastSeenAt.set(task.id, advancedTo);
            // 将游标镜像到管理器以便持久化到磁盘。发出即忘 —
            // 回调预期异步调度写入；抛出在此被吞掉，使不稳定的
            // 写入器不会污染 tick 循环。持久化路径是管理器的
            // 责任（与 addTask / removeTasks 一致）。
            try {
              onAdvanceCursor?.(task.id, advancedTo);
            } catch (error) {
              debugLog(
                `onAdvanceCursor threw for task ${task.id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        } catch (error) {
          // 单个坏任务不能停止循环其余部分。
          debugLog(
            `tick failed for task ${task.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      // onFire 是同步的，因此同一调用栈内的重入 tick 是 inFlight
      // 防御的唯一目标。在 tick 结束时清除以保持不变量简单。
      inFlight.clear();
    }
  }

  function start(): void {
    if (timerHandle !== null) return;

    const interval =
      pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : pollIntervalMs;
    // 0 和 null 都表示"不自动轮询"。
    if (interval === null || interval === 0) return;

    const handle = setInterval(tick, interval);
    // 不要仅因调度器就保持事件循环活跃 — 用户的 REPL / agent 拥有生命周期。
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
    timerHandle = handle;
  }

  async function stop(): Promise<void> {
    if (timerHandle !== null) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    inFlight.clear();
    lastSeenAt.clear();
    seededFromDisk.clear();
    parsedCache.clear();
    // 异步签名，为 Phase 2（文件 I/O 清理、锁释放）前向兼容。
    // 仅会话立即 resolve。
  }

  function nextFireFor(task: CronTask): number | null {
    try {
      const parsed = getParsed(task.cron);
      const seen = lastSeenAt.get(task.id);
      // 镜像 tick() 的播种：当调度器尚未为本会话 tick 时，
      // 查询 `task.lastFiredAt` 以便 CronList 渲染 resume 校正的
      // nextFireAt，而非从 `createdAt` 重新派生的值。虚假值
      // （未来时间戳）被忽略，与 tick() 的健全性门控一致。
      const persistedCursor =
        task.lastFiredAt !== undefined &&
        Number.isFinite(task.lastFiredAt) &&
        task.lastFiredAt <= clocks.wallNow()
          ? task.lastFiredAt
          : undefined;
      const cursor =
        seen !== undefined
          ? seen
          : persistedCursor !== undefined
            ? persistedCursor
            : undefined;
      const baseFromMs =
        cursor !== undefined && cursor > task.createdAt ? cursor : task.createdAt;
      return computeJitteredNext(task, parsed, baseFromMs);
    } catch (error) {
      debugLog(
        `getNextFireFor skipping task ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  function getNextFireTime(): number | null {
    const tasks = source();
    if (tasks.length === 0) return null;

    let min: number | null = null;
    for (const task of tasks) {
      const next = nextFireFor(task);
      if (next === null) continue;
      if (min === null || next < min) min = next;
    }
    return min;
  }

  function getNextFireForTask(taskId: string): number | null {
    const tasks = source();
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) return null;
    return nextFireFor(task);
  }

  return {
    start,
    stop,
    tick,
    getNextFireTime,
    getNextFireForTask,
  };
}

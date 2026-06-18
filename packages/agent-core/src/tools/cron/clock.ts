/**
 * 定时任务调度器的时钟源。
 *
 * 故意将两种不同的时间概念分开：
 *
 *   1. 墙钟时间 — 用户感知的"当前时间"。用于 cron 表达式匹配、
 *      `createdAt` 和 7 天过期判断。可在测试/多进程基准测试中覆盖，
 *      以便场景在模拟时间中运行而无需 `setTimeout`。
 *
 *   2. 单调递增毫秒 — 严格不递减的计数器，在 NTP 调整、挂起/恢复
 *      或模拟时钟注入时不会回退。用于轮询频率和锁心跳 — 任何需要
 *      "距上次检查是否已过 5 秒"的场景，即使墙钟时间被冻结也必须成立。
 *
 * 混合两者会污染测试可复现性：绑定到 `wallNow()` 的心跳在测试时钟
 * 冻结时会卡住；绑定到 `monoNowMs()` 的 cron 触发在基准测试回退
 * 模拟日期时不会前进。`tools/cron/` 中的每个组件都必须接受
 * `ClockSources` 并通过它路由所有时间读取。
 *
 * `monoNowMs` 始终是 `process.hrtime.bigint()`（转换为毫秒）。
 * 不可覆盖 — 接受外部单调时钟会破坏锁心跳依赖的安全网。
 *
 * `wallNow` 的解析由 `KIMI_CRON_CLOCK` 环境变量驱动；见下方
 * `resolveClockSources`。默认为 `Date.now()`。
 */
import { closeSync, openSync, readSync } from 'node:fs';

export interface ClockSources {
  /**
   * 墙钟时间 epoch 毫秒。可在测试/基准测试中通过 `KIMI_CRON_CLOCK` 覆盖。
   * 用于 cron 匹配、`createdAt`、过期判断。
   */
  wallNow(): number;

  /**
   * 严格单调递增的毫秒计数器。不可覆盖。用于 1 秒轮询频率和
   * 锁心跳存活窗口。
   */
  monoNowMs(): number;
}

const systemMonoNowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * 生产默认值 — `Date.now()` + `process.hrtime.bigint()`。
 * 当 `KIMI_CRON_CLOCK` 未设置、设为 `"system"` 或解析失败时使用。
 */
export const SYSTEM_CLOCKS: ClockSources = {
  wallNow: () => Date.now(),
  monoNowMs: systemMonoNowMs,
};

/**
 * 从规格字符串（通常为 `process.env.KIMI_CRON_CLOCK`）解析
 * `ClockSources` 实现。
 *
 *   未设置 / `"system"` → {@link SYSTEM_CLOCKS}
 *   `"file:<path>"`     → `wallNow` 每次调用时同步读取 `<path>` 的
 *                         第一行并解析为 `Number(...)`。文件缺失或
 *                         解析错误时该次调用回退到 `Date.now()`。
 *                         用于多进程基准测试共享单一基于文件的
 *                         模拟时钟。
 *
 * `monoNowMs` 始终使用 `process.hrtime.bigint()`。没有任何规格
 * 覆盖它 — 见文件头。
 *
 * 每次 `wallNow()` 调用都会重新读取数据源。故意不缓存，因为
 * 多进程基准测试修改文件时必须被每个读取器立即感知；缓存会
 * 静默地将每个进程锁定到其首次观察值。
 *
 * 无法识别的规格回退到 {@link SYSTEM_CLOCKS}（在 stderr 输出调试日志）。
 * 这是有意的 — 拼错基准测试环境变量导致 agent 不可用比使用系统时间更糟。
 */
export function resolveClockSources(spec?: string): ClockSources {
  if (spec === undefined || spec === '' || spec === 'system') {
    return SYSTEM_CLOCKS;
  }

  if (spec.startsWith('file:')) {
    const filePath = spec.slice('file:'.length);
    if (filePath === '') {
      debugInvalidSpec(spec, 'empty file path');
      return SYSTEM_CLOCKS;
    }
    return {
      wallNow: () => readFileWall(filePath),
      monoNowMs: systemMonoNowMs,
    };
  }

  debugInvalidSpec(spec, 'unrecognised scheme');
  return SYSTEM_CLOCKS;
}

// Epoch 毫秒实际上不超过 20 个字符；64 字节为前导换行符 / `\r` 留出
// 余量，并防止恶意或意外巨大的时钟文件导致 OOM（例如 `/dev/zero` 重定向）。
const MAX_CLOCK_FILE_BYTES = 64;

function readFileWall(filePath: string): number {
  let bytesRead = 0;
  const buf = Buffer.alloc(MAX_CLOCK_FILE_BYTES);
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return Date.now();
  }
  try {
    bytesRead = readSync(fd, buf, 0, MAX_CLOCK_FILE_BYTES, 0);
  } catch {
    return Date.now();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 忽略关闭错误 */
    }
  }
  const raw = buf.subarray(0, bytesRead).toString('utf8');
  const firstLine = raw.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return Date.now();
  const parsed = Number(firstLine);
  if (!Number.isFinite(parsed)) return Date.now();
  return parsed;
}

function debugInvalidSpec(spec: string, reason: string): void {
  // 这里不引入 logger — `clock.ts` 是 cron 模块的最底层，必须保持
  // 无依赖以便从任何位置导入（包括 lint 规则、类型文件）。通过
  // KIMI_CRON_DEBUG 控制的 stderr 写入足够 — 生产环境静默。
  if (process.env['KIMI_CRON_DEBUG'] === '1') {
    process.stderr.write(
      `[cron/clock] invalid KIMI_CRON_CLOCK spec ${JSON.stringify(spec)}: ${reason} — falling back to system clock\n`,
    );
  }
}

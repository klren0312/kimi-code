// ── 中文概述 ──
// 本模块提供 stdout 安全日志守卫功能。
// ACP 协议通过 stdout 传输 JSON-RPC 消息，任何非 JSON 字节泄漏到 stdout
// 都会破坏协议通道。本模块将 console.log/info/warn 重定向到 stderr，
// 保护 stdout 通道的纯净性。console.error 保持不动，因为它本就写入 stderr。

/**
 * stdout-safe logging guard.
 *
 * ACP speaks JSON-RPC over stdout, so anything that leaks non-JSON bytes
 * onto stdout corrupts the channel. `console.log` / `console.info` /
 * `console.warn` all default to stdout in Node, which means a stray
 * debug print from any dependency can break the protocol.
 *
 * {@link redirectConsoleToStderr} rebinds those three sinks to stderr.
 * `console.error` is intentionally left alone because it already writes
 * to stderr and many third-party libraries rely on that.
 */

// 中文：控制台输出函数的类型签名
type ConsoleSink = (...args: unknown[]) => void;

// 中文：保存原始 console 方法的接口，用于恢复时还原
interface SavedConsole {
  readonly log: ConsoleSink;
  readonly info: ConsoleSink;
  readonly warn: ConsoleSink;
}

// 中文：格式化单个控制台参数为字符串（支持字符串、Error 对象、JSON 序列化兜底）
function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Redirect `console.log`, `console.info`, and `console.warn` to
 * `process.stderr` until the returned restore function is invoked.
 *
 * Returns a restore function that puts the original sinks back; calling
 * the restore function twice is harmless because it just reassigns
 * the saved references.
 */
// 中文：将 console.log/info/warn 重定向到 stderr，返回恢复函数
export function redirectConsoleToStderr(): () => void {
  // 中文：保存原始的 console 方法引用，供恢复函数还原
  const saved: SavedConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };

  const writeStderr: ConsoleSink = (...args) => {
    process.stderr.write(`${args.map(formatArg).join(' ')}\n`);
  };

  // 中文：将三个控制台输出方法替换为写入 stderr 的版本
  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;

  // 中文：返回恢复函数，调用后将 console 方法恢复为原始行为
  return () => {
    console.log = saved.log;
    console.info = saved.info;
    console.warn = saved.warn;
  };
}

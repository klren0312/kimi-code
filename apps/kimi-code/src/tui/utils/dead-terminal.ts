/**
 * 检测表示控制终端（stdout/stderr pty）实际上已消失的错误——例如
 * 父 shell 崩溃、tmux 服务器消失或 SSH 连接断开但未发送 SIGHUP 之后的情况。
 *
 * 继续向已断开的终端写入会在每个渲染周期重复触发相同错误，并导致 CPU 核心被占满。
 * 调用方应跳过任何涉及 stdout/stderr 的清理操作并立即退出。
 */
const DEAD_TERMINAL_ERROR_CODES = new Set<string>(['EIO', 'EPIPE', 'ENOTCONN']);

export function isDeadTerminalError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

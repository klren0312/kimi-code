import type { Readable, Writable } from 'node:stream';

/**
 * 由 {@link Kaos} 环境启动的运行中进程。
 *
 * 提供标准 I/O 流访问、进程 ID 和生命周期管理（等待/终止）。
 * 接口刻意保持精简，以便由本地子进程、SSH 会话或容器运行时等多种后端实现。
 */
export interface KaosProcess {
  /** 连接到进程标准输入的可写流 */
  readonly stdin: Writable;
  /** 进程标准输出的可读流 */
  readonly stdout: Readable;
  /** 进程标准错误的可读流 */
  readonly stderr: Readable;
  /** 操作系统进程 ID */
  readonly pid: number;
  /** 进程已终止时为退出码，否则为 `null` */
  readonly exitCode: number | null;
  /** 等待进程退出并返回退出码 */
  wait(): Promise<number>;
  /** 向进程发送信号（默认 `SIGTERM`） */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** 释放此进程包装器持有的 stdin/stdout/stderr 资源 */
  dispose(): Promise<void> | void;
}

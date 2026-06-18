/**
 * 子进程（bash 命令）的后台任务实现。
 *
 * 封装一个 {@link KaosProcess}，使长时间运行的 shell 命令可以在后台执行，
 * 同时主代理继续工作。任务将 stdout 和 stderr 流式传输到管理器的输出缓冲区，
 * 监听 sink 的中止信号以发送 SIGTERM，并在宽限期后通过 `forceStop()` 升级为 SIGKILL。
 */

import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type { KaosProcess } from '@moonshot-ai/kaos';

import { errorMessage } from '../../loop/errors';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from './task';

/**
 * 进程后台任务的信息快照。在基础信息之上扩展了命令字符串、
 * 操作系统 PID 和退出码，以便 UI 可以显示进程详情而无需查询
 * （已终止的）进程本身。
 */
export interface ProcessBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'process';
  /** 已执行的 shell 命令。 */
  readonly command: string;
  /** 子进程的操作系统进程 ID。 */
  readonly pid: number;
  /** 进程的退出码，尚未退出时为 `null`。 */
  readonly exitCode: number | null;
}

/** 等待 stdout/stderr 流排空的最大时间（毫秒），超时后放弃。 */
const STREAM_DRAIN_GRACE_MS = 250;

/**
 * 管理子进程（通常是 shell 命令）的后台任务。
 *
 * 在 `start()` 时，任务钩入进程的 stdout/stderr 流，监听 sink 的中止信号
 * 以发送 SIGTERM，并等待进程退出。退出码为 0 时结算为 `'completed'`；
 * 非零时结算为 `'failed'`。如果在 `start()` 运行时 sink 信号已中止，
 * 则立即发送 SIGTERM。
 *
 * `forceStop()` 发送 SIGKILL——当 SIGTERM 宽限期过期且进程仍未退出时，
 * 由管理器调用。
 */
export class ProcessBackgroundTask implements BackgroundTask {
  readonly kind = 'process' as const;
  readonly idPrefix = 'bash';
  private exitCode: number | null = null;

  constructor(
    readonly proc: KaosProcess,
    readonly command: string,
    readonly description: string,
  ) {}

  /**
   * 开始管理子进程。钩入 stdout/stderr 进行输出流式传输，
   * 监听中止信号，并等待进程退出。在 `finally` 中确保流被排空且进程被释放。
   */
  async start(sink: BackgroundTaskSink): Promise<void> {
    const streams = [this.proc.stdout, this.proc.stderr] as const;
    const appendOutput = (chunk: string): void => {
      sink.appendOutput(chunk);
    };
    for (const stream of streams) {
      stream.setEncoding('utf8');
      stream.on('data', appendOutput);
    }

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    try {
      const exitCode = await this.proc.wait();
      this.exitCode = exitCode;
      await sink.settle({
        status: sink.signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      });
    } catch (error: unknown) {
      this.exitCode = this.proc.exitCode;
      await sink.settle({
        status: sink.signal.aborted ? 'killed' : 'failed',
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      });
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
      await waitForStreamDrain(streams);
      for (const stream of streams) {
        stream.off('data', appendOutput);
      }
      await this.disposeProcess();
    }
  }

  /**
   * 使用 SIGKILL 强制终止进程。当 SIGTERM 宽限期（5 秒）过期且进程仍未退出时，
   * 由管理器调用。
   */
  async forceStop(): Promise<void> {
    try {
      if (this.proc.exitCode === null) {
        await this.proc.kill('SIGKILL');
      }
    } finally {
      await this.disposeProcess();
    }
  }

  /**
   * 通过将进程字段合并到管理器提供的基础信息中，生成特定于类型的信息快照。
   */
  toInfo(base: BackgroundTaskInfoBase): ProcessBackgroundTaskInfo {
    return {
      ...base,
      kind: 'process',
      command: this.command,
      pid: this.proc.pid,
      exitCode: this.exitCode,
    };
  }

  /** 尽力清理底层 KaosProcess 资源。 */
  private async disposeProcess(): Promise<void> {
    try {
      await this.proc.dispose();
    } catch {
      /* 尽力清理 */
    }
  }
}

/**
 * 等待所有可读流排空（发出 'end' 事件）或超时。
 *
 * 这防止管理器在最后的输出块从进程的 stdout/stderr 管道读取完成之前就进行结算。
 * 超时确保如果流永远不会关闭，我们不会无限期挂起。
 */
async function waitForStreamDrain(streams: readonly Readable[]): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(streams.map((stream) => finished(stream).catch(() => {}))),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STREAM_DRAIN_GRACE_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

import type { KaosProcess } from '@moonshot-ai/kaos';
import type { Readable } from 'node:stream';

import { errorMessage } from '../../loop/errors';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
  BackgroundTaskSettlement,
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

export type ProcessBackgroundTaskOutputKind = 'stdout' | 'stderr';

export type ProcessBackgroundTaskOutputCallback = (
  kind: ProcessBackgroundTaskOutputKind,
  text: string,
) => void;

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
    private readonly onOutput?: ProcessBackgroundTaskOutputCallback,
  ) {}

  /**
   * 开始管理子进程。钩入 stdout/stderr 进行输出流式传输，
   * 监听中止信号，并等待进程退出。在 `finally` 中确保流被排空且进程被释放。
   */
  async start(sink: BackgroundTaskSink): Promise<void> {
    const streamDrained = Promise.all([
      observeProcessStream(this.proc.stdout, 'stdout', sink, this.onOutput),
      observeProcessStream(this.proc.stderr, 'stderr', sink, this.onOutput),
    ]).then(() => undefined);
    // Attach a rejection handler immediately; start() still awaits the same
    // promise after proc.wait() so stream errors keep failing the task.
    void streamDrained.catch(() => {});

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    let settlement: BackgroundTaskSettlement;
    try {
      const exitCode = await this.proc.wait();
      await waitForStreamDrain(streamDrained);
      this.exitCode = exitCode;
      settlement = {
        status: sink.signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      };
    } catch (error: unknown) {
      await waitForStreamDrainSettled(streamDrained);
      this.exitCode = this.proc.exitCode;
      settlement = {
        status: sink.signal.aborted ? 'killed' : 'failed',
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      };
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
      await this.disposeProcess();
    }
    await sink.settle(settlement);
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

async function waitForStreamDrain(streamDrained: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      streamDrained,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STREAM_DRAIN_GRACE_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForStreamDrainSettled(streamDrained: Promise<void>): Promise<void> {
  try {
    await waitForStreamDrain(streamDrained);
  } catch {
    /* original process/stream error wins */
  }
}

function observeProcessStream(
  stream: Readable,
  kind: ProcessBackgroundTaskOutputKind,
  sink: BackgroundTaskSink,
  onOutput?: ProcessBackgroundTaskOutputCallback,
): Promise<void> {
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    if (chunk.length === 0) return;
    sink.appendOutput(chunk);
    onOutput?.(kind, chunk);
  };
  stream.on('data', onData);

  return new Promise<void>((resolve, reject) => {
    let ended = false;
    const settle = (callback: () => void): void => {
      cleanup();
      callback();
    };
    const done = (): void => {
      settle(resolve);
    };
    const fail = (error: unknown): void => {
      settle(() => reject(error));
    };
    const onEnd = (): void => {
      ended = true;
      done();
    };
    const onClose = (): void => {
      if (ended || sink.signal.aborted) {
        done();
        return;
      }

      fail(createPrematureCloseError());
    };
    const onError = (error: Error): void => {
      // When the task is aborted we intentionally destroy the streams, which
      // can emit errors. Swallow those expected errors; surface anything else.
      if (sink.signal.aborted) {
        done();
      } else {
        fail(error);
      }
    };
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

function createPrematureCloseError(): Error {
  const error = new Error('Premature close') as NodeJS.ErrnoException;
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}

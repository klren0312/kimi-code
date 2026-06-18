/**
 * 子代理完成的后台任务实现。
 *
 * 封装一个子代理的 `completion` promise，使其可以在后台运行，
 * 同时主代理继续执行。当 promise resolve 时，结果被捕获为任务输出，
 * 任务结算为 `'completed'`。超时和中止分别通过将完成 promise 与截止时间竞速
 * 以及监听 sink 的取消信号来处理。
 */

import { sleep } from '@antfu/utils';

import { errorMessage, isAbortError } from '../../loop/errors';
import {
  type BackgroundTask,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSink,
} from './task';

/**
 * 代理后台任务的信息快照。在基础信息之上扩展了标识子代理的字段，
 * 以便 UI 可以通过 `Agent(resume=agentId)` 提供"恢复"操作。
 */
export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  /** `Agent(resume=...)` 接受的子代理标识符。 */
  readonly agentId?: string;
  /** 子代理配置文件名称。 */
  readonly subagentType?: string;
}

/**
 * 构造 {@link AgentBackgroundTask} 的配置选项。
 */
export interface AgentBackgroundTaskOptions {
  /** 任务被强制结算为 `'timed_out'` 之前的最长时间（毫秒）。 */
  readonly timeoutMs?: number;
  /** 当管理器发出取消信号或截止时间到达时调用的中止回调。 */
  readonly abort?: () => void;
  /** 用于下游恢复支持的子代理标识符。 */
  readonly agentId?: string;
  /** 子代理配置文件名称。 */
  readonly subagentType?: string;
}

/**
 * 等待子代理完成 promise 的后台任务。
 *
 * 在 `start()` 时，任务将提供的 `completion` promise 与以下条件竞速：
 * 1. 可选的 `timeoutMs` 截止时间（产生 `'timed_out'`）
 * 2. sink 的 `AbortSignal`（产生 `'killed'`）
 *
 * 如果 promise 先 resolve，其 `result` 字符串将被追加为输出，
 * 任务结算为 `'completed'`。错误会被捕获并结算为 `'failed'`，
 * 错误消息作为 `stopReason`。
 */
export class AgentBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly timeoutMs?: number;
  readonly agentId?: string;
  readonly subagentType?: string;
  private readonly abort?: () => void;

  constructor(
    private readonly completion: Promise<{ result: string }>,
    readonly description: string,
    options: AgentBackgroundTaskOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs;
    this.abort = options.abort;
    this.agentId = options.agentId;
    this.subagentType = options.subagentType;
  }

  /**
   * 开始跟踪子代理完成。将完成 promise 与可选截止时间和管理器的取消信号竞速。
   */
  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abort?.();
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }

    const deadlineTimeout: unique symbol = Symbol('background-agent-deadline');
    const raceInputs: Array<Promise<{ result: string } | typeof deadlineTimeout>> = [
      this.completion,
    ];
    const timeoutMs = this.timeoutMs;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      raceInputs.push(sleep(timeoutMs).then(() => deadlineTimeout));
    }

    try {
      const outcome = await Promise.race(raceInputs);
      if (outcome === deadlineTimeout) {
        this.abort?.();
        await sink.settle({ status: 'timed_out' });
        return;
      }
      sink.appendOutput(outcome.result);
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && isAbortError(error)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    } finally {
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  /**
   * 通过将代理字段合并到管理器提供的基础信息中，生成特定于类型的信息快照。
   */
  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
    };
  }
}

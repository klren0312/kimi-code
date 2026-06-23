import { errorMessage, isAbortError } from '../../loop/errors';
import {
  type BackgroundTask,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSink,
} from './task';
import type { SessionSubagentHost, SubagentHandle } from '../../session/subagent-host';

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

export class AgentBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly agentId: string;
  readonly subagentType: string;

  constructor(
    private readonly handle: SubagentHandle,
    readonly description: string,
    private readonly subagentHost: Pick<SessionSubagentHost, 'markActiveChildDetached'>,
    private readonly abortController: AbortController,
  ) {
    this.agentId = handle.agentId;
    this.subagentType = handle.profileName;
  }

  /**
   * 开始跟踪子代理完成。将完成 promise 与可选截止时间和管理器的取消信号竞速。
   */
  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abortController.abort(sink.signal.reason);
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }

    try {
      const outcome = await this.handle.completion;
      sink.appendOutput(outcome.result);
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    } finally {
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  onDetach(): void {
    this.subagentHost.markActiveChildDetached(this.agentId);
  }

  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
    };
  }
}

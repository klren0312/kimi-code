/**
 * 交互式问题流程的后台任务实现。
 *
 * 封装一个异步问题运行器，使多问题审批流程可以在后台进行，
 * 同时主代理继续执行。运行器函数接收一个中止信号并返回一个
 * {@link ExecutableToolResult}，其输出被序列化到任务的输出缓冲区中。
 * 错误结果结算为 `'failed'`；成功结果结算为 `'completed'`。
 */

import { errorMessage, isAbortError } from '../../loop/errors';
import type { ExecutableToolOutput, ExecutableToolResult } from '../../loop/types';
import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from './task';

/**
 * 问题后台任务的信息快照。在基础信息之上扩展了流程中的问题数量
 * 和发起的工具调用 ID，以便 UI 可以将任务与其触发的请求关联起来。
 */
export interface QuestionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'question';
  /** 审批流程中的问题数量。 */
  readonly questionCount: number;
  /** 发起此问题流程的工具调用 ID（如有）。 */
  readonly toolCallId?: string;
}

/**
 * 构造 {@link QuestionBackgroundTask} 的配置选项。
 */
export interface QuestionBackgroundTaskOptions {
  /** 流程将提出的问题数量。 */
  readonly questionCount: number;
  /** 发起此问题流程的工具调用 ID（如有）。 */
  readonly toolCallId?: string;
}

/**
 * 运行交互式问题/审批流程的后台任务。
 *
 * 使用 sink 的中止信号调用提供的 `run` 函数，该函数应返回一个
 * {@link ExecutableToolResult}。成功时，结果的输出被序列化并追加为任务输出；
 * 出错时，任务结算为 `'failed'`，并从结果中提取消息。如果中止信号在执行期间
 * 触发且错误为 `AbortError`，则任务结算为 `'killed'`。
 */
export class QuestionBackgroundTask implements BackgroundTask {
  readonly kind = 'question' as const;
  readonly idPrefix = 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;

  constructor(
    private readonly run: (signal: AbortSignal) => Promise<ExecutableToolResult>,
    readonly description: string,
    options: QuestionBackgroundTaskOptions,
  ) {
    this.questionCount = options.questionCount;
    this.toolCallId = options.toolCallId;
  }

  /**
   * 执行问题流程。非错误结果结算为 `'completed'`，错误结果或抛出异常
   * 结算为 `'failed'`，sink 信号中止时结算为 `'killed'`。
   */
  async start(sink: BackgroundTaskSink): Promise<void> {
    try {
      const result = await this.run(sink.signal);
      const output = serializeToolOutput(result.output);
      if (output.length > 0) sink.appendOutput(output);
      await sink.settle({
        status: result.isError === true ? 'failed' : 'completed',
        stopReason: result.isError === true ? errorStopReason(result) : undefined,
      });
    } catch (error: unknown) {
      if (sink.signal.aborted && isAbortError(error)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    }
  }

  /**
   * 通过将问题字段合并到管理器提供的基础信息中，生成特定于类型的信息快照。
   */
  toInfo(base: BackgroundTaskInfoBase): QuestionBackgroundTaskInfo {
    return {
      ...base,
      kind: 'question',
      questionCount: this.questionCount,
      toolCallId: this.toolCallId,
    };
  }
}

/** 将工具输出序列化为字符串，非字符串载荷使用 JSON 编码。 */
function serializeToolOutput(output: ExecutableToolOutput): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * 从错误结果中提取人类可读的停止原因。
 * 优先使用 `result.message`，回退到字符串化的输出。
 */
function errorStopReason(result: ExecutableToolResult): string | undefined {
  if (result.message !== undefined && result.message.length > 0) return result.message;
  if (typeof result.output !== 'string') return undefined;
  const trimmed = result.output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

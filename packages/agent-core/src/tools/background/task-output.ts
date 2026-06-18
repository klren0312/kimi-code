/**
 * TaskOutputTool — 读取后台任务的输出。
 *
 * 返回结构化的任务元数据加上固定大小的输出尾部预览。完整的、未截断的
 * 输出保存在磁盘上的 `output_path`；调用方始终被指向 `Read` 工具以分页
 * 查看完整日志，当预览被截断为尾部时也会携带提示横幅。
 *
 * 对于已终止的任务，输出还会展示任务结束的原因：
 * `stop_reason` 记录具体原因；`terminal_reason` 为需要稳定标签的调用方
 * 分类为超时 vs 显式停止 vs 失败。
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import {
  type BackgroundManager,
  isBackgroundTaskTerminal,
  type BackgroundTaskInfo,
  type BackgroundTaskOutputSnapshot,
  type BackgroundTaskStatus,
} from '../../agent/background';
import type { ExecutableToolResult, ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { matchesGlobRuleSubject } from '../support/rule-match';
import { formatPlainObject } from './format';
import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

/**
 * 作为预览内联输出的最大字节数。超过此大小的输出将被截断为尾部；
 * 完整日志通过 `Read` 工具使用返回的 `output_path` 单独读取。
 */
const OUTPUT_PREVIEW_BYTES = 32 * 1024; // 32 KiB

/** 分页提示建议每次 `Read` 调用读取的行数。 */
const PAGING_HINT_LINES = 300;

// ── Input schema ─────────────────────────────────────────────────────

export const TaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect.'),
  block: z
    .boolean()
    .default(false)
    .describe('Whether to wait for the task to finish before returning.')
    .optional(),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(30)
    .describe('Maximum number of seconds to wait when block=true.')
    .optional(),
});

export type TaskOutputInput = z.Infer<typeof TaskOutputInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

function retrievalStatus(
  status: BackgroundTaskStatus,
  block: boolean | undefined,
): 'success' | 'timeout' | 'not_ready' {
  if (isBackgroundTaskTerminal(status)) return 'success';
  return block ? 'timeout' : 'not_ready';
}

function terminalReason(info: BackgroundTaskInfo): 'timed_out' | 'stopped' | 'failed' | undefined {
  if (info.status === 'timed_out') return 'timed_out';
  if (info.status === 'killed' && info.stopReason !== undefined) return 'stopped';
  if (info.status === 'failed' && info.stopReason !== undefined) return 'failed';
  return undefined;
}

function fullOutputHint(output: BackgroundTaskOutputSnapshot): string | undefined {
  if (!output.fullOutputAvailable || output.outputPath === undefined) return undefined;
  if (output.truncated) {
    return (
      `Only the last ${String(OUTPUT_PREVIEW_BYTES)} bytes are shown above. ` +
      'Use the Read tool with the output_path to page through the full log ' +
      `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
      'lines per page).'
    );
  }
  return (
    'The preview above is the complete output. Use the Read tool with the output_path ' +
    'if you need to re-read the full log later ' +
    `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
    'lines per page).'
  );
}

export class TaskOutputTool implements BuiltinTool<TaskOutputInput> {
  readonly name = 'TaskOutput' as const;
  readonly description: string = TASK_OUTPUT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskOutputInputSchema);

  constructor(private readonly manager: BackgroundManager) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TaskOutputInput): Promise<ExecutableToolResult> {
    const info = this.manager.getTask(args.task_id);
    if (!info) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    if (args.block && !isBackgroundTaskTerminal(info.status)) {
      await this.manager.wait(args.task_id, (args.timeout ?? 30) * 1000);
    }

    // 等待后重新获取。
    const current = this.manager.getTask(args.task_id);
    if (!current) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    // 单个 manager 拥有的快照驱动尾部窗口和下面报告的每个指标。
    // 当持久化日志可用时，它们是权威来源；分离的 manager 回退到其实时环形缓冲区。
    const output = await this.manager.getOutputSnapshot(args.task_id, OUTPUT_PREVIEW_BYTES);

    const lines = [
      formatPlainObject({
        retrievalStatus: retrievalStatus(current.status, args.block),
        ...current,
        outputPath: output.outputPath,
        terminalReason: terminalReason(current),
        outputSizeBytes: output.outputSizeBytes,
        outputPreviewBytes: output.previewBytes,
        outputTruncated: output.truncated,
        fullOutputAvailable: output.fullOutputAvailable,
        fullOutputTool:
          output.fullOutputAvailable && output.outputPath !== undefined ? 'Read' : undefined,
        fullOutputHint: fullOutputHint(output),
      }),
      '',
    ];

    // 当预览省略了日志头部时，在 `[output]` 标记前发出明确的横幅，
    // 以便模型知道它看到的是尾部而非完整输出。
    if (output.truncated) {
      lines.push(
        output.fullOutputAvailable && output.outputPath !== undefined
          ? `[Truncated. Full output: ${output.outputPath}]`
          : '[Truncated. No persisted full log is available for this task.]',
      );
    }
    lines.push('[output]', output.preview || '[no output available]');

    // 供宿主 UI / 日志读取器使用的旁路摘要。与 LLM 解析的 `output` 正文不同。
    // 保持简短以便日志读取器可以将其渲染为单行。
    return {
      output: lines.join('\n'),
      isError: false,
      message: 'Task snapshot retrieved.',
    };
  }

}

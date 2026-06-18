import type { Component } from '@earendil-works/pi-tui';
import { Container, Text } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import type { ResultRenderer } from './tool-renderers/types';
import { PREVIEW_LINES } from './tool-renderers/types';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  /**
   * 最大命令行渲染数。`undefined` 表示无上限——用于 ctrl+o 展开视图，
   * 使用户即使在头部预览被截断时也能查看完整的多行命令。
   */
  readonly commandPreviewLines?: number;
  readonly resultPreviewLines?: number;
  readonly tailOutput?: boolean;
  readonly expandHint?: boolean;
}

export class ShellExecutionComponent extends Container {
  constructor(options: ShellExecutionOptions) {
    super();

    if (options.showCommand === true) {
      this.addCommandPreview(options.command ?? '', options.commandPreviewLines);
    }

    if (options.result !== undefined) {
      this.addResultPreview(
        options.result,
        options.expanded ?? false,
        options.resultPreviewLines ?? PREVIEW_LINES,
        options.tailOutput ?? false,
        options.expandHint ?? true,
      );
    }
  }

  private addCommandPreview(command: string, previewLines: number | undefined): void {
    if (command.length === 0) return;
    const allLines = command.split('\n');
    const lines = previewLines === undefined ? allLines : allLines.slice(0, previewLines);
    for (const [i, line] of lines.entries()) {
      const prefix = i === 0 ? '$ ' : '  ';
      this.addChild(new Text(currentTheme.dim(prefix + line), 2, 0));
    }
  }

  private addResultPreview(
    result: ToolResultBlockData,
    expanded: boolean,
    previewLines: number,
    tailOutput: boolean,
    expandHint: boolean,
  ): void {
    if (!result.output) return;
    this.addChild(
      new TruncatedOutputComponent(result.output, {
        expanded,
        isError: result.is_error ?? false,
        maxLines: previewLines,
        tail: tailOutput,
        expandHint,
      }),
    );
  }
}

export const shellExecutionResultRenderer: ResultRenderer = (
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx,
): Component[] => [
  new ShellExecutionComponent({
    command: typeof toolCall.args['command'] === 'string' ? toolCall.args['command'] : '',
    result,
    expanded: ctx.expanded,
    // 头部将长 bash 命令截断为 60 个字符。当用户通过 ctrl+o 展开卡片时，
    // 显示完整命令（无行数上限），以便用户查看实际执行的内容。
    showCommand: ctx.expanded,
    commandPreviewLines: undefined,
  }),
];

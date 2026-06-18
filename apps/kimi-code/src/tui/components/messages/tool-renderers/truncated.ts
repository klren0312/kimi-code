import { Text, truncateToWidth, type Component } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

const DEFAULT_INDENT = 2;

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

/**
 * 带换行感知行截断的工具输出渲染组件。
 * 使用 pi-tui 的 Text 组件计算实际的可视换行行数，
 * 然后限制在 PREVIEW_LINES 行以内。这处理了长单行输出
 * （如 JSON 数据块），否则会换行成数十个可视行。
 */
export class TruncatedOutputComponent implements Component {
  private textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly indent: number;
  private readonly expandHint: boolean;
  private readonly tail: boolean;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
      indent?: number;
      // 为 false 时，截断底部省略"ctrl+o to expand"提示
      // （用于输出固定截断且从不展开的场景）。
      expandHint?: boolean;
      // 为 true 时，折叠渲染保留最新的可视行而非前几行。
      // 适用于正在运行的命令的实时输出。
      tail?: boolean;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.expandHint = options.expandHint ?? true;
    this.tail = options.tail ?? false;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    this.textComponent = new Text(
      options.isError ? currentTheme.fg('error', cleaned) : currentTheme.dim(cleaned),
      this.indent,
      0,
    );
  }

  invalidate(): void {
    // Text 组件缓存换行结果；终端大小变化时需刷新。
    this.textComponent.invalidate();
  }

  private renderHint(width: number, hint: string): string {
    const indentWidth = Math.min(this.indent, Math.max(0, width));
    const hintWidth = Math.max(0, width - indentWidth);
    return ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…'));
  }

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);

    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const remaining = contentLines.length - this.maxLines;
    if (this.tail) {
      const shown = contentLines.slice(contentLines.length - this.maxLines);
      return [
        this.renderHint(width, `... (${String(remaining)} earlier lines)`),
        ...shown,
      ];
    }

    const shown = contentLines.slice(0, this.maxLines);
    const hint = this.expandHint
      ? `... (${String(remaining)} more lines, ctrl+o to expand)`
      : `... (${String(remaining)} more lines)`;
    return [...shown, this.renderHint(width, hint)];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
    }),
  ];
};

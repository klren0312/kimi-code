/**
 * 在对话记录中渲染思考内容。
 * 支持在思考流式传输时进行实时原地更新，完成后定稿而不替换组件。
 * 支持通过 Ctrl+O 展开/折叠（与工具输出共享）。
 */

import { Text, truncateToWidth, type Component, type TUI } from '@earendil-works/pi-tui';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component {
  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  private expanded = false;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  // 保持单个 Text 实例，以便 pi-tui 的 (text, width) → 行缓存
  // 能在多次渲染间存活。每次渲染重新构造会销毁缓存，
  // 导致每帧都强制重新换行，当对话记录中积累大量已定稿的
  // 思考块后，这会成为 CPU 的主要消耗。
  private readonly textComponent: Text;

  constructor(
    text: string,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    this.text = text;
    this.showMarker = showMarker;
    this.mode = mode;
    this.ui = ui;
    this.textComponent = new Text(this.styled(text), 0, 0);
    if (mode === 'live') {
      this.startSpinner();
    }
  }

  invalidate(): void {
    this.textComponent.setText(this.styled(this.text));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.textComponent.setText(this.styled(text));
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
  }

  finalize(): void {
    this.mode = 'finalized';
    this.stopSpinner();
  }

  dispose(): void {
    this.stopSpinner();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [''];

    if (this.mode === 'live') {
      const visibleLines =
        contentLines.length > THINKING_PREVIEW_LINES
          ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
          : contentLines;
      const spinner = currentTheme.fg(
        'textDim',
        `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
      );
      return [
        '',
        spinner + currentTheme.fg('textDim', 'thinking...'),
        ...visibleLines.map((line) => MESSAGE_INDENT + line),
      ];
    }

    const rendered: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p = i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
      rendered.push(p + contentLines[i]);
    }

    if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES) {
      return rendered;
    }

    // 前导空行 + 前 PREVIEW_LINES 行内容 + 提示行。
    const truncated = rendered.slice(0, 1 + THINKING_PREVIEW_LINES);
    const remaining = contentLines.length - THINKING_PREVIEW_LINES;
    const hint = `... (${String(remaining)} more lines, ctrl+o to expand)`;
    const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
    const hintWidth = Math.max(0, width - indentWidth);
    truncated.push(
      ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…')),
    );
    return truncated;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerInterval !== undefined) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.ui?.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval === undefined) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
  }
}

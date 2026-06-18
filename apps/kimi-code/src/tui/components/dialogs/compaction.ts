/**
 * 在对话记录中渲染上下文压缩块。
 *
 * 生命周期：
 *   - 在 `compaction.started` 时构建 → 闪烁白色圆点 +
 *     "Compacting context..." 及可选的自定义说明
 *   - 在 `compaction.completed` 时调用 `markDone()` → 实心绿色圆点 +
 *     "Compaction complete (X → Y tokens)"
 *   - 在 `compaction.cancelled` 时调用 `markCanceled()` → 实心警告圆点 +
 *     "Compaction cancelled"
 *
 * 圆点动画与 `ToolCallComponent` 一致（500ms 闪烁），
 * 使用户在 UI 中看到相同的"进行中"信号。
 */

import { Container, Text, Spacer } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

const BLINK_INTERVAL = 500;

export class CompactionComponent extends Container {
  private readonly ui: TUI | undefined;
  private readonly headerText: Text;
  private readonly instruction: string | undefined;
  private blinkOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private done = false;
  private canceled = false;
  private tokensBefore: number | undefined;
  private tokensAfter: number | undefined;

  constructor(ui?: TUI, instruction?: string | undefined) {
    super();
    this.ui = ui;
    this.instruction = instruction;

    // 顶部间距，防止此块紧贴前一条对话记录
    //（状态行、工具结果等）。
    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.addInstructionChild();

    this.startBlink();
  }

  private addInstructionChild(): void {
    if (this.instruction !== undefined) {
      this.addChild(new Text(currentTheme.dim(`  ${this.instruction}`), 0, 0));
    }
  }

  override invalidate(): void {
    // 使用当前调色板重绘标题（它缓存了 ANSI 码）。
    this.headerText.setText(this.buildHeader());
    // 使用新的主题颜色重建说明行。
    if (this.instruction !== undefined) {
      // 如果最后一个子元素是说明行则移除（它始终在 headerText 和 Spacer 之后添加）。
      if (this.children.length > 2) {
        this.children.pop();
      }
      this.addInstructionChild();
    }
    super.invalidate();
  }

  markDone(tokensBefore?: number, tokensAfter?: number): void {
    if (this.done || this.canceled) return;
    this.done = true;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.stopBlink();
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  markCanceled(): void {
    if (this.done || this.canceled) return;
    this.canceled = true;
    this.stopBlink();
    this.headerText.setText(this.buildHeader());
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopBlink();
  }

  private buildHeader(): string {
    if (this.done) {
      const bullet = currentTheme.fg('success', STATUS_BULLET);
      const label = currentTheme.boldFg('success', 'Compaction complete');
      const detail =
        this.tokensBefore !== undefined && this.tokensAfter !== undefined
          ? currentTheme.dim(` (${String(this.tokensBefore)} → ${String(this.tokensAfter)} tokens)`)
          : '';
      return `${bullet}${label}${detail}`;
    }
    if (this.canceled) {
      const bullet = currentTheme.fg('warning', STATUS_BULLET);
      const label = currentTheme.boldFg('warning', 'Compaction cancelled');
      return `${bullet}${label}`;
    }
    const bullet = this.blinkOn ? currentTheme.fg('text', STATUS_BULLET) : '  ';
    const label = currentTheme.boldFg('primary', 'Compacting context...');
    return `${bullet}${label}`;
  }

  private startBlink(): void {
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.headerText.setText(this.buildHeader());
      this.ui?.requestRender();
    }, BLINK_INTERVAL);
  }

  private stopBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }
}

/**
 * 使用 pi-tui Markdown 渲染助手消息。
 *
 * 显示白色圆点前缀，Markdown 内容缩进对齐到圆点之后。
 */

import { Container, Markdown, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private lastText = '';
  private showBullet: boolean;

  constructor(showBullet: boolean = true) {
    this.showBullet = showBullet;
    this.contentContainer = new Container();
  }

  setShowBullet(show: boolean): void {
    this.showBullet = show;
  }

  updateContent(text: string): void {
    const displayText = text;
    if (displayText === this.lastText) return;
    this.lastText = displayText;
    this.contentContainer.clear();
    if (displayText.trim().length > 0) {
      this.contentContainer.addChild(new Markdown(displayText.trim(), 0, 0, createMarkdownTheme()));
    }
  }

  invalidate(): void {
    // Markdown 以 (text, width) 为键缓存 ANSI 颜色代码。当主题变更时，
    // 缓存的字符串包含过时的颜色，因此我们用新主题重建 Markdown 子节点。
    this.contentContainer.clear();
    if (this.lastText.trim().length > 0) {
      this.contentContainer.addChild(
        new Markdown(this.lastText.trim(), 0, 0, createMarkdownTheme()),
      );
    }
  }

  render(width: number): string[] {
    if (this.lastText.trim().length === 0) return [];

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const contentWidth = Math.max(1, safeWidth - visibleWidth(prefix));
    const contentLines = this.contentContainer.render(contentWidth);

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p =
        i === 0 && this.showBullet ? currentTheme.fg('text', STATUS_BULLET) : MESSAGE_INDENT;
      lines.push(p + contentLines[i]);
    }
    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}

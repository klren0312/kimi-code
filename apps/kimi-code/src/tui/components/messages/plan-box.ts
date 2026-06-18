/**
 * PlanBoxComponent ——在完整盒型边框内渲染 ExitPlanMode 计划，
 * 自适应宽度。计划文本解析为 Markdown，因此标题、列表、粗体、
 * 行内代码等与助手消息的渲染方式一致。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Markdown, truncateToWidth, visibleWidth, type Component, type MarkdownTheme } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

const LEFT_MARGIN = 2; // 两格缩进，与其他工具调用子项对齐
const SIDE_PADDING = 1; // │ 与内容两侧之间的间距
const TITLE_PREFIX = ' plan: ';
const TITLE_SUFFIX = ' ';

export interface PlanBoxOptions {
  status?: {
    readonly label: string;
    readonly colorHex: string;
  };
}

export class PlanBoxComponent implements Component {
  private readonly markdown: Markdown;
  private readonly status: PlanBoxOptions['status'];
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    plan: string,
    markdownTheme: MarkdownTheme,
    private readonly borderHex: string,
    private readonly planPath?: string,
    opts?: PlanBoxOptions,
  ) {
    // 构建一次 Markdown 实例——pi-tui 的 Markdown 以 (text, width) 为键
    // 缓存自身的解析 + 换行输出，因此复用同一实例意味着父 Container
    // 的重复 render() 调用会命中缓存，而非每帧重新解析。
    this.markdown = new Markdown(plan.trim(), 0, 0, markdownTheme);
    this.status = opts?.status;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown.invalidate?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    if (safeWidth < LEFT_MARGIN + 4) {
      return this.markdown.render(Math.max(1, safeWidth)).map((line) => truncateToWidth(line, safeWidth, '…'));
    }

    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    // 盒型布局: "  ┌──...──┐"
    //           "  │ <内容> │"
    //           "  └──...──┘"
    // width = LEFT_MARGIN + 1 + horzLen + 1 ⇒ horzLen = width - 4
    // 内容宽度 = horzLen - 2 * SIDE_PADDING = width - 6
    const horzLen = Math.max(2, safeWidth - LEFT_MARGIN - 2);
    const contentWidth = Math.max(1, horzLen - 2 * SIDE_PADDING);

    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const title = this.buildTitle(horzLen);
    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title));
    const top =
      indent + paint('┌') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('┐');
    const bottom = indent + paint('└' + '─'.repeat(horzLen) + '┘');

    const rawLines = this.markdown.render(contentWidth);

    const lines: string[] = [top];
    for (const raw of rawLines) {
      const pad = Math.max(0, contentWidth - visibleWidth(raw));
      lines.push(indent + paint('│') + ' ' + raw + ' '.repeat(pad) + ' ' + paint('│'));
    }
    lines.push(bottom);

    const fitted = lines.map((line) => truncateToWidth(line, safeWidth, '…'));
    this.cachedWidth = width;
    this.cachedLines = fitted;
    return fitted;
  }

  private buildTitle(horzLen: number): string {
    const fallback = ' plan ';
    const statusSuffix = this.buildStatusSuffix();
    const fallbackWithStatus = ` plan${statusSuffix} `;
    const budget = Math.max(0, horzLen - 1);
    const fallbackTitle = truncateToWidth(
      visibleWidth(fallbackWithStatus) <= budget ? fallbackWithStatus : fallback,
      budget,
      '…',
    );
    const planPath = this.planPath;
    if (planPath === undefined || planPath.length === 0) return fallbackTitle;
    const basename = path.basename(planPath);
    if (basename.length === 0) return fallbackTitle;
    const linked = path.isAbsolute(planPath)
      ? toTerminalHyperlink(basename, pathToFileURL(planPath).href)
      : basename;
    const title = TITLE_PREFIX + linked + statusSuffix + TITLE_SUFFIX;
    if (visibleWidth(title) > budget) return fallbackTitle;
    return title;
  }

  private buildStatusSuffix(): string {
    const status = this.status;
    if (status === undefined || status.label.length === 0) return '';
    return ` · ${chalk.hex(status.colorHex)(status.label)}`;
  }
}

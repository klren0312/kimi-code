/**
 * ApprovalPreviewViewer —— 审批流程中 Edit diff 或 Write 文件内容的全屏预览。
 *
 * 由 `kimi-tui.ts` 通过与 `TaskOutputViewer` 相同的嵌套接管模式挂载：
 * 当前活动的审批面板被保留在下方，关闭预览后恢复。查看器是快照式的 ——
 * 其行在构造时渲染一次，滚动时只做切片操作，因此每帧渲染成本保持在
 * `O(viewport)`，即使底层 diff/内容非常大也是如此。
 *
 * 这避免了之前的问题：在包含长 hunk 的 Edit 上按 ctrl+e 会使审批面板
 * 膨胀超过一屏，与 pi-tui 的内联差异渲染器和终端模拟器的
 * "输出到 stdout 时自动滚动到底部"行为产生冲突，导致闪烁和不可滚动的历史面板。
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLines } from '#/tui/components/media/diff-preview';
import type { DiffDisplayBlock, FileContentDisplayBlock } from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

const ELLIPSIS = '…';

export type ApprovalPreviewBlock = DiffDisplayBlock | FileContentDisplayBlock;

export interface ApprovalPreviewViewerProps {
  readonly block: ApprovalPreviewBlock;
  readonly onClose: () => void;
}

/** 将行填充到指定宽度，超出时截断。 */
function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

/** 精确适配到指定宽度：先截断再填充。 */
function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

export class ApprovalPreviewViewer extends Container implements Focusable {
  focused = false;

  private readonly props: ApprovalPreviewViewerProps;
  private readonly terminal: Terminal;
  /** 预渲染的正文行（ANSI 样式，无边框/无装订线）。 */
  private bodyLines: string[];
  /** 标题栏中显示的标题（路径 + diff 统计 / "Write" 标签）。 */
  private headerTitle: string;
  /** 顶部可见行的索引。 */
  private scrollTop = 0;

  constructor(props: ApprovalPreviewViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    const built = buildBody(props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
  }

  handleInput(data: string): void {
    const visible = this.viewableRows();
    const k = printableChar(data);

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('e')) ||
      k === 'q' ||
      k === 'Q'
    ) {
      this.props.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp) || k === ' ' || data === '\x02') {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.pageDown) || data === '\x06') {
      this.scrollBy(Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      this.scrollTo(this.maxScroll());
      return;
    }
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollTop + delta);
  }

  override invalidate(): void {
    const built = buildBody(this.props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
  }

  private scrollTo(target: number): void {
    this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
    super.invalidate();
  }

  private maxScroll(): number {
    return Math.max(0, this.bodyLines.length - this.viewableRows());
  }

  /** 正文行数 = 终端行数 − 标题栏(1) − 上边框(1) − 下边框(1) − 底栏(1)。 */
  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;

    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width, bodyHeight);

    return [header, ...body, footer];
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', ' Preview ');
    return fitExactly(title + this.headerTitle, width);
  }

  private renderBody(width: number, bodyHeight: number): string[] {
    const innerWidth = Math.max(1, width - 4);

    const max = this.maxScroll();
    if (this.scrollTop > max) this.scrollTop = max;
    if (this.scrollTop < 0) this.scrollTop = 0;

    const viewRows = bodyHeight - 2;
    const top = currentTheme.fg('primary', '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [top];
    for (let i = 0; i < viewRows; i++) {
      const lineIndex = this.scrollTop + i;
      const raw = this.bodyLines[lineIndex] ?? '';
      out.push(currentTheme.fg('primary', '│ ') + fitExactly(raw, innerWidth) + currentTheme.fg('primary', ' │'));
    }
    out.push(bottom);
    return out;
  }

  private renderFooter(width: number, bodyHeight: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    const total = this.bodyLines.length;
    const viewRows = Math.max(1, bodyHeight - 2);
    const maxScroll = Math.max(0, total - viewRows);
    const percent = maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
    const lineFrom = total === 0 ? 0 : this.scrollTop + 1;
    const lineTo = Math.min(total, this.scrollTop + viewRows);

    const position = currentTheme.fg(
      'textMuted',
      ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `,
    );
    const keys =
      `${key('↑↓')} ${dim('line')}  ` +
      `${key('PgUp/PgDn')} ${dim('page')}  ` +
      `${key('g/G')} ${dim('top/bot')}  ` +
      `${key('Q/Esc/Ctrl+E')} ${dim('cancel')}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }
}

interface BuiltBody {
  lines: string[];
  title: string;
}

/** 根据展示块类型构建正文内容。 */
function buildBody(block: ApprovalPreviewBlock): BuiltBody {
  if (block.type === 'diff') {
    return buildDiffBody(block);
  }
  return buildFileContentBody(block);
}

/** 构建 diff 正文：将首行标题提取到查看器 chrome 中，正文为纯可滚动的 diff 内容。 */
function buildDiffBody(block: DiffDisplayBlock): BuiltBody {
  // renderDiffLines 输出 `+N -M path` 标题行作为首行，后面是所有变更行。
  // 我们将标题提取到查看器的 chrome 中，使正文为纯可滚动的 diff 内容；
  // 这也意味着我们不会重复渲染路径。
  const rendered = renderDiffLines(
    block.old_text,
    block.new_text,
    block.path,
    false,
    block.old_start ?? 1,
    block.new_start ?? 1,
  );
  const [header = '', ...rest] = rendered;
  return { lines: rest, title: stripLeadingSpace(header) };
}

/** 构建文件内容正文：带行号高亮显示。 */
function buildFileContentBody(block: FileContentDisplayBlock): BuiltBody {
  const lang = block.language ?? langFromPath(block.path);
  const highlighted = highlightLines(block.content, lang);
  const lines = highlighted.map(
    (line, i) => currentTheme.fg('diffGutter', String(i + 1).padStart(4) + '  ') + line,
  );
  const title = currentTheme.fg('textStrong', block.path);
  return { lines, title };
}

/** 去除字符串开头的空格。 */
function stripLeadingSpace(s: string): string {
  return s.replace(/^ +/, '');
}

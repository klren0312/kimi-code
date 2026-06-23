/**
 * ChoicePicker —— 用于斜杠命令的模态单选列表，要求用户从少量预设值中选择。
 *
 * 镜像 SessionPickerComponent 的容器替换模式：宿主调用 `showChoicePicker(...)`，
 * 该方法清除编辑器容器，addChild(picker)，setFocus(picker)；选择器调用
 * `onSelect` 或 `onCancel`，宿主将其移除。
 */

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface ChoiceOption {
  /** 传递给 onSelect 的值（如实际的编辑器命令字符串）。 */
  readonly value: string;
  /** 列表中显示的文本。 */
  readonly label: string;
  /** 可选的语义色调，用于需要更强视觉效果的标签。 */
  readonly tone?: 'danger';
  /** 可选的说明文本，显示在标签下方。 */
  readonly description?: string | undefined;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly hint?: string;
  readonly formatHint?: (text: string) => string;
  readonly notice?: string;
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  /** 为 true 时，输入的字符会过滤列表（模糊匹配），并显示搜索行。 */
  readonly searchable?: boolean;
  /** 每页显示项数。超过此数量的列表会分页。 */
  readonly pageSize?: number;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

/** 将描述文本按指定宽度自动换行。 */
function wrapDescription(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, '…');
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

export class ChoicePickerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ChoicePickerOptions;
  private readonly list: SearchableList<ChoiceOption>;

  constructor(opts: ChoicePickerOptions) {
    super();
    this.opts = opts;
    const currentIdx = opts.options.findIndex((o) => o.value === opts.currentValue);
    this.list = new SearchableList({
      items: opts.options,
      toSearchText: (o) => `${o.label} ${o.description ?? ''}`,
      pageSize: opts.pageSize,
      initialIndex: Math.max(currentIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    // 左/右方向键用于翻页（此选择器无水平控制）。
    if (matchesKey(data, Key.left)) {
      this.list.pageUp();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.list.pageDown();
      return;
    }
    // Enter 始终选中。空格也选中 —— 但仅在列表不可搜索时；
    // 在可搜索列表中，空格需要传递给查询输入。
    const isSpace = matchesKey(data, Key.space) || printableChar(data) === ' ';
    if (matchesKey(data, Key.enter) || (isSpace && this.opts.searchable !== true)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const options = view.items;

    // 标题栏镜像模型对话框（见 model-selector.ts）：边框、标题带
    // "(type to search)" 后缀（输入前显示），提示，空行，然后搜索行。
    // 关键词词汇统一使用小写以匹配所有列表对话框。
    const navParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) navParts.push('←→ page');
    navParts.push('Enter select', 'Esc cancel');
    const hint = this.opts.hint ?? navParts.join(' · ');

    const titleSuffix =
      searchable && view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintLines = hint.split(/\r?\n/);
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.title}`) + titleSuffix,
    ];
    for (const hintLine of hintLines) {
      lines.push(
        this.opts.formatHint === undefined
          ? currentTheme.fg('textMuted', ` ${hintLine}`)
          : this.opts.formatHint(` ${hintLine}`),
      );
    }
    if (this.opts.notice !== undefined) {
      for (const noticeLine of this.opts.notice.split(/\r?\n/)) {
        lines.push(currentTheme.fg('success', ` ${noticeLine}`));
      }
    }
    lines.push('');
    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ` Search: `) + currentTheme.fg('text', view.query));
    }

    if (options.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    }
    for (let i = view.page.start; i < view.page.end; i++) {
      const opt = options[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = opt.value === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const labelStyle = optionLabelStyle(opt, isSelected);
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += labelStyle(opt.label);
      if (isCurrent) {
        line += ' ' + currentTheme.fg('success', CURRENT_MARK);
      }
      lines.push(line);
      if (opt.description !== undefined && opt.description.length > 0) {
        const descriptionWidth = Math.max(1, width - 4);
        for (const descLine of wrapDescription(opt.description, descriptionWidth)) {
          lines.push(currentTheme.fg('textMuted', `    ${descLine}`));
        }
      }
    }

    lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(
        currentTheme.fg('textMuted',
          ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
        ),
      );
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

/** 根据选项的语义色调和选中状态返回标签样式函数。 */
function optionLabelStyle(
  option: ChoiceOption,
  selected: boolean,
): (text: string) => string {
  if (option.tone === 'danger') {
    return selected
      ? (text) => currentTheme.boldFg('error', text)
      : (text) => currentTheme.fg('error', text);
  }
  return selected
    ? (text) => currentTheme.boldFg('primary', text)
    : (text) => currentTheme.fg('text', text);
}

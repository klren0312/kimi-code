import {
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

// 镜像 pi-tui 私有的 select-list 布局常量
// (dist/components/select-list.js)；升级 pi-tui 时需保持同步。
const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const DESCRIPTION_MAX_LINES = 2;
const ELLIPSIS = '…';
const ELLIPSIS_WIDTH = visibleWidth(ELLIPSIS);

// truncateToWidth 在实际截断时会追加 ANSI 重置序列。
// 此处的标签和描述为纯文本，重置序列会位于
// 主题颜色包装内部并重置该行其余部分（例如
// 截断名称的选中行在名称后会丢失颜色），
// 因此将其去除。
// oxlint-disable-next-line no-control-regex -- 需要 ESC (\x1b) 来匹配 ANSI SGR 转义序列
const TRAILING_ANSI_RESET = /(?:\u001B\[0m)+$/;

function truncatePlainToWidth(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth, '').replace(TRAILING_ANSI_RESET, '');
}

interface SelectListInternals {
  readonly filteredItems: SelectItem[];
  readonly selectedIndex: number;
  readonly maxVisible: number;
  readonly theme: SelectListTheme;
  readonly layout: SelectListLayoutOptions;
}

/**
 * 将条目描述最多换行显示两行而非截断为一行的 SelectList。
 * 长命令/技能描述保持可读性；超出第二行的部分用省略号截断。
 *
 * 仅替换 `render`——选择、过滤和按键处理仍保留在 pi-tui 中。
 * pi-tui 将行状态设为私有，因此渲染器通过类型转换读取，
 * 与 CustomEditor 访问自动补全内部状态的惯用方式相同。
 */
export class WrappingSelectList extends SelectList {
  override render(width: number): string[] {
    const { filteredItems, selectedIndex, maxVisible, theme } = this.internals();
    if (filteredItems.length === 0) {
      return [theme.noMatch('  No matching commands')];
    }

    const primaryColumnWidth = this.primaryColumnWidth();
    const startIndex = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);

    const lines: string[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const item = filteredItems[i];
      if (!item) continue;
      lines.push(...this.renderItemLines(item, i === selectedIndex, width, primaryColumnWidth));
    }

    if (startIndex > 0 || endIndex < filteredItems.length) {
      const scrollText = `  (${selectedIndex + 1}/${filteredItems.length})`;
      lines.push(theme.scrollInfo(truncatePlainToWidth(scrollText, width - 2)));
    }
    return lines;
  }

  private renderItemLines(
    item: SelectItem,
    isSelected: boolean,
    width: number,
    primaryColumnWidth: number,
  ): string[] {
    const { theme } = this.internals();
    const prefix = isSelected ? '→ ' : '  ';
    const prefixWidth = visibleWidth(prefix);
    const description = item.description
      ? item.description.replaceAll(/[\r\n]+/g, ' ').trim()
      : undefined;

    if (description && width > 40) {
      const effectivePrimaryColumnWidth = Math.max(
        1,
        Math.min(primaryColumnWidth, width - prefixWidth - 4),
      );
      const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
      const truncatedValue = this.truncatePrimaryValue(
        item,
        isSelected,
        maxPrimaryWidth,
        effectivePrimaryColumnWidth,
      );
      const truncatedValueWidth = visibleWidth(truncatedValue);
      const spacing = ' '.repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
      const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
      const remainingWidth = width - descriptionStart - 2; // -2 为安全余量，与上游一致
      if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
        const descriptionLines = wrapDescription(description, remainingWidth);
        const indent = ' '.repeat(descriptionStart);
        if (isSelected) {
          return descriptionLines.map((line, index) =>
            theme.selectedText(index === 0 ? `${prefix}${truncatedValue}${spacing}${line}` : indent + line),
          );
        }
        return descriptionLines.map((line, index) =>
          index === 0
            ? prefix + truncatedValue + theme.description(spacing + line)
            : theme.description(indent + line),
        );
      }
    }

    const maxWidth = width - prefixWidth - 2;
    const truncatedValue = this.truncatePrimaryValue(item, isSelected, maxWidth, maxWidth);
    return [isSelected ? theme.selectedText(`${prefix}${truncatedValue}`) : prefix + truncatedValue];
  }

  private truncatePrimaryValue(
    item: SelectItem,
    isSelected: boolean,
    maxWidth: number,
    columnWidth: number,
  ): string {
    const { layout } = this.internals();
    const displayValue = item.label || item.value;
    const truncated = layout.truncatePrimary
      ? layout.truncatePrimary({ text: displayValue, maxWidth, columnWidth, item, isSelected })
      : displayValue;
    return truncatePlainToWidth(truncated, maxWidth);
  }

  private primaryColumnWidth(): number {
    const { filteredItems, layout } = this.internals();
    const rawMin =
      layout.minPrimaryColumnWidth ?? layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
    const rawMax =
      layout.maxPrimaryColumnWidth ?? layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
    const min = Math.max(1, Math.min(rawMin, rawMax));
    const max = Math.max(1, Math.max(rawMin, rawMax));
    const widest = filteredItems.reduce(
      (acc, item) => Math.max(acc, visibleWidth(item.label || item.value) + PRIMARY_COLUMN_GAP),
      0,
    );
    return Math.max(min, Math.min(widest, max));
  }

  private internals(): SelectListInternals {
    return this as unknown as SelectListInternals;
  }
}

/**
 * 将 `text` 最多换行至 DESCRIPTION_MAX_LINES 行，每行 `width` 列。
 * 当文本需要更多行时，最后一行从剩余文本重建并添加省略号截断。
 */
function wrapDescription(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, width);
  if (wrapped.length <= DESCRIPTION_MAX_LINES) {
    return wrapped;
  }
  const kept = wrapped.slice(0, DESCRIPTION_MAX_LINES - 1);
  const rest = wrapped.slice(DESCRIPTION_MAX_LINES - 1).join(' ');
  const clipped = truncatePlainToWidth(rest, width - ELLIPSIS_WIDTH).trimEnd();
  return [...kept, `${clipped}${ELLIPSIS}`];
}

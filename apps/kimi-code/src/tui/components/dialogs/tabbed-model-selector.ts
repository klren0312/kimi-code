/**
 * TabbedModelSelectorComponent —— ModelSelectorComponent 的薄包装器，
 * 将模型列表按提供商拆分为标签页。
 *
 * 标签页由构造时传入的 `models` 派生：
 *   ['all', ...uniqueProviderIds]   （插入顺序，去重）
 *
 * 每个标签页拥有自己的内部 ModelSelectorComponent，使用过滤后的模型子集构建。
 * ↑/↓/Enter/Esc/←/→（thinking）和输入（过滤）转发到活动的内部选择器；
 * Tab / Shift-Tab 在标签页之间切换。
 *
 * 活动标签页以填充背景高亮（与 AskUserQuestion 对话框的标签栏一致）
 * —— 参见 .agents/skills/write-tui/DESIGN.md。
 */

import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

import {
  ModelSelectorComponent,
  providerDisplayName,
  type ModelSelection,
  type ModelSelectorOptions,
} from './model-selector';

const ALL_TAB_ID = 'all';
const ALL_TAB_LABEL = 'All';

export interface TabbedModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinking: boolean;
  /** 设置后，该提供商 ID 对应的标签页初始激活，而非从 `currentValue` 派生的标签页。 */
  readonly initialTabId?: string;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

interface ModelTab {
  readonly id: string;
  readonly label: string;
  readonly selector: ModelSelectorComponent;
}

export class TabbedModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TabbedModelSelectorOptions;
  private readonly tabs: readonly ModelTab[];
  private activeIndex: number;

  constructor(opts: TabbedModelSelectorOptions) {
    super();
    this.opts = opts;
    this.tabs = buildTabs(opts);

    // 默认使用 "All" 标签页。仅当设置了显式 initialTabId（例如通过 /provider 新增的提供商）
    // 时才在特定提供商标签页上打开 —— 当前模型仍在活动标签页内高亮显示。
    const initialTabIdx = opts.initialTabId
      ? this.tabs.findIndex((tab) => tab.id === opts.initialTabId)
      : -1;
    this.activeIndex = Math.max(initialTabIdx, 0);
    this.syncFocusToActive();
  }

  handleInput(data: string): void {
    if (this.tabs.length > 1) {
      if (matchesKey(data, Key.tab)) {
        this.activeIndex = (this.activeIndex + 1) % this.tabs.length;
        this.syncFocusToActive();
        return;
      }
      if (matchesKey(data, Key.shift('tab'))) {
        this.activeIndex = (this.activeIndex - 1 + this.tabs.length) % this.tabs.length;
        this.syncFocusToActive();
        return;
      }
    }
    this.tabs[this.activeIndex]?.selector.handleInput(data);
  }

  override render(width: number): string[] {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return [];
    const inner = active.selector.render(width);
    if (this.tabs.length <= 1) {
      return inner.map((line) => truncateToWidth(line, width));
    }
    // 布局：分隔线、标题、提示、空行、标签栏、空行，然后是模型列表。
    // 内部选择器的空行（inner[3]）分隔提示与标签栏；
    // 额外的空行分隔标签栏与列表。
    const stripLine = this.renderTabStrip(width);
    const out: string[] = [
      inner[0] ?? '',
      inner[1] ?? '',
      inner[2] ?? '',
      inner[3] ?? '',
      stripLine,
      '',
    ];
    for (let i = 4; i < inner.length; i++) out.push(inner[i]!);
    return out.map((line) => truncateToWidth(line, width));
  }

  override invalidate(): void {
    super.invalidate();
    for (const tab of this.tabs) {
      tab.selector.invalidate();
    }
  }

  /** 将焦点同步到活动标签页。 */
  private syncFocusToActive(): void {
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i]!;
      tab.selector.focused = this.focused && i === this.activeIndex;
    }
  }

  /** 设置标签片段的样式。活动标签使用品牌背景填充（与 AskUserQuestion 对话框一致）；
   * 非活动标签使用静音色。两者可见宽度相同，切换时不会导致布局偏移。 */
  private styleTab(label: string, isActive: boolean): string {
    const cell = ` ${label} `;
    return isActive
      ? currentTheme.bg('primary', currentTheme.boldFg('text', cell))
      : currentTheme.fg('textMuted', cell);
  }

  /** 渲染标签栏，支持在空间不足时滚动显示。 */
  private renderTabStrip(width: number): string {
    const segments: string[] = [];
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i]!;
      segments.push(this.styleTab(tab.label, i === this.activeIndex));
    }

    // 如果所有标签加上前导空格能放得下，则显示完整标签栏。
    // 提供商切换提示在内部选择器的提示行中，不在此处。
    const totalSegmentWidth = segments.reduce((sum, s) => sum + visibleWidth(s), 0);
    if (1 + totalSegmentWidth <= width) {
      return ' ' + segments.join(' ');
    }

    // 需要滚动。找到包含 activeIndex 的最宽窗口。
    const segmentWidths = segments.map((s) => visibleWidth(s));
    let start = this.activeIndex;
    let end = this.activeIndex + 1;
    let contentWidth = segmentWidths[this.activeIndex]!;

    const fits = (s: number, e: number, cw: number): boolean => {
      const needLeft = s > 0;
      const needRight = e < segments.length;
      const frameWidth = (needLeft ? 2 : 1) + (needRight ? 2 : 0);
      return cw + frameWidth <= width;
    };

    while (true) {
      const leftW = start > 0 ? segmentWidths[start - 1]! : Infinity;
      const rightW = end < segments.length ? segmentWidths[end]! : Infinity;
      if (leftW === Infinity && rightW === Infinity) break;

      if (leftW <= rightW) {
        if (fits(start - 1, end, contentWidth + leftW)) {
          contentWidth += leftW;
          start--;
        } else if (fits(start, end + 1, contentWidth + rightW)) {
          contentWidth += rightW;
          end++;
        } else {
          break;
        }
      } else {
        if (fits(start, end + 1, contentWidth + rightW)) {
          contentWidth += rightW;
          end++;
        } else if (fits(start - 1, end, contentWidth + leftW)) {
          contentWidth += leftW;
          start--;
        } else {
          break;
        }
      }
    }

    const hasLeft = start > 0;
    const hasRight = end < segments.length;
    let strip = hasLeft ? currentTheme.fg('textMuted', '< ') : ' ';
    strip += segments.slice(start, end).join(' ');
    if (hasRight) {
      strip += currentTheme.fg('textMuted', ' >');
    }
    return strip;
  }
}

/** 根据选项构建标签页列表（"全部" + 各提供商标签页）。 */
function buildTabs(opts: TabbedModelSelectorOptions): readonly ModelTab[] {
  const entries = Object.entries(opts.models);
  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const [, model] of entries) {
    const provider = model.provider;
    if (!seen.has(provider)) {
      seen.add(provider);
      providerIds.push(provider);
    }
  }

  const tabs: ModelTab[] = [
    {
      id: ALL_TAB_ID,
      label: ALL_TAB_LABEL,
      selector: makeSelector(opts, opts.models),
    },
  ];
  for (const providerId of providerIds) {
    const subset: Record<string, ModelAlias> = {};
    for (const [alias, model] of entries) {
      if (model.provider === providerId) subset[alias] = model;
    }
    tabs.push({
      id: providerId,
      label: providerDisplayName(providerId),
      selector: makeSelector(opts, subset),
    });
  }
  return tabs;
}

/** 为指定的模型子集创建内部 ModelSelectorComponent 实例。 */
function makeSelector(
  opts: TabbedModelSelectorOptions,
  subset: Record<string, ModelAlias>,
): ModelSelectorComponent {
  const candidate = opts.selectedValue ?? opts.currentValue;
  const selectedValue = subset[candidate] !== undefined ? candidate : undefined;
  const inner: ModelSelectorOptions = {
    models: subset,
    currentValue: opts.currentValue,
    ...(selectedValue !== undefined ? { selectedValue } : {}),
    currentThinking: opts.currentThinking,
    searchable: true,
    providerSwitchHint: true,
    onSelect: opts.onSelect,
    onCancel: opts.onCancel,
  };
  return new ModelSelectorComponent(inner);
}

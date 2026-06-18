import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

const ELLIPSIS = '…';

export interface ExperimentalFeatureDraftChange {
  readonly id: ExperimentalFeatureState['id'];
  readonly enabled: boolean;
}

export interface ExperimentsSelectorOptions {
  readonly features: readonly ExperimentalFeatureState[];
  readonly onApply: (changes: readonly ExperimentalFeatureDraftChange[]) => void;
  readonly onCancel: () => void;
}

export class ExperimentsSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: ExperimentsSelectorOptions;
  private readonly list: SearchableList<ExperimentalFeatureState>;
  /** 功能开关的草稿变更，提交时与原始状态对比生成变更列表。 */
  private readonly draft = new Map<ExperimentalFeatureState['id'], boolean>();

  constructor(opts: ExperimentsSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.features,
      toSearchText: (feature) => `${feature.title} ${feature.id} ${feature.description}`,
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const changes = this.draftChanges();
      if (changes.length > 0) this.opts.onApply(changes);
      return;
    }
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      const selected = this.list.selected();
      if (selected !== undefined) this.toggleDraft(selected);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('PgUp/PgDn page');
    hintParts.push('Space toggle', 'Enter apply', 'Esc cancel');
    if (view.query.length > 0) hintParts.push('Backspace clear');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Experimental features') + titleSuffix,
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ` Search: `) + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    }

    for (let i = view.page.start; i < view.page.end; i++) {
      const feature = view.items[i]!;
      const selected = i === view.selectedIndex;
      lines.push(...this.renderFeature(feature, selected, width));
    }

    lines.push('');
    if (view.query.length > 0) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ${String(view.items.length)} / ${String(this.opts.features.length)}`,
        ),
      );
    } else if (view.page.end < view.items.length) {
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` ▼ ${String(view.items.length - view.page.end)} more`,
        ),
      );
    }
    lines.push(this.renderApplyButton());
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  /** 切换指定功能的草稿启用状态。 */
  private toggleDraft(feature: ExperimentalFeatureState): void {
    if (isLocked(feature)) return;

    const enabled = !this.effectiveEnabled(feature);
    if (enabled === feature.enabled) {
      this.draft.delete(feature.id);
      return;
    }
    this.draft.set(feature.id, enabled);
  }

  /** 获取功能的有效启用状态（优先使用草稿值，否则使用原始值）。 */
  private effectiveEnabled(feature: ExperimentalFeatureState): boolean {
    return this.draft.get(feature.id) ?? feature.enabled;
  }

  /** 检查功能的草稿是否与原始状态不同。 */
  private isDraftChanged(feature: ExperimentalFeatureState): boolean {
    return this.effectiveEnabled(feature) !== feature.enabled;
  }

  /** 收集所有已变更的草稿项。 */
  private draftChanges(): ExperimentalFeatureDraftChange[] {
    const changes: ExperimentalFeatureDraftChange[] = [];
    for (const feature of this.opts.features) {
      if (this.isDraftChanged(feature)) {
        changes.push({ id: feature.id, enabled: this.effectiveEnabled(feature) });
      }
    }
    return changes;
  }

  /** 渲染"应用变更并重新加载"按钮。 */
  private renderApplyButton(): string {
    const changes = this.draftChanges();
    const count = changes.length;
    const label = '[ Apply changes and reload ]';
    const summary =
      count === 0 ? 'no changes' : `${String(count)} ${count === 1 ? 'change' : 'changes'}`;
    const button = count === 0
      ? currentTheme.fg('textDim', label)
      : currentTheme.boldFg('primary', label);
    const summaryText = count === 0
      ? currentTheme.fg('textMuted', summary)
      : currentTheme.fg('success', summary);
    return ` ${button}  ${summaryText}`;
  }

  /** 渲染单个实验功能条目。 */
  private renderFeature(
    feature: ExperimentalFeatureState,
    selected: boolean,
    width: number,
  ): string[] {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const label = selected ? currentTheme.boldFg('primary', feature.title) : currentTheme.fg('text', feature.title);
    const enabled = this.effectiveEnabled(feature);
    const status = enabled ? 'enabled' : 'disabled';
    const statusText = enabled ? currentTheme.fg('success', status) : currentTheme.fg('textDim', status);
    const detail = this.isDraftChanged(feature)
      ? `${featureDetail(feature)} · modified`
      : featureDetail(feature);
    const lines = [
      `${prefix}${label}  ${statusText}`,
      currentTheme.fg('textMuted', `    ${detail}`),
    ];
    const descriptionWidth = Math.max(1, width - 4);
    for (const line of wrapText(feature.description, descriptionWidth)) {
      lines.push(currentTheme.fg('textMuted', `    ${line}`));
    }
    return lines;
  }
}

/** 检查功能是否被环境变量锁定（不可修改）。 */
function isLocked(feature: ExperimentalFeatureState): boolean {
  return feature.source === 'env' || feature.source === 'master-env';
}

/** 生成功能的详细信息文本（ID、来源、环境变量名）。 */
function featureDetail(feature: ExperimentalFeatureState): string {
  const source = sourceLabel(feature);
  if (feature.source === 'env' || feature.source === 'master-env') {
    return `id ${feature.id} · ${source}`;
  }
  return `id ${feature.id} · ${source} · ${feature.env}`;
}

/** 根据功能来源返回对应的中文标签。 */
function sourceLabel(feature: ExperimentalFeatureState): string {
  switch (feature.source) {
    case 'master-env':
      return 'locked by KIMI_CODE_EXPERIMENTAL_FLAG';
    case 'env':
      return `locked by ${feature.env}`;
    case 'config':
      return 'config';
    case 'default':
      return 'default';
  }
}

/** 将文本按指定宽度自动换行。 */
function wrapText(text: string, width: number): string[] {
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
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

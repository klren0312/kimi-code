import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

import type { ChoiceOption } from './choice-picker';

type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  /** 模型显示名称（左列）。 */
  readonly name: string;
  /** 提供商显示名称（右列）。 */
  readonly provider: string;
  /** 模糊过滤器匹配的组合文本（名称 + 提供商）。 */
  readonly label: string;
}

export interface ModelSelection {
  readonly alias: string;
  readonly thinking: boolean;
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  return model?.displayName ?? model?.model ?? alias;
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

export function createModelChoiceOptions(
  models: Record<string, ModelAlias>,
): readonly ChoiceOption[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    value: alias,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
  }));
}

export interface ModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinking: boolean;
  /** 为 true 时，输入的字符会过滤列表（模糊匹配），并显示搜索行。 */
  readonly searchable?: boolean;
  /** 每页显示项数。超过此数量的列表会分页（PgUp/PgDn）。 */
  readonly pageSize?: number;
  /** 为 true 时，提示行中提及 Tab 切换提供商 —— 由 TabbedModelSelectorComponent
   * 设置，使内部列表展示 Tab 键提示。 */
  readonly providerSwitchHint?: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

/** 根据模型列表创建模型选项数组。 */
function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => {
    const name = modelDisplayName(alias, cfg);
    const provider = providerDisplayName(cfg.provider);
    return { alias, model: cfg, name, provider, label: `${name} (${provider})` };
  });
}

/** 检测模型的 thinking 能力可用性。 */
function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  if (caps.includes('thinking') || model.adaptiveThinking === true) return 'toggle';
  return 'unsupported';
}

/** 计算模型的有效 thinking 状态。 */
function effectiveThinking(model: ModelAlias, thinkingDraft: boolean): boolean {
  const availability = thinkingAvailability(model);
  if (availability === 'always-on') return true;
  if (availability === 'unsupported') return false;
  return thinkingDraft;
}

/**
 * 扁平的、可搜索的单列表模型选择器。
 *
 * 单一导航轴：↑/↓ 移动光标（PgUp/PgDn 翻页），输入内容跨所有提供商
 * 进行模糊过滤（提供商名称也包含在内），←/→ 切换支持 thinking 的模型
 * 的 thinking 草稿状态。没有提供商标签页 —— 输入提供商名称过滤即可替代。
 * 参见 .agents/skills/write-tui/DESIGN.md。
 */
export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ModelSelectorOptions;
  private readonly list: SearchableList<ModelChoice>;
  /** 通过 ←/→ 设置的逐模型 thinking 覆盖值；未设置时使用能力默认值。 */
  private readonly thinkingOverrides = new Map<string, boolean>();

  constructor(opts: ModelSelectorOptions) {
    super();
    this.opts = opts;
    const choices = createModelChoices(opts.models);
    const selectedValue = opts.selectedValue ?? opts.currentValue;
    const selectedIdx = choices.findIndex((choice) => choice.alias === selectedValue);
    this.list = new SearchableList({
      items: choices,
      toSearchText: (choice) => choice.label,
      pageSize: opts.pageSize,
      initialIndex: Math.max(selectedIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  /**
   * 模型的 thinking 草稿：设置了显式 ←/→ 覆盖时使用覆盖值，
   * 否则对当前活动模型使用实时 thinking 状态，对其他支持 thinking 的
   * 模型默认为开启（有能力的模型应默认开启 thinking）。
   */
  private draftFor(choice: ModelChoice): boolean {
    const override = this.thinkingOverrides.get(choice.alias);
    if (override !== undefined) return override;
    if (choice.alias === this.opts.currentValue) return this.opts.currentThinking;
    return thinkingAvailability(choice.model) !== 'unsupported';
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }

    // ↑/↓、PgUp/PgDn，以及——在可搜索模式下——输入 + Backspace。
    if (this.list.handleKey(data)) {
      return;
    }

    // 左/右方向键切换支持 thinking 的模型的 thinking 草稿状态。
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const selected = this.selectedChoice();
      if (selected !== undefined && thinkingAvailability(selected.model) === 'toggle') {
        this.thinkingOverrides.set(selected.alias, !this.draftFor(selected));
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.selectedChoice();
      if (selected === undefined) return;
      this.opts.onSelect({
        alias: selected.alias,
        thinking: effectiveThinking(selected.model, this.draftFor(selected)),
      });
    }
  }

  override render(width: number): string[] {
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const totalCount = Object.keys(this.opts.models).length;

    const titleSuffix =
      searchable && view.query.length === 0
        ? currentTheme.fg('textMuted', '  (type to search)')
        : '';

    // "type to search" 已经在标题后缀中，因此提示行仅在查询激活后
    // 才显示 Backspace 快捷键。
    const hintParts: string[] = [];
    if (this.opts.providerSwitchHint) hintParts.push('Tab toggle provider');
    hintParts.push('↑↓ navigate');
    if (searchable && view.query.length > 0) hintParts.push('Backspace clear');
    hintParts.push('Enter select', 'Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Select a model') + titleSuffix,
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
      '',
    ];

    if (searchable && view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No matches'));
    } else {
      // 模型名称的列宽，使提供商列对齐。设置上限以确保
      // 提供商 + "← current" 标记在正常终端宽度下仍然适配。
      const nameCap = Math.max(8, Math.floor(width * 0.5));
      let nameWidth = 0;
      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(choice.name));
      }
      nameWidth = Math.min(nameWidth, nameCap);

      for (let i = view.page.start; i < view.page.end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        const isSelected = i === view.selectedIndex;
        const isCurrent = choice.alias === this.opts.currentValue;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const truncatedName = truncateToWidth(choice.name, nameWidth, '…');
        const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(truncatedName)));
        let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        line += (isSelected ? currentTheme.boldFg('primary', truncatedName) : currentTheme.fg('text', truncatedName)) + namePad;
        line += '  ' + currentTheme.fg('textMuted', choice.provider);
        if (isCurrent) {
          line += ' ' + currentTheme.fg('success', CURRENT_MARK);
        }
        lines.push(line);
      }
    }

    // 滚动/匹配指示器。
    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        currentTheme.fg('textMuted', ` ${String(view.items.length)} / ${String(totalCount)}`),
      );
    } else {
      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
      }
    }

    lines.push('');
    const selected = this.selectedChoice();
    if (selected !== undefined) {
      const availability = thinkingAvailability(selected.model);
      const thinkingHeader = availability === 'toggle' ? ' Thinking  (←→ to switch)' : ' Thinking';
      lines.push(currentTheme.fg('textMuted', thinkingHeader));
      lines.push(this.renderThinkingControl(selected));
    }
    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private selectedChoice(): ModelChoice | undefined {
    return this.list.selected();
  }

  /** 渲染 thinking 开关控件。 */
  private renderThinkingControl(choice: ModelChoice): string {
    const segment = (label: string, active: boolean): string =>
      active
        ? currentTheme.boldFg('primary', `[ ${label} ]`)
        : currentTheme.fg('text', `  ${label}  `);
    // 整个片段（含后缀）都是静音色，使不可用的一侧显示为单一灰色控件，
    // 而非可选选项。
    const unavailable = (label: string): string =>
      currentTheme.fg('textMuted', `  ${label} (Unsupported)  `);

    // On 始终在左侧，Off 始终在右侧，三种状态下保持一致，
    // 使控件在光标跨模型移动时不会产生位移。
    const availability = thinkingAvailability(choice.model);
    if (availability === 'always-on') {
      return `  ${segment('On', true)} ${unavailable('Off')}`;
    }
    if (availability === 'unsupported') {
      return `  ${unavailable('On')} ${segment('Off', true)}`;
    }
    const draft = this.draftFor(choice);
    return `  ${segment('On', draft)}  ${segment('Off', !draft)}`;
  }
}

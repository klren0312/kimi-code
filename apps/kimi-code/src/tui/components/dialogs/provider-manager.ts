/**
 * ProviderManagerComponent — `/provider` 命令的纯视图 CRUD UI。
 *
 * 单列布局，每行显示一个"平台 / 来源"：
 *   - 每个 Open Platform 登录（1 个来源 = 1 个 provider）
 *   - 每个 Custom Registry 连接按 `{url, apiKey}` 分组
 *     （1 个来源 = 同一次 api.json 获取的 N 个 provider）
 *   - 任何其他已配置的 provider（1 个来源 = 1 个 provider）
 *   - 一个合成的 `[ Add New Platform ]` 操作行
 * Kimi Code OAuth（`DEFAULT_OAUTH_PROVIDER_NAME`）被有意隐藏
 * ——该账户通过 `/login` / `/logout` 管理，不在此处。
 *
 * 键盘：
 *   - ↑ / ↓             移动高亮
 *   - ← / → · PgUp/PgDn 翻页
 *   - Enter             在 `[ Add New Platform ]` 上 → `onAdd()`
 *   - D                 带内联 `[y/N]` 确认的删除
 *                         在来源行上 → `onDeleteSource(providerIds)`
 *                         在 `[ Add New Platform ]` 上 → 忽略
 *   - Esc               `onClose()`（在确认之外）
 *
 * `[y/N]` 确认是组件内处理的瞬态子状态：
 * 激活时，仅响应 `y` / `Y` / `n` / `N` / `Esc`，
 * 提示替换底栏提示。
 *
 * 该组件是纯视图：所有 CRUD 副作用通过回调派发。
 * 宿主（`KimiTui`）负责执行 harness / config 变更，
 * 然后通过 `setOptions` 推送新快照。
 */

import type { ProviderConfig } from '@moonshot-ai/kimi-code-sdk';
import {
  getOpenPlatformById,
  isOpenPlatformId,
  type CustomRegistrySource,
} from '@moonshot-ai/kimi-code-oauth';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { pageView, type PageView } from '#/tui/utils/paging';

interface ConfirmState {
  readonly label: string;
  readonly providerIds: readonly string[];
}

export interface ProviderManagerOptions {
  /** 所有当前已配置的 providers（`config.providers`）。 */
  readonly providers: Record<string, ProviderConfig>;
  /** 当前活跃模型的 provider id。 */
  readonly activeProviderId?: string;
  readonly onAdd: () => void;
  /** 删除某个来源（Open Platform / custom-registry
   *  获取 / 独立）下的所有 providers。传递完整的 provider id 列表，
   *  以便宿主无需重新推导来源分组。 */
  readonly onDeleteSource: (providerIds: readonly string[]) => void;
  readonly onClose: () => void;
}

/** 真实（非合成）来源行。 */
interface SourceRow {
  readonly kind: 'source';
  readonly id: string;
  readonly label: string;
  readonly providerIds: readonly string[];
  /** 当 `providerIds` 中有一个是当前活跃 provider 时为 true。 */
  readonly hasActive: boolean;
  /** 从 provider 配置中提取的可选基础 URL。 */
  readonly baseUrl?: string;
}

/** 固定在底部的合成 `[ Add New Platform ]` 操作行。 */
interface AddRow {
  readonly kind: 'add';
  readonly id: '__add__';
  readonly label: string;
}

type Row = SourceRow | AddRow;

const ADD_ROW_LABEL = '[ Add New Platform ]';
const PAGE_SIZE = 8;
const HEADER_HINT = '↑↓ navigate · D delete · Esc cancel';

// 将 `ProviderConfig` 数据收窄为 `CustomRegistrySource` 载荷。
// 镜像 `kimi-tui.ts` 中的 `readCustomRegistrySource`。我们无法
// 导入该辅助函数，因为它位于宿主中，会在组件容器上产生循环依赖；
// 复制约 15 行代码代价很低。
function readCustomRegistrySource(provider: unknown): CustomRegistrySource | undefined {
  if (typeof provider !== 'object' || provider === null) return undefined;
  const source = (provider as { readonly source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return undefined;
  const candidate = source as {
    readonly kind?: unknown;
    readonly url?: unknown;
    readonly apiKey?: unknown;
  };
  if (candidate.kind !== 'apiJson') return undefined;
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return undefined;
  if (typeof candidate.apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url: candidate.url, apiKey: candidate.apiKey };
}

/**
 * 为来源行标签美化 URL。去掉协议头并
 * 截断明显的 api.json 后缀，使行保持窄。
 * 解析失败时回退到原始 URL。
 */
function sourceUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

/**
 * 将 providers 分组为来源行 + 追加合成的添加行。
 * 分组规则：
 *   - `DEFAULT_OAUTH_PROVIDER_NAME` → 跳过（通过 /logout 管理）。
 *   - Open Platform id（`isOpenPlatformId(id)`）→ 每个 provider 1 个来源，
 *     标签 = `OpenPlatformDefinition.name`。
 *   - `cfg.source.kind === 'apiJson'` → 每个 `{url, apiKey}` 对一个来源，
 *     标签 = 主机名 + 路径名。
 *   - 其他 → 每个 provider 1 个来源，标签 = provider id。
 */
function buildRows(opts: ProviderManagerOptions): readonly Row[] {
  const sources: SourceRow[] = [];

  // 从 `${url}${apiKey}` → `sources` 索引的映射，以便我们可以
  // 将后续 providers 追加到同一分组中。
  const customRegistryIndex = new Map<string, number>();

  for (const [id, cfg] of Object.entries(opts.providers)) {
    if (id === DEFAULT_OAUTH_PROVIDER_NAME) continue;

    const isActive = id === opts.activeProviderId;

    if (isOpenPlatformId(id)) {
      const platform = getOpenPlatformById(id);
      sources.push({
        kind: 'source',
        id: `open:${id}`,
        label: platform?.name ?? id,
        providerIds: [id],
        hasActive: isActive,
      });
      continue;
    }

    const baseUrl =
      typeof cfg === 'object' && cfg !== null && 'baseUrl' in cfg && typeof cfg.baseUrl === 'string'
        ? cfg.baseUrl
        : undefined;

    const customSource = readCustomRegistrySource(cfg);
    if (customSource !== undefined) {
      const key = `${customSource.url}${customSource.apiKey}`;
      const existingIdx = customRegistryIndex.get(key);
      if (existingIdx !== undefined) {
        const existing = sources[existingIdx];
        if (existing !== undefined && existing.kind === 'source') {
          sources[existingIdx] = {
            kind: 'source',
            id: existing.id,
            label: existing.label,
            providerIds: [...existing.providerIds, id],
            hasActive: existing.hasActive || isActive,
            baseUrl: existing.baseUrl,
          };
        }
        continue;
      }
      customRegistryIndex.set(key, sources.length);
      sources.push({
        kind: 'source',
        id: `custom:${key}`,
        label: sourceUrlLabel(customSource.url),
        providerIds: [id],
        hasActive: isActive,
        baseUrl,
      });
      continue;
    }

    sources.push({
      kind: 'source',
      id: `provider:${id}`,
      label: id,
      providerIds: [id],
      hasActive: isActive,
      baseUrl,
    });
  }

  return [...sources, { kind: 'add', id: '__add__', label: ADD_ROW_LABEL }];
}

export class ProviderManagerComponent extends Container implements Focusable {
  focused = false;
  private opts: ProviderManagerOptions;
  private rows: readonly Row[];
  private selectedIndex: number;
  private confirm: ConfirmState | undefined;

  constructor(opts: ProviderManagerOptions) {
    super();
    this.opts = opts;
    this.rows = buildRows(opts);
    const activeIdx = opts.activeProviderId
      ? this.rows.findIndex(
          (row) => row.kind === 'source' && row.providerIds.includes(opts.activeProviderId ?? ''),
        )
      : -1;
    this.selectedIndex = Math.max(activeIdx, 0);
    this.confirm = undefined;
  }

  /**
   * 替换组件渲染所依据的属性。尽可能保留现有选择
   * （通过 id 或第一个 provider id），这样删除时不会出现视觉跳动。
   * 任何进行中的 `[y/N]` 子状态被清除，因为底层目标可能已更改。
   */
  setOptions(next: ProviderManagerOptions): void {
    const previousSelected = this.rows[this.selectedIndex];
    const previousSelectedId = previousSelected?.id;
    const previousFirstProviderId =
      previousSelected?.kind === 'source' ? previousSelected.providerIds[0] : undefined;

    this.opts = next;
    this.rows = buildRows(next);
    this.confirm = undefined;

    let newIdx = -1;
    if (previousSelectedId !== undefined) {
      newIdx = this.rows.findIndex((row) => row.id === previousSelectedId);
    }
    if (newIdx < 0 && previousFirstProviderId !== undefined) {
      newIdx = this.rows.findIndex(
        (row) => row.kind === 'source' && row.providerIds.includes(previousFirstProviderId),
      );
    }
    if (newIdx < 0) {
      newIdx = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
    }
    this.selectedIndex = newIdx;
    this.invalidate();
  }

  /** 应用当前模糊筛选后的行；添加行始终保留。 */
  private page(): PageView {
    return pageView(this.rows.length, this.selectedIndex, PAGE_SIZE);
  }

  handleInput(data: string): void {
    if (this.confirm !== undefined) {
      this.handleConfirmInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onClose();
      return;
    }

    const rows = this.rows;

    if (matchesKey(data, Key.up)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - PAGE_SIZE);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + PAGE_SIZE);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = rows[this.selectedIndex];
      if (selected?.kind === 'add') {
        this.opts.onAdd();
      }
      return;
    }

    // 使用 D 键删除高亮的 provider。
    const ch = printableChar(data);
    if (ch === 'd' || ch === 'D') {
      this.armDeleteConfirm();
    }
  }

  private armDeleteConfirm(): void {
    const selected = this.rows[this.selectedIndex];
    if (selected === undefined || selected.kind === 'add') return;
    const ids = selected.providerIds;
    const prompt =
      ids.length === 1
        ? `Delete platform "${selected.label}"?`
        : `Delete platform "${selected.label}" and all ${String(ids.length)} providers?`;
    this.confirm = {
      label: prompt,
      providerIds: ids,
    };
    this.invalidate();
  }

  private handleConfirmInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
      this.confirm = undefined;
      this.invalidate();
      return;
    }
    if (k === 'y' || k === 'Y') {
      const confirm = this.confirm;
      this.confirm = undefined;
      this.invalidate();
      if (confirm === undefined) return;
      this.opts.onDeleteSource(confirm.providerIds);
      return;
    }
    // 在确认子状态下的任何其他按键被忽略。
  }

  override render(width: number): string[] {
    const lines: string[] = [];

    // 标题形状镜像模型对话框（参见 model-selector.ts）：单行
    // 上边框、标题、键位提示，然后一个空行。标题下方无内边框。
    const border = currentTheme.fg('primary', '─'.repeat(width));
    lines.push(border);
    lines.push(currentTheme.boldFg('primary', ' Providers'));
    lines.push(currentTheme.fg('textMuted', ' ' + HEADER_HINT));
    lines.push('');

    const rows = this.rows;
    if (rows.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No providers configured.'));
    } else {
      const view = this.page();
      for (let i = view.start; i < view.end; i++) {
        const row = rows[i];
        if (row === undefined) continue;
        for (const line of renderRow(row, { isSelected: i === this.selectedIndex, width })) {
          lines.push(line);
        }
      }
    }

    lines.push('');

    if (this.confirm !== undefined) {
      lines.push(this.renderConfirmLine(width));
    } else {
      const view = this.page();
      if (view.pageCount > 1) {
        lines.push(
          currentTheme.fg(
            'textMuted',
            ` Page ${String(view.page + 1)}/${String(view.pageCount)}`,
          ),
        );
      }
    }

    lines.push(border);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderConfirmLine(width: number): string {
    const confirm = this.confirm;
    const prompt = confirm?.label ?? '';
    const styled = currentTheme.boldFg('warning', `  ${prompt} [y/N]`);
    return truncateToWidth(styled, width, '…');
  }
}


function renderRow(
  row: Row,
  ctx: { isSelected: boolean; width: number },
): string[] {
  const { isSelected, width } = ctx;
  const pointer = isSelected ? SELECT_POINTER : ' ';
  const pointerStyle = (text: string) =>
    isSelected ? currentTheme.fg('primary', text) : currentTheme.fg('textDim', text);
  // 合成的 "Add New Platform" 行是操作/CTA：保持品牌颜色
  // 以确保不会被误读为禁用状态，选中时加粗
  // （与其他行的选中处理一致）。
  const labelStyle = (text: string) =>
    isSelected
      ? currentTheme.boldFg('primary', text)
      : row.kind === 'add'
        ? currentTheme.fg('primary', text)
        : currentTheme.fg('text', text);

  // 当前活跃的 provider 以尾随的 "← current"（success）标记，
  // 与模型选择器的当前项标记一致——参见 .agents/skills/write-tui/DESIGN.md。
  const isActive = row.kind === 'source' && row.hasActive;
  const marker = isActive ? ` ${CURRENT_MARK}` : '';

  // 预留 2 个前导空格 + 2 个指针空间 + 标记空间。
  const labelWidth = Math.max(0, width - 4 - visibleWidth(marker));
  const labelText = truncateToWidth(row.label, labelWidth, '…');
  let line = `  ${pointerStyle(`${pointer} `)}${labelStyle(labelText)}`;
  if (isActive) line += currentTheme.fg('success', marker);

  const lines: string[] = [line];

  if (row.kind === 'source' && row.baseUrl !== undefined && row.baseUrl.length > 0) {
    const urlText = truncateToWidth(row.baseUrl, Math.max(0, width - 6), '…');
    lines.push(currentTheme.fg('textMuted', `      ${urlText}`));
  }

  return lines;
}

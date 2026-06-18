/**
 * 列表选择器（ChoicePicker、ModelSelector）共享的光标 + 模糊搜索 + 分页状态机。
 * 纯逻辑，不含渲染。
 *
 * 组件负责呈现和具有组件特定含义的按键——Enter（提交）、Esc（取消）、
 * 以及 ←/→（在一个选择器中用于分页，在另一个中用于切换思考模式）。
 * 本模块负责在所有地方行为一致的按键：↑/↓、PgUp/PgDn，以及搜索编辑。
 */

import { fuzzyFilter, Key, matchesKey } from '@earendil-works/pi-tui';

import { pageView, type PageView } from './paging';
import { isPrintableChar, printableChar } from './printable-key';

const DEFAULT_PAGE_SIZE = 8;

export interface SearchableListOptions<T> {
  readonly items: readonly T[];
  /** 列表项用于模糊匹配的文本。 */
  readonly toSearchText: (item: T) => string;
  /** 每页项目数；默认为 8。 */
  readonly pageSize?: number;
  /** 初始光标位置（限制为 >= 0）。 */
  readonly initialIndex?: number;
  /** 为 false 时忽略输入的字符。默认为 false。 */
  readonly searchable?: boolean;
}

export interface SearchableListView<T> {
  /** 经过当前查询过滤后的项目。 */
  readonly items: readonly T[];
  /** 当前光标在 {@link items} 上的分页计算结果。 */
  readonly page: PageView;
  /** 限制在当前 {@link items} 范围内的光标位置。 */
  readonly selectedIndex: number;
  readonly query: string;
}

export class SearchableList<T> {
  private readonly items: readonly T[];
  private readonly toSearchText: (item: T) => string;
  private readonly pageSize: number;
  private readonly searchable: boolean;
  private query = '';
  private cursor: number;

  constructor(opts: SearchableListOptions<T>) {
    this.items = opts.items;
    this.toSearchText = opts.toSearchText;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.searchable = opts.searchable ?? false;
    this.cursor = Math.max(opts.initialIndex ?? 0, 0);
  }

  filtered(): readonly T[] {
    if (this.query.length === 0) return this.items;
    return fuzzyFilter([...this.items], this.query, this.toSearchText);
  }

  /** 光标所在的项目，限制在过滤后的范围内。 */
  selected(): T | undefined {
    const items = this.filtered();
    if (items.length === 0) return undefined;
    return items[Math.min(this.cursor, items.length - 1)];
  }

  view(): SearchableListView<T> {
    const items = this.filtered();
    return {
      items,
      page: pageView(items.length, this.cursor, this.pageSize),
      selectedIndex: Math.min(this.cursor, Math.max(0, items.length - 1)),
      query: this.query,
    };
  }

  moveUp(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  moveDown(): void {
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + 1);
  }

  pageUp(): void {
    this.cursor = Math.max(0, this.cursor - this.pageSize);
  }

  pageDown(): void {
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + this.pageSize);
  }

  /** 清除当前查询并重置光标。返回是否清除了查询。 */
  clearQuery(): boolean {
    if (this.query.length === 0) return false;
    this.query = '';
    this.cursor = 0;
    return true;
  }

  /**
   * 处理所有选择器共享的按键：↑/↓、PgUp/PgDn，以及在可搜索模式下的
   * Backspace 和可打印字符。按键被消费时返回 true。
   * Enter、Esc 和 ←/→ 有意留给组件处理。
   */
  handleKey(data: string): boolean {
    if (matchesKey(data, Key.up)) {
      this.moveUp();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.moveDown();
      return true;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.pageUp();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.pageDown();
      return true;
    }
    if (!this.searchable) return false;
    if (matchesKey(data, Key.backspace)) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
      }
      return true;
    }
    const ch = printableChar(data);
    if (isPrintableChar(ch)) {
      this.query += ch;
      this.cursor = 0;
      return true;
    }
    return false;
  }
}

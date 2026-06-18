/**
 * 列表选择器（ChoicePicker、ModelSelector）共用的纯分页计算逻辑。
 *
 * 组件维护一个指向其（已过滤的）项目列表的 `selectedIndex`；
 * 页码由该索引推导而来，因此 ↑↓ 可以平滑地跨页移动光标，
 * 同时视图仍然显示明确的页码。
 */

export interface PageView {
  /** 包含 `selectedIndex` 的页码（从零开始）。 */
  readonly page: number;
  /** 总页数；即使列表为空也至少为 1。 */
  readonly pageCount: number;
  /** 当前页的切片起始索引（包含）。 */
  readonly start: number;
  /** 当前页的切片结束索引（不包含，上限为 `total`）。 */
  readonly end: number;
}

export function pageView(total: number, selectedIndex: number, pageSize: number): PageView {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safeIndex = total <= 0 ? 0 : Math.min(Math.max(0, selectedIndex), total - 1);
  const page = Math.min(Math.floor(safeIndex / size), pageCount - 1);
  const start = page * size;
  const end = Math.min(start + size, total);
  return { page, pageCount, start, end };
}

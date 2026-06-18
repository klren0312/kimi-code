import type { AutocompleteItem } from '@earendil-works/pi-tui';

/**
 * 可补全的令牌（子命令或标志），用于斜杠命令的参数位置。
 * 跨命令通用 — 任何 `KimiSlashCommand` 都可以通过 {@link completeLeadingArg}
 * 从这些规格列表构建 `getArgumentCompletions`。
 */
export interface ArgCompletionSpec {
  /** 补全时插入的令牌，例如 `pause` 或 `resume`。 */
  readonly value: string;
  /** 自动补全菜单中显示的简短描述。 */
  readonly description: string;
}

/**
 * 斜杠命令参数的通用前导令牌补全器。
 *
 * pi-tui 传入 `argumentPrefix` = `/<command> ` 之后输入的所有内容。
 * 我们只补全*第一个*令牌：用户在其后输入空格（转到目标、标志值等）后，
 * 返回 `null`，以免补全覆盖自由文本。匹配方式为对 `value` 进行不区分大小写的前缀匹配。
 */
export function completeLeadingArg(
  specs: readonly ArgCompletionSpec[],
  argumentPrefix: string,
): AutocompleteItem[] | null {
  if (argumentPrefix.includes(' ')) return null;
  const lower = argumentPrefix.toLowerCase();
  const items = specs
    .filter((spec) => spec.value.toLowerCase().startsWith(lower))
    .map((spec) => ({ value: spec.value, label: spec.value, description: spec.description }));
  // 无需继续补全：用户已输入了唯一匹配的令牌（例如 `status`）。
  // 保持菜单打开会导致回车确认无操作的补全而非提交命令，因此在此抑制。
  // （令牌后的空格已在上方返回 null。）
  const [only] = items;
  if (items.length === 1 && only !== undefined && only.value.toLowerCase() === lower) {
    return null;
  }
  return items.length > 0 ? items : null;
}

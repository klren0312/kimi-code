// 当应用 `patch` 会改变至少一个自身属性时返回 true。
// 在 UI 刷新路径之前使用，使得重复的等价状态补丁开销很小。
export function hasPatchChanges<T extends object>(target: T, patch: Partial<T>): boolean {
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (!Object.is(target[key], patch[key])) return true;
  }
  return false;
}

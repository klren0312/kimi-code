/**
 * 工具调用遥测和去重使用的 JSON 规范化。
 * 递归排序对象键，使语义相等的参数产生相同的键。
 *
 * 这是入口点——将任意工具调用参数转换为确定性的字符串表示。
 * 具有相同逻辑参数的两次调用（无论键插入顺序如何）将始终产生相同的输出，
 * 这对去重检测和遥测分组至关重要。
 *
 * @param args - 原始工具调用参数（通常是 JSON 可序列化的对象）。
 * @returns 规范化的 JSON 字符串，对于不可序列化的值回退到 `String(args)`。
 */
export function canonicalTelemetryArgs(args: unknown): string {
  const json = JSON.stringify(sortJsonValue(args));
  return json ?? String(args);
}

/**
 * 递归按字母顺序排序对象键。数组逐元素映射；
 * 非对象原语原样传递。这确保
 * `{ a: 1, b: 2 }` 和 `{ b: 2, a: 1 }` 产生相同的 JSON 输出。
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    out[key] = sortJsonValue(value[key]);
  }
  return out;
}

/**
 * 类型守卫，检查值是否为纯对象（由 `{}` 或 `new Object()` 创建，
 * 或具有 `null` 原型）。排除数组、类实例和原语。
 * 用于安全地遍历对象键而不受原型污染。
 *
 * @param value - 要检查的值。
 * @returns 如果值是纯 `Record<string, unknown>` 则返回 `true`。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

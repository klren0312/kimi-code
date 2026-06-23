/**
 * 用于派生工具向模型声明参数 JSON Schema 的共享辅助函数。
 *
 * 工具的参数 schema 描述的是模型**输入**而非输出。zod v4 的
 * `toJSONSchema` 默认采用*输出*视图，会将任何带链尾 `.default()`
 * 的字段标记为 `required` ——产生一个同时声明 `default` 又列为
 * 必需的矛盾 schema。该矛盾也会使运行时 AJV 验证器拒绝合法的
 * 省略了默认值字段的调用。
 *
 * 始终通过此辅助函数渲染参数 schema，使 `io: 'input'` 视图统一
 * 应用，默认字段保持可选，同时保留闭合对象守卫
 * （`additionalProperties: false`）以继续拒绝未知参数。
 */

import { z } from 'zod';

/**
 * 将 zod schema 转换为暴露给模型的输入 JSON Schema。
 *
 * @param schema - 描述工具参数的 zod schema。
 * @returns 以输入视图渲染的 draft-07 JSON Schema。
 */
export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  });
  closeObjectNodes(jsonSchema);
  return jsonSchema;
}

/**
 * 对每个对象节点重新断言 `additionalProperties: false`。
 *
 * 输入视图会从 `z.object` 节点移除 `additionalProperties: false`，
 * 因为在未知键剥离之前，*输入*对象可以合法地携带额外键。
 * 但工具的参数 schema 是面向模型的契约，运行时仅通过 AJV 验证
 * ——分发前不存在 zod 解析/剥离步骤——因此没有闭合对象守卫时，
 * 拼写错误的参数会通过验证并被静默忽略。恢复该守卫可继续拒绝
 * 未知参数，与输入视图之前的输出视图行为保持一致。
 *
 * 已声明 `additionalProperties` 的节点（如 `z.record`）保持不变。
 */
function closeObjectNodes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) closeObjectNodes(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node['type'] === 'object' && node['additionalProperties'] === undefined) {
    node['additionalProperties'] = false;
  }
  for (const child of Object.values(node)) {
    closeObjectNodes(child);
  }
}

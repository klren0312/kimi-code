/**
 * 解引用 JSON Schema 中的所有 `$ref` 引用，将来自本地 JSON 指针（如 `$defs` 和
 * draft-7 `definitions`）的定义内联展开。已解析的顶层定义桶会从结果中移除。
 *
 * 循环引用会被检测到并保留为 `$ref` 以避免无限递归；在这种情况下，被引用的
 * 定义桶会被保留，以便剩余的本地 `$ref` 指针仍然可被 JSON Schema 校验器解析。
 */
export function derefJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visited = new Set<string>();
  const result = resolveNode(schema, schema, visited) as Record<string, unknown>;

  // 仅在结果中没有指向这些桶的未解析引用时才删除定义桶。
  // resolveNode() 会故意保留循环引用，这些引用仍然需要其定义桶；
  // 删除它们会导致悬挂指针。
  if (!hasUnresolvedDefinitionRef(result, '$defs')) {
    delete result['$defs'];
  }
  if (!hasUnresolvedDefinitionRef(result, 'definitions')) {
    delete result['definitions'];
  }
  return result;
}

type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
type SchemaSlotKind = 'single' | 'array' | 'map' | 'schema-or-array';
type StructuralJsonSchemaType = Extract<JsonSchemaType, 'string' | 'object' | 'array'>;

interface ChildSchemaSlot {
  key: string;
  kind: SchemaSlotKind;
  parentType?: StructuralJsonSchemaType;
}

const TYPE_COMPLETION_SKIP_KEYS = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'else',
  'if',
  'not',
  'oneOf',
  'then',
]);

// 此 Kimi 规范化器已知如何遍历的子模式位置。这也是暗示父模式类型的子模式
// 关键字的真实来源。它不是 Moonshot 在网络传输中接受的关键字列表。
const CHILD_SCHEMA_SLOTS = [
  { key: '$defs', kind: 'map' },
  { key: 'definitions', kind: 'map' },
  { key: 'dependencies', kind: 'map', parentType: 'object' },
  { key: 'dependentSchemas', kind: 'map', parentType: 'object' },
  { key: 'patternProperties', kind: 'map', parentType: 'object' },
  { key: 'properties', kind: 'map', parentType: 'object' },
  { key: 'additionalItems', kind: 'single', parentType: 'array' },
  { key: 'additionalProperties', kind: 'single', parentType: 'object' },
  { key: 'contains', kind: 'single', parentType: 'array' },
  { key: 'contentSchema', kind: 'single', parentType: 'string' },
  { key: 'else', kind: 'single' },
  { key: 'if', kind: 'single' },
  { key: 'not', kind: 'single' },
  { key: 'propertyNames', kind: 'single', parentType: 'object' },
  { key: 'then', kind: 'single' },
  { key: 'unevaluatedItems', kind: 'single', parentType: 'array' },
  { key: 'unevaluatedProperties', kind: 'single', parentType: 'object' },
  { key: 'allOf', kind: 'array' },
  { key: 'anyOf', kind: 'array' },
  { key: 'oneOf', kind: 'array' },
  { key: 'prefixItems', kind: 'array', parentType: 'array' },
  { key: 'items', kind: 'schema-or-array', parentType: 'array' },
] as const satisfies readonly ChildSchemaSlot[];

const OBJECT_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('object'),
  'dependentRequired',
  'maxProperties',
  'minProperties',
  'required',
]);

const ARRAY_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('array'),
  'maxContains',
  'maxItems',
  'minContains',
  'minItems',
  'uniqueItems',
]);

const STRING_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('string'),
  'contentEncoding',
  'contentMediaType',
  'format',
  'maxLength',
  'minLength',
  'pattern',
]);

const NUMERIC_STRUCTURE_KEYS = new Set([
  'exclusiveMaximum',
  'exclusiveMinimum',
  'maximum',
  'minimum',
  'multipleOf',
]);

/**
 * 返回一个深克隆的 JSON Schema，并为缺失的 `type` 字段填充类型值，
 * 以兼容 Kimi 工具。
 *
 * Moonshot 的工具校验器会在嵌套属性模式省略 `type` 时拒绝一些合法的
 * JSON Schema 结构（例如仅有 enum 的 MCP 属性）。这是一个提供商兼容性
 * 规范化器，不是完整的 JSON Schema 编译器：它解析本地引用、保留组合节点、
 * 推断明显的标量/对象/数组类型，并仅在嵌套的无类型属性模式中回退到
 * `string`。根模式对象被视为容器，自身不会被规范化。
 */
export function normalizeKimiToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return ensureKimiPropertyTypes(derefJsonSchema(schema));
}

function ensureKimiPropertyTypes(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = cloneJsonValue(schema);
  if (!isRecord(normalized)) {
    throw new Error('JSON Schema root must normalize to an object.');
  }
  recurseSchema(normalized);
  return normalized;
}

function hasUnresolvedDefinitionRef(node: unknown, bucketKey: string): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => hasUnresolvedDefinitionRef(child, bucketKey));
  }
  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith(`#/${bucketKey}/`)) {
      return true;
    }
    for (const [key, value] of Object.entries(obj)) {
      // 遍历结果时跳过定义桶本身——我们只关心模式中其他位置的 `$ref` 指针。
      if (key === bucketKey) continue;
      if (hasUnresolvedDefinitionRef(value, bucketKey)) return true;
    }
    return false;
  }
  return false;
}

function resolveNode(node: unknown, root: Record<string, unknown>, visited: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveNode(item, root, visited));
  }

  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;

    // 处理 $ref
    if (typeof obj['$ref'] === 'string') {
      const ref = obj['$ref'];
      if (isLocalJsonPointerRef(ref)) {
        if (visited.has(ref)) {
          // 循环引用——原样返回 $ref 以避免无限递归
          return obj;
        }
        const resolvedRef = resolveLocalJsonPointer(root, ref);
        if (resolvedRef.found) {
          visited.add(ref);
          const resolved = resolveNode(resolvedRef.value, root, visited);
          visited.delete(ref);
          // 保留兄弟关键字（JSON Schema 2020-12 语义）：
          // 一个节点可能在 `$ref` 旁边包含其他字段，如
          // `description`、`default` 或本地约束。Python 的 deref
          // 实现会将这些与已解析的定义合并；
          // 本地节点上的兄弟键优先。
          if (typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)) {
            const merged: Record<string, unknown> = { ...(resolved as Record<string, unknown>) };
            for (const [key, value] of Object.entries(obj)) {
              if (key === '$ref') continue;
              merged[key] = resolveNode(value, root, visited);
            }
            return merged;
          }
          return resolved;
        }
      }
      // 未知的 $ref——原样返回
      return obj;
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveNode(value, root, visited);
    }
    return resolved;
  }

  return node;
}

function isLocalJsonPointerRef(ref: string): boolean {
  return ref === '#' || ref.startsWith('#/');
}

function resolveLocalJsonPointer(
  root: Record<string, unknown>,
  ref: string,
): { found: true; value: unknown } | { found: false } {
  if (ref === '#') {
    return { found: true, value: root };
  }
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = unescapeJsonPointerPart(rawPart);
    if (isRecord(current)) {
      if (!hasOwn(current, part)) {
        return { found: false };
      }
      current = current[part];
    } else if (Array.isArray(current)) {
      const index = parseJsonPointerArrayIndex(part);
      if (index === null || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function unescapeJsonPointerPart(part: string): string {
  return part.replaceAll('~1', '/').replaceAll('~0', '~');
}

function parseJsonPointerArrayIndex(part: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(part)) {
    return null;
  }
  return Number(part);
}

function recurseSchema(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }

  visitChildSchemas(node, normalizeProperty);
}

function visitChildSchemas(node: Record<string, unknown>, visit: (schema: unknown) => void): void {
  for (const { key, kind } of CHILD_SCHEMA_SLOTS) {
    const value = node[key];
    if (kind === 'single') {
      if (isRecord(value)) {
        visit(value);
      }
    } else if (kind === 'array') {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      }
    } else if (kind === 'map') {
      if (isRecord(value)) {
        for (const item of Object.values(value)) {
          visit(item);
        }
      }
    } else if (kind === 'schema-or-array') {
      if (isRecord(value)) {
        visit(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      }
    }
  }
}

function childSchemaKeysForParentType(parentType: StructuralJsonSchemaType): string[] {
  return CHILD_SCHEMA_SLOTS.flatMap((slot) => {
    if (!('parentType' in slot) || slot.parentType !== parentType) {
      return [];
    }
    return [slot.key];
  });
}

function normalizeProperty(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }

  if (!hasOwn(node, 'type') && !hasAnyKey(node, TYPE_COMPLETION_SKIP_KEYS)) {
    const enumValues = node['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      node['type'] = inferTypeFromValues(enumValues);
    } else if (hasOwn(node, 'const')) {
      node['type'] = inferTypeFromValues([node['const']]);
    } else {
      node['type'] = inferTypeFromStructure(node);
    }
  } else if (!hasAnyKey(node, TYPE_COMPLETION_SKIP_KEYS) && typeof node['type'] === 'string') {
    // 某些 MCP 服务器发出的模式中，$ref 合并或生成器缺陷会导致显式 type
    // 与 enum/const 值矛盾（例如 type 为 'object' 但实际是字符串 enum 值）。
    // Moonshot 会将这些视为无效并拒绝，因此在 type 与值不一致时修复 type。
    //
    // 已知触发条件：Xcode MCP (xcrun mcpbridge) 从 Version 26.5 (17F42) 开始
    // 会为 String 类型的 Swift enum 生成此缺陷。
    const enumValues = node['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      try {
        const inferred = inferTypeFromValues(enumValues);
        if (node['type'] !== inferred) {
          node['type'] = inferred;
          removeIrrelevantStructureKeys(node, inferred);
        }
      } catch {
        // 混合或无法推断的 enum 类型——保留显式 type 不变，
        // 让提供商校验器上报错误。
      }
    } else if (hasOwn(node, 'const')) {
      try {
        const inferred = inferTypeFromValues([node['const']]);
        if (node['type'] !== inferred) {
          node['type'] = inferred;
          removeIrrelevantStructureKeys(node, inferred);
        }
      } catch {
        // 同上。
      }
    }
  }

  recurseSchema(node);
}

function removeIrrelevantStructureKeys(
  node: Record<string, unknown>,
  newType: JsonSchemaType,
): void {
  if (newType !== 'object') {
    for (const key of OBJECT_STRUCTURE_KEYS) {
      delete node[key];
    }
  }
  if (newType !== 'array') {
    for (const key of ARRAY_STRUCTURE_KEYS) {
      delete node[key];
    }
  }
}

function inferTypeFromStructure(schema: Record<string, unknown>): JsonSchemaType {
  if (hasAnyKey(schema, OBJECT_STRUCTURE_KEYS)) {
    return 'object';
  }
  if (hasAnyKey(schema, ARRAY_STRUCTURE_KEYS)) {
    return 'array';
  }
  if (hasAnyKey(schema, STRING_STRUCTURE_KEYS)) {
    return 'string';
  }
  if (hasAnyKey(schema, NUMERIC_STRUCTURE_KEYS)) {
    return 'number';
  }
  return 'string';
}

function inferTypeFromValues(values: unknown[]): JsonSchemaType {
  const inferred = new Set<JsonSchemaType>();
  for (const value of values) {
    const valueType = inferValueType(value);
    if (valueType === undefined) {
      throw new Error('Cannot infer JSON Schema type from non-JSON enum or const value.');
    }
    inferred.add(valueType);
  }
  const types = normalizeInferredTypes(inferred);
  if (types.length === 1) {
    const onlyType = types[0];
    if (onlyType === undefined) {
      throw new Error('Cannot infer JSON Schema type from an empty enum.');
    }
    return onlyType;
  }
  throw new Error('Mixed JSON Schema enum or const types are not supported by Kimi tool schemas.');
}

function inferValueType(value: unknown): JsonSchemaType | undefined {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      return undefined;
  }
  return undefined;
}

function normalizeInferredTypes(types: Set<JsonSchemaType>): JsonSchemaType[] {
  const normalized = new Set(types);
  if (normalized.has('number')) {
    normalized.delete('integer');
  }
  const order: JsonSchemaType[] = [
    'string',
    'number',
    'integer',
    'boolean',
    'object',
    'array',
    'null',
  ];
  return order.filter((type) => normalized.has(type));
}

function hasAnyKey(obj: Record<string, unknown>, keys: Set<string>): boolean {
  for (const key of keys) {
    if (hasOwn(obj, key)) {
      return true;
    }
  }
  return false;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (isRecord(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(child);
    }
    return cloned;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

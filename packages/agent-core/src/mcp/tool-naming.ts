const MCP_NAME_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';
/**
 * 大多数 LLM 提供方将工具名称限制在约 64 个字符。为前缀和分隔符
 * 留出余量，对更长的名称使用稳定的哈希后缀截断，使冲突保持极不可能。
 */
const MAX_QUALIFIED_LENGTH = 64;

/**
 * 将安全 ASCII 集之外的任何字符替换为 `_`，然后将连续的 `_` 合并为单个下划线。
 * 合并步骤保证清理后的服务器名和工具名都不包含 {@link qualifyMcpToolName}
 * 使用的 `__` 分隔符，这使感知 {@link isMcpToolName} 的解码器可以
 * 在前缀后的第一个 `__` 上无歧义地分割。
 */
export function sanitizeMcpNamePart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_NAME_PREFIX);
}

/**
 * 生成代理内部和线路上使用的限定 MCP 工具名称。如果结果超过
 * {@link MAX_QUALIFIED_LENGTH}，则用确定性的 8 字符哈希后缀替换尾部，
 * 以保持前缀结构完整。
 */
export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`;
  if (full.length <= MAX_QUALIFIED_LENGTH) return full;

  const hash = stableHash8(full);
  const head = full.slice(0, MAX_QUALIFIED_LENGTH - hash.length - 1);
  return `${head}_${hash}`;
}

function stableHash8(input: string): string {
  // 32 位 FNV-1a——足以在单个服务器的工具列表中消除截断工具名称的歧义。
  // 非加密；仅用于少量字符串间的抗冲突。
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return hash.toString(16).padStart(8, '0');
}

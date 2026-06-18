// 解码由 kimi-core 的 `qualifyMcpToolName` 生成的 `mcp__<server>__<tool>` 限定名称。
// 对于非 MCP 工具和哈希截断的限定名称（尾部 `__<tool>` 段已被折叠），返回 null。
export function decodeMcpToolName(
  name: string,
): { readonly serverName: string; readonly toolName: string } | null {
  const PREFIX = 'mcp__';
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep === rest.length - 2) return null;
  return {
    serverName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}

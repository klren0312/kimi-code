/**
 * ACP → kimi MCP server conversion.
 *
 * Translates ACP `McpServer[]` (per the ACP schema discriminated by
 * `type: 'http' | 'sse' | 'acp' | 'stdio'`) into kimi's
 * keyed `Record<string, McpServerConfig>` (the same shape the kernel's
 * `loadMcpServers` returns and what
 * `CreateSessionPayload.mcpServers` / `ResumeSessionPayload.mcpServers`
 * accept). The conversion is intentionally narrow:
 *
 *  - `http`  → kimi `transport: 'http'` with headers projected from
 *              `Array<{name, value}>` to `Record<string, string>`.
 *  - `sse`   → kimi `transport: 'sse'` with headers projected the same way.
 *  - `stdio` → kimi `transport: 'stdio'` with env projected similarly.
 *  - `acp`   → dropped with a `log.warn` (experimental ACP-transport MCP
 *              is not yet supported).
 *
 * The kernel keys MCP servers by name at the config-map level, so the
 * ACP `name` field becomes the Record key here. Duplicate names within a
 * single ACP request collapse with last-write-wins — same behaviour as
 * the kernel's own `loadMcpServers` user/project merge.
 *
 * @see packages/agent-core/src/config/schema.ts (McpServerConfigSchema)
 * @see packages/agent-core/src/mcp/session-config.ts (mergeCallerMcpServers)
 * @see node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts (McpServer)
 */

import type { McpServer, McpServerStdio } from '@agentclientprotocol/sdk';
import type { McpServerConfig } from '@moonshot-ai/agent-core';
import { log } from '@moonshot-ai/kimi-code-sdk';

// ── 中文概述 ──
// 本模块负责将 ACP 协议的 MCP 服务器配置转换为 kimi 内核的 `McpServerConfig` 格式。
// 支持 http、sse、stdio 三种传输类型，acp 类型暂不支持（记录警告并丢弃）。
// 转换后以服务器名为 key 输出 Record，供 session 创建/恢复时传入内核。

/**
 * Convert an ACP `McpServer[]` into the kernel-native
 * `Record<string, McpServerConfig>` keyed by server name. Unsupported
 * transports (`acp`) are warn-dropped — the caller never has to
 * filter them out.
 *
 * Caveat (ACP schema 0.23): the `McpServer` union types stdio as a
 * bare branch WITHOUT a discriminator. Members marked `http`, `sse`,
 * `acp` carry an explicit `type` field; stdio is identified by the
 * ABSENCE of `type`. We branch accordingly.
 */
// 中文：将 ACP MCP 服务器数组转换为内核格式的 Record，以服务器名为 key
export function acpMcpServersToConfigs(
  servers: readonly McpServer[] | undefined,
): Record<string, McpServerConfig> {
  if (!servers || servers.length === 0) return {};
  const out: Record<string, McpServerConfig> = {};
  // 中文：逐个转换，不支持的传输类型会被 acpMcpServerToConfig 过滤掉
  for (const server of servers) {
    const converted = acpMcpServerToConfig(server);
    if (converted !== null) out[converted.name] = converted.config;
  }
  return out;
}

// 中文：转换单个 ACP MCP 服务器配置为内核格式；返回 null 表示不支持该传输类型
function acpMcpServerToConfig(
  server: McpServer,
): { name: string; config: McpServerConfig } | null {
  // The stdio branch of the `McpServer` union has no `type` field
  // (see ACP schema 0.23 — stdio is the bare `McpServerStdio` shape
  // in the discriminated union). Anything without an explicit `type`
  // is treated as stdio.
  // 中文：ACP schema 0.23 中 stdio 类型无 type 字段，通过缺失 type 来识别
  if (!('type' in server) || typeof server.type !== 'string') {
    const stdio = server as McpServerStdio;
    const config: McpServerConfig = {
      transport: 'stdio',
      command: stdio.command,
      args: stdio.args,
      env: envArrayToRecord(stdio.env),
    };
    return { name: stdio.name, config };
  }
  switch (server.type) {
    case 'http': {
      const config: McpServerConfig = {
        transport: 'http',
        url: server.url,
        headers: headersArrayToRecord(server.headers),
      };
      return { name: server.name, config };
    }
    case 'sse': {
      const config: McpServerConfig = {
        transport: 'sse',
        url: server.url,
        headers: headersArrayToRecord(server.headers),
      };
      return { name: server.name, config };
    }
    case 'acp':
    default: {
      // Defensive: future ACP transports land here too. The cast is the
      // narrowest way to read `name`/`type` off the leftover variant
      // without re-declaring the union.
      // 中文：不支持的传输类型（含 acp 及未来新增类型），记录警告后丢弃
      const fallback = server as { name?: string; type?: string };
      log.warn('acp: dropping unsupported MCP server transport', {
        name: fallback.name,
        type: fallback.type,
      });
      return null;
    }
  }
}

// 中文：将 ACP 的 headers 数组格式转换为内核所需的 Record<string, string> 格式
function headersArrayToRecord(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name] = h.value;
  return out;
}

// 中文：将 ACP 的环境变量数组格式转换为内核所需的 Record<string, string> 格式
function envArrayToRecord(
  env: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of env) out[e.name] = e.value;
  return out;
}

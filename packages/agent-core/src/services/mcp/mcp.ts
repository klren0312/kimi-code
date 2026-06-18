/**
 * `IMcpService` — daemon 面向的 MCP 服务端表面。
 *
 * 封装 `ICoreProcessService.rpc.{listMcpServers, reconnectMcpServer}` 并将
 * agent-core 的 `McpServerInfo` 形状适配为 SCHEMAS §8 的 `McpServer`。
 * 适配器辅助函数（`toProtocolMcpServer`）同位于此文件。
 *
 * **CoreAPI 使用的接口**：
 *   - `core.rpc.listMcpServers({}) => readonly McpServerInfo[]`
 *     (packages/agent-core/src/rpc/core-api.ts:344)。
 *   - `core.rpc.reconnectMcpServer({name})` (line 346)。
 *
 * **服务标识**：REST.md §3.8 在路径中使用 `{mcp_server_id}`；
 * agent-core 仅暴露 `name`。在线路边界将 name 作为 id 使用
 *（在 daemon 进程生命周期内稳定）。
 *
 * **错误模型**：
 *   - `MCP_SERVER_NOT_FOUND` (40408) 由实现通过 `McpServerNotFoundError` 抛出。
 *     路由将其映射为信封码 40408。
 *
 * **防腐层**：仅为 `createDecorator` 值和 `McpServerInfo` 类型导入
 * `@moonshot-ai/agent-core`。
 *
 * **MCP 状态映射**（`McpServerInfo.status` → `McpServer.status`）：
 *   agent-core 'pending'    → 线路 'connecting'
 *   agent-core 'connected'  → 线路 'connected'
 *   agent-core 'failed'     → 线路 'error'
 *   agent-core 'disabled'   → 线路 'disconnected'
 *   agent-core 'needs-auth' → 线路 'error'   (last_error 携带提示)
 *
 * **MCP id**：agent-core 的 `McpServerInfo` 仅有 `name`。在线路边界采用
 * name 作为 id。在 daemon 进程内两者 1:1 对应。
 */

import { createDecorator } from '../../di';
import type { McpServerInfo } from '../../rpc';
import type {
  McpServer,
  McpServerStatus,
  McpServerTransport,
} from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// 适配器辅助函数（原 adapter/tool-adapter.ts 的 MCP 部分）
// ---------------------------------------------------------------------------

function mapMcpStatus(s: McpServerInfo['status']): McpServerStatus {
  switch (s) {
    case 'connected':
      return 'connected';
    case 'pending':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'disabled':
      return 'disconnected';
    case 'needs-auth':
      // 最接近的线路字面值；`last_error` 携带解释性消息。
      return 'error';
  }
}

function mapMcpTransport(t: McpServerInfo['transport']): McpServerTransport {
  // SCHEMAS §8 的 transport 是超集（增加 'sse'）；agent-core 字面值
  // 原样透传，'sse' 已是有效的线路值。
  switch (t) {
    case 'stdio':
      return 'stdio';
    case 'http':
      return 'http';
    case 'sse':
      return 'sse';
  }
}

export function toProtocolMcpServer(info: McpServerInfo): McpServer {
  const status = mapMcpStatus(info.status);
  const base: McpServer = {
    // name 作为 id：agent-core 不暴露单独的 id；daemon 的 REST 路径使用
    // {mcp_server_id}，我们将其解释为 name。
    id: info.name,
    name: info.name,
    transport: mapMcpTransport(info.transport),
    status,
    tool_count: info.toolCount,
  };
  // 存在上游错误消息时暴露。在每个非健康状态（不仅 'error'）上都暴露，
  // 因为 'needs-auth' 到达时 `error` 携带认证提示 URL。
  if (info.error !== undefined && info.error.length > 0) {
    return { ...base, last_error: info.error };
  }
  return base;
}

// ---------------------------------------------------------------------------
// 接口 + 实现
// ---------------------------------------------------------------------------

export interface IMcpService {
  readonly _serviceBrand: undefined;

  /** 返回进程内 KimiCore 已知的所有 MCP 服务端。 */
  list(): Promise<readonly McpServer[]>;

  /**
   * 触发 MCP 服务端重连。成功入队时返回 `{ restarting: true }`。
   * 服务端 id 未注册时抛出 `McpServerNotFoundError`（→ 40408）。
   */
  restart(serverId: string): Promise<{ restarting: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMcpService = createDecorator<IMcpService>('mcpService');

/**
 * 哨兵错误 — daemon 的路由层捕获此错误并映射为信封码
 * `40408 mcp.server_not_found`。其他抛出的错误落入 `installErrorHandler`（→ 50001）。
 */
export class McpServerNotFoundError extends Error {
  readonly serverId: string;
  constructor(serverId: string) {
    super(`mcp server ${serverId} does not exist`);
    this.name = 'McpServerNotFoundError';
    this.serverId = serverId;
  }
}

void IMcpService;

/**
 * `IToolService` — 面向守护进程的只读工具查询层。
 *
 * 封装 `ICoreProcessService.rpc.getTools`，将 agent-core 的 `ToolInfo`
 *（驼峰式，含 `'user'` 源字面量）转换为 SCHEMAS §8 `ToolDescriptor`
 *（下划线式，`'skill'` 源字面量）。适配器辅助函数（`toProtocolTool`、
 * `AgentCoreToolInfoLike`）在此文件中同位定义。
 *
 * **使用的 CoreAPI 表面**：
 *   - `bridge.rpc.getTools({}) => readonly ToolInfo[]`（packages/agent-core/src/rpc/core-api.ts:333）。
 *
 * **REST.md §3.8 ?session_id 行为**：当调用方传入 session_id 时，路由当前
 * 返回相同的全局列表——agent-core 的 `getTools` 不按会话区分，
 * `setActiveTools` 是唯一的按会话开关。此缺口已在 `ToolService` 中记录。
 *
 * **防腐层**：仅从 `@moonshot-ai/agent-core` 导入 `createDecorator` 值。
 */

import { createDecorator } from '../../di';
import type { ToolDescriptor, ToolSource } from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// 适配器辅助函数（原 adapter/tool-adapter.ts 的工具侧部分）
// ---------------------------------------------------------------------------

/**
 * 进程内用于工具转换的最小形状。镜像 `@moonshot-ai/agent-core` 的 `ToolInfo`，
 * 但不对其确切形状产生运行时依赖（适配器即边界）。
 */
export interface AgentCoreToolInfoLike {
  readonly name: string;
  readonly description: string;
  readonly source: 'builtin' | 'user' | 'mcp';
  /** agent-core 可能会添加 `active` 等字段；此处忽略。 */
  readonly active?: boolean;
}

function mapToolSource(s: AgentCoreToolInfoLike['source']): ToolSource {
  switch (s) {
    case 'builtin':
      return 'builtin';
    case 'user':
      return 'skill';
    case 'mcp':
      return 'mcp';
  }
}

/**
 * 从 MCP 工具名称中解析 server id 段。约定格式：
 * `mcp:<server>:<tool>`（kosong 的 `mcpRegistrar.qualifiedName`）。
 * 当名称不匹配时返回 `undefined`——调用方会省略 `mcp_server_id`。
 */
function parseMcpServerIdFromToolName(name: string): string | undefined {
  if (!name.startsWith('mcp:')) return undefined;
  const rest = name.slice('mcp:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

export function toProtocolTool(info: AgentCoreToolInfoLike): ToolDescriptor {
  const source = mapToolSource(info.source);
  const base: ToolDescriptor = {
    name: info.name,
    description: info.description,
    // agent-core 的 ToolInfo 目前缺少 JSON schema；发出 null 以诚实地
    // 表示线协议中的"未知"状态。
    input_schema: null,
    source,
  };
  if (source === 'mcp') {
    const serverId = parseMcpServerIdFromToolName(info.name);
    if (serverId !== undefined) {
      return { ...base, mcp_server_id: serverId };
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// 接口 + 实现
// ---------------------------------------------------------------------------

export interface IToolService {
  readonly _serviceBrand: undefined;

  /**
   * 返回可用的工具描述符列表。当提供 `sessionId` 时，实现可能返回
   * 会话有效的子集；当前返回全局列表（CoreAPI 缺口已在实现中记录）。
   */
  list(sessionId?: string): Promise<readonly ToolDescriptor[]>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolService = createDecorator<IToolService>('toolService');

void IToolService;

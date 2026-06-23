/**
 * @module tool/types
 *
 * 工具管理层的类型定义。定义了来源分类（builtin、user、MCP）、
 * 工具元数据结构以及 {@link ToolManager} 使用的 MCP 冲突报告类型。
 */

import type { ExecutableTool } from '../../loop';

/** 工具的来源：随 agent 附带、由用户注册、或来自 MCP 服务器。 */
export type ToolSource = 'builtin' | 'user' | 'mcp';

/** 带有类型化输入 schema 的内置工具。 */
export type BuiltinTool<Input = unknown> = ExecutableTool<Input>;

/** 用户注册工具的元数据（通过 RPC 注册工具端点）。 */
export interface UserToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** 工具元数据的公开视图，供 TUI 和工具列表 API 使用。 */
export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  /** 此工具是否在当前活跃 profile 中启用。 */
  readonly active: boolean;
  readonly source: ToolSource;
}

/** 描述注册 MCP 工具时的命名冲突。 */
export interface McpToolCollision {
  /** 尝试注册的限定（带命名空间）工具名称。 */
  readonly qualified: string;
  /** 来自 MCP 服务器的原始工具名称。 */
  readonly toolName: string;
  readonly collidesWith:
    | { readonly kind: 'same_server'; readonly toolName: string }
    | { readonly kind: 'other_server'; readonly serverName: string };
}

/** 将 MCP 服务器的工具注册到工具管理器的结果。 */
export interface McpServerRegistrationResult {
  /** 成功注册的工具限定名称。 */
  readonly registered: readonly string[];
  /** 因命名冲突而丢弃的工具。 */
  readonly collisions: readonly McpToolCollision[];
}

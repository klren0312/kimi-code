// ── 中文概述 ──
// 本模块定义了 ACP 适配器内置的斜杠命令列表。
// 提供命令注册表、命令名称集合以及命令名称类型守卫。
// 这些命令会在 ACP 会话初始化时暴露给客户端。

import type { AvailableCommand } from '@agentclientprotocol/sdk';

// 中文：ACP 内置斜杠命令的完整定义列表（只读数组）
export const ACP_BUILTIN_SLASH_COMMANDS = [
  {
    name: 'compact',
    description: 'Compact the conversation context',
    input: { hint: '<optional custom summarization instructions>' },
  },
  {
    name: 'status',
    description: 'Show current session status',
  },
  {
    name: 'usage',
    description: 'Show session token usage',
  },
  {
    name: 'mcp',
    description: 'Show MCP server status',
  },
  {
    name: 'tasks',
    description: 'List background tasks',
  },
  {
    name: 'help',
    description: 'Show available ACP commands',
  },
] as const satisfies readonly AvailableCommand[];

// 中文：内置斜杠命令名称的联合类型，从命令列表常量中推导
export type AcpBuiltinSlashCommandName = (typeof ACP_BUILTIN_SLASH_COMMANDS)[number]['name'];

// 中文：内置斜杠命令名称的快速查找集合
export const ACP_BUILTIN_SLASH_COMMAND_NAMES = new Set<string>(
  ACP_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

// 中文：类型守卫，判断给定命令名是否为 ACP 内置斜杠命令
export function isAcpBuiltinSlashCommand(name: string): name is AcpBuiltinSlashCommandName {
  return ACP_BUILTIN_SLASH_COMMAND_NAMES.has(name);
}

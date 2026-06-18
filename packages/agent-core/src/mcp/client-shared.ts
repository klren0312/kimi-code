import { getCoreVersion } from '#/version';

import type { MCPToolDefinition, MCPToolResult } from './types';

export const KIMI_MCP_CLIENT_NAME = 'kimi-code';
// 从 agent-core 的 package.json 解析版本，使 MCP 服务器在 `initialize` 中
// 看到真实版本（用于兼容性检查、遥测、调试）。
// 如果 package.json 读取失败，`getCoreVersion()` 回退到 '0.0.0'。
export const KIMI_MCP_CLIENT_VERSION = getCoreVersion();

/**
 * 运行时客户端注意到其底层传输自行消失时附加的原因上下文——
 * 即 {@link RuntimeMcpClient.close} 未被调用。连接管理器将其转换为
 * `failed` 状态，以免 UI/SDK 继续宣传由已死传输支撑的工具。
 *
 * - `error` 是通过 SDK 的 `onerror` 通道报告的最后一个错误（如果有）。
 *   对 HTTP 传输很有用，因为没有 stderr。
 * - `stderr` 是从子进程的 stderr 捕获的尾部字节；仅对 stdio 传输填充。
 */
export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

export interface McpRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

/**
 * 构建 MCP SDK `callTool` 接受的 `RequestOptions` 对象，
 * 包括配置的工具调用超时、进行中的中止信号、两者兼有或均无。
 * 当无需传递任何内容时返回 `undefined`，让 SDK 使用其默认值。
 */
export function buildRequestOptions(
  toolCallTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): McpRequestOptions | undefined {
  if (toolCallTimeoutMs === undefined && signal === undefined) return undefined;
  return { timeout: toolCallTimeoutMs, signal };
}

interface SdkListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export function toMcpToolDefinition(tool: SdkListedTool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  };
}

/**
 * 将 SDK 的 `callTool` 返回值规范化为 kosong 的 {@link MCPToolResult}。
 * SDK 可以返回现代的 `{ content, isError }` 形式或旧版的
 * `{ toolResult }` 形式；我们将旧版形式折叠为单个文本内容块。
 */
export function toMcpToolResult(result: unknown): MCPToolResult {
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const typed = result as { content: unknown; isError?: unknown };
    if (Array.isArray(typed.content)) {
      return {
        content: typed.content as MCPToolResult['content'],
        isError: typed.isError === true,
      };
    }
  }
  if (typeof result === 'object' && result !== null && 'toolResult' in result) {
    const legacy = (result as { toolResult: unknown }).toolResult;
    return {
      content: [
        {
          type: 'text',
          text: typeof legacy === 'string' ? legacy : JSON.stringify(legacy),
        },
      ],
      isError: false,
    };
  }
  return { content: [], isError: false };
}

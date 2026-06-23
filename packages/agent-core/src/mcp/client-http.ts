import type { McpServerHttpConfig } from '#/config/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import { buildMcpRemoteHeaders } from './client-remote';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface HttpMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolCallTimeoutMs?: number;
  /**
   * 默认读取 `process.env[name]`。测试可注入确定性查找函数，
   * 以避免修改全局环境变量。
   */
  readonly envLookup?: (name: string) => string | undefined;
  /**
   * 允许测试为底层传输注入伪造的 `fetch`。
   */
  readonly fetch?: typeof fetch;
  /**
   * 附加到传输层的 OAuth 客户端提供方。仅在服务器未配置静态 token 时设置；
   * SDK 使用它通过 RFC 9728 / RFC 8414 / DCR 发现和 PKCE 处理 401。
   * 连接管理器注入此提供方，并将 `UnauthorizedError` 呈现为 `needs-auth` 状态。
   */
  readonly oauthProvider?: OAuthClientProvider;
}

/**
 * 将 SDK 的可流式 HTTP 传输封装为 kosong {@link MCPClient}。
 * 静态 bearer token 从 `process.env[bearerTokenEnvVar]` 查找。
 * OAuth 提供方由连接管理器单独附加。
 */
export class HttpMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private started = false;
  private closed = false;
  // 参见 StdioMcpClient.ready ——区分握手阶段的失败（调用方通过 `connect()` 抛出
  // 异常看到，无 unexpectedClose）和就绪后的断连（`onUnexpectedClose` 设计要
  // 呈现的情况）。
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  // 参见 StdioMcpClient ——在监听器尚未安装时缓冲，以便早期关闭被重放而非丢弃。
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;
  // 锁存器，确保同一传输失败的 `onerror` 和（理论上可能的）`onclose` 不会
  // 重复触发。一旦判定连接已断开，后续 SDK 通知即为噪音。
  private unexpectedCloseFired = false;

  constructor(config: McpServerHttpConfig, options: HttpMcpClientOptions = {}) {
    const envLookup = options.envLookup ?? ((name) => process.env[name]);
    const headers = buildMcpHttpHeaders(config, envLookup);

    this.transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headers !== undefined ? { headers } : undefined,
      fetch: options.fetch,
      authProvider: options.oauthProvider,
    });
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP HTTP client is closed');
    }
    if (this.started) return;
    this.started = true;
    // 在 SDK 握手之前安装钩子；参见 StdioMcpClient.connect。
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP HTTP client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  /**
   * 注册非预期传输断开的监听器。参见 `StdioMcpClient.onUnexpectedClose`
   * 了解语义。如果传输已发出终端失败信号，则缓冲的原因会同步重放。
   */
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.client.listTools();
    return result.tools.map(toMcpToolDefinition);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    const requestOptions = buildRequestOptions(this.toolCallTimeoutMs, signal);
    const result = await this.client.callTool({ name, arguments: args }, undefined, requestOptions);
    return toMcpToolResult(result);
  }

  private async closeStartedClient(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.client.close();
  }

  private installTransportHooks(): void {
    // 幂等——参见 StdioMcpClient.installTransportHooks。
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      if (this.closed) return;
      // 握手阶段的关闭通过 `client.connect()` 抛出异常来呈现。
      if (!this.ready) return;
      this.fireUnexpectedClose({ error: this.lastTransportError });
    };
    // streamable-http 的传输层仅在其自身的 `close()` 路径上调用 `onclose`，
    // 因此 99% 的远程断连（SSE 波动 → 重连耗尽、在已断开的会话上发送 POST
    // 失败）会通过 `onerror` 到达。在此将已知的终端错误消息映射回非预期关闭，
    // 以镜像 SDK 暴露的"传输已消失"信号；其他所有错误视为瞬态，仅缓存以供诊断。
    this.client.onerror = (error) => {
      this.lastTransportError = error;
      if (this.closed) return;
      // 握手期间，终端错误（Unauthorized、重连耗尽）通过 `client.connect()`
      // 和管理器的 `shouldMarkNeedsAuth` / `formatStartupError` 传播。
      // 在此触发会导致重复报告。
      if (!this.ready) return;
      if (isTerminalTransportError(error)) {
        this.fireUnexpectedClose({ error });
      }
    };
  }

  private fireUnexpectedClose(reason: UnexpectedCloseReason): void {
    if (this.unexpectedCloseFired) return;
    this.unexpectedCloseFired = true;
    const listener = this.unexpectedCloseListener;
    if (listener !== undefined) {
      listener(reason);
    } else {
      this.pendingUnexpectedClose = reason;
    }
  }
}

/**
 * 当通过 `Client.onerror` 报告的错误表明底层 HTTP 传输已死时返回 true。
 * streamable-http SDK 不会对远程断连调用 `onclose`；而是通过 `onerror`
 * 呈现它们，但只有少数特定消息意味着"放弃"而非"将重试"：
 *
 * - `UnauthorizedError` —— RFC 9728/8414 授权流程放弃；SDK 不会在没有
 *   新的提供方调用的情况下重试。
 * - "Maximum reconnection attempts ... exceeded." —— SSE 重连预算用尽后
 *   由 `_scheduleReconnection` 发出（`streamableHttp.js`,
 *   `_scheduleReconnection`）。
 *
 * 瞬态信号（单次请求的 fetch 失败、SDK 即将重连的单次 SSE 波动）不得
 * 匹配；否则短暂的网络抖动会拆除每个 HTTP MCP 条目。
 */
export function isTerminalTransportError(error: Error): boolean {
  if (error.name === 'UnauthorizedError') return true;
  if (/Maximum reconnection attempts/i.test(error.message)) return true;
  return false;
}

export function buildMcpHttpHeaders(
  config: McpServerHttpConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  return buildMcpRemoteHeaders(config, envLookup);
}

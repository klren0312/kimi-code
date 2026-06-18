import type { McpServerSseConfig } from '#/config/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';

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

export interface SseMcpClientOptions {
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
   * OAuth 客户端提供方，附加到传输层。仅在服务器未配置静态 token 时设置；
   * 连接管理器注入此提供方，并将 `UnauthorizedError` 呈现为 `needs-auth` 状态。
   */
  readonly oauthProvider?: OAuthClientProvider;
}

/**
 * 将 SDK 已弃用的 HTTP+SSE 传输封装为 kosong {@link MCPClient}。
 * 此类存在是为了兼容旧版 MCP 服务器；新的远程服务器应优先使用可流式 HTTP。
 */
export class SseMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: SSEClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private started = false;
  private closed = false;
  // 镜像 HttpMcpClient：握手失败通过 connect() 呈现，而就绪后的终端
  // 传输错误变为非预期关闭。
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;
  private unexpectedCloseFired = false;

  constructor(config: McpServerSseConfig, options: SseMcpClientOptions = {}) {
    const envLookup = options.envLookup ?? ((name) => process.env[name]);
    const headers = buildMcpRemoteHeaders(config, envLookup);

    this.transport = new SSEClientTransport(new URL(config.url), {
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
      throw new Error('MCP SSE client is closed');
    }
    if (this.started) return;
    this.started = true;
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP SSE client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  /**
   * 为非预期的终端传输断开注册监听器。短暂的 SSE 流波动留给
   * EventSource 的重试循环；启动后的终端 HTTP 状态错误将从代理中移除工具。
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
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      this.fireUnexpectedClose({ error: this.lastTransportError });
    };
    this.client.onerror = (error) => {
      this.lastTransportError = error;
      if (this.closed) return;
      if (!this.ready) return;
      if (isTerminalSseTransportError(error)) {
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

export function isTerminalSseTransportError(error: Error): boolean {
  if (error.name === 'UnauthorizedError') return true;
  return error instanceof SseError && error.code !== undefined;
}

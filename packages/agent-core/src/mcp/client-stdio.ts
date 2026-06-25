import { ErrorCodes, KimiError } from '#/errors';
import type { McpServerStdioConfig } from '#/config/schema';
import { proxyEnvForChild, reconcileChildNoProxy } from '#/utils/proxy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isAbsolute, resolve } from 'pathe';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolCallTimeoutMs?: number;
  readonly defaultCwd?: string;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;

/**
 * 封装 `@modelcontextprotocol/sdk` 的 stdio 客户端，暴露 kosong
 * {@link MCPClient} 所需的最小接口。生命周期是显式的：调用方必须
 * 在使用前调用 `connect()`，在终止子进程时调用 `close()`。
 */
export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  // 仅在 `client.connect()` 解析且调用方未在启动过程中拆除后翻转为 true。
  // `onclose` 钩子使用此标志来区分"握手后传输断开"（→ 非预期关闭）
  // 和"握手期间传输断开"（→ `connect()` 抛出异常；管理器通过
  // `formatStartupError` 呈现失败）。
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  // 在传输关闭前监听器尚未安装时缓冲（例如服务器在响应 `tools/list` 后
  // 几秒即退出）。在 `onUnexpectedClose` 注册时重放，以确保关闭
  // 不会被静默丢弃。
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;

  /** stderr 尾部捕获的容量（字符数），用于诊断。 */
  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions = {}) {
    if (config.executor !== undefined && config.executor !== 'local') {
      throw new KimiError(ErrorCodes.NOT_IMPLEMENTED, `MCP stdio executor '${config.executor}' is not yet implemented`);
    }
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: mergeStdioEnv(config.env),
      cwd: resolveStdioCwd(config.cwd, options.defaultCwd),
      stderr: 'pipe',
    });
    // `stderr: 'pipe'` 意味着我们必须排空该流——否则子进程可能在管道满时阻塞。
    // 我们还保留最后几 KB，以便连接管理器将其附加到面向用户的失败消息中
    //（单独的 `Timed out after 30000ms` 对用户没有实际帮助）。
    this.transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP stdio client is closed');
    }
    if (this.started) return;
    this.started = true;
    // 在 SDK 握手之前安装传输钩子，以确保不会丢失握手完成与我们连线之间
    // 触发的 onclose。钩子本身基于 `this.ready` 门控，因此握手期间发生的
    // 关闭仍通过 `client.connect()` 拒绝来传播。
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP stdio client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  /**
   * 注册底层传输自行关闭时触发的监听器——即调用方尚未调用 {@link close}。
   * 最多可安装一个监听器；后续注册会替换先前的。有意的关闭不会调用该监听器。
   *
   * 如果传输在调用此方法之前已关闭，则缓冲的原因会同步重放，
   * 以确保关闭不会被丢弃。
   */
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  /**
   * 返回自子进程启动以来从其 stderr 捕获的字节尾部。
   * 由 {@link StdioMcpClient.stderrBufferCapacity} 限制，以防止
   * 噪音服务器耗尽内存。
   */
  stderrSnapshot(): string {
    return this.stderrBuffer.snapshot();
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
    // 幂等：`connect()` 是唯一的调用方且自身受 `started` 保护，
    // // 但在此防御可让未来的重构自由调用此方法。
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    // `Client.onclose` 在三种情况下触发：
    //   1. 有意的 `close()` 路径 → 由 `this.closed` 门控。
    //   2. SDK 握手期间传输断开 → 由 `!this.ready` 门控；
    //      失败已通过 `client.connect()` 拒绝呈现，`formatStartupError`
    //      在管理器层附加 stderr。
    //   3. 握手成功后传输断开 → 我们关注的情况：触发或缓冲给管理器的
    //      watch 监听器。
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      const stderr = this.stderrBuffer.snapshot();
      const reason: UnexpectedCloseReason = {
        error: this.lastTransportError,
        stderr: stderr.length > 0 ? stderr : undefined,
      };
      const listener = this.unexpectedCloseListener;
      if (listener !== undefined) {
        listener(reason);
      } else {
        // 缓冲，以便稍后注册的监听器仍能看到关闭事件。
        this.pendingUnexpectedClose = reason;
      }
    };
    this.client.onerror = (error) => {
      // 错误本身仅是信息性的——`_onclose` 才告诉我们传输已消失——
      // 因此只需记住最新的错误，让 close 处理程序决定是否呈现它。
      // 启动期间 `client.connect()` 抛出的错误已携带消息，所以此捕获
      // 仅在 `ready` 之后起作用。
      this.lastTransportError = error;
    };
  }
}

/**
 * 有界的"尾部"缓冲区：追加字符并在总量超过 `capacity` 时丢弃最旧的内容。
 * 用于保留子进程 stderr 的最后几 KB，避免无限增长。
 */
class BoundedTail {
  private buffer = '';
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
  }

  snapshot(): string {
    return this.buffer;
  }
}

function resolveStdioCwd(configCwd: string | undefined, defaultCwd: string | undefined): string | undefined {
  if (configCwd === undefined) return defaultCwd;
  if (defaultCwd !== undefined && !isAbsolute(configCwd)) return resolve(defaultCwd, configCwd);
  return configCwd;
}

// Inherit the parent's env so PATH/HOME/etc. survive — otherwise `npx`/`uvx`
// style stdio servers fail to launch even with a valid config. `config.env`
// overrides on conflict. A node child does not inherit our in-process undici
// dispatcher, so `proxyEnvForChild` adds `NODE_USE_ENV_PROXY` (and a
// loopback-protected `NO_PROXY`) to make it honor the proxy natively (on a Node
// version that supports the flag — ≥22.21 or ≥24.5). It is computed from the
// MERGED env so a proxy declared only in `config.env` is honored too.
// `reconcileChildNoProxy` then mirrors a single-casing `NO_PROXY` override onto
// both casings so it isn't shadowed by the injected value.
export function mergeStdioEnv(
  configEnv?: Record<string, string>,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  if (configEnv !== undefined) Object.assign(merged, configEnv);
  Object.assign(merged, proxyEnvForChild(merged));
  reconcileChildNoProxy(merged, configEnv);
  return merged;
}

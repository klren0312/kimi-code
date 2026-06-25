import { ErrorCodes, KimiError } from '#/errors';
import type { McpServerConfig } from '#/config/schema';
import { log as defaultLog } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { Tool } from '@moonshot-ai/kosong';

import { abortable } from '../utils/abort';
import { HttpMcpClient } from './client-http';
import { isRemoteMcpConfig } from './client-remote';
import { SseMcpClient } from './client-sse';
import type { UnexpectedCloseReason } from './client-shared';
import { StdioMcpClient } from './client-stdio';
import type { McpOAuthService } from './oauth';
import { assertMcpInputSchema, type MCPClient } from './types';

export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';

export interface McpServerEntry {
  readonly name: string;
  readonly transport: McpServerConfig['transport'];
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
}

interface InternalEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  attemptId: number;
  status: McpServerStatus;
  tools?: readonly Tool[];
  enabledNames?: ReadonlySet<string>;
  error?: string;
  client?: RuntimeMcpClient;
}

export type McpStatusListener = (entry: McpServerEntry) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type RuntimeMcpClient = StdioMcpClient | HttpMcpClient | SseMcpClient;

export interface McpConnectionManagerOptions {
  readonly envLookup?: (name: string) => string | undefined;
  readonly stdioCwd?: string;
  /**
   * 可选的 OAuth 编排器。提供后，没有静态 bearer token 的远程服务器
   * 参与通过合成工具的 OAuth 流程：
   *  - 如果 `oauthService.hasTokens(name, url)` 为 true，则将提供方
   *    附加到传输层，以便 SDK 在收到 401 时刷新 token。
   *  - 看起来像 401 / `UnauthorizedError` 的连接失败会将条目翻转为
   *    `needs-auth` 而非 `failed`；`/mcp-config` 通过合成认证工具
   *    驱动浏览器流程。
   */
  readonly oauthService?: McpOAuthService;
  /**
   * 父级日志记录器。默认为全局 `log`；Session 传入其自身的 `session.log`
   * 使 MCP 事件也出现在会话日志中。
   */
  readonly log?: Logger;
}

/**
 * 拥有 Session 中每个已配置 MCP 服务器的生命周期。
 *
 * 服务器并行连接；每个服务器的失败被隔离，因此崩溃或配置错误的条目
 * 不会阻塞 Session 启动。状态转换通过 {@link onStatusChange} 呈现，
 * 以便调用方（Session）做出响应——将工具注册到主代理、发出 wire 事件
 * 或更新 TUI。
 */
export class McpConnectionManager {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<McpStatusListener>();
  private initialLoad: Promise<void> = Promise.resolve();
  private initialLoadAttemptId = 0;
  private initialLoadStartedAt: number | undefined;
  private initialLoadFinishedAt: number | undefined;

  /**
   * 构造时注入的 OAuth 编排器。由 {@link ToolManager} 的 `needs-auth` 分支
   * 消费，以构建合成的 `authenticate` 工具。
   */
  readonly oauthService: McpOAuthService | undefined;
  private readonly log: Logger;

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.oauthService = options.oauthService;
    this.log = options.log ?? defaultLog;
  }

  /**
   * 按名称返回远程 MCP 服务器的 URL，对于未知/非远程/已禁用的条目
   * 返回 `undefined`。合成认证工具使用它来针对正确的基础 URL
   * 驱动 OAuth 发现。
   */
  getRemoteServerUrl(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    if (!isRemoteMcpConfig(entry.config)) return undefined;
    return entry.config.url;
  }

  /**
   * @deprecated 使用 {@link getRemoteServerUrl}。保留此方法是为了兼容
   * 在旧版 SSE 支持共享同一 OAuth 路径之前编写的仓库内调用方。
   */
  getHttpServerUrl(name: string): string | undefined {
    return this.getRemoteServerUrl(name);
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): readonly McpServerEntry[] {
    return Array.from(this.entries.values(), toPublicEntry);
  }

  get(name: string): McpServerEntry | undefined {
    const entry = this.entries.get(name);
    return entry !== undefined ? toPublicEntry(entry) : undefined;
  }

  /**
   * 返回给定已连接服务器的 MCP 客户端、发现的工具和工具名称允许列表，
   * 如果服务器当前未连接则返回 `undefined`。允许列表结合服务器的
   * `enabledTools` 和 `disabledTools` 过滤器；调用方应仅注册集合中的名称。
   */
  resolved(
    name: string,
  ):
    | { client: MCPClient; tools: readonly Tool[]; enabledNames: ReadonlySet<string> }
    | undefined {
    const entry = this.entries.get(name);
    if (
      entry?.status !== 'connected' ||
      entry.tools === undefined ||
      entry.client === undefined
    ) {
      return undefined;
    }
    return {
      client: entry.client,
      tools: entry.tools,
      enabledNames: entry.enabledNames ?? new Set(entry.tools.map((t) => t.name)),
    };
  }

  connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const attemptId = ++this.initialLoadAttemptId;
    this.initialLoadStartedAt = Date.now();
    this.initialLoadFinishedAt = undefined;
    const initialLoad = this.connectAllNow(configs).finally(() => {
      if (this.initialLoadAttemptId === attemptId) {
        this.initialLoadFinishedAt = Date.now();
      }
    });
    this.initialLoad = initialLoad;
    return initialLoad;
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    const previous = this.entries.get(name);
    if (previous !== undefined) {
      await this.closeClient(previous);
    }
    const disabled = config.enabled === false;
    const entry: InternalEntry = {
      name,
      config,
      attemptId: 0,
      status: disabled ? 'disabled' : 'pending',
    };
    this.entries.set(name, entry);
    this.emit(entry);
    if (!disabled) {
      await this.connectOne(entry, this.beginConnectAttempt(entry));
    }
  }

  async remove(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (entry === undefined) return false;
    await this.closeClient(entry);
    entry.status = 'disabled';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.error = undefined;
    this.emit(entry);
    this.entries.delete(name);
    return true;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (signal === undefined) return this.initialLoad;
    return abortable(this.initialLoad, signal);
  }

  initialLoadDurationMs(): number {
    if (this.initialLoadStartedAt === undefined) return 0;
    const endedAt = this.initialLoadFinishedAt ?? Date.now();
    return Math.max(0, endedAt - this.initialLoadStartedAt);
  }

  private async connectAllNow(configs: Record<string, McpServerConfig>): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const [name, config] of Object.entries(configs)) {
      const disabled = config.enabled === false;
      const entry: InternalEntry = {
        name,
        config,
        attemptId: 0,
        status: disabled ? 'disabled' : 'pending',
      };
      this.entries.set(name, entry);
      this.emit(entry);
      if (!disabled) {
        tasks.push(this.connectOne(entry, this.beginConnectAttempt(entry)));
      }
    }
    await Promise.allSettled(tasks);
  }

  async reconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
    }
    if (entry.config.enabled === false) {
      throw new KimiError(ErrorCodes.MCP_SERVER_DISABLED, `MCP server is disabled: ${name}`);
    }
    const attemptId = this.beginConnectAttempt(entry);
    await this.closeClient(entry);
    if (!this.isCurrent(entry, attemptId)) return;
    entry.status = 'pending';
    entry.tools = undefined;
    entry.enabledNames = undefined;
    entry.error = undefined;
    this.emit(entry);
    await this.connectOne(entry, attemptId);
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    const tasks = entries.map((entry) => this.closeClient(entry));
    await Promise.allSettled(tasks);
  }

  private async connectOne(entry: InternalEntry, attemptId: number): Promise<void> {
    const timeoutMs = entry.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    let client: RuntimeMcpClient | undefined;
    try {
      const startupClient = this.createClient(entry.config, entry.name);
      client = startupClient;
      entry.client = startupClient;
      const tools = await withTimeout(
        this.connectAndDiscoverTools(startupClient),
        timeoutMs,
        () => {
          // 尽力清理，如果启动承诺仍在竞争中。
          void this.closeRuntimeClient(startupClient);
        },
      );
      if (!this.isCurrent(entry, attemptId)) {
        await this.closeRuntimeClient(startupClient);
        return;
      }
      entry.tools = tools;
      entry.enabledNames = computeEnabledNames(entry.config, tools);
      entry.status = 'connected';
      this.watchForUnexpectedClose(entry, startupClient, attemptId);
    } catch (error) {
      if (!this.isCurrent(entry, attemptId)) {
        if (client !== undefined) {
          await this.closeRuntimeClient(client);
        }
        return;
      }
      if (this.shouldMarkNeedsAuth(entry, error)) {
        entry.status = 'needs-auth';
        entry.error = `${entry.name} requires OAuth — run /mcp-config login ${entry.name}`;
      } else {
        entry.status = 'failed';
        entry.error = formatStartupError(error, client);
      }
      entry.tools = undefined;
      entry.enabledNames = undefined;
      // 清除客户端引用，以便稍后的重连构建新的客户端。
      await this.closeClient(entry);
    }
    if (!this.isCurrent(entry, attemptId)) return;
    this.emit(entry);
  }

  private watchForUnexpectedClose(
    entry: InternalEntry,
    client: RuntimeMcpClient,
    attemptId: number,
  ): void {
    client.onUnexpectedClose((reason) => {
      // 客户端可能已超出其条目的生命周期（shutdown / reconnect 已继续）。
      // 如果是这样则丢弃事件——新的尝试拥有状态。
      if (!this.isCurrent(entry, attemptId)) return;
      if (entry.client !== client) return;
      entry.status = 'failed';
      entry.error = formatUnexpectedCloseError(entry.name, reason);
      entry.tools = undefined;
      entry.enabledNames = undefined;
      entry.client = undefined;
      // 尽力关闭；传输层已消失，但这让 SDK 释放计时器和待处理的请求处理器。
      void this.closeRuntimeClient(client);
      this.emit(entry);
    });
  }

  private beginConnectAttempt(entry: InternalEntry): number {
    entry.attemptId += 1;
    return entry.attemptId;
  }

  private createClient(config: McpServerConfig, name: string): RuntimeMcpClient {
    const toolCallTimeoutMs = config.toolTimeoutMs;
    if (config.transport === 'stdio') {
      return new StdioMcpClient(config, { toolCallTimeoutMs, defaultCwd: this.options.stdioCwd });
    }
    if (config.transport === 'sse') {
      return new SseMcpClient(config, {
        toolCallTimeoutMs,
        envLookup: this.options.envLookup,
        oauthProvider: this.resolveOAuthProvider(config, name),
      });
    }
    return new HttpMcpClient(config, {
      toolCallTimeoutMs,
      envLookup: this.options.envLookup,
      oauthProvider: this.resolveOAuthProvider(config, name),
    });
  }

  private resolveOAuthProvider(
    config: McpServerConfig,
    name: string,
  ): ReturnType<McpOAuthService['getProvider']> | undefined {
    const oauthService = this.oauthService;
    if (oauthService === undefined) return undefined;
    if (!isRemoteMcpConfig(config)) return undefined;
    if (config.bearerTokenEnvVar !== undefined) return undefined;
    // 仅在 token 已生成后附加提供方；在此之前，传输应传播干净的 401，
    // 以便我们可以将条目翻转为 `needs-auth`，而不是陷入 SDK 的 auth()
    // 流程（它会在我们有活跃的重定向 URL 之前尝试 DCR）。
    if (!oauthService.hasTokens(name, config.url)) return undefined;
    return oauthService.getProvider(name, config.url);
  }

  private shouldMarkNeedsAuth(entry: InternalEntry, error: unknown): boolean {
    if (this.oauthService === undefined) return false;
    if (!isRemoteMcpConfig(entry.config)) return false;
    if (entry.config.bearerTokenEnvVar !== undefined) return false;
    // 如果用户固定了静态 `headers` 块，则将 401 视为错误的头部而非
    // 将其劫持到 OAuth 流程中——对于不支持 OAuth 的服务器，真正的错误
    // 比"运行 /mcp-config login"更具可操作性。
    if (entry.config.headers !== undefined) return false;
    return isUnauthorizedLikeError(error);
  }

  private async connectAndDiscoverTools(client: RuntimeMcpClient): Promise<Tool[]> {
    await client.connect();
    const mcpTools = await client.listTools();
    return mcpTools.map((mcpTool) => ({
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: assertMcpInputSchema(mcpTool.name, mcpTool.inputSchema),
    }));
  }

  private async closeClient(entry: InternalEntry): Promise<void> {
    if (entry.client === undefined) return;
    const client = entry.client;
    entry.client = undefined;
    await this.closeRuntimeClient(client);
  }

  private async closeRuntimeClient(client: RuntimeMcpClient): Promise<void> {
    try {
      await client.close();
    } catch {
      // 抑制关闭错误——服务器无论如何都在退出，我们不希望它们掩盖原始的启动失败。
    }
  }

  private isCurrent(entry: InternalEntry, attemptId: number): boolean {
    return this.entries.get(entry.name) === entry && entry.attemptId === attemptId;
  }

  private emit(entry: InternalEntry): void {
    const view = toPublicEntry(entry);
    if (view.status === 'failed' || view.status === 'needs-auth') {
      this.log.error('mcp server unavailable', {
        server: view.name,
        transport: view.transport,
        status: view.status,
        reason: view.error,
      });
    }
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // 监听器故障不得破坏连接管理器。
      }
    }
  }
}

function toPublicEntry(entry: InternalEntry): McpServerEntry {
  return {
    name: entry.name,
    transport: entry.config.transport,
    status: entry.status,
    toolCount:
      entry.status === 'connected' && entry.enabledNames !== undefined
        ? entry.enabledNames.size
        : 0,
    error: entry.error,
  };
}

function computeEnabledNames(config: McpServerConfig, tools: readonly Tool[]): Set<string> {
  const all = tools.map((t) => t.name);
  const enabledFilter =
    config.enabledTools !== undefined ? new Set(config.enabledTools) : undefined;
  const disabledFilter =
    config.disabledTools !== undefined ? new Set(config.disabledTools) : undefined;
  const allowed = new Set<string>();
  for (const name of all) {
    if (enabledFilter !== undefined && !enabledFilter.has(name)) continue;
    if (disabledFilter !== undefined && disabledFilter.has(name)) continue;
    allowed.add(name);
  }
  return allowed;
}

function isUnauthorizedLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'UnauthorizedError') return true;
  // SDK 传输错误通常将 HTTP 状态暴露为 `.code`。
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && code === 401) return true;
  if (typeof code === 'string' && code === '401') return true;
  // 回退到消息嗅探，以便服务器特定的错误形状仍将我们翻转为 needs-auth 而非 failed。
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message);
}

function formatStartupError(error: unknown, client: RuntimeMcpClient | undefined): string {
  const base = error instanceof Error ? error.message : String(error);
  const tail = stderrTail(client);
  if (tail === undefined) return base;
  return `${base}\nstderr: ${tail}`;
}

function formatUnexpectedCloseError(name: string, reason: UnexpectedCloseReason): string {
  const parts = [`MCP server "${name}" closed unexpectedly`];
  if (reason.error !== undefined) {
    parts.push(reason.error.message);
  }
  if (reason.stderr !== undefined && reason.stderr.length > 0) {
    parts.push(`stderr: ${reason.stderr.trimEnd()}`);
  }
  return parts.join('\n');
}

function stderrTail(client: RuntimeMcpClient | undefined): string | undefined {
  if (client === undefined) return undefined;
  if (!(client instanceof StdioMcpClient)) return undefined;
  const snapshot = client.stderrSnapshot();
  if (snapshot.length === 0) return undefined;
  return snapshot.trimEnd();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * @module tool/index
 *
 * Agent 的中央工具注册表和生命周期管理器。聚合三个工具来源——
 * 内置工具（随 Agent 发布）、用户工具（通过 RPC 注册）和 MCP 工具
 * （来自已连接的 MCP 服务器）——统一为 LLM 循环向模型暴露的列表。
 * 处理 MCP 服务器状态变更、通过 profile 模式启用/禁用工具，
 * 以及 MCP 工具名称冲突检测。
 */

import { uniq } from '@antfu/utils';
import type { ChatProvider, Tool } from '@moonshot-ai/kosong';
import picomatch from 'picomatch';

import type { Agent } from '..';
import { makeErrorPayload } from '../../errors';
import type { ExecutableTool } from '../../loop';
import { createMcpAuthTool } from '../../mcp/auth-tool';
import type { McpConnectionManager, McpServerEntry } from '../../mcp';
import { mcpResultToExecutableOutput } from '../../mcp/output';
import { isMcpToolName, qualifyMcpToolName } from '../../mcp/tool-naming';
import type { MCPClient } from '../../mcp/types';
import { DEFAULT_AGENT_PROFILES } from '../../profile';
import { extendWorkspaceWithSkillRoots } from '../../skill';
import * as b from '../../tools/builtin';
import type { ToolStore, ToolStoreData, ToolStoreKey } from '../../tools/store';
import type {
  BuiltinTool,
  McpServerRegistrationResult,
  McpToolCollision,
  ToolInfo,
  UserToolRegistration,
} from './types';

export * from './types';

interface McpToolEntry {
  readonly tool: ExecutableTool;
  readonly serverName: string;
}

/**
 * 管理 Agent 可用工具的完整生命周期。
 *
 * 维护三个并行的工具注册表：
 * - **builtinTools**：在构造时根据 Agent 的 profile 和模型能力一次性创建。
 * - **userTools**：通过 RPC 动态注册/注销。
 * - **MCP 工具**：MCP 服务器连接时自动注册，带冲突检测和基于 glob 的访问控制。
 *
 * {@link loopTools} getter 将三者合并为 LLM 循环发送给提供商的最终列表。
 */
export class ToolManager {
  protected builtinTools: Map<string, BuiltinTool> = new Map();
  protected readonly userTools: Map<string, ExecutableTool> = new Map();
  protected readonly mcpTools: Map<string, McpToolEntry> = new Map();
  private loopToolsOverride: readonly ExecutableTool[] | undefined;
  /** 服务器名称 → 该服务器注册的限定工具名称列表。 */
  protected readonly mcpToolsByServer: Map<string, string[]> = new Map();
  protected enabledTools: Set<string> = new Set();
  /** Glob 模式（如 `mcp__*`、`mcp__github__*`）控制 profile 暴露哪些 MCP 工具。 */
  private mcpAccessPatterns: string[] = [];
  protected readonly store: Partial<ToolStoreData> = {};
  private mcpToolStatusUnsubscribe: (() => void) | undefined;

  constructor(protected readonly agent: Agent) {
    this.attachMcpTools();
    if (agent.config.hasProvider) {
      this.initializeBuiltinTools();
    }
  }

  protected get toolStore(): ToolStore {
    return {
      get: (key) => this.store[key],
      set: (key, value) => {
        this.updateStore(key, value);
      },
    };
  }

  /** 订阅 MCP 服务器状态变更并注册已连接的服务器。 */
  attachMcpTools(): void {
    const mcp = this.agent.mcp;
    if (mcp === undefined) return;
    if (this.mcpToolStatusUnsubscribe !== undefined) return;
    for (const entry of mcp.list()) {
      if (entry.status === 'connected') {
        this.registerConnectedMcpServer(mcp, entry);
      } else if (entry.status === 'needs-auth') {
        this.registerNeedsAuthMcpServer(mcp, entry);
      }
    }
    this.mcpToolStatusUnsubscribe = mcp.onStatusChange((entry) => {
      this.handleMcpServerStatusChange(mcp, entry);
    });
  }

  /**
   * 更新共享工具存储中的键。变更被记录以便在 Agent 恢复期间重放。
   */
  updateStore<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    this.agent.records.logRecord({
      type: 'tools.update_store',
      key,
      value,
    });
    this.store[key] = value;
  }

  /**
   * 注册用户定义的工具。工具的执行通过 RPC 层代理，
   * 由客户端处理实际实现。
   */
  registerUserTool(input: UserToolRegistration): void {
    this.agent.records.logRecord({
      type: 'tools.register_user_tool',
      ...input,
    });
    const { name, description, parameters } = input;
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (args) => {
        return {
          approvalRule: name,
          execute: async (context) => {
            return this.agent.rpc!.toolCall!(
              {
                turnId: Number(context.turnId),
                toolCallId: context.toolCallId,
                args,
              },
              { signal: context.signal },
            );
          },
        };
      },
    };
    this.userTools.set(name, tool);
    this.enabledTools.add(name);
  }

  /** 按名称移除用户注册的工具。 */
  unregisterUserTool(name: string): void {
    this.agent.records.logRecord({
      type: 'tools.unregister_user_tool',
      name,
    });
    this.userTools.delete(name);
    this.enabledTools.delete(name);
  }

  /**
   * 从父工具管理器复制已启用的用户工具到此管理器。
   * 用于生成继承其父级工具表面的子 Agent。
   */
  inheritUserTools(parent: ToolManager): void {
    for (const tool of parent.userTools.values()) {
      if (!parent.enabledTools.has(tool.name)) continue;
      this.registerUserTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
  }

  /**
   * 注册来自已连接 MCP 服务器的所有工具。检测并报告命名冲突
   * （同服务器重复和跨服务器冲突）。
   *
   * @param serverName - MCP 服务器的配置名称。
   * @param client - 用于发起工具调用的 MCP 客户端。
   * @param tools - 服务器提供的工具定义。
   * @param enabledTools - 可选的允许列表；如果设置，仅注册这些工具。
   * @returns 注册结果，包含成功注册的名称和任何冲突。
   */
  registerMcpServer(
    serverName: string,
    client: MCPClient,
    tools: readonly Tool[],
    enabledTools?: ReadonlySet<string>,
  ): McpServerRegistrationResult {
    this.unregisterMcpServer(serverName);
    const qualifiedNames: string[] = [];
    const collisions: McpToolCollision[] = [];
    const seenInThisCall = new Map<string, string>();
    for (const tool of tools) {
      if (enabledTools !== undefined && !enabledTools.has(tool.name)) continue;
      const qualified = qualifyMcpToolName(serverName, tool.name);
      const firstInThisCall = seenInThisCall.get(qualified);
      if (firstInThisCall !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'same_server', toolName: firstInThisCall },
        });
        continue;
      }
      const existingEntry = this.mcpTools.get(qualified);
      if (existingEntry !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'other_server', serverName: existingEntry.serverName },
        });
        continue;
      }
      seenInThisCall.set(qualified, tool.name);
      const wrapped: ExecutableTool = {
        name: qualified,
        description: tool.description,
        parameters: tool.parameters,
        resolveExecution: (args) => {
          return {
            approvalRule: qualified,
            execute: async (context) => {
              // `args` 已经由循环的预检（`loop/tool-call.ts`）进行了 JSON 解析
              // 和 schema 验证，因此 MCP 客户端直接获得普通对象。
              const result = await client.callTool(
                tool.name,
                (args ?? {}) as Record<string, unknown>,
                context.signal,
              );
              return mcpResultToExecutableOutput(result, qualified);
            },
          };
        },
      };
      this.mcpTools.set(qualified, { tool: wrapped, serverName });
      qualifiedNames.push(qualified);
    }
    this.mcpToolsByServer.set(serverName, qualifiedNames);
    return { registered: qualifiedNames, collisions };
  }

  /** 移除特定 MCP 服务器注册的所有工具。如果有被移除的工具则返回 `true`。 */
  unregisterMcpServer(serverName: string): boolean {
    const existing = this.mcpToolsByServer.get(serverName);
    if (existing === undefined) return false;
    for (const qualified of existing) {
      this.mcpTools.delete(qualified);
    }
    this.mcpToolsByServer.delete(serverName);
    return true;
  }

  private handleMcpServerStatusChange(mcp: McpConnectionManager, entry: McpServerEntry): void {
    if (entry.status === 'connected') {
      this.registerConnectedMcpServer(mcp, entry);
      return;
    }
    if (entry.status === 'needs-auth') {
      this.registerNeedsAuthMcpServer(mcp, entry);
      return;
    }
    if (entry.status === 'failed') {
      this.unregisterMcpServer(entry.name);
      this.agent.emitEvent({
        type: 'tool.list.updated',
        reason: 'mcp.failed',
        serverName: entry.name,
      });
      return;
    }
    if (entry.status === 'disabled' || entry.status === 'pending') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        this.agent.emitEvent({
          type: 'tool.list.updated',
          reason: 'mcp.disconnected',
          serverName: entry.name,
        });
      }
    }
  }

  private registerNeedsAuthMcpServer(mcp: McpConnectionManager, entry: McpServerEntry): void {
    // 替换之前注册的任何工具（真实或合成）；服务器切换到 needs-auth
    // 意味着先前的 token 已失效。
    this.unregisterMcpServer(entry.name);
    const oauthService = mcp.oauthService;
    const serverUrl = mcp.getRemoteServerUrl(entry.name);
    if (oauthService === undefined || serverUrl === undefined) {
      // 配置错误：服务器在没有 OAuth 服务或非远程的情况下达到了 needs-auth。
      // 视为空操作，使现有的失败错误消息继续通知用户。
      return;
    }
    const tool = createMcpAuthTool({
      serverName: entry.name,
      serverUrl,
      oauthService,
      reconnect: async () => {
        await mcp.reconnect(entry.name);
      },
    });
    this.mcpTools.set(tool.name, { tool, serverName: entry.name });
    this.mcpToolsByServer.set(entry.name, [tool.name]);
    // 合成的认证工具现在在工具列表中；以与真实工具集相同的方式
    // 将其呈现出来，以便模型发现它。
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  private registerConnectedMcpServer(mcp: McpConnectionManager, entry: McpServerEntry): void {
    const resolved = mcp.resolved(entry.name);
    if (resolved === undefined) return;
    const result = this.registerMcpServer(
      entry.name,
      resolved.client,
      resolved.tools,
      resolved.enabledNames,
    );
    this.emitMcpToolCollisions(entry.name, result.collisions);
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  private emitMcpToolCollisions(serverName: string, collisions: readonly McpToolCollision[]): void {
    if (collisions.length === 0) return;
    const summary = collisions
      .map((c) =>
        c.collidesWith.kind === 'same_server'
          ? `"${c.toolName}" -> ${c.qualified} (collides with "${c.collidesWith.toolName}" from the same server)`
          : `"${c.toolName}" -> ${c.qualified} (collides with server "${c.collidesWith.serverName}")`,
      )
      .join('; ');
    this.agent.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        'mcp.tool_name_collision',
        `MCP server "${serverName}" registered ${collisions.length} tool name` +
          `${collisions.length === 1 ? '' : 's'} ` +
          `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
        { details: { serverName, collisions: collisions as readonly unknown[] } },
      ),
    });
  }

  /**
   * 设置当前 profile 的活动工具列表。MCP 工具名称（包含 `__`）
   * 视为 glob 模式；其他为精确的内置/用户工具名称。
   */
  setActiveTools(names: readonly string[]): void {
    this.agent.records.logRecord({
      type: 'tools.set_active_tools',
      names,
    });
    // MCP 条目是单独控制的 glob 模式；其余是精确的内置/用户工具名称。
    // 这种分离使每个调用方使用一个 string[]。
    this.enabledTools = new Set(names.filter((name) => !isMcpToolName(name)));
    this.mcpAccessPatterns = names.filter((name) => isMcpToolName(name));
  }

  /**
   * 从另一个工具管理器复制循环工具覆盖。子 Agent 用于
   * 直接继承其父级已解析的工具列表。
   */
  copyLoopToolsFrom(source: ToolManager): void {
    this.loopToolsOverride = source.loopTools;
  }

  private isMcpToolEnabled(name: string): boolean {
    return this.mcpAccessPatterns.some((pattern) => picomatch.isMatch(name, pattern));
  }

  /** 生成所有注册工具（内置、用户和 MCP）的元数据。 */
  *toolInfos(): Iterable<ToolInfo> {
    for (const tool of this.builtinTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        active: this.enabledTools.has(tool.name),
        source: 'builtin',
      };
    }
    for (const tool of this.userTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        active: this.enabledTools.has(tool.name),
        source: 'user',
      };
    }
    for (const entry of this.mcpTools.values()) {
      yield {
        name: entry.tool.name,
        description: entry.tool.description,
        active: this.isMcpToolEnabled(entry.tool.name),
        source: 'mcp',
      };
    }
  }

  /** 所有工具元数据的快照数组。 */
  data(): readonly ToolInfo[] {
    return Array.from(this.toolInfos());
  }

  /** 共享工具存储数据的快照。 */
  storeData(): Readonly<Record<string, unknown>> {
    return { ...this.store };
  }

  /**
   * 根据 Agent 的配置、模型能力和可用服务创建并注册所有内置工具。
   * 在构造时调用一次，并在通过 {@link refreshBuiltinTools} 变更 Agent 能力时再次调用。
   */
  initializeBuiltinTools() {
    const {
      kaos,
      toolServices,
      config: { cwd, provider, modelCapabilities },
      background,
    } = this.agent;
    const videoUploader = this.createVideoUploader(provider);
    const workspace = extendWorkspaceWithSkillRoots(
      {
        workspaceDir: cwd,
        additionalDirs: this.agent.getAdditionalDirs(),
      },
      this.agent.skills?.registry.getSkillRoots() ?? [],
    );
    const allowBackground =
      this.enabledTools.has('TaskList') &&
      this.enabledTools.has('TaskOutput') &&
      this.enabledTools.has('TaskStop');
    const goalToolsEnabled = this.agent.type === 'main';
    this.builtinTools = new Map(
      [
        new b.ReadTool(kaos, workspace),
        new b.WriteTool(kaos, workspace),
        new b.EditTool(kaos, workspace),
        new b.GrepTool(kaos, workspace),
        new b.GlobTool(kaos, workspace),
        new b.BashTool(kaos, cwd, background, {
          allowBackground,
        }),
        (modelCapabilities.image_in || modelCapabilities.video_in) &&
          new b.ReadMediaFileTool(kaos, workspace, modelCapabilities, videoUploader),
        new b.EnterPlanModeTool(this.agent),
        new b.ExitPlanModeTool(this.agent),
        // 目标工具仅限主 Agent。
        goalToolsEnabled && new b.CreateGoalTool(this.agent),
        goalToolsEnabled && new b.GetGoalTool(this.agent),
        goalToolsEnabled && new b.SetGoalBudgetTool(this.agent),
        goalToolsEnabled && new b.UpdateGoalTool(this.agent),
        this.agent.rpc?.requestQuestion && new b.AskUserQuestionTool(this.agent),
        new b.TodoListTool(this.toolStore),
        new b.TaskListTool(background),
        new b.TaskOutputTool(background),
        new b.TaskStopTool(background),
        this.agent.cron && new b.CronCreateTool(this.agent.cron),
        this.agent.cron && new b.CronListTool(this.agent.cron),
        this.agent.cron && new b.CronDeleteTool(this.agent.cron),
        this.agent.skills?.registry.listInvocableSkills().length &&
          new b.SkillTool(this.agent),
        this.agent.subagentHost &&
          new b.AgentTool(
            this.agent.subagentHost,
            background,
            DEFAULT_AGENT_PROFILES['agent']?.subagents,
            {
              allowBackground,
              log: this.agent.log,
            },
          ),
        this.agent.subagentHost &&
          new b.AgentSwarmTool(this.agent.subagentHost, this.agent.swarmMode),
        toolServices?.webSearcher && new b.WebSearchTool(toolServices.webSearcher),
        toolServices?.urlFetcher && new b.FetchURLTool(toolServices.urlFetcher),
      ]
        .filter((tool) => !!tool)
        .map((tool) => [tool.name, tool] as const),
    );
  }

  /** 重新初始化内置工具（例如 profile 或模型变更后）。 */
  refreshBuiltinTools(): void {
    this.initializeBuiltinTools();
  }

  private createVideoUploader(provider: ChatProvider): b.VideoUploader | undefined {
    const uploadVideo = provider.uploadVideo?.bind(provider);
    if (uploadVideo === undefined) return undefined;

    const modelAlias = this.agent.config.modelAlias!;
    const withAuth = this.agent.modelProvider?.resolveAuth?.(modelAlias, {
      log: this.agent.log,
    });
    if (withAuth === undefined) return (input) => uploadVideo(input);
    return (input) => withAuth((auth) => uploadVideo(input, { auth }));
  }

  /**
   * 每个 turn 发送给 LLM 提供商的已解析工具列表。
   * 合并已启用的内置、用户和 MCP 工具，按字母排序。
   * 当不存在目标时，目标变更工具（SetGoalBudget、UpdateGoal）被隐藏，
   * 保持模型的工具表面简洁。
   */
  get loopTools(): readonly ExecutableTool[] {
    if (this.loopToolsOverride !== undefined) return this.loopToolsOverride;
    const mcpNames = [...this.mcpTools.keys()].filter((name) => this.isMcpToolEnabled(name));
    // 仅在目标存在时向模型提供目标变更工具。
    const hideGoalMutationTools = this.agent.goal.getGoal().goal === null;
    return uniq([...this.enabledTools, ...mcpNames])
      .toSorted((a, b) => a.localeCompare(b))
      .filter(
        (name) =>
          !(hideGoalMutationTools && (name === 'SetGoalBudget' || name === 'UpdateGoal')),
      )
      .map(
        (name) =>
          this.userTools.get(name) ??
          this.mcpTools.get(name)?.tool ??
          this.builtinTools.get(name),
      )
      .filter((tool) => !!tool);
  }
}

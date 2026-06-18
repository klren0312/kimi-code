/**
 * Agent 模块 - 核心 AI Agent 实现
 *
 * 本模块实现 Agent 类，它是 Kimi Code AI 编码助手的核心协调器。管理：
 * - LLM 通信（带日志的请求/响应）
 * - 对话上下文和历史
 * - 工具执行和权限
 * - 后台任务管理
 * - 会话持久化和重放
 * - 配置和模型管理
 * - 计划模式和群体模式协调
 *
 * Agent 类设计为可独立使用（无需 Session），
 * 适用于交互式 TUI 和无头/服务器用例。
 */

import { join } from 'pathe';

import { ErrorCodes, KimiError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import {
  enableLlmCommunicationLog,
  isLlmCommunicationLogEnabled,
  logLlmRequest,
  logLlmResponse,
  startLlmLogServer,
} from '#/logging/llm-communication';
import type { AgentAPI, AgentEvent, KimiConfig, SDKAgentRPC, UsageStatus } from '#/rpc';
import { generate } from '@moonshot-ai/kosong';

import type { EnabledPluginSessionStart } from '#/plugin';

import type { McpConnectionManager } from '../mcp';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import type { PreparedSystemPromptContext, ResolvedAgentProfile } from '../profile';
import type { ModelProvider } from '../session/provider-manager';
import type { SessionSubagentHost } from '../session/subagent-host';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import type { PromisableMethods } from '../utils/types';
import { BackgroundManager, BackgroundTaskPersistence } from './background';
import {
  FullCompaction,
  MicroCompaction,
  type CompactionStrategy,
  type MicroCompactionConfig,
} from './compaction';
import { CronManager } from './cron';
import { ConfigState } from './config';
import { ContextMemory } from './context';
import { GoalMode } from './goal';
import { HookEngine } from '../session/hooks';
import { InjectionManager } from './injection/manager';
import { PermissionManager, type PermissionManagerOptions } from './permission';
import { PlanMode } from './plan';
import {
  AgentRecords,
  BlobStore,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
  type AgentRecordsReplayOptions,
} from './records';
import { ReplayBuilder, type ReplayBuilderOptions } from './replay';
import { SkillManager } from './skill';
import type { SkillRegistry } from './skill/types';
import { SwarmMode } from './swarm';
import { ToolManager } from './tool/index';
import { TurnFlow } from './turn';
import { KosongLLM } from './turn/kosong-llm';
import { UsageRecorder } from './usage';
import { LlmRequestLogger, splitGenerateOptions } from './llm-request-logger';
import { resolveCompletionBudget } from '../utils/completion-budget';
import type { Kaos } from '@moonshot-ai/kaos';
import type { ToolServices } from '../tools/support/services';

// 为外部消费者重新导出类型
export type { AgentRecord, AgentRecordPersistence } from './records';
export type { SwarmModeTrigger } from './swarm';
export type { BuiltinTool, ToolInfo, ToolSource, UserToolRegistration } from './tool';
export * from './goal';

/**
 * Agent 类型决定 Agent 的行为和能力。
 * - 'main'：主交互式 Agent（具有完整功能）
 * - 'sub'：为特定任务生成的子 Agent（功能受限）
 * - 'independent'：独立 Agent（无父会话）
 */
export type AgentType = 'main' | 'sub' | 'independent';

/**
 * 创建 Agent 实例的配置选项。
 * 所有选项都是可选的，未提供时使用默认值。
 */
export interface AgentOptions {
  /** 执行环境（文件系统、进程等） */
  readonly kaos: Kaos;
  /** Agent 配置（模型、提供商等） */
  readonly config?: KimiConfig;
  /** 持久化存储的主目录 */
  readonly homedir?: string;
  /** 与宿主通信的 RPC 接口 */
  readonly rpc?: Partial<SDKAgentRPC>;
  /** Agent 记录的自定义持久化实现 */
  readonly persistence?: AgentRecordPersistence;
  /** Agent 类型（main、sub 或 independent） */
  readonly type?: AgentType;
  /** 自定义 LLM 生成函数（用于测试或自定义提供商） */
  readonly generate?: typeof generate;
  /** 工具执行服务（MCP 等） */
  readonly toolServices?: ToolServices;
  /** 上下文压缩策略 */
  readonly compactionStrategy?: CompactionStrategy;
  /** 微压缩配置 */
  readonly microCompaction?: Partial<MicroCompactionConfig>;
  /** 模型配置解析提供者 */
  readonly modelProvider?: ModelProvider | undefined;
  /** 子 Agent 管理宿主 */
  readonly subagentHost?: SessionSubagentHost | undefined;
  /** 可用技能注册表 */
  readonly skills?: SkillRegistry;
  /** MCP（模型上下文协议）连接管理器 */
  readonly mcp?: McpConnectionManager;
  /** 生命周期钩子执行引擎 */
  readonly hookEngine?: HookEngine;
  /** 权限管理配置 */
  readonly permission?: PermissionManagerOptions | undefined;
  /** 日志实例 */
  readonly log?: Logger;
  /** 用于跟踪事件的遥测客户端 */
  readonly telemetry?: TelemetryClient | undefined;
  /** 会话启动时应激活的插件 */
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  /** 实验性功能标志解析器 */
  readonly experimentalFlags?: ExperimentalFlagResolver;
  /** 重放构建器选项 */
  readonly replay?: ReplayBuilderOptions;
}

/**
 * Agent - 核心 AI Agent 实现
 *
 * Agent 类是 Kimi Code AI 能力的核心协调器。
 * 它管理 AI 交互的完整生命周期，包括：
 *
 * 1. **LLM 通信**：向 AI 模型发送请求并处理响应
 * 2. **上下文管理**：维护对话历史和 token 预算
 * 3. **工具执行**：管理和执行工具（bash、文件操作、MCP 等）
 * 4. **权限控制**：处理用户对敏感操作的审批
 * 5. **后台任务**：管理长时间运行的后台操作
 * 6. **会话持久化**：保存和恢复 Agent 状态
 * 7. **配置管理**：管理模型、提供商和行为设置
 *
 * 使用示例：
 * ```typescript
 * const agent = new Agent({
 *   kaos: myKaos,
 *   config: myConfig,
 *   homedir: '/path/to/home',
 * });
 *
 * // 设置 Agent 配置文件
 * agent.useProfile(profile);
 *
 * // 从之前的会话恢复
 * await agent.resume();
 *
 * // 生成响应
 * const result = await agent.generate(provider, systemPrompt, tools, history);
 * ```
 */
export class Agent {
  /** Agent 类型（main、sub 或 independent） */
  readonly type: AgentType;
  /** 执行环境（文件系统、进程等） */
  private _kaos: Kaos;

  /** 获取执行环境 */
  get kaos(): Kaos {
    return this._kaos;
  }

  /** 来自 config.toml 的 Agent 配置 */
  readonly kimiConfig?: KimiConfig;
  /** 持久化存储的主目录 */
  readonly homedir?: string;
  /** 与宿主通信的 RPC 接口 */
  readonly rpc?: Partial<SDKAgentRPC>;
  /** 工具执行服务 */
  readonly toolServices?: ToolServices;
  /** 会话启动时激活的插件 */
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  /** 原始 LLM 生成函数（包装认证/日志之前的） */
  readonly rawGenerate: typeof generate;
  /** 模型配置解析提供者 */
  readonly modelProvider?: ModelProvider;
  /** 子 Agent 管理宿主 */
  readonly subagentHost?: SessionSubagentHost;
  /** MCP 连接管理器 */
  readonly mcp?: McpConnectionManager;
  /** 生命周期钩子执行引擎 */
  readonly hooks?: HookEngine;
  /** 日志实例 */
  readonly log: Logger;
  /** 用于跟踪事件的遥测客户端 */
  readonly telemetry: TelemetryClient;
  /** 实验性功能标志解析器 */
  readonly experimentalFlags: ExperimentalFlagResolver;

  /** LLM 请求元数据日志记录器 */
  readonly llmRequestLogger: LlmRequestLogger;
  /** 二进制数据（图片、文件等）的存储 */
  readonly blobStore: BlobStore | undefined;
  /** Agent 记录管理器（对话历史） */
  readonly records: AgentRecords;
  /** 完整上下文压缩（摘要生成） */
  readonly fullCompaction: FullCompaction;
  /** 微上下文压缩（小型优化） */
  readonly microCompaction: MicroCompaction;
  /** 上下文记忆管理器 */
  readonly context: ContextMemory;
  /** 配置状态管理器 */
  readonly config: ConfigState;
  /** 轮次流程控制器（管理提示/响应周期） */
  readonly turn: TurnFlow;
  /** 注入管理器（用于系统提示注入） */
  readonly injection: InjectionManager;
  /** 权限管理器（处理用户审批） */
  readonly permission: PermissionManager;
  /** 计划模式控制器 */
  readonly planMode: PlanMode;
  /** 群体模式控制器（多 Agent 协调） */
  readonly swarmMode: SwarmMode;
  /** Token 使用量记录器 */
  readonly usage: UsageRecorder;
  /** 技能管理器（未配置技能时为 null） */
  readonly skills: SkillManager | null;
  /** 工具管理器（注册和执行工具） */
  readonly tools: ToolManager;
  /** 后台任务管理器 */
  readonly background: BackgroundManager;
  /** 定时任务管理器（子 Agent 为 null） */
  readonly cron: CronManager | null;
  /** 目标模式控制器 */
  readonly goal: GoalMode;
  /** 会话恢复的重放构建器 */
  readonly replayBuilder: ReplayBuilder;

  /**
   * 创建新的 Agent 实例。
   *
   * @param options - Agent 的配置选项
   */
  constructor(options: AgentOptions) {
    // 基础配置
    this.type = options.type ?? 'main';
    this._kaos = options.kaos;
    this.kimiConfig = options.config;
    this.homedir = options.homedir;
    this.rpc = options.rpc;
    this.toolServices = options.toolServices;
    this.pluginSessionStarts = options.pluginSessionStarts ?? [];
    this.rawGenerate = options.generate ?? generate;

    // 如果设置了 KIMI_CODE_LOG_LLM=1，则启用 LLM 通信日志
    if (process.env['KIMI_CODE_LOG_LLM'] === '1') {
      enableLlmCommunicationLog();
      const host = '0.0.0.0'
      const port = process.env['KIMI_CODE_LOG_LLM_PORT']
        ? Number.parseInt(process.env['KIMI_CODE_LOG_LLM_PORT'], 10)
        : undefined;
      startLlmLogServer(port, host);
    }

    // 外部依赖
    this.modelProvider = options.modelProvider;
    this.subagentHost = options.subagentHost;
    this.mcp = options.mcp;
    this.hooks = options.hookEngine;
    this.log = options.log ?? log;
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.experimentalFlags = options.experimentalFlags ?? new FlagResolver();

    // 初始化内部管理器
    this.llmRequestLogger = new LlmRequestLogger(this.log);
    this.blobStore = options.homedir
      ? new BlobStore({ blobsDir: join(options.homedir, 'blobs') })
      : undefined;
    this.records = new AgentRecords(
      this,
      options.persistence ??
        (options.homedir
          ? new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), {
              onError: (error) => {
                this.emitRecordsWriteError(error);
              },
              blobStore: this.blobStore,
            })
          : undefined),
    );
    this.fullCompaction = new FullCompaction(this, options.compactionStrategy);
    this.microCompaction = new MicroCompaction(this, options.microCompaction);
    this.context = new ContextMemory(this);
    this.config = new ConfigState(this);
    this.turn = new TurnFlow(this);
    this.injection = new InjectionManager(this);
    this.permission = new PermissionManager(this, options.permission);
    this.planMode = new PlanMode(this);
    this.swarmMode = new SwarmMode(this);
    this.usage = new UsageRecorder(this);
    this.skills = options.skills ? new SkillManager(this, options.skills) : null;
    this.tools = new ToolManager(this);
    this.background = new BackgroundManager(
      this,
      this.homedir === undefined ? undefined : new BackgroundTaskPersistence(this.homedir),
    );
    this.cron = this.type === 'sub' ? null : new CronManager(this);
    this.goal = new GoalMode(this);
    this.replayBuilder = new ReplayBuilder(this, options.replay);
  }

  /**
   * 更新执行环境。
   * 当 Agent 需要切换上下文时使用（例如不同的工作目录）。
   *
   * @param kaos - 新的执行环境
   */
  setKaos(kaos: Kaos) {
    this._kaos = kaos;
  }

  /**
   * 获取带日志和认证包装的 LLM 生成函数。
   *
   * 此 getter 返回原始生成函数的包装版本，它会：
   * 1. 在设置了 KIMI_CODE_LOG_LLM=1 时记录 LLM 请求/响应
   * 2. 处理认证（OAuth token、API 密钥）
   * 3. 测量请求持续时间
   *
   * @returns 包装后的生成函数
   */
  get generate(): typeof generate {
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      // 检查 LLM 通信日志是否启用
      const logComm = isLlmCommunicationLogEnabled();
      if (logComm) {
        logLlmRequest({
          provider: provider.name,
          model: provider.modelName,
          systemPrompt,
          tools,
          history,
        });
      }

      // 跟踪请求持续时间
      const startMs = Date.now();

      // 处理实际生成的内部函数
      const doGenerate = async (opts: typeof options) => {
        const result = await this.rawGenerate(provider, systemPrompt, tools, history, callbacks, opts);

        // 如果日志已启用则记录响应
        if (logComm) {
          logLlmResponse({
            content: result.message.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join(''),
            toolCalls: result.message.toolCalls.map((tc) => ({
              name: tc.name,
              arguments: tc.arguments ?? '',
            })),
            usage: result.usage,
            finishReason: result.finishReason,
            durationMs: Date.now() - startMs,
          });
        }
        return result;
      };

      // 如果已提供认证则直接使用
      if (options?.auth !== undefined) {
        return doGenerate(options);
      }

      // 否则尝试从模型提供者解析认证
      const modelAlias = this.config.modelAlias;
      const withAuth =
        modelAlias === undefined
          ? undefined
          : this.modelProvider?.resolveAuth?.(modelAlias, { log: this.log });

      // 如果不需要或没有可用认证则无认证生成
      if (withAuth === undefined) {
        return doGenerate(options);
      }

      // 使用解析的认证生成
      return withAuth((auth) => {
        return doGenerate({ ...options, auth });
      });
    };
  }

  /**
   * 获取此 Agent 的 KosongLLM 实例。
   *
   * KosongLLM 为 LLM 交互提供更高级别的接口，
   * 包括预算管理和提供商配置。
   *
   * @returns 为此 Agent 配置的 KosongLLM 实例
   */
  get llm(): KosongLLM {
    // 所有提供者级别的请求配置（思考、采样参数、thinking.keep）
    // 在 ConfigState.provider 中应用，以便压缩共享该配置。参见 get provider()。
    const provider = this.config.provider;
    const loopControl = this.kimiConfig?.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      maxOutputSize: this.config.maxOutputSize,
      reservedContextSize: loopControl?.reservedContextSize,
    });
    return new KosongLLM({
      provider,
      systemPrompt: this.config.systemPrompt,
      capability: this.config.modelCapabilities,
      generate: this.generate,
      completionBudgetConfig,
    });
  }

  /**
   * 向此 Agent 应用配置文件。
   *
   * 配置文件定义了 Agent 的行为，包括：
   * - 系统提示
   * - 可用工具
   * - 技能配置
   *
   * @param profile - 要应用的配置文件
   * @param context - 系统提示生成的可选上下文
   */
  useProfile(profile: ResolvedAgentProfile, context?: PreparedSystemPromptContext): void {
    const systemPrompt = profile.systemPrompt({
      osEnv: this.kaos.osEnv,
      cwd: this.config.cwd,
      skills: this.skills?.registry,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
    });
    this.config.update({ profileName: profile.name, systemPrompt });
    this.tools.setActiveTools(profile.tools);
  }

  /**
   * 从之前的会话恢复 Agent。
   *
   * 此方法会：
   * 1. 重放 Agent 记录（对话历史）
   * 2. 恢复后台任务
   * 3. 加载定时任务
   * 4. 完成上下文和轮次状态
   *
   * @param options - 重放选项
   * @returns 如有问题发生则返回警告消息
   */
  async resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }> {
    const result = await this.records.replay(options);
    try {
      this.replayBuilder.postRestoring = true;
      this.goal.normalizeAfterReplay();
      await this.background.loadFromDisk();
      await this.background.reconcile();
      await this.cron?.loadFromDisk();
      this.context.finishResume();
      this.turn.finishResume();
    } finally {
      this.replayBuilder.postRestoring = false;
    }
    return result;
  }

  /**
   * 获取此 Agent 暴露的 RPC 方法。
   *
   * 这些方法可被宿主（TUI、服务器等）调用来控制 Agent。
   * 每个方法处理特定操作，如发送提示、取消、更改设置等。
   *
   * @returns 包含所有可用 RPC 方法的对象
   */
  get rpcMethods(): PromisableMethods<AgentAPI> {
    return {
      // 用用户输入提示 Agent
      prompt: (payload) => {
        this.turn.prompt(payload.input);
      },
      // 引导 Agent（在不启动新轮次的情况下提供额外上下文）
      steer: (payload) => {
        this.telemetry.track('input_steer', { parts: payload.input.length });
        this.turn.steer(payload.input);
      },
      // 取消当前轮次
      cancel: (payload) => {
        if (this.turn.hasActiveTurn) {
          this.telemetry.track('cancel', { from: 'streaming' });
        }
        this.turn.cancel(payload.turnId);
      },
      // 撤销对话历史
      undoHistory: (payload) => {
        this.context.undo(payload.count);
      },
      // 切换思考模式
      setThinking: (payload) => {
        const wasEnabled = this.config.thinkingLevel !== 'off';
        this.config.update({ thinkingLevel: payload.level });
        const enabled = this.config.thinkingLevel !== 'off';
        if (enabled !== wasEnabled) {
          this.telemetry.track('thinking_toggle', { enabled });
        }
      },
      // 设置权限模式（ask、auto、yolo）
      setPermission: (payload) => {
        const wasYolo = this.permission.mode === 'yolo';
        const wasAuto = this.permission.mode === 'auto';
        this.permission.setMode(payload.mode);
        const enabled = this.permission.mode === 'yolo';
        if (enabled !== wasYolo) {
          this.telemetry.track('yolo_toggle', { enabled });
        }
        const afkEnabled = this.permission.mode === 'auto';
        if (afkEnabled !== wasAuto) {
          this.telemetry.track('afk_toggle', { enabled: afkEnabled });
        }
      },
      // 更换 AI 模型
      setModel: (payload) => {
        // 在记录之前验证别名是否可解析，以便恢复/运行时
        // 调用者对缺失的别名快速失败，而不是延迟到下一次提示。
        const resolved = this.modelProvider?.resolveProviderConfig(payload.model);
        if (this.config.modelAlias !== payload.model) {
          this.config.update({ modelAlias: payload.model });
          this.telemetry.track('model_switch', { model: payload.model });
        }
        return {
          model: payload.model,
          providerName: resolved?.providerName,
        };
      },
      // 获取当前模型
      getModel: () => {
        return this.config.modelAlias ?? '';
      },
      // 进入计划模式
      enterPlan: async () => {
        await this.planMode.enter();
      },
      // 取消计划模式
      cancelPlan: (payload) => {
        this.planMode.cancel(payload.id);
      },
      // 清除计划
      clearPlan: () => this.planMode.clear(),
      // 进入群体模式（多 Agent 协调）
      enterSwarm: (payload) => {
        this.swarmMode.enter(payload.trigger);
      },
      // 退出群体模式
      exitSwarm: () => {
        this.swarmMode.exit();
      },
      // 检查群体模式是否激活
      getSwarmMode: () => {
        return this.swarmMode.isActive;
      },
      // 启动完整上下文压缩
      beginCompaction: (payload) => {
        this.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
      },
      // 取消压缩
      cancelCompaction: () => {
        if (this.fullCompaction.isCompacting) {
          this.telemetry.track('cancel', { from: 'compacting' });
        }
        this.fullCompaction.cancel();
      },
      // 注册用户自定义工具
      registerTool: (payload) => {
        this.tools.registerUserTool(payload);
      },
      // 注销用户自定义工具
      unregisterTool: (payload) => {
        this.tools.unregisterUserTool(payload.name);
      },
      // 设置当前会话的活跃工具
      setActiveTools: (payload) => {
        this.tools.setActiveTools(payload.names);
      },
      // 停止后台任务
      stopBackground: (payload) => {
        void this.background.stop(payload.taskId, payload.reason);
      },
      // 清除对话上下文
      clearContext: () => {
        this.context.clear();
      },
      // 激活技能
      activateSkill: (payload) => {
        if (this.skills === null) {
          throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
        }
        this.skills.activate(payload);
      },
      // 启动 BTW（顺便一提）子 Agent
      startBtw: () => this.subagentHost!.startBtw(),
      // 目标管理
      createGoal: (payload) => this.goal.createGoal(payload),
      getGoal: () => this.goal.getGoal(),
      pauseGoal: () => this.goal.pauseGoal(),
      resumeGoal: () => this.goal.resumeGoal(),
      cancelGoal: () => this.goal.cancelGoal(),
      // 获取后台任务输出
      getBackgroundOutput: (payload) => this.background.readOutput(payload.taskId, payload.tail),
      // 获取当前状态
      getContext: () => this.context.data(),
      getConfig: () => this.config.data(),
      getPermission: () => this.permission.data(),
      getPlan: () => this.planMode.data(),
      getUsage: () => this.usage.data(),
      getTools: () => this.tools.data(),
      getBackground: (payload) => this.background.list(payload.activeOnly ?? false, payload.limit),
    };
  }

  /**
   * 向宿主（TUI、服务器等）发送事件。
   * 事件用于通知宿主状态变更、错误等。
   *
   * @param event - 要发送的事件
   */
  emitEvent(event: AgentEvent): void {
    // 在重放（从持久化恢复）期间不发送事件
    if (this.records.restoring) return;
    void this.rpc?.emitEvent?.(event);
  }

  /**
   * 发送包含当前 Agent 状态的状态更新事件。
   * 包括上下文使用量、模型信息和模式标志。
   */
  emitStatusUpdated(): void {
    // 在重放期间或未配置模型时不发送
    if (this.records.restoring) return;
    if (!this.config.hasModel) return;

    const contextTokens = this.context.tokenCount;
    const maxContextTokens = this.config.modelCapabilities.max_context_tokens;
    const contextUsage =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    const usage: UsageStatus | undefined = this.usage.status();
    const model = this.config.model;

    this.emitEvent({
      type: 'agent.status.updated',
      model,
      contextTokens,
      maxContextTokens,
      contextUsage,
      planMode: this.planMode.isActive,
      swarmMode: this.swarmMode.isActive,
      permission: this.permission.mode,
      usage,
    });
  }

  /**
   * 处理并发送记录写入错误。
   * 记录错误并向宿主发送错误事件。
   *
   * @param error - 发生的错误
   * @param record - 可选的写入失败的记录
   */
  private emitRecordsWriteError(error: unknown, record?: AgentRecord | undefined): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('wire record persist failed', {
      agentHomedir: this.homedir,
      recordType: record?.type,
      error,
    });
    this.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.RECORDS_WRITE_FAILED,
        `Failed to write agent records: ${message}`,
        {
          details: { recordType: record?.type },
        },
      ),
    });
  }
}

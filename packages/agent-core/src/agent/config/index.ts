/**
 * ConfigState - Agent 配置状态管理器
 *
 * 管理 Agent 的运行时配置，包括：
 * - 当前工作目录
 * - 模型和 Provider 设置
 * - 思考模式级别
 * - 系统提示词
 * - Profile 名称
 *
 * 此类的职责：
 * 1. 维护配置状态
 * 2. 将配置变更记录到 Agent 记录中
 * 3. 解析 Provider 和模型能力
 * 4. 应用环境相关参数（temperature、top_p 等）
 */

import {
  createProvider,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type ModelCapability,
  type ProviderConfig,
} from '@moonshot-ai/kosong';

import { applyKimiEnvSamplingParams, applyKimiEnvThinkingKeep } from '#/config/kimi-env-params';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '../../errors';
import type { AgentConfigData, AgentConfigUpdateData } from './types';
import { resolveThinkingEffort, type ThinkingEffort } from './thinking';
import type { ResolvedRuntimeProvider } from '../../session/provider-manager';

export * from './types';
export { resolveThinkingEffort, type ThinkingEffort } from './thinking';

/**
 * ConfigState - 管理 Agent 运行时配置
 *
 * 维护 Agent 的当前配置状态，提供更新和查询配置值的方法。职责包括：
 * - 工作目录管理
 * - 模型和 Provider 解析
 * - 思考模式配置
 * - 系统提示词管理
 *
 * 配置变更会自动记录到 Agent 记录中，用于持久化和回放。
 */
export class ConfigState {
  /** 当前工作目录 */
  private _cwd: string;
  /** 当前模型别名（如 'kimi-k2'、'gpt-4'） */
  private _modelAlias: string | undefined;
  /** 当前 Profile 名称（如 'coder'、'explore'） */
  private _profileName: string | undefined;
  /** 当前思考力度级别 */
  private _thinkingLevel: ThinkingEffort = 'off';
  /** 当前系统提示词 */
  private _systemPrompt: string = '';

  /**
   * 创建新的 ConfigState 实例。
   *
   * @param agent - 此配置所属的 Agent 实例
   */
  constructor(protected readonly agent: Agent) {
    this._cwd = agent.kaos.getcwd();
    this._modelAlias = agent.modelProvider?.defaultModel;
  }

  /**
   * 更新配置值。
   *
   * 此方法会：
   * 1. 将变更记录到 Agent 记录中
   * 2. 通知回放构建器
   * 3. 更新内部状态
   * 4. 根据需要重新初始化工具
   * 5. 发出状态更新事件
   *
   * @param changed - 包含变更配置值的对象
   */
  update(changed: AgentConfigUpdateData): void {
    // 无变更则跳过
    if (Object.keys(changed).length === 0) return;

    // 将配置变更记录到记录中
    this.agent.records.logRecord({
      type: 'config.update',
      ...changed,
    });
    this.agent.replayBuilder.push({
      type: 'config_updated',
      config: changed,
    });

    // 工作目录有变更则更新
    if (changed.cwd) {
      this._cwd = changed.cwd;
      void this.agent.kaos.chdir(changed.cwd);
    }

    // 模型别名有变更则更新
    if (changed.modelAlias) {
      this._modelAlias = changed.modelAlias;
    }

    // Profile 名称有变更则更新
    if (changed.profileName) {
      this._profileName = changed.profileName;
    }

    // 思考级别有变更则更新
    if (changed.thinkingLevel !== undefined) {
      this._thinkingLevel = resolveThinkingEffort(
        changed.thinkingLevel,
        this.agent.kimiConfig?.thinking,
      );
    }

    // 系统提示词有变更则更新
    if (changed.systemPrompt !== undefined) {
      this._systemPrompt = changed.systemPrompt;
    }

    // Provider 或工作目录有变更则重新初始化工具
    if (this.hasProvider && (changed.cwd !== undefined || changed.modelAlias)) {
      this.agent.tools.initializeBuiltinTools();
    }

    // 通知宿主状态变更
    this.agent.emitStatusUpdated();
  }

  /**
   * 获取当前配置数据。
   *
   * @returns 当前配置快照
   */
  data(): AgentConfigData {
    const resolved = this.tryResolvedProviderConfig();
    return {
      cwd: this.cwd,
      provider: resolved?.provider,
      modelAlias: this._modelAlias,
      modelCapabilities: resolved?.modelCapabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
    };
  }

  /**
   * 获取当前工作目录。
   */
  get cwd(): string {
    return this._cwd;
  }

  /**
   * 检查是否已配置模型。
   */
  get hasModel(): boolean {
    return this._modelAlias !== undefined;
  }

  /**
   * 检查是否已配置并解析 Provider。
   */
  get hasProvider(): boolean {
    return this.tryResolvedProviderConfig() !== undefined;
  }

  /**
   * 获取当前 Provider 配置。
   * 若未配置 Provider 则抛出异常。
   *
   * @throws {KimiError} 若 Provider 未配置
   */
  get providerConfig(): ProviderConfig {
    const provider = this.resolvedProviderConfig?.provider;
    if (provider === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Provider not set');
    }
    return provider;
  }

  /**
   * 获取当前 ChatProvider，已应用所有请求级配置。
   *
   * 此 getter 会应用：
   * - 思考模式配置
   * - 采样参数（temperature、top_p）
   * - thinking.keep 设置
   *
   * @returns 已配置的 ChatProvider 实例
   */
  get provider(): ChatProvider {
    // 所有 Provider 级别的请求配置在此处应用，使得通过 config.provider 构建的
    // 每个请求（主循环和全历史压缩）都会携带这些配置：
    //   - withThinking: 在压缩期间保留思考（#464）
    //   - 采样参数: KIMI_MODEL_TEMPERATURE / KIMI_MODEL_TOP_P
    //   - thinking.keep: KIMI_MODEL_THINKING_KEEP（仅在思考开启时）
    const provider = createProvider(this.providerConfig).withThinking(this.thinkingLevel);
    return applyKimiEnvThinkingKeep(applyKimiEnvSamplingParams(provider), this.thinkingLevel);
  }

  /**
   * 获取当前模型名称。
   * 若未配置模型则抛出异常。
   *
   * @throws {KimiError} 若模型未配置
   */
  get model(): string {
    if (this._modelAlias === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return this._modelAlias;
  }

  /**
   * 获取当前模型别名（可能为 undefined）。
   */
  get modelAlias(): string | undefined {
    return this._modelAlias;
  }

  /**
   * 获取当前思考力度级别。
   *
   * 对于始终思考模型，会自动将 'off' 钳制为 'on'。
   */
  get thinkingLevel(): ThinkingEffort {
    // 始终思考模型不能在思考禁用状态下运行。在 getter 中钳制（而非在 update() 中）
    // 可保持请求构建器、状态事件和子 Agent 继承的一致性，并在后续切换到
    // 始终思考别名时重新应用。
    if (this._thinkingLevel === 'off' && this.alwaysThinkingModel) {
      return resolveThinkingEffort('on', this.agent.kimiConfig?.thinking);
    }
    return this._thinkingLevel;
  }

  /**
   * 检查当前模型是否为始终思考模型。
   */
  private get alwaysThinkingModel(): boolean {
    return this.tryResolvedProviderConfig()?.alwaysThinking === true;
  }

  /**
   * 获取当前 Profile 名称。
   */
  get profileName(): string | undefined {
    return this._profileName;
  }

  /**
   * 获取当前系统提示词。
   */
  get systemPrompt(): string {
    return this._systemPrompt;
  }

  /**
   * 获取当前模型能力。
   * 若模型未配置则返回 UNKNOWN_CAPABILITY。
   */
  get modelCapabilities(): ModelCapability {
    return this.tryResolvedProviderConfig()?.modelCapabilities ?? UNKNOWN_CAPABILITY;
  }

  /**
   * 获取当前模型的最大输出大小。
   * 若未配置则返回 undefined。
   */
  get maxOutputSize(): number | undefined {
    return this.tryResolvedProviderConfig()?.maxOutputSize;
  }

  /**
   * 获取当前模型的已解析 Provider 配置。
   * 若模型未配置则返回 undefined。
   */
  private get resolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    if (this._modelAlias === undefined) return undefined;
    return this.agent.modelProvider?.resolveProviderConfig(this._modelAlias);
  }

  /**
   * 尝试获取已解析的 Provider 配置。
   * 若模型未配置或解析失败则返回 undefined。
   */
  private tryResolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    try {
      return this.resolvedProviderConfig;
    } catch {
      return undefined;
    }
  }
}

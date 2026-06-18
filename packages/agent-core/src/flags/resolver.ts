import { parseBooleanEnv } from '#/config/resolve';

import { FLAG_DEFINITIONS, type FlagId } from './registry';
import type {
  ExperimentalFeatureState,
  ExperimentalFlagConfig,
  FlagDefinitionInput,
} from './types';

/** 主开关：当为真值时，强制所有标志开启（最高优先级）。 */
export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

/**
 * 纯同步标志解析器。状态完全来自（env, registry），不做任何缓存：
 * 每次调用都实时读取 env，因此单个共享实例始终反映当前的进程环境变量。
 * 默认使用 process.env + FLAG_DEFINITIONS；测试可以注入自定义 env / defs。
 *
 * 优先级（最高优先级获胜）：
 *   L1 主开关 KIMI_CODE_EXPERIMENTAL_FLAG → 所有标志开启
 *   L2 每个功能的 def.env（parseBooleanEnv，可能强制开启或关闭）
 *   L3 config.toml [experimental] 每个功能的覆盖
 *   L4 注册表默认值
 */
export class FlagResolver {
  private readonly byId: ReadonlyMap<string, FlagDefinitionInput>;

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly definitions: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS,
    private configOverrides: ExperimentalFlagConfig = {},
  ) {
    this.byId = new Map(definitions.map((def) => [def.id, def]));
  }

  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void {
    this.configOverrides = overrides ?? {};
  }

  enabled(id: FlagId): boolean {
    return this.explain(id)?.enabled ?? false;
  }

  explain(id: FlagId): ExperimentalFeatureState | undefined {
    const def = this.byId.get(id);
    if (def === undefined) return undefined;
    const configValue = this.configOverrides[def.id as FlagId];
    if (parseBooleanEnv(this.env[MASTER_ENV]) === true) {
      return this.state(def, true, 'master-env', configValue);
    }
    const override = parseBooleanEnv(this.env[def.env]); // L2 per-feature
    if (override !== undefined) return this.state(def, override, 'env', configValue);
    if (configValue !== undefined) return this.state(def, configValue, 'config', configValue);
    return this.state(def, def.default, 'default', undefined);
  }

  snapshot(): Record<string, boolean> {
    return Object.fromEntries(
      this.definitions.map((def) => [def.id, this.enabled(def.id as FlagId)]),
    );
  }

  enabledIds(): readonly FlagId[] {
    return this.definitions
      .filter((def) => this.enabled(def.id as FlagId))
      .map((def) => def.id as FlagId);
  }

  explainAll(): readonly ExperimentalFeatureState[] {
    return this.definitions
      .map((def) => this.explain(def.id as FlagId))
      .filter((state): state is ExperimentalFeatureState => state !== undefined);
  }

  private state(
    def: FlagDefinitionInput,
    enabled: boolean,
    source: ExperimentalFeatureState['source'],
    configValue: boolean | undefined,
  ): ExperimentalFeatureState {
    return {
      id: def.id as FlagId,
      title: def.title,
      description: def.description,
      surface: def.surface,
      env: def.env,
      defaultEnabled: def.default,
      enabled,
      source,
      configValue,
    };
  }
}

/**
 * 仅需要进程全局 env 行为的调用方的兼容性访问器。
 * 属于 KimiCore/Session/Agent 的运行时代码应使用该所有者上的作用域解析器。
 */
export const flags = new FlagResolver();

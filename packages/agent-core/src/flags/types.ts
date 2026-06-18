import type { FlagId } from './registry';

/** 消费标志的层——仅用于文档/分组，不参与解析。 */
export type FlagSurface = 'core' | 'tui' | 'both';

/** 注册表条目的形状（id 为宽松字符串，以便 `as const satisfies` 可以验证它）。 */
export interface FlagDefinitionInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** 完整的环境变量名称，如 `KIMI_CODE_EXPERIMENTAL_MY_FEATURE`。由解析器直接读取。 */
  readonly env: string;
  readonly default: boolean;
  readonly surface: FlagSurface;
}

/** FlagId 类型化的视图，供消费者按字面量 id 获取定义。 */
export type FlagDefinition = FlagDefinitionInput & { readonly id: FlagId };

/** 每个实验性标志的已解析启用状态（标志 id → 启用）；用于 SDK 快照。 */
export type ExperimentalFlagMap = Record<string, boolean>;

/** 实验性标志的用户配置覆盖（标志 id → 启用）。 */
export type ExperimentalFlagConfig = Partial<Record<FlagId, boolean>>;

export type ExperimentalFlagSource = 'master-env' | 'env' | 'config' | 'default';

export interface ExperimentalFeatureState {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly surface: FlagSurface;
  readonly env: string;
  readonly defaultEnabled: boolean;
  readonly enabled: boolean;
  readonly source: ExperimentalFlagSource;
  readonly configValue?: boolean;
}

export interface ExperimentalFlagResolver {
  enabled(id: FlagId): boolean;
  snapshot(): ExperimentalFlagMap;
  enabledIds(): readonly FlagId[];
  explain(id: FlagId): ExperimentalFeatureState | undefined;
  explainAll(): readonly ExperimentalFeatureState[];
  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void;
}

import { ErrorCodes, KimiError } from '#/errors';
import { parseBooleanEnv } from './resolve';
import {
  validateConfig,
  type KimiConfig,
  type ModelAlias,
  type ProviderConfig,
  type ProviderType,
  type ThinkingConfig,
} from './schema';

/** 环境驱动的合成 provider / 模型别名的保留键。 */
export const ENV_MODEL_PROVIDER_KEY = '__kimi_env__';
export const ENV_MODEL_ALIAS_KEY = '__kimi_env_model__';

const ALLOWED_TYPES: readonly ProviderType[] = ['kimi', 'anthropic', 'openai'];

const DEFAULT_BASE_URL: Partial<Record<ProviderType, string>> = {
  kimi: 'https://api.moonshot.ai/v1',
  openai: 'https://api.openai.com/v1',
  // anthropic: 省略 -> 让 Anthropic SDK 选择其默认值
};

/** 未设置 KIMI_MODEL_MAX_CONTEXT_SIZE 时使用的默认上下文窗口大小（256K）。 */
const DEFAULT_MAX_CONTEXT_SIZE = 262144;

/** 未设置 KIMI_MODEL_CAPABILITIES 时的默认能力（kimi 模型同时支持两者）。 */
const DEFAULT_CAPABILITIES = ['image_in', 'thinking'];

type Env = Readonly<Record<string, string | undefined>>;

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

function fail(message: string): never {
  throw new KimiError(ErrorCodes.CONFIG_INVALID, message);
}

function parsePositiveInt(raw: string, varName: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    fail(`${varName} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

function parseProviderType(raw: string | undefined): ProviderType {
  if (raw === undefined) return 'kimi';
  const normalized = raw.toLowerCase() as ProviderType;
  if (!ALLOWED_TYPES.includes(normalized)) {
    fail(
      `KIMI_MODEL_PROVIDER_TYPE must be one of ${ALLOWED_TYPES.join(', ')}, got "${raw}".`,
    );
  }
  return normalized;
}

function parseCapabilities(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const caps = raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  return caps.length === 0 ? undefined : caps;
}

// `parseBooleanEnv` 对无法识别的输入返回 undefined。对于非空但无法解析的值
//（例如拼写错误如 `flase`），将其视为配置错误以便快速失败，与其他
// KIMI_MODEL_* 值的行为保持一致，而不是静默保留 config.toml 中的现有值。
function parseBooleanVar(raw: string | undefined, varName: string): boolean | undefined {
  const value = trimmed(raw);
  if (value === undefined) return undefined;
  const parsed = parseBooleanEnv(value);
  if (parsed === undefined) {
    fail(`${varName} must be a boolean (true/false/1/0/yes/no/on/off), got "${raw}".`);
  }
  return parsed;
}

/**
 * 当设置了 `KIMI_MODEL_NAME` 时，从 `KIMI_MODEL_*` 环境变量合成一个 provider
 * + 一个模型别名，并将其设为默认模型。当触发变量不存在时，原样返回配置。
 *
 * 重要：合成的 provider/model/default_model 仅存在于内存中的运行时配置，
 * 绝不能序列化回 config.toml。两层机制强制执行此规则：写路径通过
 * `readConfigFile` 读取原始配置，`writeConfigFile` 通过 `stripEnvModelConfig`
 * 剥离保留条目，作为防止 patch 往返（getConfig -> setConfig）的最终保障。
 */
export function applyEnvModelConfig(config: KimiConfig, env: Env = process.env): KimiConfig {
  const model = trimmed(env['KIMI_MODEL_NAME']);
  if (model === undefined) return config;

  const apiKey = trimmed(env['KIMI_MODEL_API_KEY']);
  if (apiKey === undefined) {
    fail('KIMI_MODEL_NAME is set but KIMI_MODEL_API_KEY is missing.');
  }

  const maxContextRaw = trimmed(env['KIMI_MODEL_MAX_CONTEXT_SIZE']);
  const maxContextSize =
    maxContextRaw === undefined
      ? DEFAULT_MAX_CONTEXT_SIZE
      : parsePositiveInt(maxContextRaw, 'KIMI_MODEL_MAX_CONTEXT_SIZE');

  const type = parseProviderType(trimmed(env['KIMI_MODEL_PROVIDER_TYPE']));
  const baseUrl = trimmed(env['KIMI_MODEL_BASE_URL']) ?? DEFAULT_BASE_URL[type];

  const provider: ProviderConfig = {
    type,
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };

  const maxOutputRaw = trimmed(env['KIMI_MODEL_MAX_OUTPUT_SIZE']);
  const maxOutputSize =
    maxOutputRaw !== undefined
      ? parsePositiveInt(maxOutputRaw, 'KIMI_MODEL_MAX_OUTPUT_SIZE')
      : undefined;
  const capabilities = parseCapabilities(env['KIMI_MODEL_CAPABILITIES']) ?? DEFAULT_CAPABILITIES;
  const displayName = trimmed(env['KIMI_MODEL_DISPLAY_NAME']);
  const reasoningKey = trimmed(env['KIMI_MODEL_REASONING_KEY']);
  const adaptiveThinking = parseBooleanVar(
    env['KIMI_MODEL_ADAPTIVE_THINKING'],
    'KIMI_MODEL_ADAPTIVE_THINKING',
  );

  const alias: ModelAlias = {
    provider: ENV_MODEL_PROVIDER_KEY,
    model,
    maxContextSize,
    capabilities,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(maxOutputSize !== undefined ? { maxOutputSize } : {}),
    ...(reasoningKey !== undefined ? { reasoningKey } : {}),
    ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
  };

  const thinkingMode = trimmed(env['KIMI_MODEL_THINKING_MODE']);
  const thinkingEffort = trimmed(env['KIMI_MODEL_THINKING_EFFORT']);
  const thinking: ThinkingConfig | undefined =
    thinkingMode !== undefined || thinkingEffort !== undefined
      ? {
          ...config.thinking,
          // 类型转换：thinkingMode 是原始字符串，传递给 validateConfig
          // 进行枚举验证（auto/on/off）。此转换避免 TS 编译错误
          // 而不会跳过运行时验证。
          ...(thinkingMode !== undefined ? { mode: thinkingMode as ThinkingConfig['mode'] } : {}),
          ...(thinkingEffort !== undefined ? { effort: thinkingEffort } : {}),
        }
      : config.thinking;
  const defaultThinking = parseBooleanVar(
    env['KIMI_MODEL_DEFAULT_THINKING'],
    'KIMI_MODEL_DEFAULT_THINKING',
  );

  const merged: KimiConfig = {
    ...config,
    providers: { ...config.providers, [ENV_MODEL_PROVIDER_KEY]: provider },
    models: { ...config.models, [ENV_MODEL_ALIAS_KEY]: alias },
    defaultModel: ENV_MODEL_ALIAS_KEY,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(defaultThinking !== undefined ? { defaultThinking } : {}),
  };

  // 重新验证，使合成条目遵循相同的 schema 约束
  //（例如 thinking.mode 必须为 auto/on/off）。`validateConfig` 在违反时抛出
  // KimiError(CONFIG_INVALID)，与上述显式检查一致。
  return validateConfig(merged);
}

/**
 * 在配置持久化到磁盘之前，移除环境合成的 provider/model。
 * {@link applyEnvModelConfig} 的镜像操作：后者将保留条目注入内存运行时配置；
 * 此函数保证它们绝不会到达 config.toml——包括通过 `getConfig` -> `setConfig`
 * 的 patch 往返，否则运行时配置（携带 env provider 及其 shell API key）
 * 会被合并回去并写入磁盘。每个 env 注入的顶层字段（default_model、thinking、
 * default_thinking）都从 `config.raw` 恢复到其磁盘值，而不是被擦除，
 * 因此 config.toml 中已有的真实值可以在往返中存活。
 */
export function stripEnvModelConfig(config: KimiConfig): KimiConfig {
  const hasProvider = ENV_MODEL_PROVIDER_KEY in config.providers;
  const hasModel = config.models !== undefined && ENV_MODEL_ALIAS_KEY in config.models;
  const defaultIsEnv = config.defaultModel === ENV_MODEL_ALIAS_KEY;
  if (!hasProvider && !hasModel && !defaultIsEnv) return config;

  const providers = { ...config.providers };
  delete providers[ENV_MODEL_PROVIDER_KEY];

  let models = config.models;
  if (models !== undefined && ENV_MODEL_ALIAS_KEY in models) {
    models = { ...models };
    delete models[ENV_MODEL_ALIAS_KEY];
  }

  return {
    ...config,
    providers,
    ...(models !== undefined ? { models } : {}),
    // 从 raw 恢复 env 注入的顶层字段，而不是持久化 shell 覆盖值：
    // env 的 default_model（当它指向 env 别名时），以及 env 的 thinking /
    // default_thinking。到达此处意味着 env-model 模式处于活动状态
    //（合成的 provider/model 存在），因此这些可能是 env 值；
    // 未设置的 raw 字段恢复为 undefined（即移除它）。
    ...(defaultIsEnv ? { defaultModel: rawDefaultModel(config) } : {}),
    thinking: rawThinking(config),
    defaultThinking: rawDefaultThinking(config),
  };
}

function rawDefaultModel(config: KimiConfig): string | undefined {
  const raw = config.raw?.['default_model'];
  return typeof raw === 'string' ? raw : undefined;
}

function rawDefaultThinking(config: KimiConfig): boolean | undefined {
  const raw = config.raw?.['default_thinking'];
  return typeof raw === 'boolean' ? raw : undefined;
}

function rawThinking(config: KimiConfig): ThinkingConfig | undefined {
  const raw = config.raw?.['thinking'];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as ThinkingConfig)
    : undefined;
}

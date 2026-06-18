import type { ModelCapability } from './capability';
import type { ProviderType } from './providers';

/**
 * models.dev 风格的目录：一个公开的 provider/model 元数据映射。调用方
 * 消费此结构的快照，以填充 provider + model 配置，无需手动编写上下文窗口
 * 或能力信息。
 */
export interface CatalogModelEntry {
  readonly id?: string;
  readonly name?: string;
  readonly family?: string;
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly tool_call?: boolean;
  readonly reasoning?: boolean;
  readonly interleaved?: boolean | { readonly field?: string };
  readonly modalities?: {
    readonly input?: readonly string[];
    readonly output?: readonly string[];
  };
}

export interface CatalogProviderEntry {
  readonly id?: string;
  readonly name?: string;
  /** Provider 的基础 URL；可能为空（某些 SDK 会硬编码）。 */
  readonly api?: string;
  /** 携带凭据的环境变量名——由调用方作为提示展示。 */
  readonly env?: readonly string[];
  /** models.dev SDK 包标识符；当 `type` 缺失时用于推断线路类型。 */
  readonly npm?: string;
  /** 显式线路类型扩展；缺失时从 `npm`/`id` 推断。 */
  readonly type?: string;
  readonly models?: Record<string, CatalogModelEntry>;
}

/** 顶层目录：`{ [providerId]: ProviderEntry }`（如 models.dev/api.json）。 */
export type Catalog = Record<string, CatalogProviderEntry>;

/** 标准化后的目录模型：标识信息加上其 {@link ModelCapability}。 */
export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly maxOutputSize?: number;
  readonly reasoningKey?: string;
  readonly capability: ModelCapability;
}

const KNOWN_WIRE_TYPES = [
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
] as const satisfies readonly ProviderType[];

function isWireType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (KNOWN_WIRE_TYPES as readonly string[]).includes(value);
}

function hasEmbeddingMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  return lower.includes('embedding') || /(?:^|[-_/])embed(?:$|[-_/])/.test(lower);
}

function isUsableChatModel(model: CatalogModelEntry): boolean {
  const outputModalities = model.modalities?.output;
  if (outputModalities !== undefined && !outputModalities.includes('text')) return false;
  return (
    !hasEmbeddingMarker(model.family) &&
    !hasEmbeddingMarker(model.id) &&
    !hasEmbeddingMarker(model.name)
  );
}

/**
 * 将目录中的 provider 条目解析为支持的线路类型。优先使用显式 `type`，
 * 否则从 `npm`/`id` 推断。未知的 provider 返回 `undefined`，
 * 以便调用方可以跳过它们，而不是写入无效配置。
 */
export function inferWireType(entry: CatalogProviderEntry): ProviderType | undefined {
  if (isWireType(entry.type)) return entry.type;
  const npm = (entry.npm ?? '').toLowerCase();
  const id = (entry.id ?? '').toLowerCase();
  if (npm.includes('anthropic') || id.includes('anthropic') || id.includes('claude')) {
    return 'anthropic';
  }
  if (id.includes('vertex')) return 'vertexai';
  if (npm.includes('google') || id.includes('google') || id.includes('gemini')) {
    return 'google-genai';
  }
  if (npm.includes('openai') || id.includes('openai')) return 'openai';
  return undefined;
}

/**
 * 解析目录 provider 要存储的基础 URL，将目录中的 `api` 适配为
 * 线路对应 SDK 的约定。
 *
 * models.dev 的 `api` URL 是为 `npm` 中指定的 SDK 编写的（如
 * `@ai-sdk/anthropic`），其基础 URL 已包含 `/v1` 版本段。
 * 我们将 `anthropic` 线路路由到官方 `@anthropic-ai/sdk`，后者会自行
 * 追加 `/v1/messages`——因此以 `/v1` 结尾的目录 `api` 会 POST 到
 * `/v1/v1/messages`（404）。对 anthropic 需要去掉末尾的 `/v1`。
 * OpenAI 系列 SDK 会在 `/v1` 基础上追加 `/chat/completions`，
 * 因此这些可直接通过。
 */
export function catalogBaseUrl(
  entry: CatalogProviderEntry,
  wire: ProviderType,
): string | undefined {
  const api = entry.api;
  if (typeof api !== 'string' || api.length === 0) return undefined;
  if (wire === 'anthropic') return api.replace(/\/v1\/?$/, '');
  return api;
}

/** 将一个目录模型条目标准化为 {@link CatalogModel}；跳过无效条目。 */
export function catalogModelToCapability(model: CatalogModelEntry): CatalogModel | undefined {
  if (typeof model.id !== 'string' || model.id.length === 0) return undefined;
  const context = model.limit?.context;
  if (typeof context !== 'number' || !Number.isInteger(context) || context <= 0) return undefined;
  if (!isUsableChatModel(model)) return undefined;
  const inputs = model.modalities?.input ?? [];
  const output = model.limit?.output;
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : undefined,
    maxOutputSize: typeof output === 'number' && output > 0 ? output : undefined,
    reasoningKey: catalogReasoningKey(model.interleaved),
    capability: {
      image_in: inputs.includes('image'),
      video_in: inputs.includes('video'),
      audio_in: inputs.includes('audio'),
      thinking: Boolean(model.reasoning),
      tool_use: model.tool_call ?? true,
      max_context_tokens: context,
    },
  };
}

function catalogReasoningKey(interleaved: CatalogModelEntry['interleaved']): string | undefined {
  // models.dev 允许 `interleaved: true` 表示"通用支持"——将其读取为
  // 默认的 `reasoning_content` 字段，这样没有显式字段名的 provider
  // （如某些 openai 兼容网关）仍可正常往返。
  if (interleaved === true) return 'reasoning_content';
  if (typeof interleaved !== 'object' || interleaved === null) return undefined;
  const field = interleaved.field?.trim();
  return field !== undefined && field.length > 0 ? field : undefined;
}

/** 从目录 provider 条目中提取有效的、标准化的模型列表。 */
export function catalogProviderModels(entry: CatalogProviderEntry): CatalogModel[] {
  const models = entry.models ?? {};
  return Object.values(models)
    .map((model) => catalogModelToCapability(model))
    .filter((model): model is CatalogModel => model !== undefined);
}

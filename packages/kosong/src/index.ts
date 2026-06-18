// 消息类型
export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from './message';
export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from './message';

// 提供者接口
export * from './provider';
export { createProvider, getModelCapability } from './providers';
export type { ProviderConfig, ProviderType } from './providers';
// Kimi 提供者：导出以便调用方可以将 `ChatProvider` 窄化为 Kimi
// 后端（instanceof）并应用 Kimi 特定的请求参数（生成
// kwargs、`thinking.keep` extra body）。
export { KimiChatProvider } from './providers/kimi';
export type { ExtraBody, GenerationKwargs, KimiOptions, ThinkingConfig } from './providers/kimi';

// 模型能力矩阵
export { UNKNOWN_CAPABILITY, isUnknownCapability } from './capability';
export type { ModelCapability } from './capability';

// 模型目录（models.dev 风格）元数据
export {
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
} from './catalog';
export type { Catalog, CatalogModel, CatalogModelEntry, CatalogProviderEntry } from './catalog';

// 核心函数
export { generate } from './generate';
export type { GenerateCallbacks, GenerateResult } from './generate';

// 工具线路协议 schema
export type { Tool } from './tool';

// Token 用量
export { addUsage, emptyUsage, grandTotal, inputTotal } from './usage';
export type { TokenUsage } from './usage';

// 错误
export {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isContextOverflowStatusError,
  isProviderRateLimitError,
  isRetryableGenerateError,
} from './errors';

/**
 * 具体的提供者适配器不在根 barrel 中导出，因为它们的 SDK 类型
 * 图会污染下游的声明文件。请从子路径导入：
 * `@moonshot-ai/kosong/providers/kimi`、
 * `@moonshot-ai/kosong/providers/openai-legacy` 等。
 */

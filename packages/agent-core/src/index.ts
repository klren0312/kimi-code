export * from './agent';
export * from './session';
export * from './rpc';
export * from './config';
export * from './flags';
export * from './session/export';
export * from './telemetry';
export * from './errors';
export * from './plugin';
export { buildReplay } from './agent/replay/build';
export {
  flushDiagnosticLogs,
  getRootLogger,
  log,
  redact,
  resolveGlobalLogPath,
} from './logging/logger';
export { resolveLoggingConfig } from './logging/resolve-config';
export type { ResolveLoggingInput } from './logging/resolve-config';
export { installGlobalProxyDispatcher } from './utils/proxy';

// LLM 通信日志
export {
  isLlmCommunicationLogEnabled,
  enableLlmCommunicationLog,
  triggerDeviceCodeAuth,
  triggerAuthComplete,
  triggerApprovalRequest,
  triggerApprovalResult,
  setApprovalResponseCallback,
  startLlmLogServer,
  stopLlmLogServer,
} from './logging/llm-communication';
export type { DeviceCodeInfo } from './logging/llm-communication';
export type {
  LogContext,
  LogEntry,
  LogLevel,
  LogPayload,
  Logger,
  LoggingConfig,
  RootLogger,
  SessionAttachInput,
  SessionLogHandle,
} from './logging/types';
export { USER_PROMPT_ORIGIN } from './agent/context';
export type {
  AgentContextData,
  ContextMessage,
  PromptOrigin,
  UserPromptOrigin,
} from './agent/context';
export type {
  AgentBackgroundTaskInfo,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ProcessBackgroundTaskInfo,
  QuestionBackgroundTaskInfo,
} from './agent/background';
export type { ToolServices } from './tools/support/services';
export { SingleModelProvider } from './session/provider-manager';
export type {
  BearerTokenProvider,
  ModelProvider,
  OAuthTokenProviderResolver,
  ResolvedRuntimeProvider,
} from './session/provider-manager';

// ─── Wire records（供 monorepo 内部消费者如 apps/vis 使用）────────────────
export type {
  AgentRecord,
  AgentRecordEvents,
  AgentRecordOf,
  AgentRecordPersistence,
} from './agent/records';
export { AGENT_WIRE_PROTOCOL_VERSION } from './agent/records';
export type { AgentConfigUpdateData } from './agent/config';
export type { CompactionBeginData, CompactionResult } from './agent/compaction';
export type {
  PermissionApprovalResultRecord,
  PermissionMode,
} from './agent/permission';
export type { UsageRecordScope } from './agent/usage';
export type { ToolStoreUpdate } from './tools/store';
export type {
  LoopRecordedEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopContentPartEvent,
  LoopToolCallEvent,
  LoopToolResultEvent,
} from './loop';
export type {
  ExecutableToolResult,
  ExecutableToolSuccessResult,
  ExecutableToolErrorResult,
} from './loop/types';

// ─── 依赖注入容器 ─────────────────────────────────────────────────────────
export * from './di';

// ─── 基础层 — Event<T> / Emitter<T> ───────────────────────────────────────
// 注意：顶层桶导出仅重新导出了 `Emitter`——新的 VSCode 风格 `Event<T>` 符号
// 与 `./rpc` 的 `Event`（agent-core 协议 Event 联合类型，通过上方的
// `export * from './rpc'` 导出）冲突。需要发射器 `Event<T>` 类型的调用方
// 应从显式子路径 `@moonshot-ai/agent-core/base/common/event` 导入
//（已在 `package.json` 的 `exports` 中声明）。这样既保持了现有顶层 `Event`
// 语义对 `services/src/event/event.ts` 等消费者的稳定性，又让新代码可以
// 无命名冲突地使用发射器类型。
export { Emitter } from './base/common/event';

// ─── 进程内服务（从 @moonshot-ai/services 合并而来）───────────────────────
// 重新导出 `IXxxService` 契约、默认 `XxxService` 实现、`toProtocol*` 转换器
// 和错误类。导入此桶会触发每个 `*Service.ts` 底部的 `registerSingleton(...)`
// 副作用，填充 `getSingletonServiceDescriptors()` 消费的 DI 注册表。
//
// 注意：`ApprovalRequest` / `ApprovalResponse` / `QuestionRequest` /
// `QuestionResult` 故意不在此处重新导出——它们是已通过 `./rpc`
//（`rpc/sdk-api.ts`）导出的规范协议形状，再次重新导出会导致冲突（TS2308）。
export * from './services';

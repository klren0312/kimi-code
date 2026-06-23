/**
 * 无状态 Agent 循环的公共入口点。
 *
 * 上层编排可以导入此模块；此模块不得导入宿主层实现。
 */

export type {
  AfterStepHook,
  AfterStepResult,
  BeforeStepResult,
  BeforeStepHook,
  LoopHooks,
  LoopAfterStepContext,
  LoopStepHookContext,
  LoopStepStopReason,
  LoopStoppedStepContext,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  StopReason,
  RecordStepUsageResult,
  ShouldContinueAfterStopHook,
  ShouldContinueAfterStopResult,
  LoopMessageBuilder,
  ExecutableTool,
  ToolExecution,
  ToolCall,
  ExecutableToolContext,
  ToolExecutionHookContext,
  ResolvedToolExecutionHookContext,
  PrepareToolExecutionHook,
  AuthorizeToolExecutionHook,
  PrepareToolExecutionResult,
  ExecutableToolResult,
  FinalizeToolResultContext,
  FinalizeToolResultHook,
  ToolUpdate,
  TurnResult,
} from './types';

export { ToolAccesses } from './tool-access';

export type {
  CreateLoopEventDispatcherInput,
  LoopContentPartEvent,
  LoopRecordedEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopStepRetryingEvent,
  LoopLiveOnlyEvent,
  LoopEvent,
  LoopInterruptReason,
  LoopLiveEventEmitter,
  LoopEventDispatcher,
  LoopTextDeltaEvent,
  LoopThinkingDeltaEvent,
  LoopToolCallDeltaEvent,
  LoopToolCallEvent,
  LoopToolProgressEvent,
  LoopToolResultEvent,
  LoopTurnInterruptedEvent,
} from './events';
export { createLoopEventDispatcher } from './events';

export type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LLMRequestLogFields,
  LLMStreamTiming,
  ToolCallDelta,
} from './llm';

export { runTurn } from './run-turn';
export type { RunTurnInput } from './run-turn';

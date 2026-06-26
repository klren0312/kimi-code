/**
 * 无状态 Agent 循环的公共契约。
 *
 * 此文件定义了将 Kosong 对话连接到工具执行、阶段钩子和轮次结果的窄接口。
 * 宿主层元数据、策略、归档限制和 UI 关注点保持在这些契约之外。
 *
 * 字段命名使用 camelCase，除非复用的 Kosong 类型另有规定。
 * 可选字段在 `exactOptionalPropertyTypes: true` 下故意使用 `?: T | undefined`。
 */

import type { ContentPart, Message, TokenUsage, Tool, ToolCall } from '@moonshot-ai/kosong';

import type { ToolInputDisplay } from '../tools/display';
import type { ToolAccesses } from './tool-access';
import type { LLM } from './llm';

export type { ToolCall };

export type LoopMessageBuilder = () => Message[] | Promise<Message[]>;

/**
 * 单个已完成模型步骤的停止原因。
 *
 * `tool_use` 是循环控制信号：循环执行请求的工具并继续下一个步骤。
 * 其他值对当前轮次是终止性的，除非宿主钩子明确要求循环继续。
 */
export type LoopStepStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'filtered'
  | 'paused'
  | 'unknown';

export type LoopTerminalStepStopReason = Exclude<LoopStepStopReason, 'tool_use'>;

/**
 * 可在正常 `TurnResult` 中返回的停止原因。
 *
 * `tool_use` 被故意排除，因为它不能作为已完成轮次的最终结果。
 * 错误和最大步数耗尽由抛出的错误表示，而非此联合类型。
 * 压缩是宿主级别的重试关注点，而非停止原因。
 */
export type LoopTurnStopReason = LoopTerminalStepStopReason | 'aborted';

/**
 * @deprecated 已废弃的总联合类型。步骤级模型响应用 `LoopStepStopReason`，
 * `TurnResult` 用 `LoopTurnStopReason`。
 */
export type StopReason = LoopStepStopReason | 'aborted';

export interface TurnResult {
  stopReason: LoopTurnStopReason;
  steps: number;
  usage: TokenUsage;
}

export type ExecutableToolOutput = string | ContentPart[];

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  /**
   * 内部循环控制提示。工具结果事件在持久化前剥离此字段；
   * 它仅告知当前轮次是否允许另一个模型步骤或同批次中后续的工具调用。
   */
  readonly stopTurn?: boolean | undefined;
  /**
   * 用于工具结果元数据的可选人类可读旁路通道，
   * 不应污染模型看到的数据流（例如 TaskOutput 的 "Task snapshot retrieved." 简报）。
   * 与 `output` 不同：渲染工具结果的调用方决定是否向用户展示此内容。
   */
  readonly message?: string | undefined;
  /**
   * True when the tool has already returned a partial result because it
   * truncated, paged, or otherwise dropped original output. Later generic
   * budgeting must not treat the visible output as complete source text.
   */
  readonly truncated?: boolean | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  /** 参见 {@link ExecutableToolSuccessResult.message}。 */
  readonly message?: string | undefined;
  /** 参见 {@link ExecutableToolSuccessResult.stopTurn}。 */
  readonly stopTurn?: boolean | undefined;
  /** See {@link ExecutableToolSuccessResult.truncated}. */
  readonly truncated?: boolean | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  text?: string | undefined;
  percent?: number | undefined;
  /** 当 `kind === 'custom'` 时的供应商定义事件标识符。 */
  customKind?: string | undefined;
  /** 与 `customKind` 配对的不透明载荷。 */
  customData?: unknown;
}

/**
 * 传递给工具实现的每次调用上下文。
 */
export interface ExecutableToolContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
  /**
   * Fired once when a foreground (non-background) process task is registered,
   * carrying its task id. Used by the `!` shell-command path so the TUI can
   * later detach (ctrl+b) that exact task. Background runs skip it.
   */
  readonly onForegroundTaskStart?: ((taskId: string) => void) | undefined;
}

export interface RunnableToolExecution {
  readonly isError?: false | undefined;
  readonly accesses?: ToolAccesses | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly description?: string;
  /**
   * 停止调度同一批次中后续的工具调用。仅用于
   * 成功执行会改变轮次生命周期状态的工具。
   */
  readonly stopBatchAfterThis?: boolean | undefined;
  readonly approvalRule: string;
  readonly matchesRule?: ((ruleArgs: string) => boolean) | undefined;
  readonly execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>;
}

export type ToolExecution = RunnableToolExecution | ExecutableToolErrorResult;

export interface ExecutableTool<Input = unknown> extends Tool {
  resolveExecution(input: Input): ToolExecution | Promise<ToolExecution>;
}

/**
 * 步骤钩子对齐到记录的阶段边界：`beforeStep` 在 `step.begin` 之前运行，
 * `afterStep` 在 `step.end` 之后运行。
 */

export interface LoopStepHookContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly llm: LLM;
}

export interface ToolExecutionHookContext extends LoopStepHookContext {
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface AuthorizeToolExecutionResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly syntheticResult?: ExecutableToolResult | undefined;
  readonly executionMetadata?: unknown;
}

export interface PrepareToolExecutionResult extends AuthorizeToolExecutionResult {
  readonly updatedArgs?: unknown;
}

export interface FinalizeToolResultContext extends ToolExecutionHookContext {
  readonly result: ExecutableToolResult;
}

export interface LoopAfterStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}

export interface LoopStoppedStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopTerminalStepStopReason;
}

export interface BeforeStepResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface AfterStepResult {
  readonly stopTurn?: boolean | undefined;
}

export interface RecordStepUsageResult {
  /**
   * 内部循环控制提示。宿主在记录用量后可以返回此值，
   * 当已完成的模型步骤达到了硬性运行时限制时。
   */
  readonly stopTurn?: boolean | undefined;
}

export interface ShouldContinueAfterStopResult {
  readonly continue: boolean;
}

export type BeforeStepHook = (ctx: LoopStepHookContext) => Promise<BeforeStepResult | undefined>;

export type AfterStepHook = (ctx: LoopAfterStepContext) => Promise<AfterStepResult | void>;

export type PrepareToolExecutionHook = (
  ctx: ToolExecutionHookContext,
) => Promise<PrepareToolExecutionResult | undefined>;

export type AuthorizeToolExecutionHook = (
  ctx: ResolvedToolExecutionHookContext,
) => Promise<AuthorizeToolExecutionResult | undefined>;

export type FinalizeToolResultHook = (
  ctx: FinalizeToolResultContext,
) => Promise<ExecutableToolResult | undefined>;

export type ShouldContinueAfterStopHook = (
  ctx: LoopStoppedStepContext,
) => Promise<ShouldContinueAfterStopResult | undefined>;

/**
 * 聚合所有被等待的阶段钩子。
 *
 * 钩子可以在确定性的转录点影响控制流。事件监听器观察输出，不能改变轮次行为。
 *
 * 工具钩子按提供者工具调用顺序在匹配的持久化事件记录之前串行运行，
 * 因此准备和终结决定在稳定的转录点上解析。
 */
export interface LoopHooks {
  beforeStep?: BeforeStepHook | undefined;
  afterStep?: AfterStepHook | undefined;
  prepareToolExecution?: PrepareToolExecutionHook | undefined;
  authorizeToolExecution?: AuthorizeToolExecutionHook | undefined;
  finalizeToolResult?: FinalizeToolResultHook | undefined;
  shouldContinueAfterStop?: ShouldContinueAfterStopHook | undefined;
}

/**
 * 单个已完成提供者响应的工具调用生命周期。
 *
 * 此模块将提供者顺序不变量集中在一个位置：
 *   - 在钩子或事件之前验证每个提供者工具调用
 *   - 按提供者顺序运行准备钩子并计算工具调用显示字段
 *   - 在执行开始前派发 `tool.call`
 *   - 并发执行资源访问不冲突的工具
 *   - 序列化资源访问冲突的工具
 *   - 按提供者顺序派发终端 `tool.result` 事件
 *
 * 这些阶段通过转录顺序和中止处理耦合，因此应一并审查。
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import type { Logger } from '#/logging/types';
import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '../tools/args-validator';
import { PathSecurityError } from '../tools/policies/path-access';

import { isUserCancellation } from '../utils/abort';
import { errorMessage, isAbortError } from './errors';
import type { LoopEventDispatcher, LoopToolCallEvent } from './events';
import type { LLM, LLMChatResponse } from './llm';
import { ToolAccesses } from './tool-access';
import { ToolScheduler, type ToolCallTask } from './tool-scheduler';
import type {
  AuthorizeToolExecutionResult,
  ExecutableTool,
  LoopHooks,
  ToolCall,
  PrepareToolExecutionResult,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from './types';

const GRACE_TIMEOUT_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';

const validators = new WeakMap<ExecutableTool, ToolArgsValidator>();

/**
 * 中止的工具调用的输出。当中止携带用户取消原因（用户按下了停止键）时，
 * 明确说明以便模型将其视为有意的中断，而非需要推理或重试的系统故障。
 * 其他中止保持中性措辞。
 */
function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}

export interface ToolCallStepContext {
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
}

interface ToolCallBatchContext extends ToolCallStepContext {
  readonly toolCalls: readonly ToolCall[];
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

type PrepareToolExecutionDecision =
  | { readonly kind: 'allowed'; readonly args: unknown; readonly metadata?: unknown }
  | { readonly kind: 'synthetic'; readonly args: unknown; readonly result: ExecutableToolResult }
  | { readonly kind: 'blocked'; readonly args: unknown; readonly output: string }
  | { readonly kind: 'hookFailed'; readonly args: unknown; readonly output: string };

interface PendingToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ExecutableToolResult;
  readonly stopTurn?: boolean | undefined;
}

interface PreparedToolCallTask {
  readonly task: ToolCallTask<PendingToolResult>;
  readonly stopBatchAfterThis?: boolean | undefined;
}

type ToolCallDisplayFields = Pick<LoopToolCallEvent, 'description' | 'display'>;

export interface ToolCallBatchResult {
  readonly stopTurn: boolean;
}

export async function runToolCallBatch(
  step: ToolCallStepContext,
  response: LLMChatResponse,
): Promise<ToolCallBatchResult> {
  if (response.toolCalls.length === 0) return { stopTurn: false };
  const batchStep: ToolCallBatchContext = { ...step, toolCalls: response.toolCalls };
  const calls = response.toolCalls.map((toolCall) => preflightToolCall(step.tools, toolCall));
  const scheduler = new ToolScheduler<PendingToolResult>();
  const pendingResults: Array<Promise<PendingToolResult>> = [];
  let stopTurn = false;

  try {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      const prepared = await prepareToolCall(batchStep, call);
      pendingResults.push(scheduler.add(prepared.task));

      if (prepared.stopBatchAfterThis === true) {
        stopTurn = true;
        for (const skippedCall of calls.slice(index + 1)) {
          const skippedTask = await prepareSkippedToolCall(batchStep, skippedCall);
          pendingResults.push(scheduler.add(skippedTask));
        }
        break;
      }
    }

    // 工具任务可能乱序完成；终端结果仍按提供者顺序发出。
    // 等待所有任务完成，使每个已记录的 `tool.call` 都有配对的
    // `tool.result`；调用方在写入 `step.end` 前检查中止状态。
    for (const pendingResult of pendingResults) {
      const result = await finalizePendingToolResult(batchStep, await pendingResult);
      if (result.stopTurn === true) stopTurn = true;
      await step.dispatchEvent({
        type: 'tool.result',
        parentUuid: result.toolCall.id,
        toolCallId: result.toolCall.id,
        result: result.result,
      });
    }
  } finally {
    // 准备或结果派发可能在执行开始后抛出异常。
    // 在调用方继续之前始终完成已生成的任务，以确保被拒绝的
    // 执行 Promise 不会作为分离的未处理拒绝浮出。
    await Promise.allSettled(pendingResults);
  }
  return { stopTurn };
}

/**
 * 按提供者顺序的验证阶段。不运行钩子、生成工具或写入事件。
 * 验证器编译可能填充本地缓存。
 */
function preflightToolCall(
  tools: readonly ExecutableTool[] | undefined,
  toolCall: ToolCall,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  const args = parsedArgs.success ? parsedArgs.data : {};
  const tool = tools?.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args,
      output: `Tool "${toolName}" not found`,
    };
  }
  if (!parsedArgs.success) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args,
      output: `Invalid args for tool "${toolName}": malformed JSON in arguments: ${parsedArgs.error}`,
    };
  }
  const validationError = validateExecutableToolArgs(tool, parsedArgs.data);
  if (validationError !== null) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Invalid args for tool "${toolName}": ${validationError}`,
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

function parseToolCallArguments(
  raw: string | null,
):
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: string } {
  if (raw === null || raw.length === 0) {
    return { success: true, data: {} };
  }
  try {
    return { success: true, data: JSON.parse(raw) as unknown };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  let validator = validators.get(tool);
  if (validator === undefined) {
    try {
      validator = compileToolArgsValidator(tool.parameters);
      validators.set(tool, validator);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(validator, args as JsonType);
}

async function prepareToolCall(
  step: ToolCallBatchContext,
  call: PreflightedToolCall,
): Promise<PreparedToolCallTask> {
  const settleError = async (
    args: unknown,
    output: string,
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    await dispatchToolCall(step, call, args, displayFields);
    return { task: makeResolvedToolCallTask(makeErrorToolResult(call, args, output)) };
  };

  const settleSynthetic = async (
    args: unknown,
    result: ExecutableToolResult,
    displayFields?: ToolCallDisplayFields,
  ): Promise<PreparedToolCallTask> => {
    const coerced = coerceToolResult(result, call.toolName);
    await dispatchToolCall(step, call, args, displayFields);
    return {
      task: makeResolvedToolCallTask(makeToolResult(call, args, coerced)),
      stopBatchAfterThis: toolResultStopsTurn(coerced),
    };
  };

  if (call.kind === 'rejected') return settleError(call.args, call.output);

  const decision = await runPrepareToolExecutionHook(step, call);
  if (decision.kind === 'blocked' || decision.kind === 'hookFailed') {
    return settleError(decision.args, decision.output);
  }
  if (decision.kind === 'synthetic') {
    return settleSynthetic(decision.args, decision.result);
  }

  const validationError = validateExecutableToolArgs(call.tool, decision.args);
  if (validationError !== null) {
    return settleError(
      decision.args,
      `Invalid args for tool "${call.toolName}" after prepareToolExecution hook: ${validationError}`,
    );
  }

  const effectiveArgs = decision.args;
  let execution: ToolExecution;
  try {
    execution = await call.tool.resolveExecution(effectiveArgs);
  } catch (error) {
    if (!(error instanceof PathSecurityError)) {
      step.log?.warn('tool execution setup failed', {
        toolName: call.toolName,
        toolCallId: call.toolCall.id,
        error,
      });
    }
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
    return settleError(effectiveArgs, output);
  }

  const displayFields = toolCallDisplayFieldsFromExecution(execution);
  const settleAborted = (): Promise<PreparedToolCallTask> =>
    settleError(effectiveArgs, abortedToolOutput(call.toolName, step.signal), displayFields);

  if (step.signal.aborted) return settleAborted();

  if (execution.isError === true) {
    return settleSynthetic(effectiveArgs, execution, displayFields);
  }

  const authorization = await runAuthorizeToolExecutionHook(step, call, effectiveArgs, execution);
  if (step.signal.aborted) return settleAborted();

  if (authorization?.block === true) {
    return settleError(
      effectiveArgs,
      authorization.reason ?? `Tool call "${call.toolName}" was blocked`,
      displayFields,
    );
  }

  if (authorization?.syntheticResult !== undefined) {
    return settleSynthetic(effectiveArgs, authorization.syntheticResult, displayFields);
  }

  const executionMetadata = authorization?.executionMetadata ?? decision.metadata;
  await dispatchToolCall(step, call, effectiveArgs, displayFields);
  return {
    task: {
      accesses: execution.accesses ?? ToolAccesses.all(),
      start: async () => ({
        result: runRunnableToolCall(step, call, effectiveArgs, executionMetadata, execution),
      }),
    },
    stopBatchAfterThis: execution.stopBatchAfterThis,
  };
}

async function prepareSkippedToolCall(
  step: ToolCallBatchContext,
  call: PreflightedToolCall,
): Promise<ToolCallTask<PendingToolResult>> {
  const output = 'Tool skipped because a previous tool call stopped the turn.';
  await dispatchToolCall(step, call, call.args);
  return makeResolvedToolCallTask(makeErrorToolResult(call, call.args, output));
}

function makeResolvedToolCallTask(result: PendingToolResult): ToolCallTask<PendingToolResult> {
  return {
    accesses: ToolAccesses.none(),
    start: async () => ({ result: Promise.resolve(result) }),
  };
}

/**
 * 在记录 `tool.call` 之前按提供者顺序运行 `prepareToolExecution`。
 * 钩子决定可以阻止调用或在执行开始前替换参数。
 */
async function runPrepareToolExecutionHook(
  step: ToolCallBatchContext,
  call: RunnableToolCall,
): Promise<PrepareToolExecutionDecision> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  const { toolCall, args } = call;

  if (hooks?.prepareToolExecution === undefined) {
    return { kind: 'allowed', args };
  }

  let hookResult: PrepareToolExecutionResult | undefined;
  try {
    hookResult = await hooks.prepareToolExecution({
      toolCall,
      toolCalls: step.toolCalls,
      tool: call.tool,
      args,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
  } catch (error) {
    // 如果在等待支持中止的钩子时轮次被取消，
    // 将调用报告为已中止，而不是将其视为钩子失败。
    if (isAbortError(error) || signal.aborted) {
      return {
        kind: 'hookFailed',
        args,
        output: `Tool "${call.toolName}" was aborted during prepareToolExecution hook`,
      };
    }
    return {
      kind: 'hookFailed',
      args,
      output: `prepareToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }

  const effectiveArgs = hookResult?.updatedArgs ?? args;
  if (hookResult?.block === true) {
    return {
      kind: 'blocked',
      args: effectiveArgs,
      output: hookResult.reason ?? `Tool call "${call.toolName}" was blocked`,
    };
  }

  if (hookResult?.syntheticResult !== undefined) {
    return { kind: 'synthetic', args: effectiveArgs, result: hookResult.syntheticResult };
  }

  return { kind: 'allowed', args: effectiveArgs, metadata: hookResult?.executionMetadata };
}

async function runAuthorizeToolExecutionHook(
  step: ToolCallBatchContext,
  call: RunnableToolCall,
  args: unknown,
  execution: RunnableToolExecution,
): Promise<AuthorizeToolExecutionResult | undefined> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.authorizeToolExecution === undefined) return undefined;

  try {
    return await hooks.authorizeToolExecution({
      toolCall: call.toolCall,
      toolCalls: step.toolCalls,
      tool: call.tool,
      args,
      execution,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return {
        block: true,
        reason: `Tool "${call.toolName}" was aborted during authorizeToolExecution hook`,
      };
    }
    return {
      block: true,
      reason: `authorizeToolExecution hook failed for "${call.toolName}": ${errorMessage(error)}`,
    };
  }
}

function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}

async function runRunnableToolCall(
  step: ToolCallStepContext,
  call: RunnableToolCall,
  effectiveArgs: unknown,
  metadata: unknown,
  execution: RunnableToolExecution,
): Promise<PendingToolResult> {
  const { signal } = step;
  const { toolCall, toolName } = call;

  if (signal.aborted) {
    return makeErrorToolResult(call, effectiveArgs, abortedToolOutput(toolName, signal));
  }

  let toolResult: ExecutableToolResult;
  try {
    const raw = await executeTool(step, execution, toolCall, toolName, metadata);
    toolResult = coerceToolResult(raw, toolName);
  } catch (error) {
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('tool execution failed', {
        toolName,
        toolCallId: toolCall.id,
        error,
      });
    }
    const output = aborted
      ? abortedToolOutput(toolName, signal)
      : `Tool "${toolName}" failed: ${errorMessage(error)}`;
    return makeErrorToolResult(call, effectiveArgs, output);
  }

  return makeToolResult(call, effectiveArgs, toolResult);
}

async function finalizePendingToolResult(
  step: ToolCallBatchContext,
  pendingResult: PendingToolResult,
): Promise<PendingToolResult> {
  const { hooks, signal, turnId, currentStep, llm } = step;
  if (hooks?.finalizeToolResult === undefined) {
    return { ...pendingResult, result: normalizeToolResult(pendingResult.result) };
  }

  try {
    const finalizedResult = await hooks.finalizeToolResult({
      toolCall: pendingResult.toolCall,
      toolCalls: step.toolCalls,
      args: pendingResult.args,
      result: pendingResult.result,
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    const effectiveResult = coerceToolResult(
      finalizedResult ?? pendingResult.result,
      pendingResult.toolName,
    );
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn === true || toolResultStopsTurn(effectiveResult),
      result: normalizeToolResult(effectiveResult),
    };
  } catch (error) {
    // 这是脱敏/截断边界。如果失败，不要持久化原始工具输出；改为写入错误结果。
    const aborted = isAbortError(error) || signal.aborted;
    if (!aborted) {
      step.log?.warn('finalizeToolResult hook failed', {
        toolName: pendingResult.toolName,
        toolCallId: pendingResult.toolCall.id,
        error,
      });
    }
    const output = aborted
      ? `Tool "${pendingResult.toolName}" aborted during finalizeToolResult hook.`
      : `finalizeToolResult hook failed for "${pendingResult.toolName}": ${errorMessage(error)}`;
    return {
      ...pendingResult,
      stopTurn: pendingResult.stopTurn,
      result: { output, isError: true },
    };
  }
}

async function executeTool(
  step: ToolCallStepContext,
  execution: RunnableToolExecution,
  toolCall: ToolCall,
  toolName: string,
  metadata: unknown,
): Promise<ExecutableToolResult> {
  const { dispatchEvent, signal, turnId } = step;

  signal.throwIfAborted();

  const executePromise = execution.execute({
    turnId,
    toolCallId: toolCall.id,
    metadata,
    signal,
    onUpdate: (update) => {
      if (signal.aborted) return;
      dispatchEvent({
        type: 'tool.progress',
        toolCallId: toolCall.id,
        update,
      });
    },
  });
  return raceExecuteWithGraceTimeout(executePromise, signal, toolName);
}

async function raceExecuteWithGraceTimeout(
  executePromise: Promise<ExecutableToolResult>,
  signal: AbortSignal,
  toolName: string,
): Promise<ExecutableToolResult> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<ExecutableToolResult> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          output: `Tool "${toolName}" aborted by grace timeout (${String(GRACE_TIMEOUT_MS)}ms)`,
          isError: true,
        });
      }, GRACE_TIMEOUT_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    // 忽略 AbortSignal 的工具可能永远不会完成。中止后，
    // 宽限期分支允许轮次以合成错误结果结束。
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // 某些 AbortSignal polyfill 未实现 removeEventListener。
      }
    }
  }
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

/**
 * 根据 {@link ExecutableToolResult} 契约验证工具的原始返回值。
 * 返回 `undefined`、原始值或没有有效 `output` 字段的对象的工具
 * 会被强制转换为 `isError: true` 结果，以便循环仍然可以发出
 * 配对的 `tool.result` 事件。这是任意工具实现与循环其余部分之间的信任边界。
 */
function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

function normalizeToolResult(r: ExecutableToolResult): ExecutableToolResult {
  let output: ExecutableToolResult['output'];
  if (typeof r.output === 'string') {
    output = r.output.length > 0 ? r.output : TOOL_OUTPUT_EMPTY;
  } else if (r.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = r.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = r.output.some((c) => c.type === 'text' && c.text.length > 0);
      output = hasNonEmptyText
        ? r.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...r.output];
    } else {
      const textJoined = r.output
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  return r.isError === true ? { output, isError: true } : { output };
}

function makeToolResult(
  call: PreflightedToolCall,
  args: unknown,
  result: ExecutableToolResult,
): PendingToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result,
    stopTurn: toolResultStopsTurn(result),
  };
}

function toolResultStopsTurn(result: ExecutableToolResult): boolean {
  return result.stopTurn === true;
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PendingToolResult {
  return makeToolResult(call, args, { output, isError: true });
}

/**
 * 按提供者顺序记录 `tool.call`。复用提供者/API 工具调用 ID
 * 使转录关联保持在同一个规范标识上。
 */
async function dispatchToolCall(
  step: ToolCallStepContext,
  call: PreflightedToolCall,
  args: unknown,
  displayFields?: ToolCallDisplayFields | undefined,
): Promise<void> {
  const { toolCall, toolName } = call;
  await step.dispatchEvent({
    type: 'tool.call',
    uuid: toolCall.id,
    turnId: step.turnId,
    step: step.currentStep,
    stepUuid: step.stepUuid,
    toolCallId: toolCall.id,
    name: toolName,
    args,
    description: displayFields?.description,
    display: displayFields?.display,
  });
}

/**
 * 工具调用去重与升级系统。
 *
 * 通过以下方式防止模型在相同工具调用上空转：
 * 1. **同步骤去重**：如果模型在单个 LLM 步骤中发出相同的 `(toolName, args)` 对，
 *    仅第一次实际执行；后续调用通过延迟承诺复用原始结果。
 * 2. **跨步骤升级**：当模型在连续步骤中重复相同调用时，会在结果中追加
 *    越来越紧急的系统提醒。如果连续次数达到 12，则强制停止 turn。
 *
 * 此模块的 `checkSameStep()` 故意设计为同步的，以避免在仅在 finalize 阶段
 * 解决的延迟承诺上死锁准备循环。
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import type { TelemetryClient } from '../../telemetry';
import type { ExecutableToolResult } from '../../loop/types';

import { canonicalTelemetryArgs } from './canonical-args';

/** 第一级升级提醒——连续 3 次时的温和提示。 */
const REMINDER_TEXT_1 =
  '\n\n<system-reminder>\n' +
  'You are repeating the exact same tool call with identical parameters.' +
  ' Please carefully analyze the previous result. If the task is not yet complete,' +
  ' try a different method or parameters instead of repeating the same call.' +
  '\n</system-reminder>';

/**
 * 第二级升级提醒——连续 5 次时的具体重复报告。包含工具名称、
 * 重复次数和规范化的参数，以便模型明确看到自己重复了什么。
 */
function makeReminderText2(toolName: string, repeatCount: number, args: unknown): string {
  const argsStr = canonicalTelemetryArgs(args);
  return (
    '\n\n<system-reminder>\n' +
    'You have repeatedly called the same tool with identical parameters many times.\n' +
    'Repeated tool call detected:\n' +
    `- tool: ${toolName}\n` +
    `- repeated_times: ${String(repeatCount)}\n` +
    `- arguments: ${argsStr}\n` +
    'The previous repeated calls did not make progress. Do not call this exact same tool with the exact same arguments again.\n' +
    'Carefully inspect the latest tool result and choose a different next action, different parameters, or finish the task if enough evidence has been gathered.' +
    '\n</system-reminder>'
  );
}

/** 第三级升级提醒——连续 8 次时的死胡同停止指令。告诉模型停止所有工具调用。 */
const REMINDER_TEXT_3 =
  '\n\n<system-reminder>\n' +
  'You are stuck in a dead end and have repeatedly made the same function call without progress.\n' +
  'Stop all function calls immediately. Do not call any tool in your next response.\n' +
  'In analysis, review the current execution state and identify why progress is blocked.\n' +
  'Then return a text-only summary to the user that reports the current problem, what has already been tried, and what information or decision is needed next.' +
  '\n</system-reminder>';

/** 追加第一级提醒（温和提示）的连续次数阈值。 */
const REPEAT_REMINDER_1_START = 3;
/** 追加第二级提醒（具体报告）的连续次数阈值。 */
const REPEAT_REMINDER_2_START = 5;
/** 追加第三级提醒（死胡同停止）的连续次数阈值。 */
const REPEAT_REMINDER_3_START = 8;
/** 通过 `{ stopTurn: true }` 强制停止 turn 的连续次数阈值。 */
const REPEAT_FORCE_STOP_STREAK = 12;

/** `resolve` 暴露给外部用于跨阶段连接的延迟承诺。 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** 创建新的延迟承诺。 */
function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 根据工具名称和参数构建规范化的去重键。 */
function makeKey(toolName: string, args: unknown): string {
  return `${toolName} ${canonicalTelemetryArgs(args)}`;
}

/**
 * 向工具结果的输出追加系统提醒文本块。处理字符串和 ContentPart[] 两种输出格式。
 * 保留原始 `isError` 标志。
 */
function appendReminder(result: ExecutableToolResult, reminderText: string): ExecutableToolResult {
  const output = result.output;
  let newOutput: string | ContentPart[];
  if (typeof output === 'string') {
    newOutput = output + reminderText;
  } else {
    const arr: ContentPart[] = [...output];
    const last = arr.at(-1);
    if (last !== undefined && last.type === 'text') {
      arr[arr.length - 1] = { type: 'text', text: last.text + reminderText };
    } else {
      arr.push({ type: 'text', text: reminderText });
    }
    newOutput = arr;
  }
  return result.isError === true
    ? { ...result, output: newOutput, isError: true }
    : { ...result, output: newOutput };
}

/**
 * 通过追加提醒并设置 `stopTurn: true` 创建强制停止的结果。
 * 保留原始 `isError` 标志——即使被强制停止，成功的工具结果仍保持成功状态。
 */
function forceStopResult(
  result: ExecutableToolResult,
  reminderText: string,
): ExecutableToolResult {
  const withReminder = appendReminder(result, reminderText);
  return { ...withReminder, stopTurn: true };
}

/**
 * `checkSameStep` 为重复调用返回的占位结果。不会到达模型——在 `finalizeResult` 中
 * 通过等待原始调用的延迟结果来替换。循环使用最终值派发 `tool.result` 事件，
 * 因此此内容纯粹是内部记账。
 *
 * 它必须是非错误结果，这样 tool-call.ts 中的 `toolResultStopsTurn` 不会
 * 在重复调用的名义下短路批处理。
 */
const DEDUP_PLACEHOLDER_RESULT: ExecutableToolResult = { output: '' };

/**
 * 检测和抑制单个 turn 内的重复工具调用。
 *
 * 分层实现两种行为：
 * - 同步骤去重：在同一 LLM 步骤中发出的重复 `(toolName, args)`
 *   复用原始调用的结果，而不是重复执行工具。
 * - 跨步骤去重：当完全相同的调用在步骤间连续重复时，
 *   连续次数达到 3 后，返回给模型的结果会附加系统提醒。
 *   提醒随连续次数递增：r1（温和提示）从连续 3 次开始，
 *   r2（具体重复报告）从连续 5 次开始，r3（死胡同停止指令）从连续 8 次开始。
 *   从连续 12 次起，通过 `{ stopTurn: true }` 强制停止 turn，
 *   使循环无法继续在相同调用上空转。强制停止不会将成功的工具结果
 *   翻转为错误——底层工具的 `isError` 被保留。
 *
 * 遥测：每个最终确定的原始调用（连续次数 >= 2）发出 `tool_call_repeat` 事件，
 * 携带当前连续次数作为 `repeat_count`，以及工具名称和采取的操作（none/r1/r2/r3/stop）。
 */
export class ToolCallDeduplicator {
  private stepDeferreds = new Map<string, Deferred<ExecutableToolResult>>();
  private stepCalls: string[] = [];
  private originalCallIndex = new Map<string, number>();
  private syntheticCallIds = new Set<string>();
  /**
   * 记录在 `checkSameStep` 时使用的去重键，以 `toolCallId` 为键。
   * 循环允许在 `prepareToolExecution` 和 `finalizeToolResult` 之间
   * 通过 `PrepareToolExecutionResult.updatedArgs` 重写参数，因此 finalize 时
   * 可用的 `(toolName, args)` 对可能与注册时不同。
   * 我们在注册时固定键，并在 finalize 期间通过调用 ID 查找。
   */
  private callKeyByCallId = new Map<string, string>();
  private consecutiveKey: string | null = null;
  private consecutiveCount = 0;
  private readonly telemetry: TelemetryClient | undefined;

  constructor(options?: { readonly telemetry?: TelemetryClient | undefined }) {
    this.telemetry = options?.telemetry;
  }

  /**
   * 在每个 LLM 步骤开始时重置每步骤状态。前一步骤中任何未解决的
   * 延迟承诺将被解析为错误占位符（原始结果可能因中止而丢失）。
   */
  beginStep(): void {
    for (const deferred of this.stepDeferreds.values()) {
      deferred.resolve({
        output: 'Tool call deduplicated but original result was lost',
        isError: true,
      });
    }
    this.stepDeferreds.clear();
    this.stepCalls = [];
    this.originalCallIndex.clear();
    this.syntheticCallIds.clear();
    this.callKeyByCallId.clear();
  }

  /**
   * 在每个 LLM 步骤结束时完成每步骤状态。通过扫描本步骤中的所有调用
   * 来更新连续计数器。
   */
  endStep(): void {
    for (const key of this.stepCalls) {
      if (key === this.consecutiveKey) {
        this.consecutiveCount += 1;
      } else {
        this.consecutiveKey = key;
        this.consecutiveCount = 1;
      }
    }
  }

  /**
   * 从 `prepareToolExecution` 调用。如果此 `(toolName, args)` 在当前步骤中
   * 已出现过，返回占位结果以便循环可以跳过再次执行工具；真正的结果将在
   * `finalizeResult` 中补丁。对首次出现返回 `null` 以继续正常执行路径。
   *
   * 此方法故意设计为同步的，以避免在仅在 finalize 阶段解决的延迟承诺上
   * 死锁准备循环。
   */
  checkSameStep(toolCallId: string, toolName: string, args: unknown): ExecutableToolResult | null {
    const key = makeKey(toolName, args);
    const index = this.stepCalls.length;
    this.stepCalls.push(key);
    this.callKeyByCallId.set(toolCallId, key);

    const existing = this.stepDeferreds.get(key);
    if (existing !== undefined) {
      this.syntheticCallIds.add(toolCallId);
      return DEDUP_PLACEHOLDER_RESULT;
    }
    this.stepDeferreds.set(key, makeDeferred<ExecutableToolResult>());
    this.originalCallIndex.set(toolCallId, index);
    return null;
  }

  /**
   * 从 `finalizeToolResult` 调用，按 provider 顺序。对于首次出现的调用，
   * 投影到此调用结束的连续次数，如果达到阈值则追加系统提醒，
   * 然后解决延迟承诺以便后续同步步骤的重复调用可以获取真实结果。
   * 对于合成重复，等待原始调用的延迟承诺并返回其值，丢弃占位符。
   */
  /**
   * 完成工具调用的结果。对于原始（非重复）调用，投影连续次数，
   * 如果达到阈值则追加升级提醒，发出遥测，并解决延迟承诺。
   * 对于合成重复，等待原始调用的延迟承诺并返回其结果。
   *
   * @returns 发送给模型的最终结果（可能包含追加的提醒）。
   */
  async finalizeResult(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ExecutableToolResult,
  ): Promise<ExecutableToolResult> {
    // 使用注册时记录的键，而非从此处传入的参数生成新键——
    // 循环可能已通过 updatedArgs 重写了参数。
    const key = this.callKeyByCallId.get(toolCallId);
    if (key === undefined) return result;
    this.callKeyByCallId.delete(toolCallId);

    if (this.syntheticCallIds.delete(toolCallId)) {
      const deferred = this.stepDeferreds.get(key);
      if (deferred === undefined) return result;
      return deferred.promise;
    }
    const index = this.originalCallIndex.get(toolCallId);
    if (index === undefined) return result;
    this.originalCallIndex.delete(toolCallId);

    let lastKey = this.consecutiveKey;
    let streak = this.consecutiveCount;
    for (let i = 0; i <= index; i += 1) {
      const k = this.stepCalls[i]!;
      if (k === lastKey) {
        streak += 1;
      } else {
        lastKey = k;
        streak = 1;
      }
    }

    let finalResult = result;
    let action: 'none' | 'r1' | 'r2' | 'r3' | 'stop' = 'none';
    if (streak >= REPEAT_FORCE_STOP_STREAK) {
      finalResult = forceStopResult(result, REMINDER_TEXT_3);
      action = 'stop';
    } else if (streak >= REPEAT_REMINDER_3_START) {
      finalResult = appendReminder(result, REMINDER_TEXT_3);
      action = 'r3';
    } else if (streak >= REPEAT_REMINDER_2_START) {
      finalResult = appendReminder(result, makeReminderText2(toolName, streak, args));
      action = 'r2';
    } else if (streak >= REPEAT_REMINDER_1_START) {
      finalResult = appendReminder(result, REMINDER_TEXT_1);
      action = 'r1';
    }

    if (streak >= 2) {
      this.telemetry?.track('tool_call_repeat', {
        tool_name: toolName,
        repeat_count: streak,
        action,
      });
    }

    this.stepDeferreds.get(key)?.resolve(finalResult);
    return finalResult;
  }
}

/** 用于单元测试暴露的内部常量和辅助工具。 */
export const __testing = {
  REMINDER_TEXT_1,
  REMINDER_TEXT_3,
  makeReminderText2,
  REPEAT_REMINDER_1_START,
  REPEAT_REMINDER_2_START,
  REPEAT_REMINDER_3_START,
  REPEAT_FORCE_STOP_STREAK,
};

/**
 * Agent 的轮次生命周期管理。
 *
 * **轮次**是一个完整的 用户→模型→响应 周期。本模块负责：
 * - 启动、跟踪和取消进行中的轮次（`TurnFlow`）。
 * - 驱动目标模式的自主继续循环（模型持续工作直到调用 `UpdateGoal`
 *   发出完成或阻塞信号）。
 * - 将低级循环事件映射为公共 `AgentEvent` 接口。
 * - 工具调用、重复检测、步骤跟踪和 API 错误的遥测。
 *
 * `TurnFlow` 类是轮次标识（单调递增的 `turnId`）、中止传播和
 * 引导缓冲区（在步骤边界之间排队用户消息）的单一事实来源。
 */

import { createHash } from 'node:crypto';

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  grandTotal,
  inputTotal,
  isContextOverflowStatusError,
  type ContentPart,
  type TokenUsage,
} from '@moonshot-ai/kosong';
import { basename } from 'pathe';

import type { Agent } from '..';
import {
  ErrorCodes,
  type KimiErrorPayload,
  isKimiError,
  makeErrorPayload,
  toKimiErrorPayload,
} from '#/errors';
import { isAbortError, isMaxStepsExceededError } from '../../loop/errors';
import {
  createLoopEventDispatcher,
  runTurn,
  type ExecutableToolResult,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnInterruptedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent, TurnEndReason } from '../../rpc';
import type { TelemetryPropertyValue } from '../../telemetry';
import { abortable, isUserCancellation, userCancellationReason } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin } from '../context';
import { renderUserPromptHookBlockResult, renderUserPromptHookResult } from '../../session/hooks';
import { canonicalTelemetryArgs, isPlainRecord } from './canonical-args';
import { ToolCallDeduplicator } from './tool-dedup';
import { budgetToolResultForModel } from './tool-result-budget';

/**
 * 表示当前正在运行的轮次。在 `launch()` 中创建，在轮次完成、失败或
 * 被替代时清除。`AbortController` 允许外部调用者（RPC 取消、父级
 * 子 Agent 截止时间）从外部终止轮次。
 */
interface ActiveTurn {
  readonly turnId: number;
  readonly controller: AbortController;
  readonly promise: Promise<TurnEndResult>;
  readonly firstRequest: ControlledPromise<void>;
}

/**
 * 在轮次已经在进行中时到达的用户消息。引导消息会被缓冲并在
 * 下一个步骤边界刷新，以便模型按顺序看到它们而不中断正在运行的步骤。
 */
interface BufferedSteer {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

/**
 * 完成轮次的公共结果，由 `TurnFlow` 方法返回，
 * 并被 Agent 的高级编排层（目标驱动器、RPC 层）消费。
 */
export interface TurnEndResult {
  /** 发送给外部监听器的终端 `turn.ended` 事件。 */
  readonly event: TurnEndedEvent;
  /** 轮次正常完成时的循环级停止原因。 */
  readonly stopReason?: LoopTurnStopReason;
  /** 当 `UserPromptSubmit` 钩子在模型运行前阻止了轮次时为 `true`。 */
  readonly blockedByUserPromptHook?: boolean;
}

/** `applyUserPromptHook` 的内部结果 — 同时携带结束事件和钩子是否阻止了轮次的信息。 */
interface PromptHookEndResult {
  readonly event: TurnEndedEvent;
  readonly blocked: boolean;
}

const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

/** 驱动每个目标轮次的合成"继续"提示的来源标记。 */
const GOAL_CONTINUATION_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'goal_continuation' };
export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked';
const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = 'Paused after provider authentication error';
const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = 'Paused after model configuration error';
const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';
const GOAL_PROVIDER_FILTERED_PAUSE_REASON = 'Paused after provider safety policy block';

/**
 * 目标驱动器为启动每个继续轮次附加的提示 — 用户输入"继续"的自主替代。
 * 模型通过调用 `UpdateGoal` 来决定何时停止；否则驱动器运行另一个轮次。
 */
const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far. Goal mode is iterative: do one coherent slice of work, then',
  'reassess. Call UpdateGoal with `complete` only when all required work is done, any stated',
  'validation has passed, and there is no useful next action. Do not mark complete after only',
  'producing a plan, summary, first pass, or partial result. If an external condition or required',
  'user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal',
  'with `blocked`. Otherwise keep going — use the existing conversation context and your tools,',
  'and do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

/**
 * 管理 Agent 轮次的生命周期：启动、跟踪、取消和驱动目标模式继续循环。
 *
 * 同一时间只能有一个轮次处于活跃状态。新轮次通过 `prompt()`（直接用户输入）
 * 或 `steer()`（在飞行中的修正，缓冲到下一个步骤边界）启动。`TurnFlow` 拥有
 * 单调的 `turnId` 计数器、活跃轮次的中止控制器和引导缓冲区。
 *
 * 在目标模式下，`driveGoal()` 将多个普通轮次链接成自主继续循环 —
 * 模型持续工作直到调用 `UpdateGoal({ status })` 来发出完成、阻塞或暂停信号。
 */
export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  /** 跟踪每个工具调用的开始时间（键为 toolCallId），用于持续时间遥测。 */
  private readonly toolCallStartedAt = new Map<string, { name: string; startedAt: number }>();
  /** 将每个工具调用分类为 'normal' 或 'cross_step' 重复，用于遥测。 */
  private readonly toolCallDupType = new Map<string, 'normal' | 'cross_step'>();
  /** 将步骤号映射到该步骤中已见的 `(toolName, args)` 键集合。 */
  private readonly stepToolCallKeys = new Map<number, Set<string>>();
  /** 缓存每个轮次的遥测模式（'agent' | 'plan'），用于中断轮次跟踪。 */
  private readonly telemetryModeByTurn = new Map<number, 'agent' | 'plan'>();
  /** 跟踪每个轮次的当前步骤号，用于中断轮次的遥测。 */
  private readonly currentStepByTurn = new Map<number, number>();
  /** 已经发送过 `turn_interrupted` 遥测事件的轮次 ID 集合（去重保护）。 */
  private readonly interruptedTelemetryTurnIds = new Set<number>();
  /** 记录错误类型失败的 `turn.interrupted` 事件，用于控制 API 错误遥测。 */
  private readonly stepFailureByTurn = new Map<number, LoopTurnInterruptedEvent>();
  private currentStep = 0;

  constructor(protected readonly agent: Agent) {}

  /** 从 Agent homedir 派生的尽力而为的 Agent ID（主/生成的 ID）。 */
  private get agentId(): string {
    return this.agent.homedir ? basename(this.agent.homedir) : this.agent.type;
  }

  /**
   * 从显式用户输入启动新轮次。记录 `turn.prompt` 并委托给 `launch()`。
   * 返回新的 turnId，如果轮次被标记为恢复（会话恢复）则返回 `null`。
   */
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input,
      origin,
    });
    return this.launch(input, origin);
  }

  /**
   * 发送飞行中的用户修正。如果轮次已在进行中，消息会被缓冲并在
   * 下一个步骤边界刷新（以便模型按顺序看到）。如果没有活跃轮次，
   * 行为类似于 `prompt()`。
   * 返回新的 turnId，如果被缓冲或正在恢复则返回 `null`。
   */
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.steer',
      input,
      origin,
    });
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return null;
    }
    return this.launch(input, origin);
  }

  /**
   * 重试上一个轮次，可选地标记触发原因（如 'api_error'、'user_action'）。
   * 使用重试来源启动空提示轮次。
   */
  retry(trigger?: string): number | null {
    return this.prompt([], { kind: 'retry', trigger });
  }

  /**
   * 内部轮次启动器。防止并发轮次，分配 turnId，创建中止控制器，
   * 并启动 `turnWorker` 异步循环。
   * 返回 turnId，如果另一个轮次已活跃则返回 `null`。
   */
  private launch(input: readonly ContentPart[], origin: PromptOrigin): number | null {
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: 'error',
        ...makeErrorPayload(
          'turn.agent_busy',
          `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
          { details: { turnId: this.turnId } },
        ),
      });
      return null;
    }

    // 每轮次的设置（遥测、使用窗口、`turn.started`、附加提示）
    // 现在在 `runOneTurn` 中，因此目标驱动的运行在每个继续轮次
    // 发出干净的开始/结束配对，而不是一个巨大的轮次。
    const turnId = this.allocateTurnId();
    const controller = new AbortController();
    const promise = this.turnWorker(turnId, input, origin, controller.signal);
    const firstRequest = createControlledPromise<void>();
    this.activeTurn = {
      turnId,
      controller,
      promise,
      firstRequest,
    };

    void firstRequest.catch(() => undefined);
    void promise.then(firstRequest.reject, firstRequest.reject);

    return turnId;
  }

  /** 分配下一个单调递增的轮次 ID。 */
  private allocateTurnId(): number {
    this.turnId += 1;
    return this.turnId;
  }

  /**
   * 将轮次流标记为从会话恢复中恢复。递增轮次计数器并设置哨兵，
   * 在调用 `finishResume()` 之前无法启动真正的轮次。如果轮次已活跃则无操作。
   */
  restorePrompt(): void {
    if (this.activeTurn) {
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  /**
   * 提升轮次计数器以覆盖在重放的循环事件中观察到的 turnId。
   * 这是恢复计数器的权威来源：每个运行过的轮次 — 提示轮次、
   * 目标继续或引导启动的轮次 — 都会发出携带其真实 turnId 的循环事件，
   * 尽管只有提示轮次会写入 `turn.prompt` 记录。然后从 `max + 1` 继续恢复。
   * 只会提升计数器，不会降低，因此实时路径（`turnId` 在任何循环事件
   * 之前已分配）不受影响。
   */
  observeRestoredTurnId(turnId: number): void {
    if (Number.isInteger(turnId) && turnId > this.turnId) {
      this.turnId = turnId;
    }
  }

  /**
   * 从会话重放中恢复引导消息。如果轮次活跃，消息按常规缓冲；
   * 否则流进入 'resuming' 哨兵状态（与 `restorePrompt()` 相同）。
   */
  restoreSteer(input: readonly ContentPart[], origin: PromptOrigin): void {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  /**
   * 取消活跃轮次（及所有子 Agent）。如果提供了 `turnId`，
   * 仅在匹配当前轮次时取消 — 这防止过期的取消请求终止较新的轮次。
   *
   * @param turnId - 如果提供，仅在匹配当前轮次时取消。
   * @param reason - 中止原因；默认为用户取消哨兵。
   */
  cancel(turnId?: number, reason?: unknown): void {
    this.agent.records.logRecord({ type: 'turn.cancel', turnId });
    if (turnId !== undefined && turnId !== this.currentId) {
      return; // 忽略非活跃轮次的取消
    }
    // 直接取消（RPC/重放）是用户按下停止。当取消从中止信号传播时
    // （例如子 Agent 的截止时间通过 waitForCurrentTurn），携带该原始原因，
    // 以便超时不会被错误标记为对模型的刻意用户中断。
    const cancelReason = reason ?? userCancellationReason();
    this.abortTurn(cancelReason);
    this.agent.subagentHost?.cancelAll(cancelReason);
  }

  /** 最近启动的（或当前活跃的）轮次的单调 turnId。 */
  get currentId() {
    return this.turnId;
  }

  /** 当轮次正在运行时为 `true`（不处于空闲或 'resuming' 哨兵状态）。 */
  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && this.activeTurn !== 'resuming';
  }

  private ensureActiveTurn(): ActiveTurn {
    if (this.activeTurn === null || this.activeTurn === 'resuming') {
      throw new Error('No active turn');
    }
    return this.activeTurn;
  }

  /**
   * 等待活跃轮次完成。如果提供了信号，当信号中止时轮次会被取消
   * （例如父级子 Agent 的截止时间）。
   * 在轮次完成、失败或取消时返回 `TurnEndResult`。
   */
  waitForCurrentTurn(signal?: AbortSignal | undefined): Promise<TurnEndResult> {
    const active = this.ensureActiveTurn();
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;

    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    return abortable(active.promise, signal).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  /**
   * 在活跃轮次收到第一个 LLM 响应事件（文本增量、工具调用等）时解析。
   * 用于测量首 token 时间或在模型开始响应时隐藏 UI 加载指示器。
   */
  waitForTurnFirstRequest(): Promise<void> {
    return this.ensureActiveTurn().firstRequest;
  }

  private abortTurn(reason: unknown) {
    if (this.activeTurn !== 'resuming') {
      // 原因（默认为用户取消，或在传播时为原始信号的原因）
      // 以 signal.reason 传播，以便依赖此信号的工具可以区分
      // 用户刻意中断与超时/系统中止。linkAbortSignal 将其转发到链接的子 Agent。
      this.activeTurn?.controller.abort(reason);
    }
    this.activeTurn = null;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      this.agent.context.appendUserMessage(steer.input, steer.origin);
    }
    steers.length = 0;
    return true;
  }

  /**
   * 从 'resuming' 哨兵状态转换回空闲状态。在会话重放完成后调用，
   * 流准备好接受真正的轮次。同时清除重放期间累积的引导缓冲区。
   */
  finishResume(): void {
    if (this.activeTurn === 'resuming') {
      this.activeTurn = null;
    }
    this.steerBuffer.length = 0;
  }

  /**
   * 单个飞行中 `activeTurn` 的主体。当目标活跃时路由到目标驱动器
   * （顺序继续轮次），否则运行恰好一个轮次。当整个运行完成时清除
   * `activeTurn`（通过启动信号标识，因此替代的轮次不会被损坏）。
   */
  private async turnWorker(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const ownsActiveTurn = (): boolean =>
      this.activeTurn !== null &&
      this.activeTurn !== 'resuming' &&
      this.activeTurn.controller.signal === signal;
    try {
      const initialGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (initialGoalStatus === 'active') {
        return await this.driveGoal(firstTurnId, input, origin, signal);
      }
      const end = await this.runOneTurn(firstTurnId, input, origin, signal, true);
      // A goal can become active during an ordinary turn: the model creates one
      // with CreateGoal, or resumes a paused/blocked goal via UpdateGoal. Either
      // way, hand the now-active goal to the driver so it is actually pursued,
      // instead of stopping after the turn that merely started it. (The
      // already-active case took the early return above.)
      const goalBecameActive = this.agent.goal.getGoal().goal?.status === 'active';
      if (
        goalBecameActive &&
        end.event.reason !== 'cancelled' &&
        end.event.reason !== 'failed' &&
        end.event.reason !== 'filtered'
      ) {
        return await this.driveGoal(
          this.allocateTurnId(),
          [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }],
          GOAL_CONTINUATION_ORIGIN,
          signal,
        );
      }
      return end;
    } finally {
      if (ownsActiveTurn()) {
        this.activeTurn = null;
      }
    }
  }

  /**
   * 将活跃目标驱动为一系列普通轮次 — 用户反复输入"继续"的自主等价操作。
   * 每次迭代运行一个完整轮次，然后读取模型通过 `UpdateGoal` 设置的目标状态：
   * `complete`（记录被清除）/ `blocked` / `paused` 停止循环；
   * `active`（模型未决定）重新注入目标提醒并运行下一个继续轮次。
   * 中止或失败的轮次暂停目标。目标状态阻塞器（如显式 `UpdateGoal('blocked')`、
   * 提示钩子阻止和预算限制）将其阻塞（全部可恢复）。返回最终轮次的结果。
   */
  private async driveGoal(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    let turnId = firstTurnId;
    let turnInput = input;
    let turnOrigin = origin;
    while (true) {
      const goalBeforeTurn = this.agent.goal.getGoal().goal;
      if (goalBeforeTurn?.status === 'active' && goalBeforeTurn.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
        return { event: ended };
      }

      // 统计即将运行的轮次（如果目标不活跃则无操作），以便完成统计
      // 包含模型报告 `complete` 的轮次。挂钟由存储实时跟踪
      // （在 `active` 期间锚定），因此即使模型在轮次中完成，计时器也是正确的。
      await this.agent.goal.incrementTurn();
      const end = await this.runOneTurn(turnId, turnInput, turnOrigin, signal, false);

      if (end.event.reason === 'cancelled') {
        await this.agent.goal.pauseOnInterrupt({ reason: 'Paused after interruption' });
        return end;
      }
      if (end.event.reason === 'failed') {
        await this.agent.goal.pauseActiveGoal({ reason: goalFailurePauseReason(end.event.error) });
        return end;
      }
      if (end.event.reason === 'filtered') {
        await this.agent.goal.pauseActiveGoal({ reason: GOAL_PROVIDER_FILTERED_PAUSE_REASON });
        return end;
      }
      if (end.blockedByUserPromptHook === true) {
        await this.agent.goal.markBlocked({ reason: 'Blocked by UserPromptSubmit hook' });
        return end;
      }

      // 模型通过 UpdateGoal 决定：清除的记录意味着 `complete`；
      // 任何非活跃状态意味着停止（blocked/paused）。只有仍然是 `active`
      // 的目标才会继续到下一个轮次。
      const goal = this.agent.goal.getGoal().goal;
      if (goal === null || goal.status !== 'active') {
        return end;
      }
      // 硬预算（轮次/token/挂钟，通过 SDK 设置）是确定性的上限：
      // 达到时阻止。`blocked` 是可恢复的。
      if (goal.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        return end;
      }

      turnId = this.allocateTurnId();
      turnInput = [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }];
      turnOrigin = GOAL_CONTINUATION_ORIGIN;
    }
  }

  private async endGoalTurnWithoutModel(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
  ): Promise<TurnEndedEvent> {
    this.agent.usage.beginTurn();
    const startedAt = Date.now();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);
    const ended: TurnEndedEvent = {
      type: 'turn.ended',
      turnId,
      reason: 'completed',
      durationMs: Date.now() - startedAt,
    };
    this.agent.usage.endTurn();
    this.agent.emitEvent(ended);
    return ended;
  }

  /**
   * 端到端运行恰好一个逻辑轮次：每轮次记账、`turn.started`、
   * 提示+目标提醒、步骤循环和 `turn.ended`。与目标无关 —
   * 驱动器在上方层叠目标语义。永不抛出；异常结束映射为
   * `cancelled`/`failed` 的 `turn.ended` 并返回。
   */
  private async runOneTurn(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    standalone: boolean,
  ): Promise<TurnEndResult> {
    this.currentStep = 0;
    this.stepToolCallKeys.clear();
    this.toolCallDupType.clear();
    const telemetryMode = this.telemetryMode();
    this.telemetryModeByTurn.set(turnId, telemetryMode);
    this.currentStepByTurn.set(turnId, 0);
    this.agent.telemetry.track('turn_started', { mode: telemetryMode });
    this.agent.fullCompaction.resetForTurn();
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);

    const startedAt = Date.now();
    let ended: TurnEndedEvent;
    let blockedByUserPromptHook = false;
    let completedStopReason: LoopTurnStopReason | undefined;
    // 在 turn.ended 之后发出（保持先前的排序），使错误事件
    // 刚好位于消费者关注的 turn.ended 边界之后。
    let errorEvent: AgentEvent | undefined;
    try {
      const promptHookEnded = await this.applyUserPromptHook(turnId, input, origin, signal, startedAt);
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded.event;
        blockedByUserPromptHook = promptHookEnded.blocked;
      } else {
        const stopReason = await this.runStepLoop(turnId, signal);
        completedStopReason = stopReason;
        const reason: TurnEndReason =
          stopReason === 'aborted' ? 'cancelled' : stopReason === 'filtered' ? 'filtered' : 'completed';
        ended = {
          type: 'turn.ended',
          turnId,
          reason,
          durationMs: Date.now() - startedAt,
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        ended = { type: 'turn.ended', turnId, reason: 'cancelled', durationMs: Date.now() - startedAt };
      } else {
        const summary = summarizeTurnError(error, turnId);
        void this.agent.hooks?.fireAndForgetTrigger('StopFailure', {
          matcherValue: summary.name,
          inputData: { errorType: summary.name, errorMessage: summary.message },
        });
        ended = { type: 'turn.ended', turnId, reason: 'failed', error: summary, durationMs: Date.now() - startedAt };
        errorEvent = { type: 'error', ...summary };
        if (this.shouldTrackApiError(turnId)) {
          const classification = classifyApiError(error, summary);
          const properties: Record<string, TelemetryPropertyValue> = {
            error_type: classification.errorType,
            model: this.agent.config.model,
            retryable: summary.retryable,
            duration_ms: Date.now() - startedAt,
          };
          if (classification.statusCode !== undefined) {
            properties['status_code'] = classification.statusCode;
          }
          const inputTokens = currentTurnInputTokens(this.agent.usage.data().currentTurn);
          if (inputTokens !== undefined) {
            properties['input_tokens'] = inputTokens;
          }
          this.agent.telemetry.track('api_error', properties);
        }
      }
    }
    // 在同一同步帧中发出终端 turn.ended 并（对于独立轮次）释放活跃轮次，
    // 因此会话在 turn.ended 触发时可观察地变为空闲。目标驱动在继续轮次间
    // 保持活跃轮次，在 `turnWorker` 中释放它（`standalone` 对那些情况为 false）。
    if (this.currentId === turnId) {
      this.agent.usage.endTurn();
    }
    // 用户中断（如 Esc）在没有正常 Stop 钩子触发的情况下中止轮次，
    // 因此从钩子跟踪状态的外部工具将永远看不到轮次停止。为其发出
    // 仅观察的 Interrupt 事件。
    // 以 isUserCancellation 为门控：`cancelled` 轮次也可能来自
    // 程序化中止（如子 Agent 截止时间超时，共享此钩子引擎），
    // 那些不应被误报为用户中断。
    if (ended.reason === 'cancelled' && isUserCancellation(signal.reason)) {
      void this.agent.hooks?.fireAndForgetTrigger('Interrupt', {
        inputData: { turnId, reason: 'cancelled' },
      });
    }
    this.agent.emitEvent(ended);
    // Release the active turn in the same frame as turn.ended for a standalone
    // turn, so the session is observably idle the instant turn.ended fires.
    // Exception: if the model turned the goal active during this turn (e.g.
    // CreateGoal), the session is NOT idle — turnWorker is about to drive the
    // goal. Keep the active turn alive (as the already-active goal path does) so
    // those autonomous continuations stay cancelable and exclude concurrent
    // turns; turnWorker releases it after the drive.
    if (
      standalone &&
      this.currentId === turnId &&
      this.agent.goal.getGoal().goal?.status !== 'active'
    ) {
      this.activeTurn = null;
    }
    if (this.agent.swarmMode.shouldAutoExit) {
      this.agent.swarmMode.exit();
    }
    if (errorEvent !== undefined) {
      this.agent.emitEvent(errorEvent);
    }
    if (ended.reason !== 'completed') {
      this.trackTurnInterrupted(turnId, this.currentStepByTurn.get(turnId) ?? this.currentStep);
    }
    this.telemetryModeByTurn.delete(turnId);
    this.currentStepByTurn.delete(turnId);
    this.interruptedTelemetryTurnIds.delete(turnId);
    this.stepFailureByTurn.delete(turnId);
    return { event: ended, stopReason: completedStopReason, blockedByUserPromptHook };
  }

  private async applyUserPromptHook(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<PromptHookEndResult | undefined> {
    if (origin.kind !== 'user') return undefined;
    signal.throwIfAborted();
    const promptHookResults = await this.agent.hooks?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();
    const blockResult = renderUserPromptHookBlockResult(promptHookResults);
    if (blockResult !== undefined) {
      this.agent.context.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blockResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      });
      this.agent.emitEvent({
        type: 'hook.result',
        turnId,
        hookEvent: blockResult.event,
        content: blockResult.message,
        blocked: true,
      });
      // 终端 turn.ended 由 runOneTurn（与 activeTurn 清除同步）发出，
      // 而不是在这里，因此会话在触发时即变为空闲。
      return {
        event: { type: 'turn.ended', turnId, reason: 'completed', durationMs: Date.now() - startedAt },
        blocked: true,
      };
    }

    const hookResult = renderUserPromptHookResult(promptHookResults);
    if (hookResult === undefined) return undefined;

    this.agent.context.appendUserMessage([{ type: 'text', text: hookResult.text }], {
      kind: 'hook_result',
      event: 'UserPromptSubmit',
    });
    this.agent.emitEvent({
      type: 'hook.result',
      turnId,
      hookEvent: hookResult.event,
      content: hookResult.message,
    });
    return undefined;
  }

  private async runStepLoop(turnId: number, signal: AbortSignal): Promise<LoopTurnStopReason> {
    let stopHookContinuationUsed = false;
    let goalOutcomeMessageContinuationUsed = false;
    const deduper = new ToolCallDeduplicator({ telemetry: this.agent.telemetry });
    await this.agent.mcp?.waitForInitialLoad(signal);
    // 在轮次开始时展示活跃目标（仅追加；无活跃目标时无操作）。
    // 每个目标继续是其自己的轮次，因此每轮次而非每步骤重新注入提醒，
    // 以保持提示缓存。
    await this.agent.injection.injectGoal();
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.kimiConfig?.loopControl;
      let stopForGoalBudget = false;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm: this.agent.llm,
          buildMessages: () => this.agent.context.messages,
          dispatchEvent: this.buildDispatchEvent(turnId),
          tools: this.agent.tools.loopTools,
          log: this.agent.log,
          maxSteps: loopControl?.maxStepsPerTurn,
          maxRetryAttempts: loopControl?.maxRetriesPerStep,
          recordStepUsage: async (usage) => {
            try {
              const snapshot = await this.agent.goal.recordTokenUsage(grandTotal(usage));
              stopForGoalBudget = snapshot?.budget.overBudget === true;
            } catch (error) {
              this.agent.log.warn('goal token accounting failed', { error });
            }
          },
          hooks: {
            beforeStep: async ({ signal: stepSignal }) => {
              this.flushSteerBuffer();
              this.agent.microCompaction.detect();
              await this.agent.fullCompaction.beforeStep(stepSignal);
              await this.agent.injection.inject();
              deduper.beginStep();
              return;
            },
            afterStep: async ({ usage }) => {
              this.agent.usage.record(model, usage, 'turn');
              await this.agent.fullCompaction.afterStep();
              deduper.endStep();
              return stopForGoalBudget ? { stopTurn: true } : undefined;
            },
            // oxlint-disable-next-line no-loop-func -- 停止钩子继续状态限定于此轮次。
            shouldContinueAfterStop: async (ctx) => {
              const { signal } = ctx;
              // 1. 刷新所有引导的用户消息。
              if (this.flushSteerBuffer()) return { continue: true };
              signal.throwIfAborted();

              // 2. 在 UpdateGoal 标记目标为终止后，在轮次结束前要求模型
              //    输出一个面向用户的最终结果消息。
              if (
                !goalOutcomeMessageContinuationUsed &&
                isGoalOutcomeReminderOrigin(this.agent.context.history.at(-1)?.origin)
              ) {
                goalOutcomeMessageContinuationUsed = true;
                if (!hasStepBudgetRemaining(loopControl?.maxStepsPerTurn, ctx.stepNumber)) {
                  this.agent.context.popMatchedMessage(isGoalOutcomeReminderOrigin);
                  return { continue: false };
                }
                return { continue: true };
              }

              // 3. 外部 Stop 钩子恰好获得一次继续；上限有意独立于（且不限制）目标模式。
              if (!stopHookContinuationUsed) {
                const stopBlock = await this.agent.hooks?.triggerBlock('Stop', {
                  signal,
                  inputData: { stopHookActive: stopHookContinuationUsed },
                });
                signal.throwIfAborted();
                if (stopBlock !== undefined) {
                  stopHookContinuationUsed = true;
                  this.agent.context.appendUserMessage(
                    [{ type: 'text', text: stopBlock.reason }],
                    {
                      kind: 'system_trigger',
                      name: 'stop_hook',
                    },
                  );
                  return { continue: true };
                }
              }

              // 4. 否则停止。目标继续不再在此驱动：
              //    每个目标轮次是一个普通轮次，目标驱动器在此结束后决定是否运行另一个。
              return { continue: false };
            },
            prepareToolExecution: async (ctx) => {
              const cached = deduper.checkSameStep(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
              );
              if (cached !== null) return { syntheticResult: cached };
              return undefined;
            },
            authorizeToolExecution: async (ctx) => {
              return this.agent.permission.beforeToolCall(ctx);
            },
            finalizeToolResult: async (ctx) => {
              // 在触发 PostToolUse 钩子之前解决去重，以便同一步骤的重复
              // （其 ctx.result 是去重占位符）报告原始的真实结果，而不是空成功。
              const finalResult = await deduper.finalizeResult(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.result,
              );
              const { isError, output } = finalResult;
              const event = isError === true ? 'PostToolUseFailure' : 'PostToolUse';
              void this.agent.hooks?.fireAndForgetTrigger(event, {
                matcherValue: ctx.toolCall.name,
                inputData: {
                  toolName: ctx.toolCall.name,
                  toolInput: toolInputRecord(ctx.args),
                  toolCallId: ctx.toolCall.id,
                  error: isError === true ? toKimiErrorPayload(toolOutputText(output)) : undefined,
                  toolOutput: isError === true ? undefined : toolOutputText(output).slice(0, 2000),
                },
              });
              return budgetToolResultForModel({
                homedir: this.agent.homedir,
                toolName: ctx.toolCall.name,
                toolCallId: ctx.toolCall.id,
                result: finalResult,
              });
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        if (
          error instanceof APIContextOverflowError ||
          (isKimiError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
        ) {
          await this.agent.fullCompaction.handleOverflowError(signal, error);
          continue; // 使用压缩后的上下文重试
        }
        if (isMaxStepsExceededError(error)) {
          this.agent.log.warn('turn hit max steps', {
            turnId,
            steps: this.currentStepByTurn.get(turnId) ?? this.currentStep,
            limit: isKimiError(error) ? error.details?.['maxSteps'] : undefined,
          });
        } else {
          this.agent.log.error('turn failed', { turnId, error });
        }
        throw error;
      }
    }
  }

  /**
   * 构建轮次步骤循环的事件分发器。将低级循环事件（步骤边界、工具调用、
   * 流式增量）同时翻译为会话记录和公共 `AgentEvent` 接口。
   */
  private buildDispatchEvent(turnId: number) {
    return createLoopEventDispatcher({
      appendTranscriptRecord: async (event: LoopRecordedEvent) => {
        this.agent.context.appendLoopEvent(event);
      },
      emitLiveEvent: (event: LoopEvent) => {
        this.noteFirstRequestEvent(event);
        this.trackLoopTelemetry(event, turnId);
        const mapped = mapLoopEvent(event, turnId);
        if (mapped !== undefined) this.agent.emitEvent(mapped);
      },
    });
  }

  /**
   * 在第一个有意义的 LLM 输出事件（内容、工具调用或步骤结束）时解析
   * `firstRequest` promise。这会解除等待 `waitForTurnFirstRequest()` 的调用者。
   */
  private noteFirstRequestEvent(event: LoopEvent): void {
    switch (event.type) {
      case 'step.end':
      case 'content.part':
      case 'tool.call':
      case 'text.delta':
      case 'thinking.delta':
      case 'tool.call.delta': {
        const active = this.activeTurn;
        if (active === null || active === 'resuming') return;
        active.firstRequest.resolve();
        return;
      }
      default:
        return;
    }
  }

  /**
   * 将循环事件路由到适当的遥测跟踪器：步骤开始（用于步骤计数器）、
   * 轮次中断（用于中断指标）和工具生命周期（用于工具调用持续时间和结果跟踪）。
   */
  private trackLoopTelemetry(event: LoopEvent, turnId: number): void {
    if (event.type === 'step.begin') {
      this.beginTrackedStep(turnId, event.step);
      return;
    }
    if (event.type === 'turn.interrupted') {
      if (event.reason === 'error' && event.activeStep !== undefined) {
        this.stepFailureByTurn.set(turnId, event);
      }
      this.trackTurnInterrupted(turnId, interruptedStep(event));
      return;
    }
    this.trackToolLifecycle(event, turnId);
  }

  /** 记录每轮次和全局步骤跟踪的当前步骤号。 */
  private beginTrackedStep(turnId: number, step: number): void {
    this.currentStepByTurn.set(turnId, step);
    this.currentStep = step;
    if (!this.stepToolCallKeys.has(step)) {
      this.stepToolCallKeys.set(step, new Set());
    }
  }

  /**
   * 跟踪工具调用的开始/结束时间戳并对每个调用的重复状态进行分类。
   * 在 `tool.result` 时发出包含持续时间、结果和去重类型维度的
   * `tool_call` 遥测事件。
   */
  private trackToolLifecycle(event: LoopEvent, turnId: number): void {
    if (event.type === 'tool.call') {
      const dupType = this.trackDuplicateToolCall(turnId, event.step, event.name, event.args);
      this.toolCallDupType.set(
        event.toolCallId,
        dupType === 'cross_step' ? 'cross_step' : 'normal',
      );
      this.toolCallStartedAt.set(event.toolCallId, {
        name: event.name,
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type === 'tool.result') {
      const started = this.toolCallStartedAt.get(event.toolCallId);
      if (started === undefined) return;
      this.toolCallStartedAt.delete(event.toolCallId);
      const dupType = this.toolCallDupType.get(event.toolCallId) ?? 'normal';
      this.toolCallDupType.delete(event.toolCallId);
      const outcome = telemetryToolOutcome(event.result);
      const properties: Record<string, TelemetryPropertyValue> = {
        tool_name: started.name,
        outcome,
        duration_ms: Date.now() - started.startedAt,
        dup_type: dupType,
      };
      const errorType = outcome === 'error' ? telemetryToolErrorType(event.result) : undefined;
      if (errorType !== undefined) {
        properties['error_type'] = errorType;
      }
      this.agent.telemetry.track('tool_call', properties);
    }
  }

  /**
   * 检查工具调用是否与同一步骤中更早看到的（`same_step`）或
   * 在先前步骤中看到的（`cross_step`）重复。为重复发出
   * `tool_call_dedup_detected` 遥测事件并返回分类，以便调用者
   * 可以标记工具调用的遥测。
   */
  private trackDuplicateToolCall(
    turnId: number,
    step: number,
    toolName: string,
    args: unknown,
  ): 'normal' | 'same_step' | 'cross_step' {
    const argsText = canonicalTelemetryArgs(args);
    const key = `${toolName}\u0000${argsText}`;
    const stepKeys = this.stepToolCallKeys.get(step) ?? new Set<string>();
    this.stepToolCallKeys.set(step, stepKeys);

    let dupType: 'same_step' | 'cross_step' | undefined;
    if (stepKeys.has(key)) {
      dupType = 'same_step';
    } else if (this.hasPriorStepToolCallKey(step, key)) {
      dupType = 'cross_step';
    }

    stepKeys.add(key);
    if (dupType === undefined) return 'normal';

    this.agent.telemetry.track('tool_call_dedup_detected', {
      turn_id: turnId,
      step_no: step,
      tool_name: toolName,
      dup_type: dupType,
      args_hash: createHash('sha256').update(argsText).digest('hex').slice(0, 8),
    });
    return dupType;
  }

  /** 如果给定的去重键在 `step` 之前的任何步骤中出现过则返回 `true`。 */
  private hasPriorStepToolCallKey(step: number, key: string): boolean {
    for (const [seenStep, keys] of this.stepToolCallKeys) {
      if (seenStep !== step && keys.has(key)) return true;
    }
    return false;
  }

  /** 每个轮次发出一个 `turn_interrupted` 遥测事件（通过 `interruptedTelemetryTurnIds` 去重）。 */
  private trackTurnInterrupted(turnId: number, atStep: number): void {
    if (this.interruptedTelemetryTurnIds.has(turnId)) return;
    this.interruptedTelemetryTurnIds.add(turnId);
    this.agent.telemetry.track('turn_interrupted', {
      mode: this.telemetryModeByTurn.get(turnId) ?? this.telemetryMode(),
      at_step: atStep,
    });
  }

  /** 根据计划模式是否活跃返回遥测维度值。 */
  private telemetryMode(): 'agent' | 'plan' {
    return this.agent.planMode.isActive ? 'plan' : 'agent';
  }

  /** API 错误遥测仅在轮次因步骤级错误（非用户取消）中断时发出。 */
  private shouldTrackApiError(turnId: number): boolean {
    const failure = this.stepFailureByTurn.get(turnId);
    return failure?.reason === 'error' && failure.activeStep !== undefined;
  }
}

/** 当消息来源是目标驱动器注入的目标完成/阻塞提醒时返回 `true`。 */
function isGoalOutcomeReminderOrigin(origin: PromptOrigin | undefined): boolean {
  return (
    origin?.kind === 'system_trigger' &&
    (origin.name === GOAL_COMPLETION_REMINDER_NAME ||
      origin.name === GOAL_BLOCKED_REMINDER_NAME)
  );
}

/** 当步骤预算未限制或未耗尽时返回 `true`。 */
function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

/**
 * 将步骤循环中的低级 `LoopEvent` 映射为面向外部消费者（RPC 层、TUI）
 * 的公共 `AgentEvent`。对于没有公共对应物的事件（如 `content.part`）
 * 返回 `undefined`。
 */
function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

/**
 * 将异常规范化为适用于 `turn.ended` 和错误事件的 `KimiErrorPayload`。
 * 将原始的"模型未配置"消息替换为用户可操作的登录提示。
 */
function summarizeTurnError(error: unknown, turnId: number): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  const details = { ...payload.details, turnId };

  // 为模型未配置替换为更友好的 TUI 感知消息。
  // 原始的 "Model not set" / "Provider not set" 文本不可操作；
  // 此字符串引导用户进入登录流程。
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

/**
 * 将错误负载映射为人类可读的目标暂停原因字符串。前缀编码了
 * 失败类别（速率限制、连接、认证、API、模型配置、运行时），
 * 以便目标存储可以显示有意义的状态。
 */
function goalFailurePauseReason(error: KimiErrorPayload | undefined): string {
  if (error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) return GOAL_RATE_LIMIT_PAUSE_REASON;
  if (error?.code === ErrorCodes.PROVIDER_CONNECTION_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_AUTH_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_AUTH_PAUSE_PREFIX, error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_API_ERROR) {
    return pauseReasonWithMessage(GOAL_PROVIDER_API_PAUSE_PREFIX, error.message);
  }
  if (
    error?.code === ErrorCodes.MODEL_NOT_CONFIGURED ||
    error?.code === ErrorCodes.MODEL_CONFIG_INVALID
  ) {
    return pauseReasonWithMessage(GOAL_MODEL_CONFIG_PAUSE_PREFIX, error.message);
  }
  return pauseReasonWithMessage(GOAL_RUNTIME_PAUSE_PREFIX, error?.message);
}

/** 将暂停原因前缀与可选的详细消息组合。 */
function pauseReasonWithMessage(prefix: string, message: string | undefined): string {
  return message === undefined || message.length === 0 ? prefix : `${prefix}: ${message}`;
}

/** 安全地将工具参数收窄为普通对象，用于钩子输入数据。 */
function toolInputRecord(args: unknown): Record<string, unknown> {
  return isPlainRecord(args) ? args : {};
}

/** 从工具结果的输出（字符串或 ContentPart 数组）中提取拼接的文本内容。 */
function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

/** 返回轮次中断时的步骤号。 */
function interruptedStep(event: LoopTurnInterruptedEvent): number {
  return event.activeStep ?? event.attemptedSteps;
}

/** 用于遥测维度的 API 错误的结构化分类。 */
interface ApiErrorClassification {
  /** 之一：rate_limit、auth、5xx_server、context_overflow、4xx_client、api、network、timeout、empty_response、other。 */
  readonly errorType: string;
  /** 从错误或摘要负载中可用的 HTTP 状态码。 */
  readonly statusCode?: number;
}

/**
 * 将 API 错误分类为遥测友好的类别。优先使用 HTTP 状态码，
 * 不可用时回退到错误码和错误类型启发式。
 */
function classifyApiError(error: unknown, summary: KimiErrorPayload): ApiErrorClassification {
  const statusCode = apiStatusCode(error) ?? summaryStatusCode(summary);
  if (statusCode !== undefined) {
    if (statusCode === 429) return { errorType: 'rate_limit', statusCode };
    if (statusCode === 401 || statusCode === 403) return { errorType: 'auth', statusCode };
    if (statusCode >= 500) return { errorType: '5xx_server', statusCode };
    if (isContextOverflowStatusError(statusCode, summary.message)) {
      return { errorType: 'context_overflow', statusCode };
    }
    if (statusCode >= 400) return { errorType: '4xx_client', statusCode };
    return { errorType: 'api', statusCode };
  }

  if (summary.code === ErrorCodes.PROVIDER_RATE_LIMIT) return { errorType: 'rate_limit' };
  if (summary.code === ErrorCodes.PROVIDER_AUTH_ERROR) return { errorType: 'auth' };
  if (summary.code === ErrorCodes.CONTEXT_OVERFLOW) return { errorType: 'context_overflow' };
  if (isApiConnectionError(error, summary)) return { errorType: 'network' };
  if (isApiTimeoutError(error, summary)) return { errorType: 'timeout' };
  if (isApiEmptyResponseError(error, summary)) return { errorType: 'empty_response' };
  return { errorType: 'other' };
}

/** 从错误对象中提取 HTTP 状态码（同时检查 `.statusCode` 和 `.status`）。 */
function apiStatusCode(error: unknown): number | undefined {
  if (error instanceof APIStatusError) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    return typeof statusCode === 'number' ? statusCode : undefined;
  }
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** 从错误负载的 `details.statusCode` 字段中提取状态码。 */
function summaryStatusCode(summary: KimiErrorPayload): number | undefined {
  const statusCode = summary.details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/** 类型守卫：检查错误是否是连接级 API 失败。 */
function isApiConnectionError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIConnectionError || summary.name === 'APIConnectionError';
}

/** 类型守卫：检查错误是否是 API 超时。 */
function isApiTimeoutError(error: unknown, summary: KimiErrorPayload): boolean {
  return (
    error instanceof APITimeoutError ||
    summary.name === 'APITimeoutError' ||
    summary.name === 'TimeoutError'
  );
}

/** 类型守卫：检查错误是否是空响应 API 失败。 */
function isApiEmptyResponseError(error: unknown, summary: KimiErrorPayload): boolean {
  return error instanceof APIEmptyResponseError || summary.name === 'APIEmptyResponseError';
}

/** 返回当前轮次消耗的总输入 token 数，如果尚未记录使用量则返回 `undefined`。 */
function currentTurnInputTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  return inputTotal(usage);
}

/** `tool.result` 循环事件的 `result` 字段，用于遥测分类。 */
type ToolTelemetryResult = Extract<LoopEvent, { type: 'tool.result' }>['result'];

/**
 * 将工具结果分类为 'success'、'error' 或 'cancelled'。已取消的结果
 * 是文本包含中止/取消关键字的错误 — 此区分帮助遥测将用户中断
 * 与真正的失败分开。
 */
function telemetryToolOutcome(result: ToolTelemetryResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolResultText(result).toLowerCase();
  return text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('manually interrupted')
    ? 'cancelled'
    : 'error';
}

/**
 * 将工具错误分类为遥测的特定类别：ToolNotFound、ToolInputError、
 * HookError、ToolBlocked 或通用 ToolError。
 */
function telemetryToolErrorType(result: ToolTelemetryResult): string {
  const text = toolResultText(result);
  if (text.startsWith('Tool "') && text.includes('" not found')) return 'ToolNotFound';
  if (text.startsWith('Invalid args for tool "')) return 'ToolInputError';
  if (text.includes('prepareToolExecution hook failed')) return 'HookError';
  if (text.includes('finalizeToolResult hook failed')) return 'HookError';
  if (text.includes('blocked')) return 'ToolBlocked';
  return 'ToolError';
}

/** 从工具结果中提取文本内容用于错误分类。 */
function toolResultText(result: ToolTelemetryResult): string {
  return toolOutputText(result.output);
}

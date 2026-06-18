/**
 * @module goal/index
 *
 * Agent 的目标模式管理。目标是 Agent 在多个 Turn 中持续追求的、
 * 可跟踪的持久目标，具有预算强制执行（token、Turn、挂钟时间）。
 * 目标生命周期包括创建、暂停、恢复、阻塞和完成，
 * 支持从持久化记录中完整重建状态。
 *
 * 由 {@link GoalMode} 拥有的持久目标模式状态。
 *
 * 每个 Agent 保持恰好一个当前目标，从该 Agent 的有序记录日志中重建。
 * 它拥有斜杠命令、模型工具和目标续行驱动所依赖的生命周期规则、预算计算和行为边界。
 */

import { randomUUID } from 'node:crypto';

import { ErrorCodes, KimiError } from '#/errors';
import type { Agent } from '..';
import type { AgentRecordOf } from '../records/types';
import {
  type TelemetryProperties,
} from '../../telemetry';

/** 目标名称的最大字符长度。 */
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

const GOAL_FORK_CLEARED_REMINDER = [
  'This fork does not have a current goal.',
  'Ignore earlier active-goal reminders from the source session.',
  'Handle requests normally unless the user starts a new goal.',
].join(' ');

/**
 * 目标的生命周期状态——刻意精简。持久记录只持有 `active`、`paused` 或 `blocked`；
 * `complete` 是瞬态的（宣布后即清除），永远不会落在磁盘上。恰好有一个运行状态、
 * 两个可恢复的"停止"状态和一个成功结果：
 *
 * | 状态       | 持久化 | 可恢复 | 设置者                             | 含义                                             |
 * |------------|--------|--------|------------------------------------|--------------------------------------------------|
 * | `active`   | 是     | (运行中) | createGoal / resumeGoal          | 目标驱动可以运行续行 Turn。                      |
 * | `paused`   | 是     | 是     | pauseGoal / pauseActiveGoal /    | 用户、中断、恢复或可重试的运行时停止将其停放；   |
 * |            |        |        | pauseOnInterrupt /               | 保持完整。                                       |
 * |            |        |        | normalizeAfterReplay             |                                                  |
 * | `blocked`  | 是     | 是     | markBlocked                      | 系统因某种 `reason` 停止了它。                   |
 * | `complete` | 否     | —      | markComplete                     | 成功——在消息中宣布，然后清除。                   |
 *
 * 只有 `active` 目标会推进：记账和续行 Turn 都依赖于 `status === 'active'`。
 * `paused` 和 `blocked` 是同一类事物——"驱动不运行续行 Turn，但目标完整
 * 且可通过 `/goal resume` 恢复"——区别仅在于*谁*停止了它（用户 vs 系统）
 * 和可读的 `reason`。没有单独的 `impossible`、`budget_limited`、`error` 或
 * `cancelled` 状态：不可实现的目标或耗尽的预算变为 `blocked(+reason)`，
 * 运行时/模型/Provider 故障变为 `paused(+reason)`，而 `cancelGoal` 完全丢弃记录。
 * 参见 {@link GoalMode} 了解设置器和每状态说明。
 */
export type GoalStatus =
  /**
   * 目标活跃且目标驱动可以为其运行续行 Turn。
   * 在创建（`createGoal`）和暂停/阻塞目标被恢复（`resumeGoal`）时设置。
   * 仅在此状态下进行 token/Turn/挂钟记账并运行续行 Turn。
   */
  | 'active'
  /**
   * 用户停止了目标但目标完整且可通过 `/goal resume` 恢复。
   * 通过三种方式到达：用户暂停（`pauseGoal`）；活跃 Turn 在执行中被中止
   * （如 Esc/关机）（`pauseOnInterrupt`）；或从磁盘恢复 Agent 时
   * `active` 目标不可能仍在运行而被降级（`normalizeAfterReplay`）；
   * 或运行时/模型/Provider 故障通过 `pauseActiveGoal` 停放了它。
   */
  | 'paused'
  /**
   * *系统*停止了对目标的追求，原因在 `terminalReason` 中携带：
   * 模型通过 `UpdateGoal('blocked')` 报告无法继续（外部阻碍或认为不可实现的目标）；
   * 或配置的硬预算（token/Turn/时间）已达上限。
   * 由模型的 `UpdateGoal` 中的 `markBlocked`、目标驱动中的预算检查和
   * prompt-hook 阻塞设置。
   * 与 `paused` 一样可恢复——`/goal resume` 重新激活它；
   * 普通消息仅运行一个正常 Turn 而不重新激活循环。
   * 在阻塞状态编辑目标会在下一个 Turn 生效。
   */
  | 'blocked'
  /**
   * 成功：模型通过 `UpdateGoal('complete')` 报告目标已达成。
   * 由 `markComplete` 设置。此状态是**瞬态**的——
   * `markComplete` 发出完成事件然后清除持久记录，
   * 因此目标框消失且 `complete` 永远不会落在磁盘上。
   */
  | 'complete';

/** 执行目标行为的角色。`cleared` 是记录操作，不是状态。 */
export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

/** 从 Agent 记录重建的内存目标状态。 */
interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  /** 已完成的 `active` 区间累计的活跃追求时间。 */
  wallClockMs: number;
  /**
   * 当前 `active` 区间的锚点（非活跃时为 undefined）。
   * 报告时将此后经过的实时时间加到 `wallClockMs` 上，
   * 因此即使在 Turn 中读取计时器也是正确的；当目标离开 `active` 时
   * 区间被折入 `wallClockMs`。Agent 恢复时重置。
   */
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  /** 已停止或已完成目标的可读原因。 */
  terminalReason?: string;
}

/** 通过快照和工具暴露的已计算预算视图。 */
export interface GoalBudgetReport {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

/** 当前目标的公开已计算视图。 */
export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
}

/** 目标读取操作和工具返回的包装器。 */
export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

/** 目标使用计数器在变更时刻的快照。 */
export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

/**
 * 描述 `goal.updated` 事件中的变更内容，以便 UI 渲染正确的视觉效果。
 * 仅快照刷新时省略（如仅移动徽标的 Turn 递增）。
 *
 * - `lifecycle`：状态转换——`paused` / `active`（恢复）/ `blocked`——
 *   渲染为低调的对话记录标记。
 * - `completion`：目标成功完成（唯一发布完成消息并清除记录的结果）。
 *   这取代了旧的 `terminal` 名称，在状态整合后 `terminal` 仅意味着
 *   `complete`——`blocked` 是可恢复的 `lifecycle` 变更，不是完成。
 */
export type GoalChangeKind = 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
}

interface GoalReasonInput {
  readonly reason?: string;
}

/**
 * 当前目标的单一持久拥有者。
 *
 * 生命周期规则（参见 {@link GoalStatus} 联合类型获取完整每状态映射）：
 * - 成功：`markComplete` 记录成功然后清除记录（瞬态）。
 *   模型通过 `UpdateGoal('complete')` 工具标记完成；Turn 驱动在 Turn 边界读取状态。
 *   `markComplete` 宣布然后清除记录。
 * - 任务停止：`markBlocked(reason)` 在模型无法继续、prompt-hook 阻塞
 *   或硬预算达到时设置 `blocked`。`blocked` 可恢复。
 * - 暂停：`pauseGoal`、`pauseActiveGoal` 和中断路径 `pauseOnInterrupt`
 *   设置 `paused`（可恢复）；`cancelGoal` 完全丢弃记录
 *   （无状态——这是 `/goal cancel` 执行的唯一移除操作）。
 * - 中止或失败的 Turn 不是终端的：它暂停目标，使其保持可恢复——
 *   镜像 `normalizeAfterReplay` 在 Agent 恢复时将 `active` 目标降级为 `paused`。
 */
export class GoalMode {
  private state: GoalState | undefined;

  constructor(private readonly agent: Agent) {
  }

  /**
   * 在 Agent 恢复时将回放的目标状态与运行时现实对账。
   *
   * `active` 目标在进程重启后不可能仍在运行（目标续行仅在活跃 Turn 内推进），
   * 因此被降级为 `paused`，需要 `/goal resume` 来重新启动工作。
   * `paused` 和 `blocked` 目标被保留（两者均可恢复）。任何游离的 `complete`
   * （应已跟随 `goal.clear`）被移除。
   */
  normalizeAfterReplay(): void {
    const state = this.state;
    if (state === undefined) return;

    state.wallClockResumedAt = undefined;

    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false, track: false });
      return;
    }

    if (state.status === 'active') {
      const reason = 'Paused after agent resume';
      this.applyStatus(state, 'paused');
      state.terminalReason = reason;
      this.persistState(state, { silent: true });
      this.appendStatusUpdate(state, 'runtime', reason);
      return;
    }

    // `paused` 和 `blocked` 目标保持完整（两者均可恢复）。
  }

  restoreCreate(record: AgentRecordOf<'goal.create'>): void {
    const state: GoalState = {
      goalId: record.goalId,
      objective: record.objective,
      completionCriterion: record.completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
    };
    this.state = state;
    this.agent.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change: { kind: 'created' },
    });
  }

  restoreUpdate(record: AgentRecordOf<'goal.update'>): void {
    const state = this.state;
    if (state === undefined) return;

    const status = record.status;
    if (status !== undefined) {
      state.status = status;
      state.wallClockResumedAt = undefined;
      state.terminalReason = status === 'active' ? undefined : record.reason;
    }
    if (record.turnsUsed !== undefined) state.turnsUsed = record.turnsUsed;
    if (record.tokensUsed !== undefined) state.tokensUsed = record.tokensUsed;
    if (record.wallClockMs !== undefined) {
      state.wallClockMs = record.wallClockMs;
      state.wallClockResumedAt = undefined;
    }
    if (record.budgetLimits !== undefined) state.budgetLimits = record.budgetLimits;
    if (status === undefined) return;

    this.agent.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change: status === 'complete'
        ? {
            kind: 'completion',
            status,
            reason: record.reason,
            stats: this.statsOf(state),
            actor: record.actor,
          }
        : {
            kind: 'lifecycle',
            status,
            reason: record.reason,
            actor: record.actor,
          },
    });
  }

  restoreClear(_record: AgentRecordOf<'goal.clear'>): void {
    this.state = undefined;
  }

  restoreForked(_record: AgentRecordOf<'forked'>): void {
    const hadGoal = this.state !== undefined;
    this.state = undefined;
    if (!hadGoal) return;
    this.agent.context.appendSystemReminder(GOAL_FORK_CLEARED_REMINDER, {
      kind: 'system_trigger',
      name: 'goal_fork_cleared',
    });
  }

  // --- 读取 -------------------------------------------------------------

  getGoal(): GoalToolResult {
    const state = this.state;
    return { goal: state === undefined ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  // --- 创建 -------------------------------------------------------------

  async createGoal(input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new KimiError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new KimiError(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
      );
    }

    const existing = this.state;
    if (existing !== undefined) {
      // 任何持久化的目标（active / paused / blocked）都完整且会阻塞新目标，
      // 除非设置了 `replace`；`complete` 永不持久化，因此此处不会观察到。
      // 这保护可恢复的 paused/blocked 目标不会被静默覆盖。
      if (input.replace !== true) {
        throw new KimiError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
      // 通过相同的内部清除路径清除前一个目标，以便在存储替换目标之前
      // 保持记录一致性。
      this.clearInternal('system');
    }

    const completionCriterion = normalizeCompletionCriterion(input.completionCriterion);
    const state: GoalState = {
      goalId: randomUUID(),
      objective,
      completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits: {},
    };

    this.persistState(state);
    this.agent.records.logRecord({
      type: 'goal.create',
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
    });
    this.trackGoalCreated(actor, input.replace === true);
    return this.toSnapshot(state);
  }

  // --- 用户拥有的生命周期 ---------------------------------------------

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new KimiError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  /**
   * 停放当前活跃目标，如果已停止则不抛出异常。运行时路径在轮次结束后
   * 使用此方法，此时用户可能已经暂停、清除或以其他方式更改了目标。
   */
  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async resumeGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new KimiError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    // 恢复是一次新的尝试：清除停止原因以便重新激活的目标从干净状态开始。
    state.terminalReason = undefined;
    this.applyStatus(state, 'active');
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'active', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async setBudgetLimits(
    input: { budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    state.budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.persistState(state);
    this.appendGoalUpdate({ budgetLimits: state.budgetLimits });
    this.track('goal_budget_set', {
      actor,
      ...budgetTelemetryProperties(input.budgetLimits),
    });
    return this.toSnapshot(state);
  }

  /**
   * 丢弃当前目标——唯一的面向用户"移除"操作（`/goal cancel`）。
   * 没有 `cancelled` 状态：取消操作清除持久记录并返回它移除的快照，
   * 以便调用方能报告被取消的内容。无目标时抛出异常。
   * （需要清除但不需要返回值的内部调用方——如 `createGoal` 替换
   * 已有目标——使用私有的 `clearInternal`。）
   */
  async cancelGoal(actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    this.clearInternal(actor);
    if (actor === 'user') {
      this.agent.context.appendSystemReminder(GOAL_CANCELLED_REMINDER, {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      });
    }
    return snapshot;
  }

  // --- 终态结果（系统决定）--------------------------------------------

  /**
   * 将目标标记为 `blocked`：系统因 `reason` 停止了追求——
   * 模型的 `UpdateGoal('blocked')`（包括认为不可实现的目标）、
   * 目标驱动器达到的硬预算，或提示钩子阻塞。
   * `blocked` 是持久化的且**可恢复**——通过 `/goal resume` 恢复
   * （它是 `paused` 的同级，而非死胡同），因此发出 `lifecycle` 变更。
   * 对于不存在或非活跃的目标无操作，因此用户的暂停/清除永远不会被覆盖。
   */
  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'blocked');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  /**
   * 记录目标成功，然后清除持久记录。`complete` 是瞬态的：
   * 记录并发出携带最终统计的终端 `complete` 变更
   * （以便 UI/调用方渲染结果），然后清除目标使框消失。
   * 返回最终快照（状态 `complete`）。对于不存在或非活跃的目标无操作。
   */
  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'complete');
    state.terminalReason = input.reason;
    const snapshot = this.toSnapshot(state);
    // 在清除之前记录 + 通知 UI 完成（含最终统计）。
    this.appendStatusUpdate(state, actor, input.reason);
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason: input.reason,
      stats: this.statsOf(state),
      actor,
    });
    // ...然后清除持久记录（发出 onGoalUpdated(null) → 框清除）。
    this.clearInternal(actor);
    return snapshot;
  }

  // --- 用户中断转换 ----------------------------------------------------

  /**
   * 当活跃目标的实时轮次被中止（Esc、关机或任何其他轮次级取消）时停放目标。
   * 这**不是**终态：目标变为 `paused` 并保持可通过 `/goal resume` 恢复，
   * 镜像 `normalizeAfterReplay` 在 Agent 恢复时降级 `active` 目标的行为。
   * 对于不存在或已非活跃的目标无操作，因此用户的暂停/清除或
   * 已停止的目标永远不会被覆盖。
   */
  async pauseOnInterrupt(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(input, 'user');
  }

  // --- 记账与报告 -------------------------------------------------------

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const delta = Math.max(0, tokenDelta);
    state.tokensUsed += delta;
    this.persistState(state, { silent: true }); // 逐步记账：不更新 UI
    this.appendGoalUpdate({ tokensUsed: state.tokensUsed });
    return this.toSnapshot(state);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    this.persistState(state);
    this.appendGoalUpdate({ turnsUsed: state.turnsUsed });
    this.track('goal_continued', {
      turns_used: state.turnsUsed,
    });
    return this.toSnapshot(state);
  }

  // --- 内部实现 ----------------------------------------------------------

  private clearInternal(
    actor: GoalActor,
    opts: { emit?: boolean; track?: boolean } = {},
  ): void {
    const state = this.state;
    if (state === undefined) return; // idempotent
    this.persistState(undefined, { silent: opts.emit === false });
    this.agent.records.logRecord({ type: 'goal.clear' });
    if (opts.track !== false) {
      this.track('goal_cleared', { actor });
    }
  }

  private appendStatusUpdate(state: GoalState, actor: GoalActor, reason?: string): void {
    this.appendGoalUpdate({
      status: state.status,
      reason,
      wallClockMs: liveWallClockMs(state, Date.now()),
      actor,
    });
    this.track('goal_status_changed', {
      actor,
      status: state.status,
      turns_used: state.turnsUsed,
      tokens_used: state.tokensUsed,
      wall_clock_ms: liveWallClockMs(state, Date.now()),
      ...budgetTelemetryProperties(state.budgetLimits),
    });
  }

  private appendGoalUpdate(
    update: Omit<AgentRecordOf<'goal.update'>, 'type' | 'time'>,
  ): void {
    this.agent.records.logRecord({
      type: 'goal.update',
      ...update,
    });
  }

  private trackGoalCreated(
    actor: GoalActor,
    replace: boolean,
  ): void {
    this.track('goal_created', {
      actor,
      replace,
    });
  }

  private track(event: string, properties: TelemetryProperties): void {
    this.agent.telemetry.track(event, properties);
  }

  private applyStatus(
    state: GoalState,
    status: GoalStatus,
  ): void {
    // 离开 `active` 时将实时挂钟区间折入累计总额，进入 `active` 时锚定新区间，
    // 以便 `wallClockMs` 在暂停/恢复/完成期间保持正确的、可持久化的总额。
    const now = Date.now();
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      state.wallClockMs += Math.max(0, now - state.wallClockResumedAt);
      state.wallClockResumedAt = undefined;
    }
    if (status === 'active') {
      state.wallClockResumedAt = now;
    }
    state.status = status;
  }

  private requireState(): GoalState {
    const state = this.state;
    if (state === undefined) {
      throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }


  /**
   * 更新内存目标状态，除非 `silent`，否则发出带结果快照的 `goal.updated` 事件。
   * `silent` 用于逐步 token / 挂钟记账，避免每步更新 UI。
   */
  private persistState(
    state: GoalState | undefined,
    opts: { silent?: boolean; change?: GoalChange } = {},
  ): void {
    this.state = state;
    if (opts.silent !== true) {
      this.emitGoalUpdated(state === undefined ? null : this.toSnapshot(state), opts.change);
    }
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.agent.emitEvent({ type: 'goal.updated', snapshot, change });
  }

  /** {@link GoalChange} 的计数器快照。 */
  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
      budget: computeBudgetReport(state, Date.now()),
      terminalReason: state.terminalReason,
    };
  }
}

/**
 * 实时活跃追求时间：累计总额加上进行中的 `active` 区间。
 * 即使在 Turn 中读取也是正确的（区间在目标离开 `active` 之前
 * 不会被折入 `wallClockMs`）。
 */
function liveWallClockMs(state: GoalState, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, now - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

function computeBudgetReport(
  state: GoalState,
  now: number = Date.now(),
): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function budgetTelemetryProperties(limits: GoalBudgetLimits): TelemetryProperties {
  return {
    has_token_budget: limits.tokenBudget !== undefined,
    has_turn_budget: limits.turnBudget !== undefined,
    has_wall_clock_budget: limits.wallClockBudgetMs !== undefined,
  };
}

function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

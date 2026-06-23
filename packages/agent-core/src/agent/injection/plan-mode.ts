/**
 * 计划模式注入器。
 *
 * 管理周期性的系统提醒，强制只读行为并引导模型完成计划模式工作流
 * （理解 → 设计 → 审查 → 编写计划 → 退出）。处理进入、退出和上下文恢复的
 * 状态转换，并通过去重机制避免重复注入。
 *
 * @module plan-mode
 */

import type { PlanFilePath } from '../plan';
import { DynamicInjector } from './injector';

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;

/**
 * 计划模式提醒变体。
 *
 * - `full` — 用于首次提醒以及每隔 {@link PLAN_MODE_FULL_REFRESH_TURNS} 个
 *   助手轮次的周期性刷新。
 * - `sparse` — 在完整提醒之间的轻量级保活提醒，在经过
 *   {@link PLAN_MODE_DEDUP_MIN_TURNS} 个助手轮次后开始触发。
 * - `reentry` — 当恢复的规划会话已包含计划内容时使用一次，
 *   使模型在继续之前先读取现有计划。
 */
export type PlanModeVariant = 'full' | 'sparse' | 'reentry';

/**
 * 向代理上下文注入计划模式提醒。
 *
 * 当计划模式激活时，注入器会周期性地追加系统提醒，强制只读行为并引导模型
 * 完成"理解 → 设计 → 审查 → 编写计划 → 退出"的工作流。提醒经过去重处理：
 * 进入时注入一次完整提醒，之后每隔 {@link PLAN_MODE_FULL_REFRESH_TURNS} 个
 * 助手轮次注入一次完整提醒，中间穿插轻量级的稀疏提醒。当恢复的会话已包含
 * 计划内容时，使用重入提醒。
 *
 * 退出计划模式时注入一次性的退出提醒以解除只读限制。上下文清除时，
 * 注入器会记住计划模式是否处于激活状态，以便发出重入提醒而非全新的完整提醒。
 */
export class PlanModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'plan_mode';

  /** 最近一次上下文清除前计划模式是否处于激活状态。 */
  private wasActive = false;

  /**
   * 记住上下文清除前计划模式是否处于激活状态，以便下一次 `getInjection`
   * 调用可以发出重入提醒，而非将其视为全新的计划模式进入。
   */
  override onContextClear(): void {
    super.onContextClear();
    this.wasActive = this.agent.planMode.isActive;
  }

  /**
   * 为当前周期生成适当的计划模式提醒。处理三种状态转换：
   * 进入计划模式（完整或重入提醒）、保持计划模式（根据轮次节奏返回
   * 完整、稀疏或 null）、退出计划模式（一次性退出提醒）。
   */
  override async getInjection(): Promise<string | undefined> {
    const { isActive, planFilePath } = this.agent.planMode;
    if (!isActive) {
      if (!this.wasActive) {
        return undefined;
      }
      this.wasActive = false;
      this.injectedAt = null;
      return exitReminder();
    }
    if (!this.wasActive) {
      this.injectedAt = null;
      this.wasActive = true;
      if (await this.hasCurrentPlanContent()) {
        return reentryReminder(planFilePath);
      }
    }
    const variant = this.getVariant();
    if (variant === null) return undefined;

    return variant === 'full'
      ? fullReminder(planFilePath)
      : variant === 'sparse'
        ? sparseReminder(planFilePath)
        : reentryReminder(planFilePath);
  }

  /**
   * 根据自上次注入以来的助手轮次数，决定注入哪种提醒变体。如果轮次数太少，
   * 连稀疏提醒都不值得触发，则返回 `null`（跳过），以防止连续快速的重复注入。
   */
  protected getVariant(): PlanModeVariant | null {
    if (this.injectedAt === null) return 'full';
    const history = this.agent.context.history;
    let assistantTurnsSince = 0;
    for (let i = this.injectedAt + 1; i < history.length; i++) {
      const msg = history[i];
      if (msg === undefined) continue;
      if (msg.role === 'assistant') {
        assistantTurnsSince += 1;
        continue;
      }
      if (msg.role === 'user') {
        return 'full';
      }
    }
    if (assistantTurnsSince >= PLAN_MODE_FULL_REFRESH_TURNS) return 'full';
    if (assistantTurnsSince >= PLAN_MODE_DEDUP_MIN_TURNS) return 'sparse';
    return null;
  }

  /**
   * 检查代理的计划文件是否已有内容，用于在计划模式于当前上下文中首次激活时
   * 决定使用完整进入提醒还是重入提醒。
   */
  private async hasCurrentPlanContent(): Promise<boolean> {
    try {
      const data = await this.agent.planMode.data();
      return data !== null && data.content.trim().length > 0;
    } catch {
      return false;
    }
  }
}
function withPlanFileFooter(body: string, planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) return body;
  return `${body}\n\nPlan file: ${planFilePath}`;
}

function fullReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineFullReminder();
  }

  const body = `Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

Workflow:
  1. Understand — explore the codebase with Glob, Grep, Read.
  2. Design — converge on the best approach; consider trade-offs but aim for a single recommendation.
  3. Review — re-read key files to verify understanding.
  4. Write Plan — modify the plan file with Write or Edit. Use Write if the plan file does not exist yet.
  5. Exit — call ExitPlanMode for user approval.

## Handling multiple approaches
Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations — if one approach is clearly superior, just propose that one.
When the best approach depends on user preferences, constraints, or context you don't have, use AskUserQuestion to clarify first. This helps you write a better, more targeted plan rather than dumping multiple options for the user to sort through.
When you do include multiple approaches in the plan, you MUST pass them as the \`options\` parameter when calling ExitPlanMode, so the user can select which approach to execute at approval time.
NEVER write multiple approaches in the plan and call ExitPlanMode without the \`options\` parameter — the user will only see the default approval controls with no way to choose a specific approach.

AskUserQuestion is for clarifying missing requirements or user preferences that affect the plan.
Never ask about plan approval via text or AskUserQuestion.
Your turn must end with either AskUserQuestion (to clarify requirements or preferences) or ExitPlanMode (to request plan approval). Do NOT end your turn any other way.
Do NOT use AskUserQuestion to ask about plan approval or reference "the plan" — the user cannot see the plan until you call ExitPlanMode.`;
  return withPlanFileFooter(body, planFilePath);
}

function sparseReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineSparseReminder();
  }

  const body = `Plan mode still active (see full instructions earlier). Prefer read-only tools except the current plan file. Use Write or Edit to modify the plan file. If it does not exist yet, create it with Write first. Use Bash only when needed; Bash follows the normal permission mode and rules. Use AskUserQuestion to clarify user preferences when it helps you write a better plan. If the plan has multiple approaches, pass options to ExitPlanMode so the user can choose. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval). Never ask about plan approval via text or AskUserQuestion.`;
  return withPlanFileFooter(body, planFilePath);
}

function reentryReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return inlineReentryReminder();
  }

  const body = `Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

## Re-entering Plan Mode
A plan file from a previous planning session already exists.
Before proceeding:
  1. Read the existing plan file to understand what was previously planned.
  2. Evaluate the user's current request against that plan.
  3. If different task: replace the old plan with a fresh one. If same task: update the existing plan.
  4. You may use Write or Edit to modify the plan file. If the file does not exist yet, create it with Write first.
  5. Use AskUserQuestion to clarify missing requirements or user preferences that affect the plan.
  6. Always edit the plan file before calling ExitPlanMode.

Your turn must end with either AskUserQuestion (to clarify requirements) or ExitPlanMode (to request plan approval).`;
  return withPlanFileFooter(body, planFilePath);
}

function inlineFullReminder(): string {
  return `Plan mode is active. You MUST NOT make any edits or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

Workflow:
  1. Understand — explore the codebase with Glob, Grep, Read.
  2. Design — converge on the best approach; consider trade-offs but aim for a single recommendation.
  3. Review — re-read key files to verify understanding.
  4. Wait for the host to provide a plan file path, write the plan there, then call ExitPlanMode.

## Handling multiple approaches
Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations — if one approach is clearly superior, just propose that one.
When the best approach depends on user preferences, constraints, or context you don't have, use AskUserQuestion to clarify first.
When you do include multiple approaches in the plan, you MUST pass them as the \`options\` parameter when calling ExitPlanMode, so the user can select which approach to execute at approval time.

AskUserQuestion is for clarifying missing requirements or user preferences that affect the plan.
Never ask about plan approval via text or AskUserQuestion.
Your turn must end with either AskUserQuestion (to clarify requirements or preferences) or ExitPlanMode (to request plan approval). Do NOT end your turn any other way.`;
}

function inlineSparseReminder(): string {
  return `Plan mode still active (see full instructions earlier). Read-only; no plan file path is available in this host. Wait for the host to provide a plan file path before calling ExitPlanMode. Use AskUserQuestion to clarify user preferences when it helps you write a better plan. If the plan has multiple approaches, pass options to ExitPlanMode so the user can choose. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for approval).`;
}

function inlineReentryReminder(): string {
  return `Plan mode is active. You MUST NOT make any edits or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use Bash only when needed; Bash follows the normal permission mode and rules. This supersedes any other instructions you have received.

## Re-entering Plan Mode
No plan file path is available in this host.
Before proceeding:
  1. Re-evaluate the user request and any existing conversation context.
  2. Use AskUserQuestion to clarify missing requirements or user preferences that affect the plan.
  3. Wait for the host to provide a plan file path, write the revised plan there, then call ExitPlanMode.

Your turn must end with either AskUserQuestion (to clarify requirements) or ExitPlanMode (to request plan approval).`;
}

function exitReminder(): string {
  return `Plan mode is no longer active. The read-only and plan-file-only restrictions from plan mode no longer apply. Continue with the approved plan using the normal tool and permission rules.`;
}

/**
 * 批准精选的默认安全工具列表的策略。
 *
 * 这些工具对外部世界没有副作用——它们是只读操作（Read、Grep、Glob）、
 * UI 辅助工具（TodoList、TaskList）或内部状态管理器（Goal 工具、CronList）。
 * 默认批准它们可减少不必要的提示，同时将具有写入能力的工具保持在显式批准之后。
 *
 * 此策略在链中较晚运行，在所有拒绝/询问/模式策略之后，
 * 因此任何更早的策略仍然可以在需要时阻止这些工具。
 */

import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/** 无需用户确认即可安全批准的工具。 */
const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AskUserQuestion',
  'Skill',
  // 目标控制工具对外部世界没有副作用：GetGoal 是只读的，
  // 变更工具仅记录目标自身的运行时状态。
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
]);

/** 批准默认批准列表中工具的工具调用。 */
export class DefaultToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  /** 如果工具在默认批准集中则返回 `approve`；否则传递。 */
  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!DEFAULT_APPROVE_TOOLS.has(context.toolCall.name)) return;
    return {
      kind: 'approve',
    };
  }
}

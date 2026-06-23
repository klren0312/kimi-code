/**
 * 批准计划模式特定工具调用的策略。
 *
 * 当计划模式激活时，大多数写入工具被 {@link PlanModeGuardDenyPermissionPolicy} 阻止。
 * 此策略在该守卫之后运行，批准计划模式期间允许的特定工具：
 * - `EnterPlanMode`：始终批准（如果已在计划模式中则幂等）。
 * - 对计划文件本身的 `Write`/`Edit`：批准，以便 agent 可以迭代完善计划。
 * - `ExitPlanMode` 不带计划审查显示或计划为空时：直接批准
 *   （审查询问策略处理非空情况）。
 */

import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { writeFileAccesses } from './file-access-ask';

/** 批准计划模式期间允许的计划模式特定工具调用。 */
export class PlanModeToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'plan-mode-tool-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName === 'EnterPlanMode') {
      return {
        kind: 'approve',
      };
    }

    if (
      (toolName === 'Write' || toolName === 'Edit') &&
      this.agent.planMode.isActive &&
      writesOnlyPlanFile(context, this.agent.planMode.planFilePath)
    ) {
      return {
        kind: 'approve',
      };
    }

    if (toolName === 'ExitPlanMode') {
      if (!this.agent.planMode.isActive) {
        return {
          kind: 'approve',
        };
      }
      if (context.execution.display?.kind !== 'plan_review') {
        return {
          kind: 'approve',
        };
      }
      if (context.execution.display.plan.trim().length > 0) return;
      return {
        kind: 'approve',
      };
    }
  }
}

/** Checks whether all write accesses in the context target only the plan file. */
function writesOnlyPlanFile(
  context: PermissionPolicyContext,
  planFilePath: string | null,
): boolean {
  if (planFilePath === null) return false;
  const writeAccesses = writeFileAccesses(context);
  return writeAccesses.every((access) => access.path === planFilePath);
}

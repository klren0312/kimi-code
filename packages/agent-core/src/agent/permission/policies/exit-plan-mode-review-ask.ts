/**
 * 退出计划模式时呈现计划审查对话框的策略。
 *
 * 当 agent 调用 `ExitPlanMode` 且计划非空且显示类型为 `plan_review` 时，
 * 此策略拦截调用并请求用户批准、修改或拒绝计划。这是计划模式工作流的主要用户交互点。
 *
 * 此策略处理计划审查的完整生命周期：
 * - 批准：退出计划模式，将批准的计划作为合成输出返回。
 * - 拒绝并"拒绝并退出"：退出计划模式并报错。
 * - 拒绝并"修改"或反馈：保持计划模式并附带反馈。
 * - 关闭：静默保持计划模式。
 *
 * 在会话批准历史之前运行，以防止过时的会话批准绕过新计划内容的审查。
 */

import type { Agent } from '../..';
import type { ApprovalResponse, PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/** 与计划一起呈现的可选选项，用于结构化反馈。 */
interface ExitPlanModeOption {
  readonly label: string;
  readonly description: string;
}

/** 附加到 ExitPlanMode 执行上下文的计划审查显示数据。 */
interface PlanReviewDisplay {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly ExitPlanModeOption[] | undefined;
}

/**
 * 拦截 `ExitPlanMode` 调用以呈现计划审查对话框。
 * 追踪计划提交和解决结果的遥测数据。
 */
export class ExitPlanModeReviewAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'exit-plan-mode-review-ask';

  constructor(private readonly agent: Agent) {}

  /**
   * 当满足计划审查条件时返回带有 `resolveApproval` 回调的 `ask` 结果：
   * 非 auto 模式、计划模式激活、plan_review 显示、且计划内容非空。
   */
  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'ExitPlanMode') return;
    if (this.agent.permission.mode === 'auto') return;
    if (!this.agent.planMode.isActive) return;
    const display = context.execution.display;
    if (display?.kind !== 'plan_review') return;
    if (display.plan.trim().length === 0) return;
    this.agent.telemetry.track('plan_submitted', {
      has_options: display.options !== undefined && display.options.length >= 2,
    });
    return {
      kind: 'ask',
      reason: {
        has_options: display.options !== undefined,
      },
      resolveApproval: (result) =>
        this.exitPlanModeApprovalResult(result, {
          plan: display.plan,
          path: display.path,
          options: display.options,
        }),
    };
  }

  /**
   * 处理已批准的计划：退出计划模式，使用所选选项格式化已批准的计划，
   * 并将其作为合成工具输出返回。
   */
  private exitPlanModeApprovalResult(result: ApprovalResponse, display: PlanReviewDisplay) {
    if (result.decision !== 'approved') {
      return this.rejectedExitPlanModeApprovalResult(result);
    }

    const selected = selectedExitPlanModeOption(display.options, result.selectedLabel);

    const failed = this.exitPlanMode();
    if (failed !== undefined) {
      return { kind: 'result' as const, syntheticResult: failed };
    }

    if (result.selectedLabel !== undefined && result.selectedLabel.length > 0) {
      this.agent.telemetry.track('plan_resolved', {
        outcome: 'approved',
        chosen_option: result.selectedLabel,
      });
    } else {
      this.agent.telemetry.track('plan_resolved', { outcome: 'approved' });
    }

    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    const savedTo = display.path !== undefined ? `Plan saved to: ${display.path}\n\n` : '';
    const formattedPlan = `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${display.plan}`;
    return {
      kind: 'result' as const,
      syntheticResult: {
        isError: false,
        output: `Exited plan mode. ${optionPrefix}${formattedPlan}`,
      },
    };
  }

  /**
   * 处理被拒绝的计划：追踪解决结果，然后根据拒绝类型（关闭、拒绝并退出、
   * 修改或通用拒绝）返回适当的合成输出。
   */
  private rejectedExitPlanModeApprovalResult(result: ApprovalResponse) {
    this.trackRejectedPlanResolution(result);

    if (result.decision === 'cancelled') {
      return {
        kind: 'result' as const,
        syntheticResult: {
          isError: false,
          output: 'Plan approval dismissed. Plan mode remains active.',
        },
      };
    }

    if (result.selectedLabel === 'Reject and Exit') {
      const failed = this.exitPlanMode();
      return {
        kind: 'result' as const,
        syntheticResult:
          failed ?? {
            isError: true,
            stopTurn: true,
            output: 'Plan rejected by user. Plan mode deactivated.',
          },
      };
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      return {
        kind: 'result' as const,
        syntheticResult: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the plan. Feedback:\n\n${feedback}`
              : 'User requested revisions. Plan mode remains active.',
        },
      };
    }

    return {
      kind: 'result' as const,
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    };
  }

  /** 退出计划模式，如果退出失败则返回错误对象。 */
  private exitPlanMode(): { isError: true; output: string } | undefined {
    try {
      this.agent.planMode.exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        output: `Failed to exit plan mode: ${message}`,
      };
    }
  }

  /** 追踪被拒绝计划解决结果的遥测数据，按拒绝类型分类。 */
  private trackRejectedPlanResolution(result: ApprovalResponse): void {
    if (result.decision === 'cancelled') {
      this.agent.telemetry.track('plan_resolved', { outcome: 'dismissed' });
      return;
    }

    if (result.selectedLabel === 'Reject and Exit') {
      this.agent.telemetry.track('plan_resolved', { outcome: 'rejected_and_exited' });
      return;
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      this.agent.telemetry.track('plan_resolved', {
        outcome: 'revise',
        has_feedback: feedback.length > 0,
      });
      return;
    }

    this.agent.telemetry.track('plan_resolved', { outcome: 'rejected' });
  }
}

/** 从显示选项中按标签查找匹配的选项。 */
function selectedExitPlanModeOption(
  options: readonly ExitPlanModeOption[] | undefined,
  label: string | undefined,
): ExitPlanModeOption | undefined {
  if (options === undefined || label === undefined) return;
  return options.find((option) => option.label === label);
}

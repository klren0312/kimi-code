/**
 * 当 auto 模式激活时拒绝 `AskUserQuestion` 调用的策略。
 *
 * Auto 模式旨在无人值守运行。`AskUserQuestion` 工具会阻塞等待用户输入，
 * 违背了 auto 模式的目的。此策略显式阻止它，并指示 agent 独立做出合理决策。
 *
 * 此策略在链中早期运行（在 auto 模式全面批准之前），以确保拒绝优先于 auto 模式批准。
 */

import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/** 当 agent 处于 auto 模式时，拒绝 AskUserQuestion 工具调用。 */
export class AutoModeAskUserQuestionDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'auto-mode-ask-user-question-deny';

  constructor(private readonly agent: Agent) {}

  /** 在 auto 模式下对 AskUserQuestion 返回 `deny`；否则传递。 */
  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    if (context.toolCall.name !== 'AskUserQuestion') return;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    };
  }
}

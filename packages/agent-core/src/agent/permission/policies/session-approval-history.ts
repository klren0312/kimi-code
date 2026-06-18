/**
 * 自动批准匹配会话级批准模式的工具调用的策略。
 *
 * 当用户以"批准本次会话"范围批准工具调用时，权限管理器会记住规则模式。
 * 此策略将传入的工具调用与这些记忆的模式进行匹配，以避免在会话期间
 * 对相同的工具+参数组合再次提示用户。
 *
 * 在用户配置的询问规则之前运行，以确保显式的会话内授权
 * 始终优先于后续调用中仍然匹配的询问规则。
 */

import type { Agent } from '../..';
import {
  matchPermissionRule,
  type PermissionRuleMatch,
} from '../matches-rule';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';

/**
 * 批准匹配用户先前在会话期间批准的模式的工具调用。
 * 这可防止对用户已显式允许的工具重复显示批准提示。
 */
export class SessionApprovalHistoryPermissionPolicy implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.matchSessionApprovalRule(context);
    if (match === undefined) return;
    return {
      kind: 'approve',
      reason: {
        has_rule_args: match.hasRuleArgs,
        match_strategy: match.strategy,
      },
    };
  }

  /**
   * 遍历所有会话级批准模式（本地 + 从父级继承），
   * 返回第一个与当前工具调用匹配的结果。
   */
  private matchSessionApprovalRule(
    context: PermissionPolicyContext,
  ): PermissionRuleMatch | undefined {
    for (const pattern of this.agent.permission.sessionApprovalRulePatterns) {
      const match = matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return match;
    }
  }
}

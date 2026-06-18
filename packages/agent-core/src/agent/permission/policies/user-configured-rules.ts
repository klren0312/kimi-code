/**
 * 评估用户配置的权限规则的策略。
 *
 * 用户可以通过配置文件（项目级 `.kimi/permissions.json`、用户级设置）
 * 定义权限规则，具有三种可能的决策：`deny`、`allow` 和 `ask`。
 * 此模块提供三个具体策略——每种决策类型一个——加上一个处理规则过滤和匹配的共享抽象基类。
 *
 * 仅考虑具有"用户配置"作用域（`turn-override`、`project`、`user`）的规则；
 * 会话运行时规则由 {@link SessionApprovalHistoryPermissionPolicy} 单独处理。
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
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from '../types';

/** 源自用户配置（非会话运行时）的作用域。 */
const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>([
  'turn-override',
  'project',
  'user',
]);

/**
 * 用户配置规则策略的共享基类。将 agent 的规则集过滤为用户配置的作用域，
 * 并查找第一个匹配请求决策和工具调用上下文的规则。
 */
abstract class UserConfiguredPermissionPolicy {
  constructor(protected readonly agent: Agent) {}

  /**
   * 查找第一个具有给定决策且匹配工具调用的用户配置规则。
   * 如果没有规则匹配则返回 `undefined`，允许链中的下一个策略进行评估。
   */
  protected firstMatchingRule(
    context: PermissionPolicyContext,
    decision: PermissionRuleDecision,
  ): PermissionRuleMatch | undefined {
    const rules = this.agent.permission.data().rules.filter((rule): rule is PermissionRule =>
      USER_CONFIGURED_SCOPES.has(rule.scope),
    );
    for (const rule of rules) {
      if (rule.decision !== decision) continue;
      const match = matchPermissionRule({
        rule,
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return match;
    }
    return;
  }
}

/**
 * 拒绝匹配用户配置 `deny` 规则的工具调用。这是最高优先级的用户规则策略，
 * 因为拒绝必须始终优先于允许和询问，无论模式如何。
 */
export class UserConfiguredDenyPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-deny';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'deny');
    if (match === undefined) return;
    return {
      kind: 'deny',
      reason: userRuleReason('deny', match),
      message: formatPermissionRuleDenyMessage(
        context.toolCall.name,
        match.rule.reason,
        this.agent.type,
      ),
    };
  }
}

/**
 * 批准匹配用户配置 `allow` 规则的工具调用。在询问规则之后运行，
 * 以便显式的 `ask` 规则即使在 `allow` 规则也匹配时仍能提示用户。
 */
export class UserConfiguredAllowPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-allow';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'allow');
    if (match === undefined) return;
    return {
      kind: 'approve',
      reason: userRuleReason('allow', match),
    };
  }
}

/**
 * 当工具调用匹配用户配置的 `ask` 规则时请求用户批准。
 * 这对于通常安全但在某些参数模式下应提示的工具很有用
 * （例如 `Write(/etc/**)`）。
 */
export class UserConfiguredAskPermissionPolicy
  extends UserConfiguredPermissionPolicy
  implements PermissionPolicy
{
  readonly name = 'user-configured-ask';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, 'ask');
    if (match === undefined) return;
    return {
      kind: 'ask',
      reason: userRuleReason('ask', match),
    };
  }
}

/** 从规则匹配构建结构化遥测原因元数据。 */
function userRuleReason(decision: PermissionRuleDecision, match: PermissionRuleMatch) {
  return {
    rule_decision: decision,
    has_rule_args: match.hasRuleArgs,
    match_strategy: match.strategy,
  };
}

/**
 * 格式化面向用户的拒绝消息。子 agent 会收到额外提示以尝试不同方法，
 * 避免浪费重试轮次。
 */
function formatPermissionRuleDenyMessage(
  tool: string,
  reason: string | undefined,
  agentType?: Agent['type'],
): string {
  const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
  if (agentType === 'sub') {
    return `Tool "${tool}" was denied.${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
  }
  return `Tool "${tool}" was denied by permission rule.${suffix}`;
}

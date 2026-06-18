/**
 * 当权限模式为 `'auto'` 时无条件批准所有工具调用的策略。
 *
 * Auto 模式专为无人值守或半自主运行设计，agent 应在无需用户提示的情况下继续执行。
 * 此策略在链中所有拒绝规则之后运行，因此显式拒绝（包括 auto 模式特定的拒绝
 * 如 AskUserQuestion）仍然优先。
 */

import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';

/** 当 agent 处于 auto 模式时，无条件批准所有工具调用。 */
export class AutoModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'auto-mode-approve';

  constructor(private readonly agent: Agent) {}

  /** 如果权限模式为 `'auto'` 则返回 `approve`，否则传递给下一个策略。 */
  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;
    return {
      kind: 'approve',
    };
  }
}

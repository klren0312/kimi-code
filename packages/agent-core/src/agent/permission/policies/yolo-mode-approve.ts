/**
 * 当权限模式为 `'yolo'` 时无条件批准所有工具调用的策略。
 *
 * 在 yolo 模式下，用户选择接受无限制的工具执行——只有显式的拒绝规则
 * （在链中更早被评估）才能阻止调用。此策略在所有拒绝规则之后运行，
 * 因此充当 yolo 模式的"其余全部放行"兜底策略。
 */

import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyResult } from '../types';

/** 当 agent 处于 yolo 模式时，无条件批准所有工具调用。 */
export class YoloModeApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'yolo-mode-approve';

  constructor(private readonly agent: Agent) {}

  /** 如果权限模式为 `'yolo'` 则返回 `approve`，否则传递给下一个策略。 */
  evaluate(): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'yolo') return;
    return {
      kind: 'approve',
    };
  }
}

/**
 * 当没有其他策略匹配时，请求用户批准的兜底策略。
 *
 * 这是链中的最后一个策略。如果没有更早的策略返回结果，此策略返回 `ask`
 * 以提示用户。这确保每个工具调用都会得到权限决策——不会有静默遗漏。
 */

import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/** 始终返回 `ask`，作为未匹配工具调用的兜底策略。 */
export class FallbackAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'fallback-ask';

  /** 无条件返回 `ask`——上下文未使用，因为此策略始终提示用户。 */
  evaluate(_context: PermissionPolicyContext): PermissionPolicyResult {
    return {
      kind: 'ask',
    };
  }
}

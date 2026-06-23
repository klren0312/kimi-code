/**
 * 无条件拒绝所有工具调用的策略。
 *
 * 用于不应允许任何工具调用的特定场景，例如在"附加问题"处理中，
 * 期望 agent 回答问题而不执行任何工具。拒绝原因包含
 * `source: 'side_question'` 用于遥测识别。
 */

import type { PermissionPolicy, PermissionPolicyResult } from '../types';

/** 使用调用方提供的消息无条件拒绝每个工具调用。 */
export class DenyAllPermissionPolicy implements PermissionPolicy {
  readonly name = 'deny-all';

  constructor(private readonly message: string) {}

  /** 无论工具调用上下文如何，始终返回拒绝结果。 */
  evaluate(): PermissionPolicyResult {
    return {
      kind: 'deny',
      message: this.message,
      reason: { source: 'side_question' },
    };
  }
}

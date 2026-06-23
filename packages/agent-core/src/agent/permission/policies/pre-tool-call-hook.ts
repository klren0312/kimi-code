/**
 * 委托给外部 `PreToolUse` 钩子的策略。
 *
 * 此策略在链中第一个运行（最高优先级），允许外部钩子处理器——由插件或
 * 宿主应用程序注册——在任何其他策略评估之前阻止工具调用。如果钩子返回
 * 带有原因的阻止结果，则拒绝该工具调用。
 *
 * 这是不适合基于规则模型的自定义权限逻辑的逃生舱口。
 */

import type { Agent } from '../..';
import { isPlainRecord } from '../../turn/canonical-args';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * 评估 `PreToolUse` 钩子触发器。如果外部处理器阻止了调用，
 * 返回带有处理器原因消息的拒绝结果。
 */
export class PreToolCallHookPermissionPolicy implements PermissionPolicy {
  readonly name = 'pre-tool-call-hook';

  constructor(private readonly agent: Agent) {}

  /**
   * 触发 `PreToolUse` 钩子，如果钩子阻止则返回拒绝。
   * 在钩子之后检查信号中止以支持取消操作。
   */
  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const hookResult = await this.agent.hooks?.triggerBlock('PreToolUse', {
      matcherValue: context.toolCall.name,
      signal: context.signal,
      inputData: {
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
      },
    });
    context.signal.throwIfAborted();
    if (hookResult === undefined) return;
    return {
      kind: 'deny',
      message: hookResult.reason,
    };
  }
}

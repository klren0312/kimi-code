/**
 * 强制执行 AgentSwarm 排他性约束的策略。
 *
 * AgentSwarm 是一个批量操作工具，可同时生成多个子 agent。为了正确性和资源管理，
 * 它必须是模型响应中唯一的工具调用——不能与其他工具混合使用，
 * 且多个 AgentSwarm 调用必须顺序发出，而非并行。
 *
 * 此策略强制执行两条规则：
 * 1. 同一响应中的多个 AgentSwarm 调用 → 拒绝。
 * 2. AgentSwarm 与其他工具在同一响应中混合 → 拒绝。
 *
 * 响应中单独一个 AgentSwarm 调用可通过。
 */

import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * 当 AgentSwarm 排他性被违反时拒绝工具调用。当恰好只有一个单独的
 * AgentSwarm 调用或没有 AgentSwarm 调用时返回 `undefined`（通过）。
 */
export class AgentSwarmExclusiveDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'agent-swarm-exclusive-deny';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolCalls = context.toolCalls;
    const agentSwarmCount = toolCalls.filter(
      (toolCall) => toolCall.name === 'AgentSwarm',
    ).length;

    if (agentSwarmCount === 0) return;
    if (agentSwarmCount === 1 && toolCalls.length === 1) return;

    return {
      kind: 'deny',
      message:
        agentSwarmCount > 1
          ? multipleAgentSwarmDeniedMessage(toolCalls.length > agentSwarmCount)
          : mixedAgentSwarmDeniedMessage(),
      reason: {
        agent_swarm_tool_calls: agentSwarmCount,
        tool_calls: toolCalls.length,
      },
    };
  }
}

/** Formats the denial message for multiple parallel AgentSwarm calls. */
function multipleAgentSwarmDeniedMessage(hasOtherToolCalls: boolean): string {
  const suffix = hasOtherToolCalls
    ? ' AgentSwarm also must not be combined with other tools in the same response.'
    : '';
  return (
    'AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are not forbidden, ' +
    'but issue them sequentially: call one AgentSwarm, wait for its result, then call the next; ' +
    `or merge the work into a single AgentSwarm when one swarm can cover it.${suffix}`
  );
}

/** Formats the denial message for AgentSwarm mixed with other tools. */
function mixedAgentSwarmDeniedMessage(): string {
  return (
    'AgentSwarm must be the only tool call in a model response. Retry with a single AgentSwarm ' +
    'call by itself, then call any other tools after it returns.'
  );
}

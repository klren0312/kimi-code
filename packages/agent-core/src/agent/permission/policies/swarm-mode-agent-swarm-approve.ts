/**
 * 当 swarm 模式激活时批准 `AgentSwarm` 工具调用的策略。
 *
 * Swarm 模式通过 AgentSwarm 工具启用多 agent 编排。此策略并非将 AgentSwarm
 * 设为全局默认批准工具（那会在所有模式下绕过权限检查），而是仅在 swarm 模式
 * 被显式激活时才批准。这确保该工具受控于有意的模式切换。
 */

import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/** 当 agent 的 swarm 模式激活时，批准 AgentSwarm 调用。 */
export class SwarmModeAgentSwarmApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'swarm-mode-agent-swarm-approve';

  constructor(private readonly agent: Agent) {}

  /** 如果 swarm 模式激活则对 AgentSwarm 返回 `approve`；否则传递。 */
  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return;
    if (!this.agent.swarmMode.isActive) return;
    return {
      kind: 'approve',
    };
  }
}

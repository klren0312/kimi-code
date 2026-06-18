/**
 * 权限系统的策略链工厂。
 *
 * 组装 {@link PermissionManager} 在每次工具调用时评估的有序 {@link PermissionPolicy} 列表。
 * 顺序是有意的且具有语义意义——策略从上到下评估；第一个非 undefined 的结果生效。
 *
 * 优先级顺序（从高到低）：
 * 1. 外部钩子阻止（PreToolUse）
 * 2. 结构性守卫（AgentSwarm 互斥性）
 * 3. 自动模式拒绝（自动模式下的 AskUserQuestion）
 * 4. 计划模式守卫（写入限制、TaskStop/Cron 阻止）
 * 5. 用户配置的拒绝规则
 * 6. 自动模式全量批准
 * 7. 会话批准历史（用户会话级批准的模式）
 * 8. 用户配置的询问/允许规则
 * 9. ExitPlanMode 审查流程
 * 10. 计划模式工具批准（EnterPlanMode、计划文件写入）
 * 11. 敏感文件/git 控制路径守卫
 * 12. Yolo 模式全量批准
 * 13. Swarm 模式 AgentSwarm 批准
 * 14. 默认工具批准（只读工具）
 * 15. Git CWD 写入批准
 * 16. 兜底：询问用户
 */

import type { Agent } from '../..';
import type { PermissionPolicy } from '../types';
import { AgentSwarmExclusiveDenyPermissionPolicy } from './agent-swarm-exclusive-deny';
import { AutoModeApprovePermissionPolicy } from './auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from './auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicy } from './default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicy } from './exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import {
  GitControlPathAccessAskPermissionPolicy,
  SensitiveFileAccessAskPermissionPolicy,
} from './file-access-ask';
import { GitCwdWriteApprovePermissionPolicy } from './git-cwd-write-approve';
import { PlanModeGuardDenyPermissionPolicy } from './plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicy } from './plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicy } from './swarm-mode-agent-swarm-approve';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';
import { YoloModeApprovePermissionPolicy } from './yolo-mode-approve';

/**
 * 创建有序的权限策略链。策略按顺序运行；第一个非 undefined 的结果生效。
 * 顺序编码了优先级规则：钩子和守卫的拒绝优先于基于模式的批准，
 * 用户配置的规则优先于默认规则，兜底策略始终询问用户。
 */
export function createPermissionDecisionPolicies(agent: Agent): PermissionPolicy[] {
  return [
    // PreToolUse 钩子返回阻止 → 拒绝。
    new PreToolCallHookPermissionPolicy(agent),
    // AgentSwarm 是批量互斥的，无论权限模式如何都必须单独运行。
    new AgentSwarmExclusiveDenyPermissionPolicy(),
    // 自动模式 + AskUserQuestion → 拒绝。
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    // 计划模式：在计划文件之外的 Write/Edit 或 TaskStop → 拒绝。
    new PlanModeGuardDenyPermissionPolicy(agent),
    // 用户配置的拒绝规则匹配 → 拒绝。
    new UserConfiguredDenyPermissionPolicy(agent),
    // 自动模式 → 批准（任何自动模式阻止必须是上面的拒绝规则）。
    new AutoModeApprovePermissionPolicy(agent),
    // 会话级批准记忆规则匹配 → 批准。运行在用户配置的询问规则之前，以便会话内授权在后续调用中优先于仍匹配的询问规则。
    new SessionApprovalHistoryPermissionPolicy(agent),
    // 用户配置的询问规则匹配 → 询问。
    new UserConfiguredAskPermissionPolicy(agent),
    // 用户配置的允许规则匹配 → 批准。
    new UserConfiguredAllowPermissionPolicy(agent),
    // ExitPlanMode 活跃 plan_review + 非空计划 + 非自动模式 → 询问（自行跟踪 plan_submitted/plan_resolved）。运行在会话历史之前，避免过时的会话批准绕过新计划体的审查。
    new ExitPlanModeReviewAskPermissionPolicy(agent),
    // EnterPlanMode、对计划文件的 Write/Edit 或无可操作 plan_review 的 ExitPlanMode → 批准。
    new PlanModeToolApprovePermissionPolicy(agent),
    // 访问敏感文件（.env、SSH 密钥、凭证）→ 询问。
    new SensitiveFileAccessAskPermissionPolicy(),
    // 访问 .git 或 git 控制目录路径 → 询问。
    new GitControlPathAccessAskPermissionPolicy(agent),
    // Yolo 模式 → 批准。
    new YoloModeApprovePermissionPolicy(agent),
    // Swarm 模式保持 AgentSwarm 可用，但不使其成为全局默认批准的工具。
    new SwarmModeAgentSwarmApprovePermissionPolicy(agent),
    // 工具在默认批准列表中（只读/UI 辅助工具）→ 批准。
    new DefaultToolApprovePermissionPolicy(),
    // 在 git 工作树中对 cwd 内的 POSIX 路径的 Write/Edit → 批准。
    new GitCwdWriteApprovePermissionPolicy(agent),
    // 无匹配项 → 询问。
    new FallbackAskPermissionPolicy(),
  ];
}

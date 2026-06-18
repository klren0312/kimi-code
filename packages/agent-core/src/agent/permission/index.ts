/**
 * 权限管理器——权限系统的中央协调器。
 *
 * 拥有有序策略链、活跃权限模式和有效规则集。在每次工具调用之前，
 * agent 调用 {@link PermissionManager.beforeToolCall} 遍历策略链，
 * 并将第一个匹配的策略结果转换为 `PrepareToolExecutionResult`
 * （批准、带消息拒绝或通过 RPC 询问用户）。
 *
 * 支持通过 `parent` 选项构建层级权限管理器：
 * 子 agent 的管理器继承父级的规则和模式，除非本地覆盖。
 */

import type { Agent } from '..';
import type { PrepareToolExecutionResult } from '../../loop';
import { createPermissionDecisionPolicies } from './policies';
import type {
  ApprovalResponse,
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResolution,
  PermissionPolicyResult,
  PermissionRule,
} from './types';

export * from './types';

/** 构造 {@link PermissionManager} 的选项。 */
export interface PermissionManagerOptions {
  /** 初始权限规则，用于初始化管理器。 */
  readonly initialRules?: readonly PermissionRule[];
  /** 可选的父管理器，继承其规则和模式。 */
  readonly parent?: PermissionManager;
}

/** 遍历策略链的内部结果——将策略名称与其结果配对。 */
interface PolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

/**
 * 管理工具调用的权限评估。
 *
 * 管理器持有一个有序的 {@link PermissionPolicy} 实例列表（"策略链"），
 * 并为每个工具调用按顺序评估它们。第一个返回非 undefined 结果的策略决定结果。
 *
 * 管理器还跟踪：
 * - 活跃的 {@link PermissionMode}（带父级继承）。
 * - 用户配置的 {@link PermissionRule}。
 * - 会话级"会话批准"模式，在会话剩余时间内自动批准匹配的工具调用。
 *
 * @example
 * ```ts
 * const manager = new PermissionManager(agent, { initialRules });
 * const result = await manager.beforeToolCall(toolCallContext);
 * // result 为 undefined（批准）、{ block: true, reason }（拒绝）或处理询问
 * ```
 */
export class PermissionManager {
  /** 有序策略链。第一个非 undefined 的结果生效。 */
  readonly policies: PermissionPolicy[];
  /** 此管理器实例本地的用户配置权限规则。 */
  readonly rules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;
  private readonly parent: PermissionManager | undefined;
  private readonly localSessionApprovalRulePatterns = new Set<string>();

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this.policies = createPermissionDecisionPolicies(this.agent);
  }

  /**
   * 有效的权限模式。回退到父管理器的模式，如果无覆盖或父级存在则回退到 `'manual'`。
   * 此层级结构允许子 agent 继承父级的模式，同时仍允许本地覆盖。
   */
  get mode(): PermissionMode {
    return this.modeOverride ?? this.parent?.mode ?? 'manual';
  }

  set mode(mode: PermissionMode) {
    this.modeOverride = mode;
  }

  /**
   * 返回当前权限状态的可序列化快照（模式 + 包括继承规则在内的有效规则）。
   * UI 用于显示权限状态。
   */
  data(): PermissionData {
    return {
      mode: this.mode,
      rules: this.effectiveRules,
    };
  }

  /**
   * 更改权限模式并带有完整副作用：记录日志、推送到回放构建器并通知状态监听器。
   * 对于用户发起的更改，优先使用此方法而非 `mode` 设置器。
   */
  setMode(mode: PermissionMode): void {
    this.agent.records.logRecord({
      type: 'permission.set_mode',
      mode,
    });
    this.agent.replayBuilder.push({
      type: 'permission_updated',
      mode,
    });
    this.modeOverride = mode;
    this.agent.emitStatusUpdated();
  }

  /**
   * 记录批准交互的结果。如果用户授予了会话级批准，
   * 则记住规则模式，以便后续匹配的调用自动批准而无需提示。
   */
  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.agent.records.logRecord({
      type: 'permission.record_approval_result',
      ...record,
    });
    this.agent.replayBuilder.push({
      type: 'approval_result',
      record,
    });
    if (record.result.decision !== 'approved' || record.result.scope !== 'session') {
      return;
    }
    const pattern = record.sessionApprovalRule;
    if (pattern === undefined) return;
    this.localSessionApprovalRulePatterns.add(pattern);
  }

  /**
   * 所有会话级批准规则模式，包括从父管理器继承的模式。
   * 由 {@link SessionApprovalHistoryPermissionPolicy} 用于自动批准
   * 用户之前为会话批准的调用。
   */
  get sessionApprovalRulePatterns(): readonly string[] {
    return [
      ...this.localSessionApprovalRulePatterns,
      ...(this.parent?.sessionApprovalRulePatterns ?? []),
    ];
  }

  /**
   * 工具调用执行前的权限评估入口点。遍历策略链，跟踪遥测数据，
   * 并将生效的策略结果转换为工具执行循环可理解的 `PrepareToolExecutionResult`。
   *
   * @returns `undefined` 表示允许工具调用，或带有 `block: true` 的结果表示拒绝。
   */
  async beforeToolCall(
    context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;

    this.agent.telemetry.track('permission_policy_decision', {
      policy_name: evaluation.policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    return this.permissionPolicyResolutionToPrepare(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  /**
   * 处理'ask'策略结果，通过 RPC 向用户发送批准请求。管理完整生命周期：
   * 触发钩子、处理错误、记录遥测数据，并将用户的响应转换回准备结果。
   * 当无 RPC 可用时（无头模式），自动批准。
   */
  private async requestToolApproval(
    context: PermissionPolicyContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    policyName: string | undefined,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const { signal } = context;
    const id = context.toolCall.id;
    const name = context.toolCall.name;
    const display =
      context.execution.display ?? {
        kind: 'generic',
        summary: context.execution.description ?? `Approve ${name}`,
        detail: context.args,
      };
    const action = context.execution.description ?? `Call ${name}`;
    const startedAt = Date.now();

    let response: ApprovalResponse;
    let requestedApproval = false;
    if (this.agent.rpc?.requestApproval) {
      requestedApproval = true;
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionRequest', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          toolInput: context.args,
          display,
        },
      });
      try {
        response = await this.agent.rpc.requestApproval(
          {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            display,
          },
          { signal },
        );
      } catch (error) {
        this.agent.telemetry.track('permission_approval_result', {
          policy_name: policyName ?? null,
          tool_name: name,
          permission_mode: this.mode,
          result: 'error',
          approval_surface: display.kind,
          duration_ms: Date.now() - startedAt,
          session_cache_written: false,
          has_feedback: false,
        });
        void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
          matcherValue: name,
          inputData: {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            decision: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        const resolved = result.resolveError?.(error);
        return resolved === undefined
          ? Promise.reject(error)
          : this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
      }
    } else {
      response = {
        decision: 'approved',
      };
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;

    if (requestedApproval) {
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          decision: response.decision,
          scope: response.scope,
          feedback: response.feedback,
          selectedLabel: response.selectedLabel,
        },
      });
    }

    this.recordApprovalResult({
      turnId: Number(context.turnId),
      toolCallId: id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
    this.agent.telemetry.track('permission_approval_result', {
      policy_name: policyName ?? null,
      tool_name: name,
      permission_mode: this.mode,
      result:
        response.decision === 'approved' && response.scope === 'session'
          ? 'approved_for_session'
          : response.decision,
      approval_surface: display.kind,
      duration_ms: Date.now() - startedAt,
      session_cache_written: sessionApprovalRule !== undefined,
      has_feedback: response.feedback !== undefined && response.feedback.length > 0,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
    }

    if (response.decision === 'approved') {
      return undefined;
    }

    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  /**
   * 按顺序遍历策略链并返回第一个非 undefined 的评估结果，
   * 如果没有策略匹配则返回 `undefined`。这是权限系统的核心调度循环。
   */
  private async evaluatePolicies(
    context: PermissionPolicyContext,
  ): Promise<PolicyEvaluation | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) {
        return { policyName: policy.name, result };
      }
    }
    return undefined;
  }

  /** 合并本地规则与继承的父级规则，获取完整有效规则集。 */
  private get effectiveRules(): PermissionRule[] {
    return [...this.rules, ...(this.parent?.effectiveRules ?? [])];
  }

  /**
   * 将 {@link PermissionPolicyResolution} 转换为工具执行循环的 `PrepareToolExecutionResult` 格式。
   * 处理所有四个分支：approve（可选元数据）、deny（带消息）、ask（委托给 {@link requestToolApproval}）
   * 和原始结果透传。
   */
  private permissionPolicyResolutionToPrepare(
    result: PermissionPolicyResolution,
    context: PermissionPolicyContext,
    policyName?: string,
  ): Promise<PrepareToolExecutionResult | undefined> | PrepareToolExecutionResult | undefined {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          block: true,
          reason: result.message ?? this.formatPolicyDenyMessage(context.toolCall.name),
        };
      case 'ask':
        return this.requestToolApproval(context, result, policyName);
      case 'result': {
        const { kind: _kind, ...prepareResult } = result;
        return prepareResult;
      }
    }
  }

  /**
   * 格式化用户可见的拒绝消息。子 agent 会收到额外提示，
   * 建议尝试不同的方法而非重试，以减少在被阻止路径上浪费的轮次。
   */
  protected formatApprovalRejectionMessage(
    toolName: string,
    result: { decision: 'approved' | 'rejected' | 'cancelled'; feedback?: string },
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.agent.type === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  /** 格式化策略评估的拒绝消息。子 agent 会收到避免重试的提示。 */
  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.agent.type === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }
}

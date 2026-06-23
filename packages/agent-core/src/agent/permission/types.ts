/**
 * 权限系统的核心类型定义。
 *
 * 权限系统控制工具调用是否被允许、拒绝或需要用户批准。它使用策略链架构，
 * 其中每个 {@link PermissionPolicy} 评估工具调用上下文并返回决策。
 * 策略按顺序评估；第一个非 undefined 的结果生效。
 *
 * 关键概念：
 * - **PermissionMode**：顶层权限姿态（`manual`、`yolo`、`auto`），影响非拒绝规则的行为。
 * - **PermissionRule**：用户配置的 DSL 规则（`Read(/etc/**)`、`Bash(rm *)`），
 *   将模式映射到允许/拒绝/询问决策。
 * - **PermissionPolicy**：可组合的策略对象，根据规则、钩子和模式设置评估工具调用。
 */

import type { PrepareToolExecutionResult, ResolvedToolExecutionHookContext } from '../../loop';
import type { ToolInputDisplay } from '../../tools/display';

/** 权限规则评估的三种可能结果。 */
export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

/**
 * 规则来源。`session-runtime` 存储由"会话批准"产生的规则；
 * `turn-override`、`project` 和 `user` 保留给外部调用者提供的静态加载规则。
 */
export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

/**
 * 顶层用户可见的权限姿态。控制构造闭包时非拒绝规则的处理方式。
 * 与规则合并无关：拒绝规则无论在何种模式下都会触发。
 *
 *   - `manual` — 规则集驱动决策；未匹配的工具调用需要询问
 *   - `yolo`   — 只有拒绝规则能阻止；其他所有规则都允许
 *   - `auto`   — 调用者可以完全绕过规则检查
 */
export type PermissionMode = 'manual' | 'yolo' | 'auto';

/**
 * 单条权限规则。`pattern` 是 DSL 形式（`Read(/etc/**)`、`Bash(rm *)` 或裸 `Write`）。
 * 规则参数仅由提供匹配器的工具解释；其他工具仅按名称匹配。
 */
export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

/**
 * 描述等待用户批准的工具调用。发送到 UI 层，
 * 以便使用工具的显示元数据渲染有意义的批准提示。
 */
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  action: string;
  display: ToolInputDisplay;
}

/**
 * 用户对批准请求的响应。`scope: 'session'` 授予会话期间匹配调用的全量批准，
 * 避免对相同工具模式重复提示。
 */
export interface ApprovalResponse {
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selectedLabel?: string;
}

/**
 * 单次批准交互的审计记录。记录到 agent 的记录流中，用于回放和调试。
 */
export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

/**
 * 当前权限状态的可序列化快照：活跃模式和有效规则集。UI 用于显示权限状态。
 */
export interface PermissionData {
  mode: PermissionMode;
  rules: PermissionRule[];
}

/** 规则匹配中使用的简化决策类型（对应 {@link PermissionRuleDecision}）。 */
export type PermissionDecision = 'approve' | 'deny' | 'ask';

/** 结构化权限决策原因的允许值类型。 */
export type PermissionReasonValue = string | number | boolean | null;

/**
 * 附加到权限决策的结构化键值元数据。
 * 用于遥测和调试，以了解策略触发原因。
 */
export type PermissionDecisionReason = Readonly<Record<string, PermissionReasonValue>>;

/**
 * 所有可能策略解析结果的联合类型。策略可以返回标准的 {@link PermissionPolicyResult}
 * 或原始的 `PrepareToolExecutionResult`（以 `kind: 'result'` 包装）以直接注入合成工具输出。
 */
export type PermissionPolicyResolution =
  | PermissionPolicyResult
  | ({ readonly kind: 'result' } & PrepareToolExecutionResult);

/**
 * 传递给权限策略 `evaluate` 方法的上下文。扩展了解析后的工具执行钩子上下文，
 * 包含策略做出决策所需的一切：工具调用元数据、执行信息、参数和信号。
 */
export interface PermissionPolicyContext extends ResolvedToolExecutionHookContext {}

/**
 * 策略评估结果的可区分联合类型：
 * - `approve`：允许工具调用，可选附加执行元数据。
 * - `deny`：阻止工具调用，可选用户可见的提示消息。
 * - `ask`：提示用户批准，可选回调将批准/拒绝解析为最终策略解析结果。
 */
export type PermissionPolicyResult =
  | {
      readonly kind: 'approve';
      readonly reason?: PermissionDecisionReason;
      readonly executionMetadata?: unknown;
    }
  | {
      readonly kind: 'deny';
      readonly reason?: PermissionDecisionReason;
      readonly message?: string;
    }
  | {
      readonly kind: 'ask';
      readonly reason?: PermissionDecisionReason;
      readonly resolveApproval?: (
        result: ApprovalResponse,
      ) => PermissionPolicyResolution | undefined;
      readonly resolveError?: (error: unknown) => PermissionPolicyResolution | undefined;
    };

/**
 * 可组合的权限策略。策略由 {@link PermissionManager} 按优先级顺序评估；
 * 第一个非 undefined 的结果决定工具调用的命运。返回 `undefined` 以传递给下一个策略。
 */
export interface PermissionPolicy {
  readonly name: string;
  evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;
}

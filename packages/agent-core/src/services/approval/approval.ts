/**
 * 审批服务接口 + 协议适配器。
 *
 * **服务接口**（`IApprovalService`）：Reverse-RPC 一次性 broker 角色 —
 * 将 `KimiCore` 产出的 `ApprovalRequest` 路由到等待方（WS 上的 web 客户端、
 * 测试中的 mock 处理器），并在响应到达时 resolve promise。
 *
 * 角色：一次性 broker — 参见 `packages/services/AGENTS.md`。按包级约定保留
 * `Service` 后缀；broker 语义存在于接口形状（`request` + `resolve`）
 * 和文档注释中，而非类型名称。
 *
 * **形状说明：** 服务的 `request()` 返回 agent-core 进程内的
 * `ApprovalResponse`（`{ decision, scope?, feedback?, selectedLabel? }`，
 * 参见 `packages/agent-core/src/rpc/sdk-api.ts:10`）。
 * SCHEMAS.md §6.1 定义了协议级 `ApprovalResponse`，具有相同的字段但使用
 * snake_case（`selected_label`）。协议↔进程内适配器位于 daemon/REST 边界
 *（参见 SCHEMAS.md §6.4）— 服务保持 SDK 形状。当协议 Zod 验证器发布后，
 * 此接口保持 SDK 形状；REST 处理器负责适配。
 *
 * **适配器**（`toBrokerRequest` / `toAgentCoreResponse`）：桥接同一审批交互的
 * 两种表示：
 *
 *   1. **进程内 SDK 形状**（agent-core，camelCase）— `BridgeClientAPI` 从
 *      `KimiCore.requestApproval(...)` 接收到的。参见
 *      `packages/agent-core/src/rpc/sdk-api.ts:17-23`：
 *        `ApprovalRequest { turnId?, toolCallId, toolName, action, display }`
 *      和 `ApprovalResponse { decision, scope?, feedback?, selectedLabel? }`。
 *
 *   2. **协议线路形状**（snake_case，带 daemon 分配的元数据）— daemon 作为
 *      `event.approval.requested` 广播的内容，以及 REST resolve 处理器
 *      作为请求体接收的内容。参见 SCHEMAS.md §6.1 和
 *      `packages/protocol/src/approval.ts`。
 *
 * **字段映射**：
 *
 *     SDK (camelCase) → 协议 (snake_case)
 *     ----------------------------------------
 *     toolCallId      → tool_call_id
 *     toolName        → tool_name
 *     turnId          → turn_id          （可选）
 *     display         → tool_input_display  （透传 — 12-arm 联合）
 *     selectedLabel   → selected_label   （响应侧）
 *
 * **防腐层**：这是审批领域协议↔SDK 形状转换的唯一位置。
 * daemon 路由通过适配器间接调用 `toBrokerRequest`（KimiCore →
 * BridgeClientAPI.requestApproval → IApprovalService.request），
 * REST resolve 处理器调用 `toAgentCoreResponse`。
 */

import { createDecorator } from '../../di';
import type { ApprovalRequest, ApprovalResponse } from '../../rpc';
import type {
  ApprovalRequest as ProtocolApprovalRequest,
  ApprovalResponse as ProtocolApprovalResponse,
} from '@moonshot-ai/protocol';
import type {} from '@moonshot-ai/protocol'; // 仅类型标记 — 保持对 protocol 的依赖引用

// 为服务侧消费者重新导出 ApprovalResponse，使其无需直接依赖 agent-core。
export type { ApprovalRequest, ApprovalResponse };

export interface IApprovalService {
  readonly _serviceBrand: undefined;

  /**
   * 当 KimiCore 需要用户审批时由适配器调用。resolve 为用户的决定
   *（或在无客户端连接/超时时为取消响应 — 具体取决于实现策略）。
   */
  request(req: ApprovalRequest & { sessionId: string; agentId: string }): Promise<ApprovalResponse>;

  /**
   * 由应答侧（REST 处理器 / TUI / mock）调用以结算挂起的 `request()` promise。
   * `id` 与 `ApprovalRequest.toolCallId` 匹配，为稳定的关联键。
   */
  resolve(id: string, response: ApprovalResponse): void;

  /**
   * 返回 session 的协议形状挂起审批请求。被 session 状态生命周期
   * 用于检测 `awaiting_approval`。
   */
  listPending(sessionId: string): readonly ProtocolApprovalRequest[];
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IApprovalService = createDecorator<IApprovalService>('approvalService');

// ---------------------------------------------------------------------------
// 适配器辅助函数（从 adapter/approval-adapter.ts 迁移）
// ---------------------------------------------------------------------------

export interface ToBrokerRequestParams {
  /** daemon 铸造的 ULID，标识此审批交互。 */
  readonly approvalId: string;
  /** 审批所在的 session。 */
  readonly sessionId: string;
  /** `createdAt` ISO 字符串；broker 传入新的 `new Date().toISOString()`。 */
  readonly createdAt: string;
  /** `expiresAt` ISO 字符串；broker 计算 `createdAt + 60s`。 */
  readonly expiresAt: string;
}

/**
 * 进程内 SDK 请求 + daemon 分配的元数据 → 协议线路形状。
 *
 * daemon broker 在广播前用于构建 WS `event.approval.requested` 负载。
 *
 * `req` 可能携带桥接层附加的额外上下文字段（`sessionId`、`agentId`）—
 * 我们从 `params.sessionId`（daemon 侧权威来源）读取 `sessionId`，
 * 并忽略请求上的任何重复字段。
 */
export function toBrokerRequest(
  req: ApprovalRequest,
  params: ToBrokerRequestParams,
): ProtocolApprovalRequest {
  return {
    approval_id: params.approvalId,
    session_id: params.sessionId,
    turn_id: req.turnId,
    tool_call_id: req.toolCallId,
    tool_name: req.toolName,
    action: req.action,
    // 透传 — SCHEMAS §6.1 要求保持 12-arm 联合并保留
    // `generic.summary` 作为客户端回退渲染。
    tool_input_display: req.display,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

/**
 * 协议 REST 请求体 → 进程内 SDK 响应。
 *
 * REST resolve 处理器用于结算 agent 侧的 Promise。
 */
export function toAgentCoreResponse(
  resp: ProtocolApprovalResponse,
): ApprovalResponse {
  return {
    decision: resp.decision,
    scope: resp.scope,
    feedback: resp.feedback,
    selectedLabel: resp.selected_label,
  };
}

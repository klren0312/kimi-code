/**
 * `BridgeClientAPI` — `CoreProcessService` 拥有的进程内 RPC 对的 SDK 侧。
 * 实现 `SDKAPI`（`@moonshot-ai/agent-core` rpc/sdk-api.ts:78，通过
 * `SDKAgentAPI` :67-72）使 `KimiCore` 能通过 `createRPC<CoreAPI, SDKAPI>()`
 * 调用它。方法路由到 DI 解析的对等服务：
 *
 *   emitEvent(event)        → IEventService.publish(event)
 *   requestApproval(req)    → IApprovalService.request(req)
 *   requestQuestion(req)    → IQuestionService.request(req)
 *   toolCall(req)           → 不支持（此处不使用 SDK 自定义工具调用）
 *
 * 协议↔进程内适配器（SCHEMAS.md §6.4 snake_case 形状、REST 请求/响应
 * Zod 验证）位于 daemon REST 边界 — 不在此处。对等服务接口保持 SDK 形状。
 */

import type { ApprovalRequest, ApprovalResponse, Event, QuestionRequest, QuestionResult, SDKAPI, ToolCallRequest, ToolCallResponse } from '../../rpc';

import type { IApprovalService } from '../approval/approval';
import type { IEventService } from '../event/event';
import type { ILogService } from '../logger/logger';
import type { IQuestionService } from '../question/question';

export interface CoreProcessClientDeps {
  readonly eventService: IEventService;
  readonly approvalService: IApprovalService;
  readonly questionService: IQuestionService;
  readonly logService: ILogService;
}

export class BridgeClientAPI implements SDKAPI {
  private readonly deps: CoreProcessClientDeps;

  constructor(deps: CoreProcessClientDeps) {
    this.deps = deps;
  }

  emitEvent(event: Event): void {
    const e = event as { type?: string; sessionId?: string; agentId?: string };
    this.deps.logService.debug(
      { type: e.type, sessionId: e.sessionId, agentId: e.agentId },
      '[DBG coreProcessClient.emitEvent]',
    );
    this.deps.eventService.publish(event);
  }

  async requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    return this.deps.approvalService.request(request);
  }

  async requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
    options?: { signal?: AbortSignal },
  ): Promise<QuestionResult> {
    return this.deps.questionService.request(request, options);
  }

  async toolCall(
    request: ToolCallRequest & { sessionId: string; agentId: string },
  ): Promise<ToolCallResponse> {
    // 与 `SDKRpcClientBase.toolCall` 一致（packages/node-sdk/src/rpc.ts:577-582）
    // — daemon 的进程内适配器不暴露 SDK 侧自定义工具调用；
    // agent 会收到可向上游展示的错误结果。
    return {
      output: `SDK custom tool calls are not supported in the daemon adapter: ${request.toolCallId}`,
      isError: true,
    };
  }
}

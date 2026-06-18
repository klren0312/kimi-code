import { Disposable, IInstantiationService, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import { ErrorCodes, KimiError } from '../../errors';
import type { AgentContextData, ContextMessage } from '../../agent/context';
import type { JsonObject, ListSessionsPayload, SessionSummary } from '../../rpc';
import type { SessionMeta } from '../../session';
import {
  type CompactSessionRequest,
  type CompactSessionResponse,
  type Event,
  type Message,
  type PageResponse,
  type Session,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionStatus,
  type SessionStatusResponse,
  type SessionUpdate,
  type UndoSessionRequest,
  type UndoSessionResponse,
} from '@moonshot-ai/protocol';

import { IApprovalService } from '../approval/approval';
import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IEventService } from '../event/event';
import { toProtocolMessage } from '../message/message';
import { IPromptService, type AgentStatePatch } from '../prompt/prompt';
import { IQuestionService } from '../question/question';
import {
  ISessionService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  toProtocolSession,
  type SessionCreateOptions,
  type SessionListQuery,
} from './session';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;
const CHILD_SESSION_KIND = 'child';

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function canUndoHistory(history: readonly ContextMessage[], count: number): boolean {
  let found = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') return false;
    if (isRealUserPrompt(message)) {
      found++;
      if (found >= count) return true;
    }
  }
  return false;
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return origin.kind === 'skill_activation' && origin.trigger === 'user-slash';
}

function pageContextMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  context: AgentContextData,
  requestedPageSize: number | undefined,
): PageResponse<Message> {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = context.history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

export class SessionService extends Disposable implements ISessionService {
  readonly _serviceBrand: undefined;

  private readonly _onDidCreate = this._register(new Emitter<{ session: Session }>());
  readonly onDidCreate = this._onDidCreate.event;
  private readonly _onDidClose = this._register(new Emitter<{ sessionId: string }>());
  readonly onDidClose = this._onDidClose.event;

  private readonly _statusBySession = new Map<string, SessionStatus>();
  private readonly _activeTurns = new Set<string>();
  private readonly _abortedTurns = new Set<string>();
  private _promptService: IPromptService | undefined;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IApprovalService private readonly approvalService: IApprovalService,
    @IQuestionService private readonly questionService: IQuestionService,
  ) {
    super();
    this._register(
      this.eventService.onDidPublish((event) => {
        this._handleBusEvent(event);
      }),
    );
  }

  private get promptService(): IPromptService {
    return (this._promptService ??= this.instantiation.invokeFunction((a) => a.get(IPromptService)));
  }

  /**
   * 根据实时守护进程状态计算会话生命周期状态。
   *
   * 优先级：
   *   1. awaiting_approval — 存在待处理的审批请求
   *   2. awaiting_question — 存在待处理的用户提问
   *   3. running           — 存在活跃的 prompt 或活跃的 turn
   *   4. aborted           — 上一个 turn 以取消/失败结束且未启动新工作
   *   5. idle              — 其他情况
   */
  private _computeStatus(sessionId: string): SessionStatus {
    if (this.approvalService.listPending(sessionId).length > 0) {
      return 'awaiting_approval';
    }
    if (this.questionService.listPending(sessionId).length > 0) {
      return 'awaiting_question';
    }
    if (
      this.promptService.getCurrentPromptId(sessionId) !== undefined ||
      this._activeTurns.has(sessionId)
    ) {
      return 'running';
    }
    if (this._abortedTurns.has(sessionId)) {
      return 'aborted';
    }
    return 'idle';
  }

  /**
   * 用实时计算的状态值覆盖协议 Session 上的占位状态，
   * 并记录上次返回的状态，以便仅在状态真正变化时触发 status_changed 事件。
   */
  private _patchSessionStatus(session: Session): Session {
    const status = this._computeStatus(session.id);
    session.status = status;
    this._statusBySession.set(session.id, status);
    return session;
  }

  /**
   * 当会话的计算状态与上次公布的状态不同时，发布 `event.session.status_changed`。
   * 在每个相关生命周期事件后调用，以保持会话列表同步。
   */
  private _emitStatusChanged(sessionId: string): void {
    const previous = this._statusBySession.get(sessionId) ?? 'idle';
    const next = this._computeStatus(sessionId);
    if (previous === next) return;

    this._statusBySession.set(sessionId, next);
    this.eventService.publish({
      type: 'event.session.status_changed',
      agentId: 'main',
      sessionId,
      status: next,
      previous_status: previous,
      current_prompt_id: this.promptService.getCurrentPromptId(sessionId),
    } as unknown as Event);
  }

  private _handleBusEvent(event: Event): void {
    const type = (event as { type?: string }).type;
    const sessionId = (event as { sessionId?: string }).sessionId;
    if (sessionId === undefined || sessionId === '' || type === undefined) return;

    switch (type) {
      case 'turn.started': {
        this._activeTurns.add(sessionId);
        this._abortedTurns.delete(sessionId);
        this._emitStatusChanged(sessionId);
        break;
      }
      case 'turn.ended': {
        this._activeTurns.delete(sessionId);
        const reason = (event as { reason?: string }).reason;
        if (reason === 'cancelled' || reason === 'failed') {
          this._abortedTurns.add(sessionId);
        } else {
          this._abortedTurns.delete(sessionId);
        }
        this._emitStatusChanged(sessionId);
        break;
      }
      case 'prompt.submitted': {
        this._abortedTurns.delete(sessionId);
        this._emitStatusChanged(sessionId);
        break;
      }
      case 'prompt.completed':
      case 'prompt.aborted':
      case 'event.approval.requested':
      case 'event.approval.resolved':
      case 'event.approval.expired':
      case 'event.question.requested':
      case 'event.question.answered':
      case 'event.question.dismissed':
      case 'event.question.expired': {
        this._emitStatusChanged(sessionId);
        break;
      }
    }
  }

  async create(input: SessionCreate, options?: SessionCreateOptions): Promise<Session> {
    if (input.metadata === undefined || typeof input.metadata.cwd !== 'string') {
      throw new Error('SessionService.create: metadata.cwd is required');
    }
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.core.rpc.createSession({
      workDir: input.metadata.cwd,
      metadata: metadataForCore,
      model: input.agent_config?.model,
      client: options?.client,
    });
    if (input.title !== undefined) {
      try {
        await this.core.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
      }
    }
    const meta = await this.tryGetMeta(summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    const corePayload: ListSessionsPayload = {
      workDir: query.workDir,
      includeArchive: query.includeArchive,
    };
    const all = await this.core.rpc.listSessions(corePayload);
    const sorted = all.toSorted((a, b) => b.updatedAt - a.updatedAt);

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof sorted;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = sorted.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = sorted.slice(0, pivotIndex);
    } else {
      slice = sorted;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    const items = await Promise.all(
      pageSummaries.map(async (s) =>
        this._patchSessionStatus(toProtocolSession(s, await this.tryGetMeta(s.id)))
      ),
    );

    const filtered =
      query.status !== undefined ? items.filter((s) => s.status === query.status) : items;

    return { items: filtered, has_more: hasMore };
  }

  async get(id: string): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await this.tryGetMeta(id);
    return this._patchSessionStatus(toProtocolSession(summary, meta));
  }

  async update(id: string, input: SessionUpdate): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    if (input.title !== undefined) {
      await this.core.rpc.renameSession({ sessionId: id, title: input.title });
    }

    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.core.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    const ac = input.agent_config;
    if (ac !== undefined) {
      const patch: AgentStatePatch = {};
      if (ac.model !== undefined && ac.model !== '') patch.model = ac.model;
      if (ac.thinking !== undefined) patch.thinking = ac.thinking;
      if (ac.permission_mode !== undefined) patch.permission_mode = ac.permission_mode;
      if (ac.plan_mode !== undefined) patch.plan_mode = ac.plan_mode;
      if (ac.swarm_mode !== undefined) patch.swarm_mode = ac.swarm_mode;
      if (ac.goal_objective !== undefined) patch.goal_objective = ac.goal_objective;
      if (ac.goal_control !== undefined) patch.goal_control = ac.goal_control;
      if (
        patch.model !== undefined ||
        patch.thinking !== undefined ||
        patch.permission_mode !== undefined ||
        patch.plan_mode !== undefined ||
        patch.swarm_mode !== undefined ||
        patch.goal_objective !== undefined ||
        patch.goal_control !== undefined
      ) {
        await this.promptService.applyAgentState(id, patch, 'meta');
      }
    }

    const allAfter = await this.core.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await this.tryGetMeta(id);
    return this._patchSessionStatus(toProtocolSession(summaryAfter, meta));
  }

  async fork(id: string, input: SessionFork): Promise<Session> {
    const source = await this.get(id);
    const title = input.title ?? `Fork: ${source.title || source.id}`;
    const metadata = input.metadata === undefined ? undefined : asJsonObject(input.metadata);
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  async listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>> {
    await this.get(id);
    const all = await this.core.rpc.listSessions({});
    const sorted = all.toSorted((a, b) => b.updatedAt - a.updatedAt);
    const children = sorted.filter(
      (summary) =>
        summary.metadata?.['parent_session_id'] === id &&
        summary.metadata?.['child_session_kind'] === CHILD_SESSION_KIND,
    );

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof children;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(0, pivotIndex);
    } else {
      slice = children;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const items = await Promise.all(
      pageSummaries.map(async (s) =>
        this._patchSessionStatus(toProtocolSession(s, await this.tryGetMeta(s.id)))
      ),
    );
    const filtered =
      query.status !== undefined
        ? items.filter((session) => session.status === query.status)
        : items;

    return {
      items: filtered,
      has_more: slice.length > pageSize,
    };
  }

  async createChild(id: string, input: SessionChildCreate): Promise<Session> {
    const parent = await this.get(id);
    const title = input.title ?? `Child: ${parent.title || parent.id}`;
    const metadata = asJsonObject({
      ...input.metadata,
      parent_session_id: id,
      child_session_kind: CHILD_SESSION_KIND,
    });
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  private emitCreated(session: Session): void {
    this._onDidCreate.fire({ session });
    this.eventService.publish({
      type: 'event.session.created',
      agentId: 'main',
      sessionId: session.id,
      session,
    });
  }

  async getStatus(id: string): Promise<SessionStatusResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    const [config, context, permission, plan] = await Promise.all([
      this.core.rpc.getConfig({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getContext({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPermission({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPlan({ sessionId: id, agentId: 'main' }),
    ]);

    const maxContextTokens = config.modelCapabilities?.max_context_tokens ?? 0;
    const contextTokens = context.tokenCount;
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;

    const agentState = this.promptService.getAgentStateSnapshot(id);

    return {
      status: this._computeStatus(id),
      model: config.modelAlias ?? config.provider?.model,
      thinking_level: config.thinkingLevel,
      permission: permission.mode,
      plan_mode: plan !== null,
      swarm_mode: agentState?.swarmMode ?? false,
      context_tokens: contextTokens,
      max_context_tokens: maxContextTokens,
      context_usage: contextUsage,
    };
  }

  async compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    // beginCompaction 只能感知已加载到核心内存中的会话——因此先 resume
    // （与 undo 逻辑一致），以避免对新打开的会话执行 compact 时抛出
    // SESSION_NOT_FOUND 错误。
    await this.core.rpc.resumeSession({ sessionId: id });

    const instruction = normalizeOptionalString(input.instruction);
    await this.core.rpc.beginCompaction({
      sessionId: id,
      agentId: 'main',
      instruction,
    });
    return {};
  }

  async undo(id: string, input: UndoSessionRequest): Promise<UndoSessionResponse> {
    const summary = await this.requireSummary(id);
    await this.core.rpc.resumeSession({ sessionId: id });
    const before = await this.core.rpc.getContext({ sessionId: id, agentId: 'main' });
    if (!canUndoHistory(before.history, input.count)) {
      throw new SessionUndoUnavailableError(id);
    }

    try {
      await this.core.rpc.undoHistory({
        sessionId: id,
        agentId: 'main',
        count: input.count,
      });
    } catch (error) {
      if (error instanceof KimiError && error.code === ErrorCodes.REQUEST_INVALID) {
        throw new SessionUndoUnavailableError(id, error.message);
      }
      throw error;
    }

    const after = await this.core.rpc.getContext({ sessionId: id, agentId: 'main' });
    return {
      messages: pageContextMessages(id, summary.createdAt, after, input.page_size),
      status: await this.getStatus(id),
    };
  }

  async archive(id: string): Promise<{ archived: true }> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.core.rpc.archiveSession({ sessionId: id });
    this._onDidClose.fire({ sessionId: id });
    this._statusBySession.delete(id);
    this._activeTurns.delete(id);
    this._abortedTurns.delete(id);
    return { archived: true };
  }

  private async requireSummary(id: string): Promise<SessionSummary> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    return summary;
  }

  private async tryGetMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      const meta = await this.core.rpc.getSessionMetadata({ sessionId: id });
      return meta;
    } catch {
      return undefined;
    }
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }
}

registerSingleton(ISessionService, SessionService, InstantiationType.Delayed);

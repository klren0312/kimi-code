/**
 * `PromptService` — `IPromptService` 的实现。
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import type {
  Event,
  PromptItem,
  PromptListResponse,
  PromptSubmission,
  PromptSteerResult,
  PromptSubmitResult,
  PromptThinking,
} from '@moonshot-ai/protocol';
import type { PermissionMode } from '../../agent/permission';
import { ulid } from 'ulid';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IAuthSummaryService } from '../authSummary/authSummary';
import { IEventService } from '../event/event';
import { ILogService } from '../logger/logger';
import { ISessionService, SessionNotFoundError } from '../session/session';
import {
  IPromptService,
  PromptNotFoundError,
  PromptAlreadyCompletedError,
  type AgentStatePatch,
  type AgentStateSnapshot,
  type AgentStateSource,
  type PromptAbortResult,
  type PromptDispatchLogEntry,
  type SyntheticPromptCompletedEvent,
  type SyntheticPromptAbortedEvent,
  type SyntheticPromptSteeredEvent,
  type SyntheticPromptSubmittedEvent,
} from './prompt';

const MAIN_AGENT_ID = 'main';

function promptKey(sessionId: string, agentId: string): string {
  return `${sessionId}\u0000${agentId}`;
}

/** 每会话分发日志条目上限；环形缓冲区溢出时丢弃最旧条目。 */
const DISPATCH_LOG_CAP = 100;

/**
 * 当且仅当补丁中定义了任意运行时控制字段时为 `true`。
 * 用于在调用方未携带任何可操作字段时短路 `applyAgentState` / prompt 请求体覆盖路径。
 */
function hasAnyAgentStateField(patch: AgentStatePatch): boolean {
  return (
    patch.model !== undefined ||
    patch.thinking !== undefined ||
    patch.permission_mode !== undefined ||
    patch.plan_mode !== undefined ||
    patch.swarm_mode !== undefined ||
    patch.goal_objective !== undefined ||
    patch.goal_control !== undefined
  );
}

/**
 * 从 `PromptSubmission` 请求体中提取运行时控制字段为影子补丁。
 * 当请求体不携带任何字段时返回 `undefined`——提交路径会跳过影子引导和差量分发，
 * 从而在热路径的纯内容 prompt 上节省 RPC 调用。
 */
function pickAgentStatePatch(body: PromptSubmission): AgentStatePatch | undefined {
  const patch: AgentStatePatch = {};
  if (body.model !== undefined) patch.model = body.model;
  if (body.thinking !== undefined) patch.thinking = body.thinking;
  if (body.permission_mode !== undefined) patch.permission_mode = body.permission_mode;
  if (body.plan_mode !== undefined) patch.plan_mode = body.plan_mode;
  if (body.swarm_mode !== undefined) patch.swarm_mode = body.swarm_mode;
  if (body.goal_objective !== undefined) patch.goal_objective = body.goal_objective;
  if (body.goal_control !== undefined) patch.goal_control = body.goal_control;
  return hasAnyAgentStateField(patch) ? patch : undefined;
}

/**
 * 每会话"活跃 prompt"状态。在完成/中止时清除。
 *
 * 当 prompt 已提交但首个 `turn.started` 尚未到达时，`turnId === null`
 *（RPC 对在 `ready()` 之前排队调用，因此间隙很小但在实践中非零）。
 *
 * 当 `turn.ended` 到达时设置 `terminal === true`——我们保留记录以便
 * 对已完成 prompt 的中止表现为 40903，而非 40402。
 */
interface PromptState {
  agentId: string;
  promptId: string;
  userMessageId: string;
  body: PromptSubmission;
  createdAt: string;
  turnId: number | null;
  /** 在顶层 turn 的 `turn.ended` 时设置（reason='completed'|'failed'）。 */
  completed: boolean;
  /** 在 reason='cancelled' 的 `turn.ended` 或成功的 abort RPC 后设置。 */
  aborted: boolean;
}

type CorePromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly imageUrl: { readonly url: string } }
  | { readonly type: 'video_url'; readonly videoUrl: { readonly url: string } };

function toPromptItem(state: PromptState, status: 'running' | 'queued'): PromptItem {
  return {
    prompt_id: state.promptId,
    user_message_id: state.userMessageId,
    status,
    content: state.body.content,
    created_at: state.createdAt,
  };
}

function contentToCoreParts(content: PromptSubmission['content']): CorePromptPart[] {
  const input: CorePromptPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        input.push({ type: 'text', text: part.text });
        break;
      case 'image':
        if (part.source.kind === 'url') {
          input.push({
            type: 'image_url',
            imageUrl: { url: part.source.url },
          });
        } else if (part.source.kind === 'base64') {
          input.push({
            type: 'image_url',
            imageUrl: {
              url: `data:${part.source.media_type};base64,${part.source.data}`,
            },
          });
        }
        break;
      case 'video':
        if (part.source.kind === 'url') {
          input.push({
            type: 'video_url',
            videoUrl: { url: part.source.url },
          });
        } else if (part.source.kind === 'base64') {
          input.push({
            type: 'video_url',
            videoUrl: {
              url: `data:${part.source.media_type};base64,${part.source.data}`,
            },
          });
        }
        break;
      case 'file':
      case 'thinking':
      case 'tool_result':
      case 'tool_use':
        break;
    }
  }
  return input;
}

function steerContentToCoreParts(states: readonly PromptState[]): CorePromptPart[] {
  const textBodies: string[] = [];
  let allText = true;
  for (const state of states) {
    const texts: string[] = [];
    for (const part of state.body.content) {
      if (part.type !== 'text') {
        allText = false;
        break;
      }
      texts.push(part.text);
    }
    if (!allText) break;
    textBodies.push(texts.join('\n'));
  }
  if (allText) {
    return [{ type: 'text', text: textBodies.join('\n\n') }];
  }

  const input: CorePromptPart[] = [];
  states.forEach((state, index) => {
    if (index > 0) input.push({ type: 'text', text: '\n\n' });
    input.push(...contentToCoreParts(state.body.content));
  });
  return input;
}

/**
 * `turn.started` agent-core 事件的类型守卫。
 */
function isTurnStarted(e: Event): e is Event & { type: 'turn.started'; turnId: number } {
  return (e as { type?: string }).type === 'turn.started';
}

/**
 * `turn.ended` agent-core 事件的类型守卫。
 */
function isTurnEnded(e: Event): e is Event & {
  type: 'turn.ended';
  turnId: number;
  reason: 'completed' | 'cancelled' | 'failed';
} {
  return (e as { type?: string }).type === 'turn.ended';
}

/**
 * `agent.status.updated` agent-core 事件的类型守卫。携带我们镜像到每会话影子中的
 * 字段子集（model / permission / planMode），每次实时变更时更新。
 * `thinkingLevel` 不在此事件上——引导时从 `getConfig` 种子获取，
 * 后续由每请求的差量分发保持同步。
 */
function isAgentStatusUpdated(e: Event): e is Event & {
  type: 'agent.status.updated';
  model?: string;
  permission?: PermissionMode;
  planMode?: boolean;
} {
  return (e as { type?: string }).type === 'agent.status.updated';
}

/**
 * 每会话的 `model` / `thinking` / `permissionMode` / `planMode` 影子。
 * 类型从 `./prompt` 重导出，使守护进程调试路由可以消费它而无需深入 `PromptService` 内部。
 * 在首次 `submit` 引导之前不存在。参见 `_bootstrapAgentState` + `_applyAgentState`。
 */

export class PromptService
  extends Disposable
  implements IPromptService
{
  readonly _serviceBrand: undefined;

  /** 每会话的活跃 prompt。在完成/中止时清除。 */
  private readonly _active = new Map<string, PromptState>();

  private readonly _queued = new Map<string, PromptState[]>();

  /**
   * 每会话的 `model` / `thinking` / `permissionMode` / `planMode` 影子。
   * 在首次 `submit` 引导之前不存在。参见 `_bootstrapAgentState` + `_applyAgentState`。
   */
  private readonly _agentState = new Map<string, AgentStateSnapshot>();

  /**
   * 每会话的无状态控制 setter 分发环形缓冲区。
   * 每条目在底层 `core.rpc.*` setter 于 `_applyAgentState` 中解析后立即记录
   * `{ts, kind, payload, promptId}`。缓冲区上限为 `DISPATCH_LOG_CAP`；
   * 溢出时丢弃最旧条目。在 `ISessionService.onDidClose` 时与影子一起清除。
   * 通过 `_dispatchLogForTest` 暴露，供守护进程的
   * `/debug/prompts/{sid}/dispatch-log` 路由和单元测试使用——不在热路径上读取。
   */
  private readonly _dispatchLog = new Map<string, PromptDispatchLogEntry[]>();

  /**
   * `prompt.completed` 合成事件的 VSCode 风格 Emitter。监听器异常通过
   * `Emitter.fire()` 路由到 `onUnexpectedError`。通过 `_register(...)`
   * 拥有，PromptService 拆解时一起销毁。
   */
  private readonly _onDidComplete = this._register(
    new Emitter<SyntheticPromptCompletedEvent>(),
  );
  readonly onDidComplete = this._onDidComplete.event;
  /**
   * `prompt.aborted` 合成事件的 VSCode 风格 Emitter。拥有和异常路由语义
   * 与 `_onDidComplete` 相同。
   */
  private readonly _onDidAbort = this._register(
    new Emitter<SyntheticPromptAbortedEvent>(),
  );
  readonly onDidAbort = this._onDidAbort.event;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
    @IAuthSummaryService private readonly auth: IAuthSummaryService,
    @ISessionService private readonly sessionService: ISessionService,
    @ILogService private readonly _logger: ILogService,
  ) {
    super();
    // 自订阅事件流以进行生命周期合成。
    // `onDidPublish` 是 VSCode 风格的访问器——调用它会注册 `_handleBusEvent`
    // 并返回一个 `IDisposable`，在销毁时分离。我们通过 `this._register(...)`
    // 注册它，使监听器在 PromptService 销毁时拆解（根据 start.ts 的接线顺序，
    // 这发生在事件服务销毁之前）。重入是安全的：合成的 `prompt.*` 事件
    // 不匹配下面的 `turn.*` 谓词。
    this._register(
      this.eventService.onDidPublish(this._handleBusEvent.bind(this)),
    );
    // 会话关闭时丢弃每会话影子，使新建会话的下次提交能干净地重新引导。
    this._register(
      this.sessionService.onDidClose(({ sessionId }) => {
        this._agentState.delete(sessionId);
        this._dispatchLog.delete(sessionId);
        for (const key of this._queued.keys()) {
          if (key.startsWith(`${sessionId}\u0000`)) this._queued.delete(key);
        }
      }),
    );
  }

  // --- IPromptService ---------------------------------------------------

  async list(sid: string): Promise<PromptListResponse> {
    await this._requireSession(sid);
    const key = promptKey(sid, MAIN_AGENT_ID);
    const active = this._active.get(key);
    return {
      active:
        active !== undefined && !active.completed && !active.aborted
          ? toPromptItem(active, 'running')
          : null,
      queued: (this._queued.get(key) ?? []).map((state) =>
        toPromptItem(state, 'queued'),
      ),
    };
  }

  async submit(sid: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    await this._requireSession(sid);
    await this.core.rpc.resumeSession({ sessionId: sid });

    // 就绪门控。在生成 prompt_id 并交给 agent-core 之前抛出
    // AuthProvisioningRequired / AuthTokenMissing / AuthModelNotResolved。
    // 守护进程路由层映射为 40110/40111/40113。
    await this.auth.ensureReady();

    const promptId = `prompt_${ulid()}`;
    const state = this._createPromptState(sid, promptId, body);
    const key = promptKey(sid, state.agentId);

    const existing = this._active.get(key);
    if (existing !== undefined && !existing.completed && !existing.aborted) {
      this._enqueue(sid, state);
      const item = toPromptItem(state, 'queued');
      this._publishSubmitted(sid, state, item);
      return item;
    }

    const item = toPromptItem(state, 'running');
    await this._startPrompt(sid, state, () => {
      this._publishSubmitted(sid, state, item);
    });
    return item;
  }

  async startBtw(sid: string): Promise<string> {
    await this._requireSession(sid);
    await this.core.rpc.resumeSession({ sessionId: sid });
    await this.auth.ensureReady();
    return this.core.rpc.startBtw({ sessionId: sid, agentId: MAIN_AGENT_ID });
  }

  async steer(sid: string, promptIds: readonly string[]): Promise<PromptSteerResult> {
    await this._requireSession(sid);
    if (promptIds.length === 0) {
      throw new PromptNotFoundError(sid, '');
    }
    const key = promptKey(sid, MAIN_AGENT_ID);
    const active = this._active.get(key);
    if (active === undefined || active.completed || active.aborted) {
      throw new PromptNotFoundError(sid, promptIds[0]!);
    }

    const queue = this._queued.get(key) ?? [];
    const selected: PromptState[] = [];
    for (const promptId of promptIds) {
      const state = queue.find((item) => item.promptId === promptId);
      if (state === undefined) {
        throw new PromptNotFoundError(sid, promptId);
      }
      selected.push(state);
    }

    const selectedIds = new Set(promptIds);
    const remaining = queue.filter((item) => !selectedIds.has(item.promptId));
    this._replaceQueue(sid, MAIN_AGENT_ID, remaining);

    try {
      await this.core.rpc.steer({
        sessionId: sid,
        agentId: MAIN_AGENT_ID,
        input: steerContentToCoreParts(selected),
      });
    } catch (error) {
      this._restoreSteeredQueueItems(sid, selected);
      throw error;
    }

    const event: SyntheticPromptSteeredEvent = {
      type: 'prompt.steered',
      agentId: MAIN_AGENT_ID,
      sessionId: sid,
      activePromptId: active.promptId,
      promptIds: [...promptIds],
      content: selected.flatMap((state) => state.body.content),
      steeredAt: new Date().toISOString(),
    };
    this.eventService.publish(event as unknown as Event);
    return { steered: true, prompt_ids: [...promptIds] };
  }

  private async _startPrompt(
    sid: string,
    state: PromptState,
    onStarted?: () => void,
  ): Promise<void> {
    const overridePatch = state.agentId === MAIN_AGENT_ID ? pickAgentStatePatch(state.body) : undefined;
    if (overridePatch !== undefined) {
      await this._ensureAgentStateBootstrapped(sid);
      await this._applyAgentStateInternal(sid, overridePatch, 'prompt', state.promptId);
    }

    const key = promptKey(sid, state.agentId);
    this._active.set(key, state);
    const input = contentToCoreParts(state.body.content);
    onStarted?.();

    // 发后即忘。agent-core 通过 RPC 对的 SDK 端流式推送事件，
    // 落在 `BridgeClientAPI.emitEvent → IEventService.publish` 上。
    // 提交 RPC 同步返回（PromptPayload → void）；错误将作为后续
    // `error` 事件表现，而非此处的拒绝。
    try {
      this._logger.debug(
        { sid, promptId: state.promptId, agentId: state.agentId, partCount: input.length },
        '[DBG prompt-service.submit] -> core.rpc.prompt(...)',
      );
      await this.core.rpc.prompt({
        sessionId: sid,
        agentId: state.agentId,
        input,
      });
      this._logger.debug(
        { sid, promptId: state.promptId },
        '[DBG prompt-service.submit] core.rpc.prompt(...) resolved',
      );
    } catch (error) {
      // 清除活跃 prompt 状态使下次提交能成功；向路由层暴露错误。
      if (this._active.get(key)?.promptId === state.promptId) {
        this._active.delete(key);
      }
      this._logger.debug(
        { sid, promptId: state.promptId, err: (error as Error)?.message ?? error },
        '[DBG prompt-service.submit] core.rpc.prompt(...) threw',
      );
      throw error;
    }
  }

  private _publishSubmitted(sid: string, state: PromptState, item: PromptSubmitResult): void {
    const event: SyntheticPromptSubmittedEvent = {
      type: 'prompt.submitted',
      agentId: state.agentId,
      sessionId: sid,
      promptId: item.prompt_id,
      userMessageId: item.user_message_id,
      status: item.status,
      content: item.content,
      createdAt: item.created_at,
    };
    this.eventService.publish(event);
  }

  private _publishAborted(sid: string, agentId: string, pid: string): void {
    const ev: SyntheticPromptAbortedEvent = {
      type: 'prompt.aborted',
      agentId,
      sessionId: sid,
      promptId: pid,
      abortedAt: new Date().toISOString(),
    };
    // 在发布合成事件之前先触发类型化监听器：PromptService 必须仍然
    // 触发类型化事件，然后调用 publish() 发出合成事件。
    this._onDidAbort.fire(ev);
    this.eventService.publish(ev as unknown as Event);
  }

  async abort(sid: string, pid: string): Promise<PromptAbortResult> {
    await this._requireSession(sid);
    const key = promptKey(sid, MAIN_AGENT_ID);
    const state = this._active.get(key);
    if (state !== undefined && state.promptId === pid) {
      if (state.completed || state.aborted) {
        throw new PromptAlreadyCompletedError(sid, pid);
      }
      // 乐观标记为已中止——_handleBusEvent 不会重新合成。
      state.aborted = true;
      try {
        const cancelArgs: { sessionId: string; agentId: string; turnId?: number } = {
          sessionId: sid,
          agentId: state.agentId,
        };
        if (state.turnId !== null) cancelArgs.turnId = state.turnId;
        await this.core.rpc.cancel(cancelArgs);
      } catch (error) {
        // 回滚乐观标志以便路由层暴露真实错误；
        // 调用方将通过全局错误处理器看到 50001（内部错误）。
        state.aborted = false;
        throw error;
      }
      this._publishAborted(sid, state.agentId, pid);
      return { aborted: true };
    }

    // 队列中的 prompt：从队列中移除并合成 prompt.aborted。
    // 不需要 core RPC，因为该 prompt 从未被分发。
    const queue = this._queued.get(key) ?? [];
    const index = queue.findIndex((item) => item.promptId === pid);
    if (index === -1) {
      throw new PromptNotFoundError(sid, pid);
    }
    queue.splice(index, 1);
    if (queue.length === 0) {
      this._queued.delete(key);
    }
    this._publishAborted(sid, MAIN_AGENT_ID, pid);
    return { aborted: true };
  }

  async abortBySession(sid: string): Promise<PromptAbortResult> {
    await this._requireSession(sid);
    const state = this._active.get(promptKey(sid, MAIN_AGENT_ID));
    if (state !== undefined && !state.completed && !state.aborted) {
      // 普通 prompt 路径：让 abort() 处理 turnId 映射和事件合成。
      return this.abort(sid, state.promptId);
    }
    // 没有守护进程管理的活跃 prompt。取消正在运行的任何 agent-core turn
    //（例如技能激活），无需 turnId。
    // TurnFlow.cancel(undefined) 在空闲时是安全的空操作。
    await this.core.rpc.cancel({ sessionId: sid, agentId: MAIN_AGENT_ID });
    return { aborted: true };
  }

  getCurrentPromptId(sid: string): string | undefined {
    const state = this._active.get(promptKey(sid, MAIN_AGENT_ID));
    if (state === undefined || state.completed || state.aborted) {
      return undefined;
    }
    return state.promptId;
  }

  /**
   * `IPromptService.applyAgentState` — 由 `submit`（按 turn 覆盖）和
   * `SessionService.update`（`POST /sessions/{sid}/profile`）共享的入口。
   * 验证会话存在性，延迟引导影子，然后对每个非影子字段通过匹配的
   * `core.rpc.*` setter 进行差量分发。分发日志条目标记 `source`，
   * 使下游观察者能区分 prompt 驱动和 profile 驱动的 setter。
   *
   * 当所有字段匹配影子时为空操作；setter 失败时抛出异常
   *（调用方/路由层暴露错误）。接受空 `patch` 且不引导任何内容
   * ——对需要在请求体未携带运行时控制时干净空操作的
   * SessionService.update 路径很有用。
   */
  async applyAgentState(
    sid: string,
    patch: AgentStatePatch,
    source: AgentStateSource,
    promptId?: string,
  ): Promise<void> {
    if (!hasAnyAgentStateField(patch)) return;
    await this._requireSession(sid);
    await this._ensureAgentStateBootstrapped(sid);
    await this._applyAgentStateInternal(sid, patch, source, promptId ?? '');
  }

  // --- IPromptService 类型化事件访问器 ------------------------------------
  //
  // `onDidComplete` / `onDidAbort` 在上面声明为 `Emitter<T>.event` 访问器；
  // 消费方通过 `svc.onDidComplete(handler)`（返回 IDisposable）订阅，
  // 并通过 `Disposable._register(...)` 拥有分离生命周期。

  // --- 无状态会话控制（每请求差量分发）-----------------------------------

  /**
   * 如果尚未引导，从 `getConfig` / `getPermission` / `getPlan` 种子化
   * 每会话影子。在同一会话生命周期内的多次提交间幂等；
   * 在 `ISessionService.onDidClose` 时清除。
   *
   * 三个 RPC 并行运行——它们没有共享前置条件。
   */
  private async _ensureAgentStateBootstrapped(sid: string): Promise<void> {
    if (this._agentState.has(sid)) return;
    const [config, permission, plan, swarmMode] = await Promise.all([
      this.core.rpc.getConfig({ sessionId: sid, agentId: MAIN_AGENT_ID }),
      this.core.rpc.getPermission({ sessionId: sid, agentId: MAIN_AGENT_ID }),
      this.core.rpc.getPlan({ sessionId: sid, agentId: MAIN_AGENT_ID }),
      this.core.rpc.getSwarmMode({ sessionId: sid, agentId: MAIN_AGENT_ID }),
    ]);
    const snapshot: AgentStateSnapshot = {};
    if (config.modelAlias !== undefined) snapshot.model = config.modelAlias;
    // `AgentConfigData.thinkingLevel` 类型为 `string`，但实践中取
    // `PromptThinking` 字面量之一（`off|low|...|max`）；窄化转换使
    // 差量比较保持类型化，无需强制 protocol 从 agent-core 导入。
    snapshot.thinking = config.thinkingLevel as PromptThinking;
    snapshot.permissionMode = permission.mode;
    snapshot.planMode = plan !== null;
    snapshot.swarmMode = swarmMode;
    this._agentState.set(sid, snapshot);
  }

  /**
   * 差量分发：对 `patch` 上存在的四个控制中的每一个，
   * 仅当值与影子不同时才调用匹配的 `core.rpc.*` setter。
   * 每个 setter 串行运行，任何失败都会暴露给调用方。每个成功的 setter
   * 还会追加到每会话的分发日志环形缓冲区；两个 prompt 之间缺少条目
   * 证明影子抑制了冗余分发。
   *
   * 前置条件：`_ensureAgentStateBootstrapped(sid)` 已运行（影子 Map 携带 `sid`）。
   * 调用方必须自行守卫。
   */
  private async _applyAgentStateInternal(
    sid: string,
    patch: AgentStatePatch,
    source: AgentStateSource,
    promptId: string,
  ): Promise<void> {
    const shadow = this._agentState.get(sid);
    if (shadow === undefined) {
      // 引导是前置条件；此处缺少影子是 bug，而非可恢复状态。
      throw new Error(
        `PromptService._applyAgentStateInternal: shadow not bootstrapped for sid=${sid}`,
      );
    }
    const agentId = MAIN_AGENT_ID;

    if (patch.model !== undefined && patch.model !== shadow.model) {
      const payload = { sessionId: sid, agentId, model: patch.model };
      await this.core.rpc.setModel(payload);
      shadow.model = patch.model;
      this._recordDispatch(sid, 'setModel', payload, promptId, source);
    }
    if (patch.thinking !== undefined && patch.thinking !== shadow.thinking) {
      const payload = { sessionId: sid, agentId, level: patch.thinking as PromptThinking };
      await this.core.rpc.setThinking(payload);
      shadow.thinking = patch.thinking;
      this._recordDispatch(sid, 'setThinking', payload, promptId, source);
    }
    if (
      patch.permission_mode !== undefined &&
      patch.permission_mode !== shadow.permissionMode
    ) {
      const payload = {
        sessionId: sid,
        agentId,
        mode: patch.permission_mode as PermissionMode,
      };
      await this.core.rpc.setPermission(payload);
      shadow.permissionMode = patch.permission_mode as PermissionMode;
      this._recordDispatch(sid, 'setPermission', payload, promptId, source);
    }
    if (patch.plan_mode !== undefined && patch.plan_mode !== shadow.planMode) {
      const payload = { sessionId: sid, agentId };
      if (patch.plan_mode) {
        await this.core.rpc.enterPlan(payload);
        this._recordDispatch(sid, 'enterPlan', payload, promptId, source);
      } else {
        // `cancelPlan({id?})` 接受省略的 id——`PlanMode.cancel` 清除当前活跃的
        // 任何 id。影子不跟踪 id，因此我们总是省略。
        await this.core.rpc.cancelPlan(payload);
        this._recordDispatch(sid, 'cancelPlan', payload, promptId, source);
      }
      shadow.planMode = patch.plan_mode;
    }

    // 群体模式切换。enterSwarm/exitSwarm 在 agent 侧是幂等不抛异常的；
    // 我们仍用影子守卫以避免冗余的分发日志条目。
    if (patch.swarm_mode !== undefined && patch.swarm_mode !== shadow.swarmMode) {
      const payload = { sessionId: sid, agentId };
      if (patch.swarm_mode) {
        const enterPayload = { ...payload, trigger: 'manual' as const };
        await this.core.rpc.enterSwarm(enterPayload);
        this._recordDispatch(sid, 'enterSwarm', enterPayload, promptId, source);
      } else {
        await this.core.rpc.exitSwarm(payload);
        this._recordDispatch(sid, 'exitSwarm', payload, promptId, source);
      }
      shadow.swarmMode = patch.swarm_mode;
    }

    // 目标创建。createGoal 在输入无效时抛出 KimiError
    //（GOAL_OBJECTIVE_EMPTY, GOAL_OBJECTIVE_TOO_LONG），
    // 或在目标已活跃且无 replace=true 时抛出（GOAL_ALREADY_EXISTS）。
    // 让这些传播以便 REST 路由层映射到正确的代码。
    if (patch.goal_objective !== undefined) {
      const payload = {
        sessionId: sid,
        agentId,
        objective: patch.goal_objective,
        replace: false,
      };
      await this.core.rpc.createGoal(payload);
      this._recordDispatch(sid, 'createGoal', payload, promptId, source);
      // `goal_objective` 是一次性创建触发器；不保留在影子上。
    }

    // 目标生命周期控制。每个操作映射到自己的 RPC；
    // 错误（GOAL_NOT_FOUND, GOAL_STATUS_INVALID, GOAL_NOT_RESUMABLE）传播。
    if (patch.goal_control !== undefined) {
      const payload = { sessionId: sid, agentId };
      switch (patch.goal_control) {
        case 'pause':
          await this.core.rpc.pauseGoal(payload);
          this._recordDispatch(sid, 'pauseGoal', payload, promptId, source);
          break;
        case 'resume':
          await this.core.rpc.resumeGoal(payload);
          this._recordDispatch(sid, 'resumeGoal', payload, promptId, source);
          break;
        case 'cancel':
          await this.core.rpc.cancelGoal(payload);
          this._recordDispatch(sid, 'cancelGoal', payload, promptId, source);
          break;
      }
      // `goal_control` 是一次性操作触发器；不保留在影子上。
    }
  }

  /**
   * 将分发条目追加到每会话环形缓冲区，达到上限时驱逐最旧条目。
   * 仅在底层 setter 于 `_applyAgentStateInternal` 中成功解析后调用。
   */
  private _recordDispatch(
    sid: string,
    kind: PromptDispatchLogEntry['kind'],
    payload: Record<string, unknown>,
    promptId: string,
    source: AgentStateSource,
  ): void {
    let buf = this._dispatchLog.get(sid);
    if (buf === undefined) {
      buf = [];
      this._dispatchLog.set(sid, buf);
    }
    buf.push({
      ts: new Date().toISOString(),
      kind,
      // 浅拷贝，使后续的影子变更/调用方无法追溯修改已记录的负载。
      payload: { ...payload },
      promptId,
      source,
    });
    if (buf.length > DISPATCH_LOG_CAP) {
      buf.splice(0, buf.length - DISPATCH_LOG_CAP);
    }
  }

  // --- 私有事件处理器（替代 IPromptLifecycleObserver）---------------------

  private _handleBusEvent(event: Event): void {
    const sid = (event as { sessionId?: string }).sessionId;
    if (sid === undefined || sid === '') return;

    // 将实时的 `agent.status.updated` 镜像到每会话影子中。
    // 当带外调用方（TUI / SDK / agent 自身）在 prompt 之间变更
    // `model` / `permission` / `planMode` 时，这保持影子的准确性。
    // 只有事件上存在的字段更新影子——`thinking` 不在此事件上，
    // 保持上次 `setThinking`（或引导 getConfig）设定的值。
    if (isAgentStatusUpdated(event)) {
      const shadow = this._agentState.get(sid);
      if (shadow !== undefined) {
        if (event.model !== undefined) shadow.model = event.model;
        if (event.permission !== undefined) shadow.permissionMode = event.permission;
        if (event.planMode !== undefined) shadow.planMode = event.planMode;
      }
      // status 事件也正常发布；穿透允许下面的其他事件类型处理器——但目前没有重叠。
      return;
    }

    const agentId = (event as { agentId?: string }).agentId ?? MAIN_AGENT_ID;
    const key = promptKey(sid, agentId);
    const state = this._active.get(key);
    if (state === undefined) return;

    if (isTurnStarted(event)) {
      // 捕获提交后的首个 turn.started 作为"顶层" turn。
      // 后续嵌套 turn（例如子 agent）携带不同的 turnId 值，
      // 不会被提升为 prompt 的顶层。
      state.turnId ??= event.turnId;
      return;
    }

    if (isTurnEnded(event)) {
      // 仅在顶层 turn 结束时触发。嵌套的 turn.ended 事件直接通过，
      // 不进行 prompt 级别的合成。
      if (state.turnId === null || event.turnId !== state.turnId) return;

      // 如果我们已通过 abort RPC 合成过，不要重复发出。
      // 标记为已完成以防止过时查找，但不发出任何内容。
      if (state.aborted) {
        this._active.delete(key);
        void this._startNextQueued(sid, state.agentId);
        return;
      }

      const reason = event.reason;
      if (reason === 'cancelled') {
        // 模型产生了我们未通过 abort RPC 发起的取消
        //（或它穿过了乐观标志）。合成 prompt.aborted。
        state.aborted = true;
        const synth: SyntheticPromptAbortedEvent = {
          type: 'prompt.aborted',
          agentId: state.agentId,
          sessionId: sid,
          promptId: state.promptId,
          abortedAt: new Date().toISOString(),
        };
        this._active.delete(key);
        // 在发布合成事件之前先触发类型化监听器。
        this._onDidAbort.fire(synth);
        this.eventService.publish(synth as unknown as Event);
        void this._startNextQueued(sid, state.agentId);
        return;
      }

      state.completed = true;
      const synth: SyntheticPromptCompletedEvent = {
        type: 'prompt.completed',
        agentId: state.agentId,
        sessionId: sid,
        promptId: state.promptId,
        finishedAt: new Date().toISOString(),
        reason: reason === 'failed' ? 'failed' : 'completed',
      };
      this._active.delete(key);
      // 在发布合成事件之前先触发类型化监听器。
      this._onDidComplete.fire(synth);
      this.eventService.publish(synth as unknown as Event);
      void this._startNextQueued(sid, state.agentId);
    }
  }

  /**
   * 测试辅助——窥探活跃 prompt 状态。
   */
  _activeForTest(sid: string): Readonly<PromptState> | undefined {
    const state = this._active.get(promptKey(sid, MAIN_AGENT_ID));
    return state === undefined ? undefined : { ...state };
  }

  /**
   * 读取会话当前的运行时控制影子（如已引导）。返回副本，
   * 调用方无法修改内部状态。
   */
  getAgentStateSnapshot(sid: string): AgentStateSnapshot | undefined {
    const snap = this._agentState.get(sid);
    return snap === undefined ? undefined : { ...snap };
  }

  /**
   * 测试辅助——窥探每会话的无状态控制影子。
   * 在会话首次提交之前为 undefined。
   */
  _agentStateForTest(sid: string): Readonly<AgentStateSnapshot> | undefined {
    return this.getAgentStateSnapshot(sid);
  }

  /**
   * 测试/调试辅助——返回每会话的分发日志环形缓冲区（最新在末尾）。
   * 当会话从未触发过 setter 时返回 `undefined`；空数组表示
   * "有提交但每个字段都匹配影子"。守护进程的
   * `/debug/prompts/{sid}/dispatch-log` 路由消费此方法；
   * 单元测试直接对其断言。
   */
  _dispatchLogForTest(sid: string): readonly PromptDispatchLogEntry[] | undefined {
    const buf = this._dispatchLog.get(sid);
    if (buf === undefined) return undefined;
    // 防御性拷贝——调用方可能在并行提交推送新条目时迭代。
    return buf.slice();
  }

  /**
   * 测试辅助——注入活跃 prompt 记录。供守护进程 e2e 测试使用，
   * 这些测试需要在不驱动真实 `core.rpc.prompt(...)` 调用的情况下
   * 练习生命周期合成路径（该调用需要加载了 provider 凭据的内存中
   * KimiCore）。不属于公共契约；下划线前缀是"不要在生产中使用"的信号。
   */
  _injectActiveForTest(sid: string, promptId: string, turnId: number | null): void {
    this._active.set(promptKey(sid, MAIN_AGENT_ID), {
      agentId: MAIN_AGENT_ID,
      promptId,
      userMessageId: `msg_${sid}_pending_${promptId}`,
      body: { content: [{ type: 'text', text: 'test' }] },
      createdAt: new Date().toISOString(),
      turnId,
      completed: false,
      aborted: false,
    });
  }

  // --- 内部实现 -----------------------------------------------------------

  private _createPromptState(
    sid: string,
    promptId: string,
    body: PromptSubmission,
  ): PromptState {
    return {
      agentId: body.agent_id ?? MAIN_AGENT_ID,
      promptId,
      userMessageId: `msg_${sid}_pending_${promptId}`,
      body,
      createdAt: new Date().toISOString(),
      turnId: null,
      completed: false,
      aborted: false,
    };
  }

  private _enqueue(sid: string, state: PromptState): void {
    const key = promptKey(sid, state.agentId);
    let queue = this._queued.get(key);
    if (queue === undefined) {
      queue = [];
      this._queued.set(key, queue);
    }
    queue.push(state);
  }

  private _replaceQueue(sid: string, agentId: string, queue: PromptState[]): void {
    const key = promptKey(sid, agentId);
    if (queue.length === 0) {
      this._queued.delete(key);
      return;
    }
    this._queued.set(key, queue);
  }

  private _restoreSteeredQueueItems(sid: string, selected: readonly PromptState[]): void {
    const queue = this._queued.get(promptKey(sid, MAIN_AGENT_ID)) ?? [];
    const queueIds = new Set(queue.map((state) => state.promptId));
    const missing = selected.filter((state) => !queueIds.has(state.promptId));
    this._replaceQueue(sid, MAIN_AGENT_ID, [...missing, ...queue]);
  }

  private async _startNextQueued(sid: string, agentId = MAIN_AGENT_ID): Promise<void> {
    const key = promptKey(sid, agentId);
    const active = this._active.get(key);
    if (active !== undefined && !active.completed && !active.aborted) return;
    const queue = this._queued.get(key);
    const next = queue?.shift();
    if (queue !== undefined && queue.length === 0) {
      this._queued.delete(key);
    }
    if (next === undefined) return;
    await this._startPrompt(sid, next).catch(() => {
      void this._startNextQueued(sid, agentId);
    });
  }

  private async _requireSession(sid: string): Promise<void> {
    const all = await this.core.rpc.listSessions({});
    if (!all.some((s) => s.id === sid)) {
      throw new SessionNotFoundError(sid);
    }
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    this._active.clear();
    this._queued.clear();
    this._agentState.clear();
    this._dispatchLog.clear();
    // `_onDidComplete` 和 `_onDidAbort` 通过 `this._register(...)` 注册，
    // 因此 `super.dispose()` 会刷新它们的监听器。
    super.dispose();
  }
}

// 在全局单例注册表下自注册。所有构造函数依赖都是
// `@I…` 注入的（@ICoreProcessService / @IEventService / @IAuthSummaryService）；
// `staticArguments = []`。`supportsDelayedInstantiation = false` 保留当前的反向销毁语义。
registerSingleton(IPromptService, PromptService, InstantiationType.Delayed);

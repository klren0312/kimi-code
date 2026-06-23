import {
  RequestError,
  type AgentSideConnection,
  type ClientCapabilities,
  type AvailableCommand,
  type ContentBlock,
  type ModelId,
  type PromptResponse,
  type SessionModeId,
} from '@agentclientprotocol/sdk';
import {
  ErrorCodes,
  log,
  type ApprovalRequest,
  type ApprovalResponse,
  type BackgroundTaskInfo,
  type ContextMessage,
  type Event,
  type KimiErrorPayload,
  type KimiHarness,
  type McpServerInfo,
  type QuestionAnswers,
  type QuestionRequest,
  type Session,
  type SessionStatus,
  type SessionUsage,
} from '@moonshot-ai/kimi-code-sdk';

import {
  approvalRequestToPermissionOptions,
  attachSelectedLabel,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from './approval';
import {
  ACP_BUILTIN_SLASH_COMMANDS,
  type AcpBuiltinSlashCommandName,
} from './builtin-commands';
import { buildSessionConfigOptions } from './config-options';
import { listModelsFromHarness } from './model-catalog';
import { acpBlocksToPromptParts } from './convert';
import {
  acpToolCallId,
  assistantDeltaToSessionUpdate,
  configOptionUpdateNotification,
  planFromDisplayBlock,
  stringifyArgs,
  thinkingDeltaToSessionUpdate,
  toolCallDeltaToSessionUpdate,
  toolCallLazyCreateToSessionUpdate,
  toolCallStartedUpgradeToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolProgressToSessionUpdate,
  toolResultToSessionUpdate,
  turnEndReasonToStopReason,
} from './events-map';
import { acpModeToToggles, DEFAULT_MODE_ID, isAcpModeId, type AcpModeId } from './modes';
import { outcomeToQuestionAnswer, questionItemToPermissionOptions } from './question';
import { detectSlashIntent } from './slash';

// ── 中文概述 ──
// 本模块是 ACP 协议适配器的核心会话层，负责将 ACP 协议的 session 操作
// 转译为 Kimi SDK 的 Session 接口调用。
// 核心职责：
// - 管理会话的模型、思考模式、运行模式等配置状态（适配器侧权威副本）
// - 处理 prompt 请求：拦截斜杠命令（技能/内置命令/未知命令）或转发给 SDK
// - 将 SDK 事件流（assistant.delta、tool.call、turn.ended 等）实时转换为 ACP session/update 通知
// - 桥接审批请求（handleApproval）和问答请求（handleQuestion）的反向 RPC 通道
// - 重放历史会话记录（replayHistory），用于客户端重新连接时恢复状态
// - 错误映射：将认证类错误映射为 authRequired，其他映射为 internalError

/**
 * Telemetry sink threaded into {@link AcpSession} so reverse-RPC bridges
 * (`handleApproval`, `handleQuestion`) can emit PII-free breadcrumbs
 * without reaching back through the harness. Optional — when absent,
 * the session is a silent passthrough (matches the Phase 11.2 stub-
 * tolerant pattern in `server.ts:trackSessionStarted`).
 */
// 中文：遥测追踪函数类型，用于在反向 RPC 桥接中发射无 PII 的面包屑事件
export type TelemetryTrackFn = (
  event: string,
  properties?: Record<string, unknown>,
) => void;

/**
 * Adapter-side wrapper around a {@link Session} from the Kimi node SDK.
 *
 * Stored in `AcpServer.sessions` so subsequent `session/prompt` and
 * `session/cancel` calls can locate the underlying SDK session by its
 * ACP `sessionId`. The `conn` field holds the {@link AgentSideConnection}
 * so `prompt()` can emit `session/update` chunks back to the client
 * without re-plumbing the connection through the call stack.
 */
// 中文：ACP 会话适配器类，封装 Kimi SDK Session，管理配置状态并桥接 ACP 协议与 SDK 事件流
export class AcpSession {
  /**
   * The most recently observed turnId from the underlying SDK event
   * stream. Used by {@link handleApproval} to compose the prefixed ACP
   * `toolCallId` (`${turnId}:${rawId}`) so the client can correlate the
   * permission prompt with the tool card it has already rendered.
   *
   * Updated inside the existing `onEvent` listener in {@link prompt}
   * (any event carrying a numeric `turnId` advances the value), and
   * reset to `undefined` on `turn.ended`. Approval flows are gated by
   * the SDK on the active turn so a stale value is effectively
   * unreachable in practice; the `undefined` fallback in
   * `buildPermissionToolCallUpdate` exists for defence-in-depth.
   */
  // 中文：当前活跃轮次 ID，用于在审批请求中组装 ACP 前缀工具调用 ID（${turnId}:${rawId}）
  private currentTurnId: number | undefined = undefined;

  /**
   * The adapter-side authoritative current BASE model id (no
   * `,thinking` suffix) for the `configOptions` model picker (PLAN D11).
   * Updated by {@link setModel} after the SDK call lands. Phase 15
   * decoupled thinking from the model id — see
   * {@link currentThinkingEnabledInternal} — so this field never carries
   * a `,thinking` suffix even when the client originally sent one
   * through `unstable_setSessionModel`.
   */
  // 中文：适配器侧权威的当前基础模型 ID（不含 ,thinking 后缀）
  private currentModelIdInternal: string;

  /**
   * The adapter-side authoritative current thinking-toggle state.
   * Phase 15 split this out of the model id so the client renders a
   * separate boolean `SessionConfigOption` (the spec's
   * `'thought_level'` category) instead of an inlined `,thinking`
   * variant row in the model dropdown. Updated by {@link setThinking}
   * and by {@link setModel} when the caller passed a merged
   * `${id},thinking` form (legacy `unstable_setSessionModel`
   * compatibility).
   *
   * Maps to the SDK's effort-level string at the boundary:
   * `true` → `'high'` (the typical default for kimi-code), `false`
   * → `'off'`. The granularity of `'low' | 'medium' | 'xhigh' | 'max'`
   * is intentionally not surfaced — the ACP `thinking` axis is binary
   * (Phase 16 wire form: 2-entry `select` `off` / `on`; pre-Phase-16
   * was `SessionConfigBoolean`).
   */
  // 中文：适配器侧权威的思考模式开关状态，映射到 SDK 的 effort-level（true→'high', false→'off'）
  private currentThinkingEnabledInternal = false;

  /**
   * The adapter-side authoritative current mode id. Updated by
   * {@link setMode} after both SDK toggles (`setPlanMode` + `setPermission`)
   * land so the next `config_option_update` notification reflects the
   * new mode. Always one of the four PLAN D9 literals.
   */
  // 中文：适配器侧权威的当前运行模式 ID（default/plan/auto/yolo 四种之一）
  private currentModeIdInternal: AcpModeId = DEFAULT_MODE_ID;

  /**
   * Per-session `slash command name → skill name` map, seeded by
   * {@link AcpServer.emitAvailableCommandsUpdate} from the same
   * `listSkills()` snapshot that builds the client palette. Consulted
   * by {@link prompt} to intercept `/skill:<name> ...` inputs and
   * route them to {@link Session.activateSkill} instead of forwarding
   * the raw slash text to {@link Session.prompt} — which is what made
   * Zed fall back to model-driven Bash exploration of
   * `~/.kimi-code/skills/` and incurred permission prompts. Defaults
   * to an empty map so adapter-level unit tests (which never call
   * `setSkillCommandMap`) behave as a no-op passthrough.
   */
  // 中文：斜杠命令名 → 技能名称的映射表，用于拦截 /skill:<name> 并路由到 activateSkill
  private skillCommandMap: ReadonlyMap<string, string> = new Map();

  /**
   * The most recent command palette advertised to the ACP client. Used by
   * `/help` so the response matches the client's `available_commands_update`
   * snapshot, including dynamically discovered skill commands.
   */
  // 中文：最近一次通告给 ACP 客户端的可用命令列表，供 /help 响应使用
  private availableCommands: readonly AvailableCommand[] = [];

  constructor(
    readonly conn: AgentSideConnection,
    readonly session: Session,
    /**
     * Capabilities the client declared during `initialize`. Passed in
     * by `AcpServer.newSession` so `prompt()` can decide whether to
     * route file I/O through ACP reverse-RPC (`fs.readTextFile` /
     * `fs.writeTextFile`) or fall back to local FS. Optional because
     * adapter-level unit tests still construct `AcpSession` with the
     * two-arg form; absence means "no FS reverse-RPC".
     */
    private readonly clientCapabilities?: ClientCapabilities,
    /**
     * Optional telemetry sink. `AcpServer` threads in
     * `harness.track?.bind(harness)` (Phase 11.2 PII-free pattern); unit
     * tests that construct `AcpSession` with a stub session leave this
     * undefined and the bridges become silent. Internal emits use the
     * {@link safeTrack} guard so a missing or throwing sink can never
     * crash a reverse-RPC handler.
     */
    private readonly track?: TelemetryTrackFn,
    /**
     * Initial value of the adapter-side current BASE model id, supplied by
     * the server when creating / loading the session so the first
     * `config_option_update` snapshot matches the response's
     * `configOptions.model.currentValue`. Defaults to empty string when
     * absent (adapter-level unit tests). Phase 15: must be the bare model
     * key (no `,thinking` suffix); thinking is carried separately by
     * {@link initialThinkingEnabled}.
     */
    initialModelId?: string,
    /**
     * Harness reference used by {@link emitConfigOptionUpdate} to
     * re-list available models when emitting the post-change snapshot.
     * Optional because adapter-level unit tests build `AcpSession`
     * without a harness; when absent, `emitConfigOptionUpdate` is a
     * silent no-op (matches the {@link safeTrack} pattern). Phase 14.3
     * introduces this so the model + mode picker funnel can refresh
     * the full SessionConfigOption[] snapshot on every change.
     */
    private readonly harness?: KimiHarness,
    /**
     * Initial value of the adapter-side thinking-toggle state, supplied
     * by the server when creating / loading the session. Phase 15
     * introduces this so resumed sessions whose persisted
     * `thinkingLevel` was non-`'off'` start with the toggle on.
     * Defaults to `false` when absent.
     */
    initialThinkingEnabled?: boolean,
  ) {
    this.currentModelIdInternal = initialModelId ?? '';
    this.currentThinkingEnabledInternal = initialThinkingEnabled ?? false;
    // 中文：在会话构造时注册审批桥接处理器（而非每次 prompt 时），
    // 因为 setApprovalHandler 的作用域是整个 SDK 会话而非单个轮次
    // Register the approval bridge once, at session-construction time —
    // NOT per-prompt — because `setApprovalHandler` is scoped to the
    // SDK session, not the individual turn. The handler captures `this`
    // lexically; the arrow form avoids re-binding on every event.
    //
    // Defensive: the real `Session` class always provides this method,
    // but partial-stub `Session` instances used in adapter-level unit
    // tests may omit it. Treat absence as "no approval channel" rather
    // than crashing the constructor — the SDK still works end-to-end,
    // just without reverse-RPC approvals.
    if (typeof this.session.setApprovalHandler === 'function') {
      this.session.setApprovalHandler((req) => this.handleApproval(req));
    }
    // 中文：同样的模式，注册问答桥接处理器（AskUserQuestion 反向 RPC 通道）
    // Same pattern as the approval handler, but for the AskUserQuestion
    // reverse-RPC channel (Phase 13.1). Pre-Phase-13 builds of the SDK
    // do not expose `setQuestionHandler`, and unit-test stubs may omit
    // it; the `typeof === 'function'` guard keeps both cases working.
    if (typeof this.session.setQuestionHandler === 'function') {
      this.session.setQuestionHandler(async (req) => this.handleQuestion(req));
    }
  }

  /** ACP-level session identifier — matches the underlying SDK session id. */
  // 中文：获取 ACP 会话标识符，与底层 SDK 会话 ID 一致
  get id(): string {
    return this.session.id;
  }

  /**
   * Adapter-side authoritative current BASE model id (no `,thinking`
   * suffix), used by {@link AcpServer.setSessionConfigOption} to build
   * the response's `configOptions` snapshot after a model / mode /
   * thinking change.
   */
  // 中文：获取适配器侧当前基础模型 ID
  get currentModelId(): string {
    return this.currentModelIdInternal;
  }

  /**
   * Adapter-side authoritative thinking-toggle state, used by
   * {@link AcpServer.setSessionConfigOption} to build the response's
   * `configOptions` snapshot.
   */
  // 中文：获取适配器侧当前思考模式开关状态
  get currentThinkingEnabled(): boolean {
    return this.currentThinkingEnabledInternal;
  }

  /**
   * Adapter-side authoritative current mode id, used by
   * {@link AcpServer.setSessionConfigOption} to build the response's
   * `configOptions` snapshot after a model / mode change.
   */
  // 中文：获取适配器侧当前运行模式 ID
  get currentModeId(): AcpModeId {
    return this.currentModeIdInternal;
  }

  /**
   * Forward an ACP `session/cancel` notification to the underlying SDK
   * session. The SDK's `cancel()` is idempotent at the RPC layer, so
   * repeated cancels (or a cancel on an already-finished turn) are
   * acceptable.
   */
  // 中文：转发 ACP session/cancel 请求到 SDK 会话（幂等操作）
  async cancel(): Promise<void> {
    await this.session.cancel();
  }

  /**
   * Seed the per-session `slash command name → skill name` map used by
   * {@link prompt} to intercept `/skill:<name> ...` inputs. Called by
   * {@link AcpServer.emitAvailableCommandsUpdate} from the same
   * `listSkills()` snapshot that builds the client palette, so the map
   * stays in lockstep with what the client advertises.
   */
  // 中文：设置斜杠命令到技能名称的映射表
  setSkillCommandMap(map: ReadonlyMap<string, string>): void {
    this.skillCommandMap = map;
  }

  /**
   * Seed the advertised command palette and the skill-routing map from one
   * resolver snapshot. This keeps `available_commands_update`, `/help`, and
   * skill slash interception in lockstep.
   */
  // 中文：从解析器快照中同步设置命令面板和技能路由映射，保持三者一致
  setAvailableCommands(
    commands: readonly AvailableCommand[],
    skillCommandMap: ReadonlyMap<string, string>,
  ): void {
    this.availableCommands = commands.slice();
    this.skillCommandMap = skillCommandMap;
  }

  /**
   * Forward an ACP `session/set_model` (`unstable_setSessionModel`)
   * request to the underlying SDK session.
   *
   * ACP allows model identifiers like `"kimi-k2,thinking"` where the
   * `,thinking` suffix signals "always-thinking" mode (mirrors the
   * Python ref's `_ModelIDConv.from_acp_model_id` at
   * `kimi-cli/src/kimi_cli/acp/server.py:425-433`). Phase 15 decoupled
   * thinking from the model id at the ACP surface — it's now its own
   * `thought_level` config option (Phase 16 wire form: 2-entry `select`
   * `off` / `on`) — but this legacy compat path is
   * kept: when the caller sends a merged form, we split it into the
   * bare model key (forwarded to `Session.setModel`) plus a thinking
   * flag (forwarded to `Session.setThinking`).
   *
   * Wire semantics:
   *  - `'kimi-v2'`           → setModel('kimi-v2'); thinking state unchanged.
   *  - `'kimi-v2,thinking'`  → setModel('kimi-v2') + setThinking('high');
   *    thinking state flips on.
   *
   * Note the asymmetry: a bare model id does NOT turn thinking OFF.
   * That keeps the model / thinking axes orthogonal — model changes
   * preserve thinking state. To explicitly disable thinking, the
   * client must call `setSessionConfigOption({ configId: 'thinking',
   * value: false })` (or send `setThinking('off')` directly through
   * the SDK channel, but the ACP surface only exposes the boolean).
   *
   * `currentModelIdInternal` is updated to the bare key — the snapshot
   * therefore never carries a `,thinking` suffix in the model option's
   * `currentValue`. Thinking visibility in the snapshot is governed
   * by `currentThinkingEnabledInternal` and
   * {@link buildSessionConfigOptions}'s `thinkingSupported` gate.
   *
   * Unknown model errors bubble up from the SDK as-is; the caller in
   * `AcpServer.unstable_setSessionModel` decides how to translate them.
   */
  // 中文：设置模型 ID，支持旧格式 "model,thinking" 后缀自动拆分（模型+思考开关）
  async setModel(modelId: ModelId): Promise<void> {
    const suffix = ',thinking';
    const hasSuffix = modelId.endsWith(suffix);
    const baseKey = hasSuffix ? modelId.slice(0, -suffix.length) : modelId;
    await this.session.setModel(baseKey);
    // 中文：如果携带 ,thinking 后缀，同步开启思考模式
    if (hasSuffix && typeof this.session.setThinking === 'function') {
      await this.session.setThinking(THINKING_ON_LEVEL);
      this.currentThinkingEnabledInternal = true;
    }
    this.currentModelIdInternal = baseKey;
    await this.emitConfigOptionUpdate();
  }

  /**
   * Forward an ACP thinking-toggle change to the underlying SDK.
   *
   * Phase 15 introduces this as the new canonical channel for the
   * thinking axis. Boolean → effort-level mapping:
   *  - `true`  → `Session.setThinking('high')` (kimi-code's typical
   *    default; the agent-core `resolveThinkingEffort` would also
   *    coerce a missing config to `'high'`).
   *  - `false` → `Session.setThinking('off')`.
   *
   * Tolerant to partial-stub `Session` instances (adapter-level unit
   * tests construct minimal fakes that may omit `setThinking`): when
   * the method is missing we still update the adapter-side toggle
   * state and emit the snapshot, so the ACP wire stays consistent —
   * the test simply doesn't observe an SDK call.
   *
   * Always emits a `config_option_update` notification afterwards so
   * the client sees the toggle reflect the new value, even if it
   * came in through the funnel and the response itself already
   * carries a fresh snapshot.
   */
  // 中文：切换思考模式开关，将布尔值映射为 SDK 的 effort-level 字符串
  async setThinking(enabled: boolean): Promise<void> {
    if (!enabled && (await this.currentModelAlwaysThinking())) {
      // 中文：当前模型声明了 always_thinking，忽略关闭请求但仍刷新快照
      // The current model cannot disable thinking (declared
      // 'always_thinking'); silently ignore the off request — agent-core
      // clamps the runtime the same way — but still refresh the snapshot
      // so a stale client toggle snaps back to on.
      this.currentThinkingEnabledInternal = true;
      await this.emitConfigOptionUpdate();
      return;
    }
    if (typeof this.session.setThinking === 'function') {
      await this.session.setThinking(enabled ? THINKING_ON_LEVEL : THINKING_OFF_LEVEL);
    }
    this.currentThinkingEnabledInternal = enabled;
    await this.emitConfigOptionUpdate();
  }

  /**
   * Whether the currently-selected model declares 'always_thinking'.
   * Harness-less adapter unit tests resolve to false — the agent-core
   * runtime clamp still protects the actual request in that case.
   */
  // 中文：检查当前模型是否声明了 always_thinking（始终开启思考）
  private async currentModelAlwaysThinking(): Promise<boolean> {
    if (!this.harness) return false;
    const models = await listModelsFromHarness(this.harness);
    return models.find((m) => m.id === this.currentModelIdInternal)?.alwaysThinking === true;
  }

  /**
   * Forward an ACP `session/set_mode` request to the underlying SDK
   * session.
   *
   * Phase 12.2 supports the full 4-mode taxonomy (PLAN D9 at
   * `PLAN.md:85-106`):
   *
   *  - `'default'` → `setPlanMode(false)` + `setPermission('manual')`
   *  - `'plan'`    → `setPlanMode(true)`  + `setPermission('manual')`
   *  - `'auto'`    → `setPlanMode(false)` + `setPermission('auto')`
   *  - `'yolo'`    → `setPlanMode(false)` + `setPermission('yolo')`
   *
   * Order inside every arm is `setPlanMode` → `setPermission` →
   * `emitConfigOptionUpdate`. The dispatch table lives in
   * {@link acpModeToToggles} so the registry of modes and the toggles
   * each mode maps to stay co-located.
   *
   * Phase 14.3 (PLAN D11) emits the generic `config_option_update`
   * notification in place of Phase 12's `current_mode_update` — model
   * and mode pickers share the same notification channel now so a
   * client that listens for either change has exactly one subscription
   * point.
   *
   * No idempotency optimisation (PLAN D9 line 105): even if the client
   * re-asserts the current mode, both SDK calls fire and a fresh
   * `config_option_update` notification is emitted.
   *
   * Error policy:
   *  - Unknown `modeId` → JSON-RPC `invalid_params` (-32602) BEFORE any
   *    SDK call, so the client sees a structured rejection rather than
   *    a partial state change.
   *  - SDK errors from `setPlanMode` or `setPermission` propagate
   *    as-is up to {@link AcpServer.setSessionMode}. When either throws,
   *    the `config_option_update` notification is suppressed (the client
   *    will see the rejection and can re-query state).
   */
  // 中文：设置运行模式（default/plan/auto/yolo），转换为计划模式和权限两组 SDK 开关
  async setMode(modeId: SessionModeId): Promise<void> {
    if (!isAcpModeId(modeId)) {
      throw RequestError.invalidParams({ modeId }, `Unknown sessionModeId: ${modeId}`);
    }
    const { plan, permission } = acpModeToToggles(modeId);
    // 中文：按顺序设置计划模式和权限，然后更新配置快照
    await this.session.setPlanMode(plan);
    await this.session.setPermission(permission);
    this.currentModeIdInternal = modeId;
    await this.emitConfigOptionUpdate();
  }

  /**
   * Push a `config_option_update` session notification carrying the
   * full {@link SessionConfigOption}[] snapshot computed from the
   * adapter-side `currentModelId` + `currentModeId` authoritative state.
   *
   * Called from {@link setModel} and {@link setMode} after the SDK
   * toggle(s) succeed. Tolerant to missing `harness` (adapter-level
   * unit tests construct `AcpSession` without one): when absent, the
   * snapshot cannot be assembled and the emit is silently skipped so
   * the SDK call path still completes. The failure mode is symmetric
   * to {@link safeTrack}.
   *
   * Errors during the underlying `listModelsFromHarness` call or
   * the `sessionUpdate` push are caught and logged at `warn` — same
   * policy as {@link emitAvailableCommandsUpdate}: pushing a session
   * update is a streaming concern, not load-bearing for the SDK call
   * that triggered it.
   */
  // 中文：构建并推送 config_option_update 通知，将当前模型/思考/模式状态快照发送给客户端
  private async emitConfigOptionUpdate(): Promise<void> {
    if (!this.harness) return;
    try {
      const snapshot = await buildSessionConfigOptions(
        this.harness,
        this.currentModelIdInternal,
        this.currentThinkingEnabledInternal,
        this.currentModeIdInternal,
      );
      await this.conn.sessionUpdate(configOptionUpdateNotification(this.id, snapshot));
    } catch (err) {
      log.warn('acp: failed to emit config_option_update', {
        sessionId: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Replay the underlying SDK session's persisted history as a stream
   * of ACP `session/update` notifications.
   *
   * Used by `session/load` (`AcpServer.loadSession`) to bring a freshly
   * reattached client up to the same on-screen state it would have if
   * it had observed every prior `session/prompt` live. Replay is pure
   * event emission: no `onEvent` subscription, no `session.prompt()`
   * call, no Kaos. The method walks {@link Session.getResumeState}
   * (which the node SDK populates from the on-disk session snapshot
   * during `harness.resumeSession`) and synthesizes per-message
   * notifications:
   *
   *  - role `user`         → `user_message_chunk` per text {@link ContentPart}.
   *  - role `assistant`    → `agent_message_chunk` / `agent_thought_chunk`
   *    per text/think content, plus a `tool_call` notification per
   *    `toolCalls` entry. A monotonically increasing synthetic `turnId`
   *    starts at 1 and bumps on each assistant message so the wire ids
   *    (`${turnId}:${toolCallId}`) match the live emission scheme used
   *    in {@link runPromptBody}.
   *  - role `tool`         → `tool_call_update` with `status: 'completed'`
   *    (or `'failed'` if the SDK marked the message as an error).
   *    `toolCallId` is looked up from the bookkeeping map populated when
   *    the originating assistant message was replayed.
   *
   * Tool calls whose result we never observe (interrupted turn,
   * truncated history) are emitted as `tool_call` only — they stay in
   * `in_progress` on the client, which is honest about the underlying
   * state. Likewise, tool messages whose originating `toolCallId` we
   * cannot find are skipped with a warning rather than crashing
   * replay; the latter would deny the rest of the session a chance to
   * surface.
   *
   * Errors thrown by individual `sessionUpdate` calls are caught and
   * logged so a single transient push failure does not truncate the
   * whole replay. The method awaits every push (unlike the live
   * `runPromptBody` fire-and-forget path) because replay is a one-shot
   * batch — completion ordering is what tells the caller (`loadSession`)
   * that the response is safe to return.
   */
  // 中文：重放历史会话记录，将持久化的消息逐条转换为 ACP session/update 通知
  // 用于客户端重新连接时恢复到断点前的显示状态
  async replayHistory(agentId: string = MAIN_AGENT_ID): Promise<void> {
    const sessionId = this.id;
    const conn = this.conn;
    const resumeState = this.session.getResumeState?.();
    if (!resumeState) {
      log.warn('acp: replayHistory called on session without resume state', { sessionId });
      return;
    }
    const agent = resumeState.agents?.[agentId];
    if (!agent) {
      log.warn('acp: replayHistory found no agent state for replay', {
        sessionId,
        agentId,
        knownAgents: resumeState.agents ? Object.keys(resumeState.agents) : [],
      });
      return;
    }

    let turnId = 0;
    // Map from SDK toolCallId → owning synthetic turnId, populated when
    // the assistant message that issued the call is replayed and read
    // when the tool result lands. Lives for the duration of one replay.
    // 中文：工具调用 ID → 所属合成轮次 ID 的映射表，在重放期间维护
    const toolCallTurnIds = new Map<string, number>();

    for (const message of agent.context.history) {
      try {
        await this.replayMessage(message, sessionId, conn, {
          getTurnId: () => turnId,
          beginAssistantTurn: () => {
            turnId += 1;
          },
          recordToolCall: (toolCallId) => {
            toolCallTurnIds.set(toolCallId, turnId);
          },
          lookupToolCallTurnId: (toolCallId) => toolCallTurnIds.get(toolCallId),
        });
      } catch (err) {
        log.warn('acp: replayHistory failed to emit a message; continuing', {
          sessionId,
          role: message.role,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Emit ACP session updates for a single historical {@link ContextMessage}.
   *
   * Factored out of {@link replayHistory} so the per-message dispatch
   * stays small and the outer loop is just the turnId/tool-bookkeeping
   * shell. Awaits every `sessionUpdate` so the replay completes in
   * order (see {@link replayHistory} JSDoc for the rationale).
   */
  // 中文：重放单条历史消息，根据角色（user/assistant/tool）分发到不同的转换逻辑
  private async replayMessage(
    message: ContextMessage,
    sessionId: string,
    conn: AgentSideConnection,
    ctx: {
      getTurnId: () => number;
      beginAssistantTurn: () => void;
      recordToolCall: (toolCallId: string) => void;
      lookupToolCallTurnId: (toolCallId: string) => number | undefined;
    },
  ): Promise<void> {
    switch (message.role) {
      case 'user':
        // 中文：用户消息——逐段发送 user_message_chunk
        for (const part of message.content) {
          if (part.type === 'text' && part.text) {
            await conn.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: part.text },
              },
            });
          }
        }
        return;
      case 'assistant': {
        // 中文：助手消息——开始新轮次，重放文本/思考内容和工具调用
        ctx.beginAssistantTurn();
        const turnId = ctx.getTurnId();
        for (const part of message.content) {
          await this.replayAssistantContentPart(part, sessionId, conn, turnId);
        }
        for (const toolCall of message.toolCalls ?? []) {
          ctx.recordToolCall(toolCall.id);
          await this.replaySyntheticToolCall(toolCall, sessionId, conn, turnId);
        }
        return;
      }
      case 'tool': {
        // 中文：工具结果消息——查找对应的工具调用 ID 并发送完成/失败状态
        const rawToolCallId = message.toolCallId;
        if (!rawToolCallId) {
          // Tool result with no correlation id — log and skip rather
          // than crash. The on-disk session is the source of truth;
          // we cannot synthesize a missing id.
          log.warn('acp: replayHistory skipped tool message with no toolCallId', { sessionId });
          return;
        }
        const turnId = ctx.lookupToolCallTurnId(rawToolCallId);
        if (turnId === undefined) {
          log.warn('acp: replayHistory found tool message with no matching call', {
            sessionId,
            toolCallId: rawToolCallId,
          });
          return;
        }
        const isError = message.isError === true;
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: acpToolCallId(turnId, rawToolCallId),
            status: isError ? 'failed' : 'completed',
            content: toolMessageContentToAcpToolCallContent(message.content),
          },
        });
        return;
      }
      default:
        // system / unknown roles — ACP has no analogue; skip.
        // 中文：系统/未知角色——ACP 无对应语义，跳过
        return;
    }
  }

  // 中文：重放助手消息中的单个内容部分（文本或思考），转换为对应的 session/update 通知
  private async replayAssistantContentPart(
    part: ContextMessage['content'][number],
    sessionId: string,
    conn: AgentSideConnection,
    turnId: number,
  ): Promise<void> {
    if (part.type === 'text' && part.text) {
      await conn.sessionUpdate(
        assistantDeltaToSessionUpdate(sessionId, {
          type: 'assistant.delta',
          turnId,
          delta: part.text,
        }),
      );
      return;
    }
    if (part.type === 'think' && part.think) {
      await conn.sessionUpdate(
        thinkingDeltaToSessionUpdate(sessionId, {
          type: 'thinking.delta',
          turnId,
          delta: part.think,
        }),
      );
      return;
    }
    // image_url / audio_url / video_url are skipped at this layer —
    // they belong to the user input side and ACP does not have a
    // dedicated assistant-media chunk.
  }

  // 中文：重放历史中的合成工具调用通知（工具结果在 tool 角色消息中单独处理）
  private async replaySyntheticToolCall(
    toolCall: NonNullable<ContextMessage['toolCalls']>[number],
    sessionId: string,
    conn: AgentSideConnection,
    turnId: number,
  ): Promise<void> {
    const name = toolCall.name;
    const argsRaw = toolCall.arguments;
    const parsedArgs = parseToolCallArguments(argsRaw);
    await conn.sessionUpdate(
      toolCallStartToSessionUpdate(sessionId, {
        type: 'tool.call.started',
        turnId,
        toolCallId: toolCall.id,
        name,
        args: parsedArgs,
      }),
    );
  }

  /**
   * Run an ACP `session/prompt` against the underlying SDK session.
   *
   * Error mapping (Phase 11.1):
   *  - Auth-coded errors (`AUTH_LOGIN_REQUIRED`, `PROVIDER_AUTH_ERROR`)
   *    surface as `RequestError.authRequired()` so the ACP client can
   *    drive its own re-auth UX rather than a generic internal error.
   *  - Everything else becomes `RequestError.internalError(...)` with
   *    the stack/message logged to the agent log file but NOT exposed
   *    to the client (the JSON-RPC layer would otherwise leak details).
   *  - Auth-coded failures may arrive on TWO paths: a `turn.ended`
   *    event with `reason: 'failed'` and an `event.error` payload, OR
   *    a synchronous `session.prompt(...)` rejection. Both are
   *    routed through {@link mapPromptError} for parity.
   *
   * Subscribes to the session event stream; for every `assistant.delta`,
   * pushes an `agent_message_chunk` `session/update` notification to the
   * client. Resolves with the ACP `PromptResponse` (containing
   * `stopReason`) when a `turn.ended` event arrives.
   *
   * Cleanup invariants:
   *  - The event subscription is unsubscribed on EVERY exit path
   *    (success, cancel, failed turn, and `session.prompt()` rejection).
   *  - If `session.prompt()` rejects synchronously or asynchronously, the
   *    rejection is propagated as a `prompt` request error so the client
   *    sees a JSON-RPC error rather than a hung request.
   */
  // 中文：处理 ACP session/prompt 请求——先拦截斜杠命令，再转发给 SDK 执行
  async prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    const parts = acpBlocksToPromptParts(blocks);
    const sessionId = this.id;
    const conn = this.conn;

    // ACP clients send slash commands as plain text `ContentBlock`s in
    // `session/prompt`. Intercept only commands the adapter can execute
    // directly: skills route to `Session.activateSkill(...)`, ACP-owned
    // built-ins route to local SDK queries, and unknown slash commands are
    // reported locally instead of being forwarded to the model as text.
    // 中文：检测输入中的斜杠命令意图，按类型分发处理
    const intent = detectLeadingSlashIntent(blocks, this.skillCommandMap);
    if (intent.kind === 'skill') {
      // 中文：技能命令——路由到 Session.activateSkill 执行
      this.emitTelemetry('acp_skill_activated', { skill_name: intent.skillName });
      const skillName = intent.skillName;
      const skillArgs = intent.args;
      return this.runTurnBody(sessionId, conn, () =>
        // `activateSkill` accepts `args?: string | undefined`; pass the
        // empty string through verbatim — the SDK's
        // `normalizeOptionalString` converts `''` to `undefined`, which
        // is the canonical "no args" form for the skill renderer.
        this.session.activateSkill(skillName, skillArgs.length > 0 ? skillArgs : undefined),
      );
    }
    if (intent.kind === 'builtin') {
      // 中文：内置命令（compact/status/usage/mcp/tasks/help）——本地执行
      return this.runBuiltInCommand(intent.name, intent.args);
    }
    if (intent.kind === 'unknown') {
      // 中文：未知斜杠命令——返回错误提示
      return this.runUnknownSlashCommand(intent.name);
    }

    // 中文：普通文本提示——转发给 SDK prompt 执行
    return this.runTurnBody(sessionId, conn, () => this.session.prompt(parts));
  }

  // 中文：执行内置 ACP 命令（compact/status/usage/mcp/tasks/help），返回结果消息
  private async runBuiltInCommand(
    name: AcpBuiltinSlashCommandName,
    args: string,
  ): Promise<PromptResponse> {
    try {
      switch (name) {
        case 'compact':
          await this.runCompactCommand(args);
          break;
        case 'status':
          await this.emitLocalCommandMessage(formatStatusReport(await this.session.getStatus()));
          break;
        case 'usage':
          await this.emitLocalCommandMessage(
            formatUsageReport(await this.session.getUsage(), await this.session.getStatus()),
          );
          break;
        case 'mcp':
          await this.emitLocalCommandMessage(formatMcpReport(await this.session.listMcpServers()));
          break;
        case 'tasks':
          await this.emitLocalCommandMessage(
            formatTasksReport(await this.session.listBackgroundTasks()),
          );
          break;
        case 'help':
          await this.emitLocalCommandMessage(formatHelpReport(this.availableCommands));
          break;
      }
    } catch (error) {
      await this.emitLocalCommandMessage(`/${name} failed: ${errorMessage(error)}`);
    }
    return { stopReason: 'end_turn' };
  }

  // 中文：处理未知的斜杠命令，返回提示信息
  private async runUnknownSlashCommand(name: string): Promise<PromptResponse> {
    await this.emitLocalCommandMessage(
      `Unknown ACP command: /${name}. Use /help to see available commands.`,
    );
    return { stopReason: 'end_turn' };
  }

  // 中文：向客户端推送一条本地命令结果消息（agent_message_chunk）
  private async emitLocalCommandMessage(text: string): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId: this.id,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }

  // 中文：执行上下文压缩命令（/compact），监听压缩生命周期事件并返回结果
  private async runCompactCommand(args: string): Promise<void> {
    const instruction = args.trim() || undefined;
    let started = false;
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    // The agent-core compaction worker emits events in this order on
    // failure: `compaction.cancelled` (from `markCanceled`) followed by
    // `error` (unless the failure happened while blocked-by-turn, in
    // which case `compact()` itself rejects). We resolve on whichever
    // terminal event arrives first and ignore the rest, so a follow-up
    // `error` after a cancelled never causes a double-settle.
    // 中文：监听压缩事件流，在首个终止事件到达时结算（防止重复结算）
    const completion = new Promise<CompactionOutcome>((resolve, reject) => {
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      unsubscribe = this.session.onEvent((event: Event) => {
        if (event.agentId !== undefined && event.agentId !== MAIN_AGENT_ID) return;
        if (event.type === 'compaction.started') {
          started = true;
          void this.emitLocalCommandMessage(
            instruction === undefined
              ? 'Compacting conversation context…'
              : `Compacting conversation context with instruction: ${instruction}`,
          );
          return;
        }
        if (event.type === 'compaction.completed') {
          settle(() => resolve({ kind: 'completed', result: event.result }));
          return;
        }
        if (event.type === 'compaction.cancelled') {
          settle(() => resolve({ kind: 'cancelled' }));
          return;
        }
        if (event.type === 'compaction.blocked') {
          void this.emitLocalCommandMessage('Compaction is blocked by the current turn; retry when the turn is idle.');
          return;
        }
        // Surface any error event the worker emits, even if it lands
        // before `compaction.started` — that path is currently empty
        // (begin() throws synchronously and rejects compact()), but
        // dropping pre-start errors would silently hang the prompt if
        // the worker is ever restructured.
        // 中文：捕获压缩错误事件（即使在 started 之前到达）
        if (event.type === 'error') {
          settle(() => reject(new Error(event.message)));
        }
      });
    });
    try {
      await this.session.compact({ instruction });
      if (!started && !settled) {
        await this.emitLocalCommandMessage('Compaction was not started.');
        return;
      }
      const outcome = await completion;
      if (outcome.kind === 'completed') {
        await this.emitLocalCommandMessage(formatCompactionCompleted(outcome.result));
      } else {
        await this.emitLocalCommandMessage('Compaction cancelled.');
      }
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * Body of {@link prompt}, extracted so the event-listener invariants
   * — single `onEvent` subscription, `settled` flag semantics,
   * `currentTurnId` reset — live in one place and can be driven by
   * either `Session.prompt(parts)` or `Session.activateSkill(name, args)`.
   * Both entry points trigger the same downstream turn (skill
   * activation internally calls `agent.turn.prompt(...)` after
   * injecting the `<kimi-skill-loaded>` block — see
   * `packages/agent-core/src/agent/skill/index.ts`), so the event
   * subscription's `turn.started` / `turn.ended` semantics apply
   * uniformly.
   */
  // 中文：prompt 的核心执行体——订阅 SDK 事件流，将实时事件转换为 ACP session/update 通知
  // 支持 prompt 和 activateSkill 两种入口，共享同一套事件监听和结算逻辑
  private runTurnBody(
    sessionId: string,
    conn: AgentSideConnection,
    kick: () => Promise<unknown>,
  ): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve, reject) => {
      let settled = false;
      const isFromMainAgent = (event: { agentId?: string }): boolean =>
        event.agentId === undefined || event.agentId === MAIN_AGENT_ID;
      // Per-tool-call streaming args accumulator. Lives in the Promise
      // executor closure so each `prompt()` invocation gets its own
      // map and no state leaks across concurrent or sequential turns.
      // Keyed on the **SDK** `toolCallId` (not the ACP-prefixed one)
      // because the SDK delta events only carry the raw id.
      // 中文：每个工具调用的流式参数累积器，按 SDK toolCallId 索引
      const argsByToolCall = new Map<string, { args: string }>();
      // Set of **wire-level** (turn-prefixed) tool-call ids for which
      // we have already sent the `tool_call` CREATE notification. The
      // agent-core actually emits `tool.call.delta` events BEFORE
      // `tool.call.started` (deltas come from the model's args stream;
      // the started event comes from the loop dispatching the call
      // afterwards). Without this set, the naive "started → tool_call,
      // delta → tool_call_update" mapping puts updates on the wire
      // ahead of the create, and clients such as Zed surface "Tool
      // call not found" until the create eventually lands. We instead
      // lazy-create the wire `tool_call` on the first delta and
      // downgrade the eventual started event into a `tool_call_update`
      // carrying the canonical title/kind/rawInput (and any
      // `display`-derived diff).
      //
      // Keyed on the wire id (`${turnId}:${rawToolCallId}`) — not the
      // raw SDK `toolCallId` — because providers may legitimately
      // reuse the same raw id across turns within one prompt, and
      // each turn produces a distinct wire-level tool call that needs
      // its own CREATE.
      // 中文：已发送 tool_call CREATE 的线级 ID 集合，用于处理 delta-before-started 的乱序问题
      const startedToolCalls = new Set<string>();
      const initialActiveTurnId = this.currentTurnId;
      let hasReceivedOwnTurnStarted = false;
      const unsub = this.session.onEvent((event) => {
        if (
          event.type === 'turn.started' &&
          isFromMainAgent(event) &&
          (initialActiveTurnId === undefined || event.turnId !== initialActiveTurnId)
        ) {
          hasReceivedOwnTurnStarted = true;
        }
        // Track the active turn so `handleApproval` (registered once at
        // construction, called via `setApprovalHandler`) can compose the
        // prefixed `${turnId}:${toolCallId}` wire id that matches the
        // tool card the client already rendered. This branch is purely
        // additive: it runs before the existing dispatch and never
        // returns, so the if-chain below behaves exactly as in Phase 4.
        // Subagent turn events carry their own `turnId`; filtering on
        // `agentId` keeps `currentTurnId` aligned with the parent turn
        // that the approval prompt actually belongs to.
        // 中文：跟踪活跃轮次 ID（仅主线程事件），供 handleApproval 组装前缀工具调用 ID
        if (
          'turnId' in event &&
          typeof event.turnId === 'number' &&
          isFromMainAgent(event)
        ) {
          this.currentTurnId = event.turnId;
        }
        if (event.type === 'error') {
          // 中文：错误事件——如果另一个轮次正活跃且自身尚未开始，立即拒绝
          if (settled) return;
          if (!isFromMainAgent(event)) return;
          if (event.code !== ErrorCodes.TURN_AGENT_BUSY) return;
          if (hasReceivedOwnTurnStarted) return;
          settled = true;
          argsByToolCall.clear();
          startedToolCalls.clear();
          this.currentTurnId = undefined;
          unsub();
          log.warn('acp: prompt rejected because another turn is active', {
            sessionId,
            details: event.details,
          });
          reject(
            RequestError.invalidRequest(
              { code: event.code, details: event.details },
              event.message,
            ),
          );
          return;
        }
        if (event.type === 'assistant.delta') {
          if (!isFromMainAgent(event)) return;
          // `sessionUpdate` is itself async (it serializes onto the
          // ndjson stream). The text deltas form a strictly ordered
          // single-producer/single-consumer pipeline, so each await
          // would force the next delta to wait for the previous flush.
          // Fire-and-forget keeps the stream pumping; we log push
          // failures rather than dropping them silently.
          // 中文：助手文本增量——fire-and-forget 推送 agent_message_chunk 以保持流式管道畅通
          conn
            .sessionUpdate(assistantDeltaToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push agent_message_chunk', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'thinking.delta') {
          // 中文：思考内容增量——fire-and-forget 推送 agent_thought_chunk
          if (!isFromMainAgent(event)) return;
          conn
            .sessionUpdate(thinkingDeltaToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push agent_thought_chunk', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'tool.call.started') {
          if (!isFromMainAgent(event)) return;
          // Seed the accumulator with the **stringified initial args**.
          // The wire-level `tool_call_update` is REPLACE-content (not
          // append) so each subsequent delta emits the cumulative args
          // string; if we seeded with an empty string the first delta
          // would silently drop the initial args from the rendered card.
          // 中文：用字符串化的初始参数初始化累积器（REPLACE-content 语义）
          argsByToolCall.set(event.toolCallId, { args: stringifyArgs(event.args) });
          // Branch on whether a streaming delta already lazy-created
          // the wire `tool_call` for this id:
          //  - YES → we cannot send a second `tool_call` CREATE; emit a
          //    `tool_call_update` (the "upgrade") so `title`/`kind`/
          //    `rawInput`/`display`-derived diff land on the existing
          //    card and `status` flips to `'in_progress'`.
          //  - NO  → no prior deltas (e.g. provider doesn't stream args);
          //    take the original path and emit the `tool_call` CREATE.
          // 中文：判断 delta 是否已提前 lazy-create 了 wire tool_call，决定发送 CREATE 还是升级 UPDATE
          const startedWireId = acpToolCallId(event.turnId, event.toolCallId);
          if (startedToolCalls.has(startedWireId)) {
            // 中文：已有 CREATE——发送升级通知（补充 title/kind/rawInput 等元数据）
            conn
              .sessionUpdate(toolCallStartedUpgradeToSessionUpdate(sessionId, event))
              .catch((err) => {
                log.warn('acp: failed to push tool_call_update (start upgrade)', {
                  sessionId,
                  toolCallId: event.toolCallId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          } else {
            // 中文：无先前 delta——按常规路径发送 tool_call CREATE
            startedToolCalls.add(startedWireId);
            conn
              .sessionUpdate(toolCallStartToSessionUpdate(sessionId, event))
              .catch((err) => {
                log.warn('acp: failed to push tool_call', {
                  sessionId,
                  toolCallId: event.toolCallId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }
          // Phase 9.3: when the tool exposed a structured TodoList
          // display, additionally fire a `plan` session_update so ACP
          // clients can render the agent's evolving TODO list. Other
          // display kinds (diff/file_io/command/…) are already folded
          // into the tool_call card; only `todo_list` becomes a plan.
          // The emission is fire-and-forget under the same idle-stream
          // discipline as the assistant deltas above.
          // 中文：如果工具暴露了 TodoList 展示，额外推送 plan 通知供客户端渲染 TODO 列表
          if (event.display) {
            const planNote = planFromDisplayBlock(sessionId, event.turnId, event.display);
            if (planNote !== null) {
              conn.sessionUpdate(planNote).catch((err) => {
                log.warn('acp: failed to push plan', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }
          return;
        }
        if (event.type === 'tool.call.delta') {
          if (!isFromMainAgent(event)) return;
          // The agent-core emits these args-stream deltas BEFORE the
          // `tool.call.started` event (deltas come from the provider's
          // streaming phase; started is dispatched afterwards). If we
          // haven't yet sent a `tool_call` CREATE for this id, do so now
          // from the delta — Zed otherwise sees a `tool_call_update`
          // for an unknown id and surfaces "Tool call not found" until
          // the start eventually lands.
          // 中文：工具调用参数增量——如果尚未发送 CREATE，则从 delta 事件 lazy-create
          const deltaWireId = acpToolCallId(event.turnId, event.toolCallId);
          if (!startedToolCalls.has(deltaWireId)) {
            // 中文：首次 delta——lazy-create tool_call 并初始化累积器
            const initial = event.argumentsPart ?? '';
            argsByToolCall.set(event.toolCallId, { args: initial });
            startedToolCalls.add(deltaWireId);
            conn
              .sessionUpdate(toolCallLazyCreateToSessionUpdate(sessionId, event))
              .catch((err) => {
                log.warn('acp: failed to push tool_call (lazy create from delta)', {
                  sessionId,
                  toolCallId: event.toolCallId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            return;
          }
          // Subsequent delta — accumulate then emit an update with the
          // cumulative args text (REPLACE-content semantics).
          // 中文：后续 delta——累积参数并推送增量更新（REPLACE-content 语义）
          let acc = argsByToolCall.get(event.toolCallId);
          if (!acc) {
            acc = { args: '' };
            argsByToolCall.set(event.toolCallId, acc);
          }
          conn
            .sessionUpdate(toolCallDeltaToSessionUpdate(sessionId, event, acc))
            .catch((err) => {
              log.warn('acp: failed to push tool_call_update (delta)', {
                sessionId,
                toolCallId: event.toolCallId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'tool.progress') {
          // 中文：工具进度更新——转换并推送（部分工具不产生进度通知则跳过）
          if (!isFromMainAgent(event)) return;
          const note = toolProgressToSessionUpdate(sessionId, event);
          if (note === null) return;
          conn.sessionUpdate(note).catch((err) => {
            log.warn('acp: failed to push tool_call_update (progress)', {
              sessionId,
              toolCallId: event.toolCallId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          return;
        }
        if (event.type === 'tool.result') {
          // 中文：工具执行结果——转换并推送完成状态的 tool_call_update
          if (!isFromMainAgent(event)) return;
          conn
            .sessionUpdate(toolResultToSessionUpdate(sessionId, event))
            .catch((err) => {
              log.warn('acp: failed to push tool_call_update (result)', {
                sessionId,
                toolCallId: event.toolCallId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }
        if (event.type === 'turn.ended') {
          // 中文：轮次结束事件——结算 Promise，清理状态，清理事件订阅
          if (settled) return;
          if (!isFromMainAgent(event)) return;
          settled = true;
          if (event.reason === 'failed') {
            // Failures bubble up via the SDK `error` payload. Phase 11.1
            // upgrades the prior "log + resolve end_turn" behaviour to
            // route auth-coded failures through `RequestError.authRequired()`
            // so the client can trigger its re-auth UX. Other failure
            // codes still resolve with `end_turn` (the spec discourages
            // signaling errors through `stopReason`; the failure is
            // observable in the log).
            // 中文：失败的轮次——认证类错误映射为 authRequired，其他错误降级为 end_turn
            log.warn('acp: turn ended with failed reason', {
              sessionId,
              error: event.error,
            });
            argsByToolCall.clear();
            startedToolCalls.clear();
            this.currentTurnId = undefined;
            unsub();
            const authErr = authRequiredFromPayload(event.error);
            if (authErr) {
              reject(authErr);
              return;
            }
          } else {
            if (event.reason === 'filtered') {
              // The provider's safety policy blocked the response. It is
              // mapped to ACP `refusal` (see turnEndReasonToStopReason); log
              // it here too so the block stays observable in the agent logs,
              // mirroring the `failed` branch above.
              log.warn('acp: turn ended with filtered reason', { sessionId });
            }
            argsByToolCall.clear();
            startedToolCalls.clear();
            // Drop the turnId so a late-arriving approval (e.g. an SDK
            // reverse-RPC racing the turn boundary) falls back to the raw
            // SDK id rather than re-prefixing with a stale value.
            // 中文：清除轮次 ID，防止迟到的审批请求使用过期值
            this.currentTurnId = undefined;
            unsub();
          }
          resolve({ stopReason: turnEndReasonToStopReason(event.reason) });
        }
      });

      // 中文：启动 SDK 调用（prompt 或 activateSkill），捕获同步/异步拒绝并映射为 ACP 错误
      kick().catch((err) => {
        if (settled) return;
        settled = true;
        unsub();
        reject(mapPromptError(err, sessionId));
      });
    });
  }

  /**
   * Bridge an SDK {@link ApprovalRequest} through the ACP reverse-RPC
   * `session/request_permission`.
   *
   * Flow:
   *  1. Build the wire-level {@link ToolCallUpdate} so the client can
   *     correlate the prompt with the tool card it already rendered
   *     (uses the prefixed `${turnId}:${rawId}` form when available).
   *  2. Forward to the client via `conn.requestPermission` with the
   *     three canonical options (`allow_once`, `allow_always`, `reject`).
   *  3. Map the response back to {@link ApprovalResponse} for the SDK.
   *
   * Error policy: any RPC failure (transport drop, client error,
   * timeout) resolves with `decision: 'rejected'` and a structured log
   * line. Rejecting on failure is strictly safer than approving when
   * the client cannot confirm intent, and matches the Python
   * reference's behaviour for the same edge case.
   *
   * The handler is registered exactly once in the constructor; this
   * method is invoked by the SDK reverse-RPC layer whenever the loop
   * needs human authorization to proceed with a tool call.
   */
  // 中文：审批桥接——将 SDK 审批请求通过 ACP requestPermission 转发给客户端，等待用户决策
  private async handleApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    const toolCall = buildPermissionToolCallUpdate(this.currentTurnId, req);
    const options = approvalRequestToPermissionOptions(req);
    // Phase 13.2 telemetry breadcrumb: how many discrete options does
    // the plan_review surface carry? PII-free (just a count), matches
    // the Phase 11.2 telemetry discipline.
    // 中文：遥测——记录 plan_review 选项数量（无 PII）
    if (req.display.kind === 'plan_review') {
      const count = req.display.options?.length ?? 0;
      this.emitTelemetry('plan_review_options_count', { count });
    }
    try {
      // `requestPermission` is an awaitable JSON-RPC request (unlike
      // the fire-and-forget `sessionUpdate` notifications elsewhere in
      // this file), so the SDK call site naturally blocks on the
      // user's decision before the tool runs.
      // 中文：向客户端发起权限请求并等待用户决策（阻塞式 RPC）
      const response = await this.conn.requestPermission({
        sessionId: this.id,
        options: [...options],
        toolCall,
      });
      // Map the discriminator first (pure mapper, easy to unit-test),
      // then stitch the matched option's human-readable name as
      // `selectedLabel` so the SDK can surface "approved as
      // 'Approve once'" in subsequent reasoning. `attachSelectedLabel`
      // is a no-op for `cancelled` outcomes, unknown optionIds, and
      // plan_* optionIds (Phase 13.2 — the plan_review branch attaches
      // selectedLabel inside `permissionResponseToApprovalResponse`).
      // 中文：将客户端响应映射为 SDK 审批响应，并附加选中选项的标签
      return attachSelectedLabel(
        response,
        permissionResponseToApprovalResponse(req, response),
        options,
      );
    } catch (err) {
      // 中文：RPC 失败时降级为拒绝（安全优先原则：无法确认意图时拒绝比批准更安全）
      log.warn('acp: requestPermission failed; rejecting', {
        sessionId: this.id,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return { decision: 'rejected' };
    }
  }

  /**
   * Bridge an SDK {@link QuestionRequest} (the AskUserQuestion tool's
   * reverse-RPC) through the same ACP
   * `session/request_permission` surface used by approvals.
   *
   * ACP currently has no dedicated `session/request_question` method, so
   * the adapter re-uses `requestPermission` and tags the options with a
   * `q{n}_*` namespace so the round-trip is unambiguous.
   *
   * Degradation rules:
   *  - `req.questions.length > 1` → only the first question is asked;
   *    telemetry records the dropped count so we can observe how often
   *    multi-question prompts land in the wild.
   *  - `q.multiSelect === true` → still asked as single-select; the
   *    SDK's ask-user tool tolerates a single-key answer for a multi-
   *    select prompt so this is a graceful narrow rather than a hard
   *    fail.
   *
   * Error policy mirrors {@link handleApproval}: any RPC failure logs
   * a warning and returns `null` so the SDK resolves the tool with the
   * canonical "user dismissed" branch (`rpc.ts:567`). Returning `null`
   * is strictly safer than fabricating an answer the user did not give.
   */
  // 中文：问答桥接——将 SDK AskUserQuestion 请求复用 ACP requestPermission 通道转发给客户端
  private async handleQuestion(req: QuestionRequest): Promise<QuestionAnswers | null> {
    const questions = req.questions;
    if (questions.length === 0) {
      // Pathological input — log and dismiss. No telemetry: the SDK
      // would never emit an empty `questions` payload in practice.
      log.warn('acp: handleQuestion received empty questions array', {
        sessionId: this.id,
      });
      return null;
    }
    if (questions.length > 1) {
      // 中文：多问题降级——仅询问第一个问题，记录丢弃数量
      log.warn('acp: handleQuestion degrading to first question only', {
        sessionId: this.id,
        dropped: questions.length - 1,
      });
      this.emitTelemetry('question_degraded', {
        reason: 'multi_question',
        dropped: questions.length - 1,
      });
    }
    const q = questions[0]!;
    if (q.multiSelect === true) {
      // 中文：多选降级为单选——记录遥测
      this.emitTelemetry('question_degraded', { reason: 'multi_select' });
    }
    const options = questionItemToPermissionOptions(q, 0);
    const rawToolCallId = req.toolCallId ?? 'ask-user';
    // 中文：组装前缀工具调用 ID（格式 ${turnId}:${rawId}）
    const toolCallId =
      this.currentTurnId !== undefined
        ? acpToolCallId(this.currentTurnId, rawToolCallId)
        : rawToolCallId;
    try {
      const response = await this.conn.requestPermission({
        sessionId: this.id,
        options: [...options],
        toolCall: {
          toolCallId,
          title: 'AskUserQuestion',
          content: [{ type: 'content', content: { type: 'text', text: q.question } }],
        },
      });
      const answer = outcomeToQuestionAnswer(q, response);
      if (answer === null) {
        // Dismissed via skip / cancel / unknown optionId — telemetry
        // matches the ask-user tool's existing `question_dismissed`
        // event so dashboards stay coherent.
        // 中文：用户跳过/取消——记录 question_dismissed 遥测
        this.emitTelemetry('question_dismissed');
      } else {
        // 中文：用户已回答——记录 question_answered 遥测
        this.emitTelemetry('question_answered');
      }
      return answer;
    } catch (err) {
      // 中文：RPC 失败时降级为返回 null（用户未作答），比捏造答案更安全
      log.warn('acp: requestPermission (question) failed; dismissing', {
        sessionId: this.id,
        toolCallId: req.toolCallId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fire-and-forget telemetry emitter that guards a missing or
   * throwing `track` sink. Mirrors the Phase 11.2 pattern in
   * `server.ts:trackSessionStarted` — telemetry must never crash a
   * reverse-RPC handler.
   */
  // 中文：安全的遥测发射器——缺失或抛异常的 sink 不会崩溃反向 RPC 处理器
  private emitTelemetry(event: string, properties?: Record<string, unknown>): void {
    if (typeof this.track !== 'function') return;
    try {
      this.track(event, properties);
    } catch (err) {
      log.warn('acp: telemetry track failed', {
        sessionId: this.id,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Map a Kimi SDK error (raw `Error`, `KimiError`, or `KimiErrorPayload`)
 * into the ACP {@link RequestError} shape used by the JSON-RPC layer.
 *
 * Auth-coded inputs (`auth.login_required`, `provider.auth_error`)
 * become `RequestError.authRequired()` so the client can drive its own
 * re-auth UX. Everything else becomes `RequestError.internalError(...)`
 * with the raw error logged to the agent log file but NOT exposed in
 * the JSON-RPC response — the client only sees the canonical
 * "session prompt failed" message, preventing accidental leakage of
 * stack frames or PII through the wire.
 *
 * The kimi-cli Python reference performs the same mapping at
 * `kimi-cli/src/kimi_cli/acp/session.py:218-247`; this is the TS port.
 */
// 中文：压缩完成事件的结果类型
type CompactionCompletedResult = Extract<Event, { type: 'compaction.completed' }>['result'];

// 中文：压缩操作的可能结果——完成（含结果）或取消
type CompactionOutcome =
  | { readonly kind: 'completed'; readonly result: CompactionCompletedResult }
  | { readonly kind: 'cancelled' };

// 中文：从错误对象中安全提取错误消息字符串
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 中文：格式化帮助报告——列出所有可用的 ACP 斜杠命令
function formatHelpReport(commands: readonly AvailableCommand[]): string {
  const visibleCommands: readonly AvailableCommand[] =
    commands.length > 0 ? commands : ACP_BUILTIN_SLASH_COMMANDS;
  return [
    'Available ACP commands:',
    ...visibleCommands.map((command) => {
      const hint = command.input?.hint ? ` ${command.input.hint}` : '';
      return `- /${command.name}${hint} — ${command.description}`;
    }),
  ].join('\n');
}

// 中文：格式化会话状态报告——显示模型、思考级别、权限模式和上下文使用情况
function formatStatusReport(status: SessionStatus): string {
  const maxTokens = status.maxContextTokens > 0 ? status.maxContextTokens.toLocaleString('en-US') : 'unknown';
  const usage = formatContextUsage(status.contextUsage);
  return [
    'Session status:',
    `- Model: ${status.model ?? '(not set)'}`,
    `- Thinking: ${status.thinkingLevel}`,
    `- Permission: ${status.permission}`,
    `- Plan mode: ${status.planMode ? 'on' : 'off'}`,
    `- Context: ${status.contextTokens.toLocaleString('en-US')} / ${maxTokens}${usage}`,
  ].join('\n');
}

// 中文：格式化 Token 使用量报告——按总量、当前轮次和各模型分别统计
function formatUsageReport(usage: SessionUsage, status: SessionStatus): string {
  const lines = ['Session usage:'];
  if (usage.total !== undefined) {
    lines.push(`- Total: ${formatTokenUsage(usage.total)}`);
  }
  if (usage.currentTurn !== undefined) {
    lines.push(`- Current turn: ${formatTokenUsage(usage.currentTurn)}`);
  }
  for (const [model, modelUsage] of Object.entries(usage.byModel ?? {})) {
    lines.push(`- ${model}: ${formatTokenUsage(modelUsage)}`);
  }
  lines.push(
    `- Context: ${status.contextTokens.toLocaleString('en-US')} / ${status.maxContextTokens.toLocaleString('en-US')}${formatContextUsage(status.contextUsage)}`,
  );
  return lines.join('\n');
}

// 中文：格式化 MCP 服务器状态报告
function formatMcpReport(servers: readonly McpServerInfo[]): string {
  if (servers.length === 0) return 'No MCP servers are configured for this session.';
  return [
    `MCP servers (${servers.length}):`,
    ...servers.map((server) => {
      const base = `- ${server.name}: ${server.status} (${server.transport}, ${server.toolCount} tools)`;
      return server.error === undefined ? base : `${base}\n  Error: ${server.error}`;
    }),
  ].join('\n');
}

// 中文：格式化后台任务状态报告
function formatTasksReport(tasks: readonly BackgroundTaskInfo[]): string {
  if (tasks.length === 0) return 'No background tasks for this session.';
  return [
    `Background tasks (${tasks.length}):`,
    ...tasks.map((task) => {
      const parts = [`- ${task.taskId}: ${task.status}`, task.description];
      if (task.kind === 'process') parts.push(`command=${task.command}`);
      if (task.kind === 'agent' && task.subagentType !== undefined) parts.push(`subagent=${task.subagentType}`);
      if (task.stopReason !== undefined) parts.push(`reason=${task.stopReason}`);
      return parts.join(' · ');
    }),
  ].join('\n');
}

// 中文：格式化压缩完成结果——显示压缩的消息数和 Token 数变化
function formatCompactionCompleted(result: CompactionCompletedResult): string {
  return [
    'Compaction completed.',
    `- Messages compacted: ${result.compactedCount.toLocaleString('en-US')}`,
    `- Tokens before: ${result.tokensBefore.toLocaleString('en-US')}`,
    `- Tokens after: ${result.tokensAfter.toLocaleString('en-US')}`,
  ].join('\n');
}

// 中文：格式化单次 Token 使用量详情（输入/输出/缓存读取/缓存创建）
function formatTokenUsage(usage: NonNullable<SessionUsage['total']>): string {
  return [
    `input ${usage.inputOther.toLocaleString('en-US')}`,
    `output ${usage.output.toLocaleString('en-US')}`,
    `cache read ${usage.inputCacheRead.toLocaleString('en-US')}`,
    `cache creation ${usage.inputCacheCreation.toLocaleString('en-US')}`,
  ].join(', ');
}

// agent-core emits `contextUsage` as a 0..1 fraction (`contextTokens /
// maxContextTokens` — see agent-core/src/agent/index.ts:419-422). It can
// briefly exceed 1.0 when a turn overflows the budget; we still surface
// that as ">100%" rather than collapsing back into 0..1.
// 中文：将上下文使用率（0~1 小数）格式化为百分比字符串，允许超过 100%
function formatContextUsage(contextUsage: number): string {
  if (!Number.isFinite(contextUsage) || contextUsage < 0) return '';
  return ` (${(contextUsage * 100).toFixed(1)}%)`;
}

/**
 * Inspect the leading `ContentBlock` of an ACP prompt for a
 * `/skill:<name>` form. Only the first block is examined — when Zed
 * (or any other ACP client) sends a slash command, it always lives in
 * the first text block; multi-part prompts that interleave images or
 * resources before text are typed by humans and do not start with a
 * slash. Non-text leading blocks short-circuit to passthrough.
 *
 * The parsing/resolution itself is delegated to `./slash` —
 * deliberately duplicated from the TUI's
 * `apps/kimi-code/src/tui/commands/parse.ts` and `resolve.ts` to
 * avoid an app→package import inversion. See `./slash`'s top-of-file
 * comment for the sync target.
 */
// 中文：检测 ACP 提示词中的前导斜杠命令意图（仅检查第一个文本块）
function detectLeadingSlashIntent(
  blocks: readonly ContentBlock[],
  skillCommandMap: ReadonlyMap<string, string>,
): ReturnType<typeof detectSlashIntent> {
  const first = blocks[0];
  if (!first || first.type !== 'text') return { kind: 'passthrough' };
  return detectSlashIntent(first.text, skillCommandMap);
}

// 中文：将 prompt 调用中的错误映射为 ACP RequestError（认证错误特殊处理，其他降级为内部错误）
function mapPromptError(err: unknown, sessionId: string): RequestError {
  const authErr = authRequiredFromUnknown(err);
  if (authErr) {
    log.warn('acp: prompt rejected with auth error; mapping to authRequired', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return authErr;
  }
  log.error('acp: prompt failed', {
    sessionId,
    error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
  });
  return RequestError.internalError(undefined, 'session prompt failed');
}

/**
 * Inspect a {@link KimiErrorPayload} (as carried on `turn.ended`
 * failed events) and return a `RequestError.authRequired()` if its
 * `code` is one of the auth-required codes; otherwise `undefined`.
 *
 * Kept separate from {@link authRequiredFromUnknown} because the
 * `turn.ended` event hands us a serialized payload (no class identity
 * to branch on) — we only need the `code` discriminator here.
 */
// 中文：检查 turn.ended 失败载荷是否包含认证错误码，返回 authRequired 或 undefined
function authRequiredFromPayload(payload: KimiErrorPayload | undefined): RequestError | undefined {
  if (!payload) return undefined;
  if (isAuthErrorCode(payload.code)) {
    return RequestError.authRequired();
  }
  return undefined;
}

/**
 * Type-narrowing predicate for the codes the adapter treats as
 * "the client must re-authenticate before retrying". Currently:
 *  - `auth.login_required` — Kimi Platform / OAuth login flow needed.
 *  - `provider.auth_error` — the downstream provider rejected the
 *    request with a 401 (the node SDK lifts these into `KimiError`
 *    at `kimi-code-model-provider.ts:99-103`).
 */
// 中文：判断错误码是否为"需要重新认证"类型（auth.login_required 或 provider.auth_error）
function isAuthErrorCode(code: unknown): boolean {
  return code === ErrorCodes.AUTH_LOGIN_REQUIRED || code === ErrorCodes.PROVIDER_AUTH_ERROR;
}

/**
 * Best-effort detection of "auth required" for the `session.prompt(...)`
 * rejection path. The thrown value MAY be:
 *  - A `KimiError` instance with a recognized `code` field.
 *  - A plain object that happens to expose a `code` (covers RPC-layer
 *    deserialized payloads that lost class identity).
 *  - Anything else — returns `undefined`.
 */
// 中文：尽力检测 prompt 拒绝路径中的"需要认证"错误（支持 KimiError 和普通对象）
function authRequiredFromUnknown(err: unknown): RequestError | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (isAuthErrorCode(code)) {
      return RequestError.authRequired();
    }
  }
  return undefined;
}

/**
 * Effort-level strings passed to {@link Session.setThinking} when the
 * ACP `thinking` toggle flips. Phase 15 wired the ACP-side binary axis
 * (then a `SessionConfigBoolean`; Phase 16 reshaped it to a 2-entry
 * `select` `off` / `on` for Zed UI compatibility) to the SDK's
 * effort-level channel: `true` → `'high'` (kimi-code's typical default,
 * also `resolveThinkingEffort`'s fallback), `false` → `'off'`. The
 * granularity of `'low' | 'medium' | 'xhigh' | 'max'` is intentionally
 * not exposed — the ACP `thinking` axis is binary.
 */
// 中文：思考模式开启时的 effort-level（kimi-code 的典型默认值）
const THINKING_ON_LEVEL = 'high';
// 中文：思考模式关闭时的 effort-level
const THINKING_OFF_LEVEL = 'off';

/**
 * Identifier the agent-core session emits for the main (user-facing)
 * agent. Subagents are issued generated ids by `Session.spawnAgent`;
 * filtering on this constant keeps `turn.ended` / `error` events from a
 * child agent from settling the parent's `session/prompt` promise.
 */
// 中文：主线程代理 ID——用于区分主代理事件和子代理事件，防止子代理事件结算父代理的 prompt Promise
const MAIN_AGENT_ID = 'main';

/**
 * Parse a tool call's `arguments` field (kosong wire format: a JSON
 * string or `null`) into the structured object expected by the live
 * {@link toolCallStartToSessionUpdate} mapper. Falls back to the raw
 * string when the payload is not valid JSON — the mapper itself uses
 * {@link stringifyArgs}, which gracefully `String(x)`s anything it
 * cannot serialize, so the worst case is a degraded preview rather
 * than a crash.
 */
// 中文：解析工具调用参数的 JSON 字符串为结构化对象（无效 JSON 时降级为原始字符串）
function parseToolCallArguments(rawArguments: string | null): unknown {
  if (rawArguments === null || rawArguments === '') return {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

/**
 * Project a `tool` role {@link ContextMessage}'s `content` array into
 * the ACP `tool_call_update.content` shape (an array of
 * `ToolCallContent` entries). The historical message's content is a
 * sequence of kosong content parts — for replay we surface text parts
 * directly and stringify anything else (image refs etc.) as a
 * `[type]` placeholder so the client still sees that something was
 * returned.
 */
// 中文：将工具角色消息的 content 数组转换为 ACP tool_call_update.content 格式
// 非文本部分（图片/音频等）降级为 [type] 占位符以保留存在证据
function toolMessageContentToAcpToolCallContent(
  parts: ContextMessage['content'],
): Array<{ type: 'content'; content: { type: 'text'; text: string } }> {
  const result: Array<{ type: 'content'; content: { type: 'text'; text: string } }> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        result.push({ type: 'content', content: { type: 'text', text: part.text } });
      }
      continue;
    }
    // image_url / audio_url / video_url / think — surface a marker so
    // the result card is not empty. Replay should not lose evidence
    // that a non-text part was present.
    // 中文：非文本内容——降级为 [type] 占位符标记
    result.push({
      type: 'content',
      content: { type: 'text', text: `[${part.type}]` },
    });
  }
  return result;
}

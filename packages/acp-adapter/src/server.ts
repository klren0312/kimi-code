/**
 * ACP `AgentSideConnection` wrapper.
 *
 * Phase 3 implements `initialize`, `session/new`, and `session/cancel`
 * against {@link KimiHarness}. `prompt` is wired in step 3.4. `initialize`
 * advertises the terminal-auth method (see {@link TERMINAL_AUTH_METHOD}).
 */

import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
  type Agent,
  type AgentCapabilities,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AvailableCommand,
  type CancelNotification,
  type ClientCapabilities,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { KimiHarness, Session, SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';
import { LocalKaos, type Kaos } from '@moonshot-ai/kaos';

import { TERMINAL_AUTH_METHOD, buildTerminalAuthMethod } from './auth-methods';
import { redirectConsoleToStderr } from './log-guard';
import { AcpKaos } from './kaos-acp';
import { AcpSession, type TelemetryTrackFn } from './session';
import { buildSessionConfigOptions } from './config-options';
import { availableCommandsUpdateNotification } from './events-map';
import { acpMcpServersToConfigs } from './mcp';
import { listModelsFromHarness } from './model-catalog';
import { DEFAULT_MODE_ID } from './modes';
import { negotiateVersion, type AcpVersionSpec } from './version';

// ── 中文概述 ──
// 本模块实现 ACP 协议的服务端处理逻辑，是客户端（如 Zed、JetBrains）与 Kimi 引擎之间的桥梁。
// 核心职责：
//   1. 处理 ACP `initialize` 握手，协商协议版本并声明 Agent 能力
//   2. 管理会话生命周期：`session/new`（创建）、`session/load`（加载并回放历史）、`session/resume`（恢复但不回放）
//   3. 转发用户提示词（`prompt`）到对应会话，支持取消操作
//   4. 处理会话配置变更（模型切换、模式切换、思考模式开关）
//   5. 提供认证流程（终端认证方式）和会话列表查询
//   6. 通过 `runAcpServer` / `runAcpServerWithStream` 启动服务，桥接 Node stdio 到 ACP JSON-RPC 通道

/**
 * Per-session snapshot returned by the {@link AcpServer} caller's
 * `slashCommands` resolver. Carries both what gets advertised in the
 * `available_commands_update` push and the `skillCommandMap` that
 * {@link AcpSession.prompt} consults to intercept `/skill:<name>`
 * inputs and route them to {@link Session.activateSkill}.
 *
 * `skillCommandMap` is optional for backward compatibility: callers
 * that pre-date slash-command routing (or that only advertise builtin
 * commands) can omit it and get the previous "always passthrough"
 * behavior.
 */
// 中文：每次会话的斜杠命令快照，包含广告给客户端的命令列表和技能命令映射（用于拦截 `/skill:<name>` 并路由到 activateSkill）
export interface SlashCommandsSnapshot {
  readonly commands: ReadonlyArray<AvailableCommand>;
  readonly skillCommandMap?: ReadonlyMap<string, string>;
}

// 中文：斜杠命令解析器类型——可以是静态数组、快照对象、或接收 Session 返回命令列表的异步函数
type SlashCommandsResolver =
  | ReadonlyArray<AvailableCommand>
  | SlashCommandsSnapshot
  | ((
      session: Session,
    ) =>
      | Promise<ReadonlyArray<AvailableCommand> | SlashCommandsSnapshot>
      | ReadonlyArray<AvailableCommand>
      | SlashCommandsSnapshot);

// 中文：解析后的斜杠命令结果，保证包含命令列表和技能命令映射（即使输入没有提供映射也为空 Map）
interface ResolvedSlashCommands {
  readonly commands: ReadonlyArray<AvailableCommand>;
  readonly skillCommandMap: ReadonlyMap<string, string>;
}

// 中文：将斜杠命令输入统一转换为 ResolvedSlashCommands 格式——数组输入补充空映射，快照输入提取字段
function toResolvedSlashCommands(
  input: ReadonlyArray<AvailableCommand> | SlashCommandsSnapshot,
): ResolvedSlashCommands {
  if (Array.isArray(input)) {
    return { commands: input, skillCommandMap: new Map() };
  }
  const snap = input as SlashCommandsSnapshot;
  return {
    commands: snap.commands,
    skillCommandMap: snap.skillCommandMap ?? new Map(),
  };
}

/**
 * Inline auth gate — moved out of `KimiAuthFacade.hasUsableToken()` so
 * the SDK doesn't have to carry an ACP-specific convenience method.
 * Mirrors the original semantics exactly: any provider with `hasToken`
 * set counts as authed.
 */
// 中文：检查 Harness 是否已认证——只要任一 provider 持有 token 即视为已认证
async function harnessIsAuthed(harness: KimiHarness): Promise<boolean> {
  const status = await harness.auth.status();
  return status.providers.some((entry) => entry.hasToken === true);
}

/**
 * Agent-side ACP handler. Routes `initialize` + `session/new` + `session/cancel`
 * into {@link KimiHarness}; refuses methods that are not yet wired with a
 * JSON-RPC "method not found" error so clients see a structured failure
 * rather than a silent hang.
 *
 * The harness is captured eagerly so Phase 3 routes `session/new`,
 * `session/cancel` (and Phase 3.4: `session/prompt`) into it without
 * changing the public constructor. The {@link AgentSideConnection} (if
 * supplied) is forwarded to every {@link AcpSession} so the session can
 * push `session/update` chunks back to the client.
 */
// 中文：ACP 服务端主类——实现 Agent 接口，负责路由所有 ACP 请求到 KimiHarness 和 AcpSession
export class AcpServer implements Agent {
  // 中文：协议版本协商结果，initialize 之后可用
  private negotiated: AcpVersionSpec | undefined;
  // 中文：客户端在 initialize 阶段声明的能力集合
  private clientCapabilities: ClientCapabilities | undefined;
  // 中文：活跃会话映射表，sessionId → AcpSession
  private readonly sessions = new Map<string, AcpSession>();
  // 中文：Agent 身份元信息（名称、版本等），在 initialize 响应中返回给客户端
  private readonly agentInfo: Implementation | undefined;
  // 中文：终端认证所需的环境变量，供客户端启动 `kimi login` 子进程时使用
  private readonly terminalAuthEnv: Readonly<Record<string, string>> | undefined;
  // 中文：旧版终端认证的二进制路径，用于不支持 AuthMethodTerminal 的客户端
  private readonly terminalAuthLegacyCommand: string | undefined;
  // 中文：斜杠命令解析函数，将 SlashCommandsResolver 统一包装为异步函数
  private readonly resolveSlashCommands: (
    session: Session,
  ) => Promise<ResolvedSlashCommands>;
  /**
   * Lazily-built inner {@link Kaos} (a {@link LocalKaos}) used as the
   * delegate target for every {@link AcpKaos} this server hands out.
   * One per server (not per session) so we don't re-probe the
   * environment for every `session/new` call.
   */
  private innerKaos: Kaos | undefined = undefined;

  constructor(
    private readonly harness: KimiHarness,
    private readonly conn?: AgentSideConnection | undefined,
    opts?: {
      agentInfo?: Implementation;
      /**
       * Env vars to advertise in `authMethods[0].env` so the `kimi login`
       * subprocess the client spawns (via `terminal-auth`) lands its
       * token under the same data root the ACP server uses. Intended for
       * sandboxed test setups (e.g. `{ KIMI_CODE_HOME: '/tmp/...' }`);
       * leave undefined in production so the advertised env stays empty.
       */
      terminalAuthEnv?: Readonly<Record<string, string>>;
      /**
       * Absolute binary path advertised in `_meta['terminal-auth'].command`
       * for clients that don't yet honor the first-class
       * `AuthMethodTerminal` (Zed without `AcpBetaFeatureFlag`, JetBrains
       * plugin). Clients on this legacy path spawn `<command> login`
       * directly. Defaults to undefined (the `_meta` fallback is omitted).
       */
      terminalAuthLegacyCommand?: string;
      /**
       * Slash commands to advertise in the one-shot
       * `available_commands_update` pushed immediately after each
       * `session/new`, `session/load`, and `session/resume`. Accepts
       * either a static array, or a resolver called once per session
       * (with the just-created `Session`) so per-session sources like
       * `session.listSkills()` can be merged in. When omitted, the
       * adapter falls back to an empty list.
       *
       * Returning a {@link SlashCommandsSnapshot} (`{ commands, skillCommandMap }`)
       * additionally lets {@link AcpSession.prompt} intercept
       * `/skill:<name> ...` inputs at the adapter boundary and route
       * them to {@link Session.activateSkill} instead of forwarding the
       * raw slash text — matching the TUI's slash-command behavior so
       * skill activations don't fall back to model-driven Bash
       * exploration of `~/.kimi-code/skills/`.
       */
      slashCommands?: SlashCommandsResolver;
    },
  ) {
    this.agentInfo = opts?.agentInfo;
    this.terminalAuthEnv = opts?.terminalAuthEnv;
    this.terminalAuthLegacyCommand = opts?.terminalAuthLegacyCommand;
    const slash = opts?.slashCommands;
    this.resolveSlashCommands =
      typeof slash === 'function'
        ? async (session) => toResolvedSlashCommands(await slash(session))
        : async () => toResolvedSlashCommands(slash ?? []);
  }

  /** Returns the {@link AcpVersionSpec} chosen during `initialize`, if any. */
  get negotiatedVersion(): AcpVersionSpec | undefined {
    return this.negotiated;
  }

  /** Returns the client capabilities advertised during `initialize`, if any. */
  get clientCaps(): ClientCapabilities | undefined {
    return this.clientCapabilities;
  }

  /** @internal — for tests/inspection only. */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  // 中文：处理 ACP `initialize` 握手——协商协议版本，声明 Agent 能力（加载会话、提示词能力、MCP 能力等），返回认证方式
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.negotiated = negotiateVersion(params.protocolVersion);
    this.clientCapabilities = params.clientCapabilities;

    const agentCapabilities: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    };

    return {
      protocolVersion: this.negotiated.protocolVersion,
      agentCapabilities,
      authMethods: [
        this.terminalAuthEnv !== undefined || this.terminalAuthLegacyCommand !== undefined
          ? buildTerminalAuthMethod({
              env: this.terminalAuthEnv,
              legacyCommand: this.terminalAuthLegacyCommand,
            })
          : TERMINAL_AUTH_METHOD,
      ],
      ...(this.agentInfo ? { agentInfo: this.agentInfo } : {}),
    };
  }

  // 中文：创建新会话——检查认证、预生成会话 ID、构建 AcpKaos（可选）、通过 Harness 创建会话、注册 AcpSession、推送配置选项和可用命令
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!(await harnessIsAuthed(this.harness))) {
      throw RequestError.authRequired();
    }
    // ACP's `cwd` maps to the SDK's `workDir`. `model`, `planMode`, and
    // similar fields are wired in Phase 8 (per PLAN D3) — Phase 3.2 keeps
    // the surface minimal. Phase 10.1 adds `mcpServers` forwarding so
    // ACP-supplied servers (Zed config, JetBrains config) are passed
    // alongside the on-disk config; unsupported ACP-transport servers
    // are warn-dropped inside the conversion. `mcpServers` is NOT a
    // declared field on `CreateSessionOptions` — the SDK is a
    // transparent passthrough for unknown fields (see
    // `packages/node-sdk/src/kimi-harness.ts:createSession` and
    // `packages/node-sdk/src/rpc.ts:createSession`), so the kernel
    // (`CreateSessionPayload.mcpServers` in agent-core) receives the
    // record verbatim. The `@ts-expect-error` documents this contract;
    // if the SDK ever switches from spread-passthrough to explicit field
    // copy, this line breaks and we revisit the boundary.
    // 中文：将 ACP 客户端提供的 MCP 服务器配置转换为 SDK 格式，不支持的传输类型会被警告丢弃
    const mcpServers = acpMcpServersToConfigs(params.mcpServers);
    if (!this.conn) {
      // Defensive: every code path that constructs `AcpServer` (the
      // runners below, and any test that intends to drive `newSession`)
      // must supply the connection. Surface a clear internal error
      // rather than letting Phase 3.4's `prompt` discover a missing
      // connection mid-stream.
      throw RequestError.internalError(undefined, 'AcpServer is missing its AgentSideConnection');
    }
    // Pre-mint the session id so the optional `AcpKaos` (built when the
    // client advertised `fs.readTextFile` / `fs.writeTextFile`) carries
    // the correct reverse-RPC channel for the same session the kernel
    // is about to construct. Boundary injection — the kaos is captured
    // by the kernel `SessionImpl` ctor and every tool downstream sees
    // the same reference, no AsyncLocalStorage needed.
    const sessionId = `session_${randomUUID()}`;
    const acpKaos = await this.maybeBuildAcpKaos(sessionId);
    const persistenceKaos = acpKaos === undefined ? undefined : await this.ensureInnerKaos();
    const session = await this.harness.createSession({
      id: sessionId,
      workDir: params.cwd,
      kaos: acpKaos,
      persistenceKaos,
      // @ts-expect-error — `mcpServers` is a kernel-side extension
      // (agent-core `CreateSessionPayload`) the SDK transparently
      // forwards via spread. See block comment above.
      mcpServers,
    });
    const currentModelId = await this.resolveCurrentModelId();
    const currentThinkingEnabled = await this.resolveCurrentThinkingEnabled();
    const acpSession = new AcpSession(
      this.conn,
      session,
      this.clientCapabilities,
      this.makeTelemetryTrack(),
      currentModelId,
      this.harness,
      currentThinkingEnabled,
    );
    this.sessions.set(session.id, acpSession);
    // Telemetry breadcrumb so we can observe ACP adoption (number of
    // sessions started via this surface, vs. TUI / SDK direct). The
    // property set is deliberately minimal: `mode` distinguishes
    // `newSession` from `loadSession`; no user content / PII.
    this.trackSessionStarted(session.id, 'new');
    // Phase 14 (PLAN D11) advertises both the model and mode pickers as
    // a unified `configOptions: SessionConfigOption[]` surface. The
    // dedicated Phase 12 `modes:` field is gone — see
    // `docs/{zh,en}/reference/kimi-acp.md` and the changeset for the
    // pre-release breaking note. `currentModeId` always starts at
    // `default` (PLAN D9); `currentModelId` is resolved from the harness
    // config (`defaultModel` if set, else the first listed alias) so
    // the dropdown's "current" highlight matches the session the SDK
    // just constructed. Phase 15 adds the `thinking` toggle when the
    // current model's catalog row advertises `thinkingSupported`;
    // Phase 16 reshaped that toggle from `boolean` to a 2-entry
    // `select` so Zed actually renders it.
    const configOptions = await buildSessionConfigOptions(
      this.harness,
      currentModelId,
      currentThinkingEnabled,
      DEFAULT_MODE_ID,
    );
    this.scheduleAvailableCommandsUpdate(session.id);
    return {
      sessionId: session.id,
      configOptions,
    };
  }

  /**
   * Handle ACP `session/load`. Mirrors {@link newSession}'s auth gate
   * and connection guard, but resumes an existing on-disk session
   * via the shared {@link setupSessionFromExisting} helper instead of
   * creating a new one. After the AcpSession is wired up, replays the
   * persisted history as a synchronous batch of `session/update`
   * notifications so the client sees the prior turns before the
   * response settles.
   *
   * The ACP `LoadSessionResponse` shape allows an empty body — every
   * field (`configOptions`, `models`, `modes`) is optional. Phase 12.1
   * starts populating `modes` so a resumed session re-renders Zed's
   * mode dropdown identically to a freshly created one; the
   * `currentModeId` is always `default` on load because the SDK does
   * not persist mode across runs (PLAN D9).
   *
   * The non-trivial setup (auth gate, connection guard, harness
   * resume, AcpSession construction, session registration, configOptions
   * computation) is shared with {@link resumeSession} via
   * {@link setupSessionFromExisting}; the ONE differentiator is that
   * `loadSession` calls `replayHistory()` here, whereas `resumeSession`
   * deliberately skips it (per ACP spec G4 / plan gap-4.3).
   */
  // 中文：加载已有会话——恢复磁盘上的会话状态，回放历史记录并推送 `session/update` 通知给客户端
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const { session, acpSession, configOptions } = await this.setupSessionFromExisting({
      cwd: params.cwd,
      sessionId: params.sessionId,
      mcpServers: params.mcpServers,
    });
    // Same telemetry breadcrumb as `newSession`, but `mode: 'load'`
    // so we can distinguish session creation from resumption. No PII.
    this.trackSessionStarted(session.id, 'load');
    // Synchronously replay history — the response must not settle
    // until every historical `session/update` has been pushed,
    // otherwise the client would race the load completion against
    // its own UI bootstrap. This is the ONE difference vs.
    // `resumeSession`, which intentionally omits this step.
    await acpSession.replayHistory();
    this.scheduleAvailableCommandsUpdate(session.id);
    return { configOptions };
  }

  /**
   * Handle ACP `session/resume`. Per ACP spec, `session/resume` is the
   * lighter-weight sibling of `session/load`: same on-disk session
   * rehydration, same `configOptions:` advertisement — but the client
   * is expected to have already seen the prior turns, so the agent
   * deliberately does NOT replay history. This makes `resumeSession`
   * the right surface for clients that maintain their own transcript
   * (e.g. external session managers, or a TUI reattaching to a still-
   * running session) and would only flicker if the agent re-emitted
   * the historical `session/update` notifications.
   *
   * Setup is shared verbatim with {@link loadSession} via
   * {@link setupSessionFromExisting} (auth gate, conn guard, harness
   * `resumeSession` with `session.not_found` mapping, AcpSession
   * construction, configOptions build). The only differences are:
   * (a) telemetry mode is `'resume'` (vs `'load'`), and (b) no
   * `replayHistory()` call. See plan G4 (lines 106-170) for the
   * rationale, and gap-4.1 for the matching capability advertisement.
   */
  // 中文：恢复会话（轻量版）——与 loadSession 共享设置逻辑，但不回放历史（客户端已自行维护对话记录）
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const { session, configOptions } = await this.setupSessionFromExisting({
      cwd: params.cwd,
      sessionId: params.sessionId,
      mcpServers: params.mcpServers,
    });
    // Telemetry breadcrumb — distinguishes resume from new/load so we
    // can observe which clients adopt the lighter-weight resume
    // surface vs the history-replaying load surface. No PII.
    this.trackSessionStarted(session.id, 'resume');
    this.scheduleAvailableCommandsUpdate(session.id);
    return { configOptions };
  }

  /**
   * Shared setup for `session/load` and `session/resume`: gates auth,
   * checks the connection, resolves MCP servers, asks the harness to
   * resume the on-disk session, computes the current model/thinking
   * projection (with a resume-state fallback), constructs the
   * {@link AcpSession}, registers it under `session.id`, and builds
   * the unified `configOptions:` surface (PLAN D11) that both handlers
   * return.
   *
   * Behavior is byte-for-byte identical to the pre-refactor
   * `loadSession` body minus the `replayHistory()` call — which lives
   * in `loadSession` itself because `resumeSession` per ACP spec must
   * NOT replay history (the client is expected to have already seen
   * those turns; replay is a load-only behavior). See plan G4
   * (lines 106-170) for the rationale.
   *
   * The `@ts-expect-error` boundary at the SDK `resumeSession` call
   * is preserved verbatim — `mcpServers` is a kernel-only extension
   * the SDK forwards via spread (see the `newSession` comment block
   * for the full contract). The `session.not_found` → `invalidParams`
   * mapping is also preserved so unknown-session errors surface as a
   * structured JSON-RPC failure rather than a generic internal error.
   */
  // 中文：loadSession 和 resumeSession 的共享设置流程——认证检查、连接验证、MCP 解析、恢复会话、构建配置选项
  private async setupSessionFromExisting(params: {
    cwd: string;
    sessionId: string;
    mcpServers?: ReadonlyArray<McpServer>;
  }): Promise<{
    session: Session;
    acpSession: AcpSession;
    configOptions: SessionConfigOption[];
  }> {
    if (!(await harnessIsAuthed(this.harness))) {
      throw RequestError.authRequired();
    }
    if (!this.conn) {
      throw RequestError.internalError(undefined, 'AcpServer is missing its AgentSideConnection');
    }
    // ACP `cwd` → SDK `workDir` for parity with `newSession`. The
    // harness's `resumeSession` only takes `{ id }` today; the cwd
    // arrives on the request for future validation but is not enforced
    // here (the on-disk session already has its own workDir). Phase
    // 10.1 also forwards `mcpServers` so a resumed session can pick up
    // ACP-supplied MCP servers (matching `newSession` behaviour). Same
    // `@ts-expect-error` boundary as `newSession` — the SDK's
    // `resumeSession` spreads `input` so unknown fields ride to the
    // kernel.
    const mcpServers = acpMcpServersToConfigs(params.mcpServers);
    const acpKaos = await this.maybeBuildAcpKaos(params.sessionId);
    const persistenceKaos = acpKaos === undefined ? undefined : await this.ensureInnerKaos();
    let session: Session;
    try {
      session = await this.harness.resumeSession({
        id: params.sessionId,
        kaos: acpKaos,
        persistenceKaos,
        // @ts-expect-error — see block comment above; mcpServers is a
        // kernel-only field that the SDK forwards via spread.
        mcpServers,
      });
    } catch (err) {
      // Surface unknown-session as invalid_params so the JSON-RPC layer
      // returns a structured failure rather than a generic internal
      // error. Other errors propagate as-is.
      const code = (err as { code?: string } | undefined)?.code;
      if (code === 'session.not_found') {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown sessionId: ${params.sessionId}`,
        );
      }
      throw err;
    }
    // Phase 14 (PLAN D11) — same `configOptions:` advertisement as
    // `newSession`. `currentModeId` is `default` on every load (mode
    // is session-scoped per PLAN D9); `currentModelId` is read from
    // the resumed session's main-agent config when available so the
    // dropdown's highlight matches the model the resumed turn will
    // actually use — falling back to the harness-level default
    // resolution when the resume state lacks a `modelAlias`.
    // 中文：从恢复状态中读取模型别名，若无则回退到 Harness 默认模型解析
    const resumeState = session.getResumeState?.();
    const resumedModelAlias = resumeState?.agents?.['main']?.config?.modelAlias;
    const currentModelId =
      typeof resumedModelAlias === 'string' && resumedModelAlias.length > 0
        ? resumedModelAlias
        : await this.resolveCurrentModelId();
    // Phase 15 reads the resumed thinking level off the main-agent
    // config and projects it onto the binary toggle: any non-`'off'`
    // effort level reads as "thinking on" because the ACP surface only
    // exposes the boolean axis. Falls back to the harness-level default
    // when the resume state lacks the field.
    // 中文：思考模式投影——非 'off' 的思考等级映射为布尔值 true（ACP 仅暴露布尔轴）
    const resumedThinkingLevel = resumeState?.agents?.['main']?.config?.thinkingLevel;
    const currentThinkingEnabled =
      typeof resumedThinkingLevel === 'string'
        ? resumedThinkingLevel.trim().toLowerCase() !== 'off' &&
          resumedThinkingLevel.trim().length > 0
        : await this.resolveCurrentThinkingEnabled();
    const acpSession = new AcpSession(
      this.conn,
      session,
      this.clientCapabilities,
      this.makeTelemetryTrack(),
      currentModelId,
      this.harness,
      currentThinkingEnabled,
    );
    this.sessions.set(session.id, acpSession);
    const configOptions = await buildSessionConfigOptions(
      this.harness,
      currentModelId,
      currentThinkingEnabled,
      DEFAULT_MODE_ID,
    );
    return { session, acpSession, configOptions };
  }

  /**
   * Build an {@link AcpKaos} for a given session id if (and only if)
   * the client advertised any FS reverse-RPC capability. Returns
   * `undefined` otherwise — the caller then omits the `kaos` field
   * from `harness.createSession`/`resumeSession`, leaving the kernel
   * to fall back to its process-wide {@link LocalKaos}.
   *
   * The inner {@link LocalKaos} is built lazily on the first capable
   * session and cached on `this.innerKaos`; subsequent sessions reuse
   * it. The resulting {@link AcpKaos} is captured by the kernel
   * `SessionImpl` ctor and every tool downstream sees the same
   * reference — no AsyncLocalStorage involved.
   */
  // 中文：按需构建 AcpKaos——仅当客户端声明了文件系统反向 RPC 能力时才创建，否则返回 undefined
  private async maybeBuildAcpKaos(sessionId: string): Promise<AcpKaos | undefined> {
    const fs = this.clientCapabilities?.fs;
    if (!fs?.readTextFile && !fs?.writeTextFile) {
      return undefined;
    }
    if (!this.conn) {
      return undefined;
    }
    const innerKaos = await this.ensureInnerKaos();
    return new AcpKaos(this.conn, sessionId, innerKaos);
  }

  // 中文：确保内部 LocalKaos 实例已创建（惰性初始化，全服务器共享一个实例）
  private async ensureInnerKaos(): Promise<Kaos> {
    if (!this.innerKaos) {
      this.innerKaos = await LocalKaos.create();
    }
    return this.innerKaos;
  }

  /**
   * Re-check whether the on-disk token is usable; does NOT trigger an
   * actual OAuth flow. The stdio JSON-RPC channel has no TTY to render
   * the device-code prompt — clients are expected to spawn
   * `kimi login` themselves via the terminal-auth method advertised in
   * `initialize.authMethods` (`args:['login']`, see {@link TERMINAL_AUTH_METHOD})
   * and then re-invoke `authenticate('login')` to confirm the token
   * landed on disk. Mirrors kimi-cli `acp/server.py:374-398` semantics
   * (plan G3, lines 68-104).
   */
  // 中文：处理认证请求——验证方法为 'login' 后重新检查 token 是否可用，不触发实际 OAuth 流程
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    if (params.methodId !== 'login') {
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `Unknown auth method: ${params.methodId}`,
      );
    }
    if (!(await harnessIsAuthed(this.harness))) {
      throw RequestError.authRequired();
    }
    // void = empty success body (ACP allows AuthenticateResponse | void).
  }

  // 中文：处理用户提示词——查找对应会话并转发 prompt 到 AcpSession
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    }
    return acpSession.prompt(params.prompt);
  }

  // 中文：取消会话操作——cancel 是 JSON-RPC 通知，不允许返回错误，因此未知会话仅记录警告
  async cancel(params: CancelNotification): Promise<void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      // `cancel` is a JSON-RPC notification — the spec forbids notifications
      // returning errors. Log so unknown sessionIds aren't silently absorbed.
      log.warn('acp: cancel for unknown sessionId', { sessionId: params.sessionId });
      return;
    }
    try {
      await acpSession.cancel();
    } catch (err) {
      // Same notification-cannot-error rule: log and swallow.
      log.warn('acp: error while cancelling session', {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle ACP `session/set_mode`. Looks the session up by id and
   * forwards to {@link AcpSession.setMode}. Unknown session ids throw
   * `invalid_params`; unknown modeIds throw `invalid_params` from
   * inside {@link AcpSession.setMode}.
   *
   * The ACP schema models the response as a `_meta`-only object; we
   * return `undefined` (allowed by the `Agent` interface's
   * `SetSessionModeResponse | void` union) so the wire payload is the
   * canonical empty success.
   */
  // 中文：设置会话模式——将 modeId 转发到 AcpSession，未知模式由 AcpSession 抛出 invalid_params
  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setMode(params.modeId);
  }

  /**
   * Handle the experimental ACP `session/set_model`
   * (`unstable_setSessionModel`). Looks the session up by id and
   * forwards to {@link AcpSession.setModel}. Errors from the SDK
   * (e.g. an unknown model) propagate as-is so the JSON-RPC layer can
   * surface a structured failure.
   */
  // 中文：实验性方法——设置会话模型，将 modelId 转发到 AcpSession，SDK 错误直接传播给客户端
  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setModel(params.modelId);
  }

  /**
   * Handle ACP `session/set_config_option` — the spec's generic
   * config-picker dispatch (PLAN D11). Routes by `params.configId`:
   *
   *  - `'model'` → {@link AcpSession.setModel} (same path as
   *    {@link unstable_setSessionModel}).
   *  - `'mode'`  → {@link AcpSession.setMode} (same path as
   *    {@link setSessionMode}).
   *  - anything else → JSON-RPC `invalid_params` (-32602) BEFORE any
   *    SDK call, so the client sees a structured rejection rather
   *    than a half-applied state change.
   *
   * The underlying {@link AcpSession} methods already emit
   * `config_option_update` via {@link AcpSession.emitConfigOptionUpdate}
   * after the SDK call lands, so the response handler does NOT
   * double-emit — it only builds a fresh snapshot from the now-current
   * `currentModelId` + `currentModeId` and returns it on the wire.
   * This funnels all three input paths
   * (`unstable_setSessionModel` / `setSessionMode` / `setSessionConfigOption`)
   * through the same notification channel with identical shape.
   */
  // 中文：通用配置选项分发——按 configId 路由到 setModel / setMode / setThinking，返回更新后的配置快照
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    const value = (params as { value: unknown }).value;
    switch (params.configId) {
      case 'model':
        await acpSession.setModel(String(value));
        break;
      case 'mode':
        await acpSession.setMode(String(value));
        break;
      case 'thinking': {
        // Phase 16 changed the wire shape from boolean to a 2-entry
        // `select` (`'on'` / `'off'`) for Zed UI compatibility. Strict
        // equality with `'on'` keeps the parse deterministic — any
        // other string (including a stale `true` / `false` boolean
        // sent by a pre-Phase-16 client) reads as "off" rather than
        // silently flipping based on truthiness.
        // 中文：严格等于 'on' 为启用，其他值均视为关闭（确保解析确定性）
        await acpSession.setThinking(value === 'on');
        break;
      }
      default:
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unknown configId: ${params.configId}`,
        );
    }
    return {
      configOptions: await buildSessionConfigOptions(
        this.harness,
        acpSession.currentModelId,
        acpSession.currentThinkingEnabled,
        acpSession.currentModeId,
      ),
    };
  }

  /**
   * Handle ACP `session/list`. Forwards to
   * {@link KimiHarness.listSessions} (optionally filtered by `cwd` —
   * the SDK calls it `workDir`) and projects each
   * {@link SessionSummary} into an ACP {@link SessionInfo}.
   *
   * No pagination support in this version — `nextCursor` is always
   * `null`. Mirrors the Python reference at `acp/server.py:303-322`
   * where the response is built in a single shot from the harness'
   * full snapshot.
   */
  // 中文：列出会话——可按 cwd 过滤，将 SDK 的 SessionSummary 映射为 ACP 的 SessionInfo 格式
  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP `cwd` ↔ SDK `workDir`. The filter is optional; treat
    // `null` (the schema-allowed sentinel for "no filter") the same
    // as `undefined`.
    const cwd = params.cwd ?? undefined;
    const summaries = await this.harness.listSessions(
      cwd === undefined ? {} : { workDir: cwd },
    );
    const sessions: SessionInfo[] = summaries.map((summary) =>
      sessionSummaryToSessionInfo(summary),
    );
    return { sessions, nextCursor: null };
  }

  /**
   * Stub the ACP `ext/<method>` extension surface. The interface
   * declares both `extMethod` and `extNotification` as optional, but
   * implementing them explicitly with a structured `MethodNotFound`
   * response gives clients a uniform failure shape (mirrors the
   * `authenticate` pattern at {@link AcpServer.authenticate}) — some
   * clients treat "method absent on the agent" differently from an
   * explicit error reply.
   *
   * Future work (PLAN D9): route slash-command bridge / model-list /
   * mode-list extensions through here once the adapter has access to
   * the kimi-code app's registry. Phase 11 keeps it as a no-op stub.
   */
  // 中文：ACP 扩展方法存根——当前未实现，抛出 MethodNotFound 错误以提供结构化失败响应
  async extMethod(
    method: string,
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw RequestError.methodNotFound(method);
  }

  /**
   * Stub the ACP extension-notification surface. Symmetric to
   * {@link extMethod}: throwing `MethodNotFound` here surfaces a
   * structured failure on the JSON-RPC channel rather than a silent
   * drop. The ACP SDK currently models notifications as void-returning
   * promises; throwing is the only way to signal "unsupported" back to
   * the connection layer.
   */
  // 中文：ACP 扩展通知存根——当前未实现，抛出 MethodNotFound 以避免静默丢弃
  async extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    throw RequestError.methodNotFound(method);
  }

  /**
   * Compute the `currentValue` for the `model` config option when the
   * caller (either `newSession` or `loadSession`'s fallback path) does
   * not have a more specific signal. Prefers the harness's configured
   * `defaultModel`; otherwise falls back to the first listed catalog
   * alias so the dropdown's "current" highlight is always one of the
   * options the client will render. Returns the empty string when the
   * harness has no models at all — a degenerate config the UI can still
   * render (an empty dropdown with an empty `currentValue`).
   *
   * Tolerant to partial-stub harnesses (`getConfig` missing or
   * throwing) — adapter-level unit tests routinely construct minimal
   * `KimiHarness` shapes that only stub `auth.status` + `createSession`.
   * Production callers always supply a real harness with both methods;
   * the swallow-and-fallback path exists purely for test ergonomics
   * (matches the `track?.bind(...)` pattern at `trackSessionStarted`).
   *
   * Logged at `warn` when a fallback fires so a dev who forgot to set
   * `default_model = ...` sees a breadcrumb in the agent log.
   */
  // 中文：解析当前模型 ID——优先使用 Harness 配置的 defaultModel，否则回退到模型目录第一个条目
  private async resolveCurrentModelId(): Promise<string> {
    // Minimal-stub harnesses (no `getConfig`) skip the catalog entirely
    // and return the empty string silently. The old code path was the
    // same — `listAvailableModels` used to live behind a
    // `typeof harness.listAvailableModels === 'function'` guard, and we
    // preserve that ergonomic so adapter unit tests with bare-bones
    // stubs don't fire spurious "no models" warnings.
    if (typeof this.harness.getConfig !== 'function') return '';
    try {
      const config = await this.harness.getConfig();
      const declared = config.defaultModel;
      if (typeof declared === 'string' && declared.length > 0) {
        return declared;
      }
    } catch (err) {
      log.warn('acp: harness.getConfig threw during configOptions assembly; falling back', {
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
    try {
      const models = await listModelsFromHarness(this.harness);
      if (models.length === 0) {
        log.warn('acp: harness exposes no models; configOptions will ship an empty model picker');
        return '';
      }
      log.warn(
        'acp: harness has no defaultModel; falling back to first catalog entry for configOptions.currentValue',
        { fallbackModelId: models[0]!.id },
      );
      return models[0]!.id;
    } catch (err) {
      log.warn('acp: listModelsFromHarness threw during configOptions assembly', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return '';
  }

  /**
   * Compute the initial value for the `thinking` toggle when
   * a session is created (or loaded with no persisted thinking state).
   * Reads the harness's `getConfig().defaultThinking` flag if exposed —
   * the same source `Session.createSession` would consult for new
   * sessions. Returns `false` when the harness has no opinion, so the
   * toggle starts off.
   *
   * Tolerant to partial-stub harnesses for the same reason
   * {@link resolveCurrentModelId} is — adapter-level unit tests
   * routinely omit `getConfig`. The swallow-and-fallback path keeps
   * the test ergonomics symmetric.
   */
  // 中文：解析思考模式初始状态——读取 Harness 配置的 defaultThinking，返回布尔值表示是否启用
  private async resolveCurrentThinkingEnabled(): Promise<boolean> {
    if (typeof this.harness.getConfig !== 'function') return false;
    try {
      const config = await this.harness.getConfig();
      const declared = (config as { defaultThinking?: unknown }).defaultThinking;
      if (typeof declared === 'boolean') return declared;
      if (typeof declared === 'string') {
        const normalized = declared.trim().toLowerCase();
        return normalized !== 'off' && normalized.length > 0;
      }
      return false;
    } catch (err) {
      log.warn('acp: harness.getConfig threw during thinking toggle resolution; defaulting to off', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Build a {@link TelemetryTrackFn} wrapper bound to the underlying
   * harness so the {@link AcpSession} (and its reverse-RPC bridges in
   * Phase 13) can emit PII-free breadcrumbs through the same
   * `harness.track` channel `trackSessionStarted` uses. The wrapper
   * shape is required by the broader `Record<string, unknown>` properties
   * type {@link TelemetryTrackFn} uses — the harness's own `track` is
   * typed against the narrower `TelemetryProperties` (a
   * `Readonly<Record<string, boolean | number | string | undefined | null>>`),
   * and TS won't widen the parameter type implicitly when assigning into
   * a function-valued field. Phase 13's call sites (`session.ts:790,797,820,822,717`)
   * only emit primitive-valued properties so the runtime narrowing is
   * upheld by construction; the cast is purely a compile-time bridge.
   *
   * Returns `undefined` when the harness lacks `.track` (unit-test
   * stubs); {@link AcpSession} treats absence as "silent passthrough"
   * via {@link safeTrack}.
   */
  // 中文：构建遥测追踪函数包装器——将 harness.track 包装为 TelemetryTrackFn，用于 AcpSession 发送无 PII 的面包屑事件
  private makeTelemetryTrack(): TelemetryTrackFn | undefined {
    const harness = this.harness;
    if (typeof harness.track !== 'function') return undefined;
    return (event, properties) => {
      // Cast: the harness expects the narrower `TelemetryProperties`
      // shape (Readonly<Record<string, primitive>>); Phase 13 callers
      // only pass primitive values so the runtime contract holds.
      harness.track(event, properties as Parameters<typeof harness.track>[1]);
    };
  }

  // 中文：延迟调度可用命令更新通知——通过 setTimeout(0) 异步执行，避免阻塞当前请求
  private scheduleAvailableCommandsUpdate(sessionId: string): void {
    setTimeout(() => {
      void this.emitAvailableCommandsUpdate(sessionId);
    }, 0);
  }

  // 中文：推送可用命令更新通知给客户端——解析斜杠命令、注入到 AcpSession、通过 session/update 发送给客户端
  private async emitAvailableCommandsUpdate(sessionId: string): Promise<void> {
    if (!this.conn) return;
    const acpSession = this.sessions.get(sessionId);
    if (!acpSession) return;
    try {
      const { commands, skillCommandMap } = await this.resolveSlashCommands(
        acpSession.session,
      );
      // Seed the AcpSession's command catalog BEFORE the notification goes
      // out. The resolver call already awaited the (async) `listSkills()`
      // round trip, so the command list and skill map are the same snapshot
      // the client sees in its palette — no race between "/skill:X is
      // advertised" and "the adapter can intercept /skill:X". Intentionally
      // tolerant of older AcpSession builds in adapter-level unit tests.
      if (typeof acpSession.setAvailableCommands === 'function') {
        acpSession.setAvailableCommands(commands, skillCommandMap);
      } else if (typeof acpSession.setSkillCommandMap === 'function') {
        acpSession.setSkillCommandMap(skillCommandMap);
      }
      await this.conn.sessionUpdate(
        availableCommandsUpdateNotification(sessionId, commands),
      );
    } catch (err) {
      log.warn('acp: failed to push available_commands_update', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Emit the single ACP-adapter telemetry event.
   *
   * Wraps {@link KimiHarness.track} so a partial harness stub
   * (common in unit tests — see `auth-gate.test.ts`, `session-new.test.ts`)
   * cannot crash the request path. Production callers always supply a
   * real harness with `.track`; the swallow-and-log fallback exists
   * purely for test ergonomics.
   *
   * Property set is deliberately minimal: `sessionId` + `mode`. No
   * user content, no IDE identity, no client capabilities — keeping
   * the breadcrumb PII-free.
   */
  // 中文：发送会话启动遥测事件——仅记录 sessionId 和 mode（new/load/resume），无用户内容或 PII
  private trackSessionStarted(sessionId: string, mode: 'new' | 'load' | 'resume'): void {
    const track = this.harness.track?.bind(this.harness);
    if (typeof track !== 'function') return;
    try {
      track('acp_session_started', { sessionId, mode });
    } catch (err) {
      log.warn('acp: telemetry track failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Drive an {@link AcpServer} over an arbitrary ACP {@link Stream}.
 *
 * Useful for tests that build the stream with `ndJsonStream` over an
 * in-memory pair instead of process stdio.
 */
// 中文：在指定的 ACP Stream 上驱动 AcpServer——适用于测试场景（内存流对）或自定义 I/O
export async function runAcpServerWithStream(
  harness: KimiHarness,
  stream: Stream,
  opts?: {
    agentInfo?: Implementation;
    terminalAuthEnv?: Readonly<Record<string, string>>;
    terminalAuthLegacyCommand?: string;
    slashCommands?: SlashCommandsResolver;
  },
): Promise<void> {
  const conn = new AgentSideConnection((c) => new AcpServer(harness, c, opts), stream);
  await conn.closed;
}

/**
 * Drive an {@link AcpServer} over Node stdio (or the supplied streams).
 *
 * The ACP SDK speaks Web `ReadableStream` / `WritableStream`, so Node stdio
 * is bridged through `Readable.toWeb` / `Writable.toWeb`.
 *
 * Phase 11.1 wires SIGINT / SIGTERM to a single-shot cleanup that calls
 * {@link KimiHarness.close} so an editor terminating the agent process
 * (Zed closing the panel, JetBrains stopping the run config, the user
 * pressing Ctrl-C) drains in-flight sessions before the OS reaps the
 * process. The handlers are installed via `.once(...)` and explicitly
 * uninstalled in `finally` so repeat invocations from tests do not
 * pollute the process-wide listener set.
 *
 * The `signals` option exists primarily for tests — production callers
 * use the default of `process`. A test can pass a fresh
 * `EventEmitter`, emit `'SIGINT'` on it, and assert `harness.close()`
 * was called exactly once without touching the real Node signal
 * handlers (which vitest itself relies on).
 */
// 中文：在 Node stdio（或自定义流）上启动 ACP 服务——桥接 Node Readable/Writable 到 Web 流，注册信号处理优雅关闭
export async function runAcpServer(
  harness: KimiHarness,
  opts?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    /**
     * Optional agent identity metadata advertised in the `initialize`
     * response (`InitializeResponse.agentInfo`). When omitted, the
     * field is left out of the response rather than serialized as
     * `null`, matching the kimi-cli reference implementation.
     */
    agentInfo?: Implementation;
    /**
     * Env vars to forward to the `kimi login` subprocess clients spawn
     * via `terminal-auth`. See {@link AcpServer} ctor for the use case.
     */
    terminalAuthEnv?: Readonly<Record<string, string>>;
    /**
     * Absolute path to the agent binary, advertised in the legacy
     * `_meta['terminal-auth'].command` fallback. See {@link AcpServer}
     * ctor for compatibility rationale.
     */
    terminalAuthLegacyCommand?: string;
    /**
     * Slash commands to advertise to ACP clients so their slash-command
     * palette is populated. See {@link AcpServer} ctor for details.
     */
    slashCommands?: SlashCommandsResolver;
    /**
     * @internal Test seam — supply a fake `EventEmitter` (or a
     * subset that exposes `.once` / `.off`) to drive SIGINT / SIGTERM
     * without touching the real `process` listener set. Defaults to
     * `process` in production.
     */
    signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'>;
  },
): Promise<void> {
  // Stdout is the JSON-RPC channel; protect it before anything else
  // (a dependency, harness, etc.) can emit non-JSON via console.log.
  redirectConsoleToStderr();
  const input = (opts?.input ?? process.stdin) as Readable;
  const output = (opts?.output ?? process.stdout) as Writable;
  const stream = ndJsonStream(Writable.toWeb(output), Readable.toWeb(input));
  const signals = opts?.signals ?? process;

  // 中文：幂等清理——防止信号触发和自然关闭重复调用 harness.close()
  let cleanedUp = false;
  const cleanup = async (signal?: NodeJS.Signals): Promise<void> => {
    // Idempotent: signal-then-natural-close (or vice-versa) must not
    // call `harness.close()` twice. `cleanedUp` is checked-and-set
    // synchronously so concurrent invocations cannot race.
    if (cleanedUp) return;
    cleanedUp = true;
    if (signal) {
      log.info('acp: received signal, draining harness', { signal });
    }
    try {
      await harness.close();
    } catch (err) {
      // The process is exiting either way; log so the diagnostic is
      // preserved rather than disappearing into a thrown promise.
      log.error('acp: harness close failed during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onSigint = (): void => {
    void cleanup('SIGINT');
  };
  const onSigterm = (): void => {
    void cleanup('SIGTERM');
  };
  signals.once('SIGINT', onSigint);
  signals.once('SIGTERM', onSigterm);

  try {
    // Resolves when `AgentSideConnection.closed` settles — either
    // because the client disconnected stdin (natural EOF) or because
    // a signal handler closed the underlying stream.
    await runAcpServerWithStream(harness, stream, {
      agentInfo: opts?.agentInfo,
      terminalAuthEnv: opts?.terminalAuthEnv,
      terminalAuthLegacyCommand: opts?.terminalAuthLegacyCommand,
      slashCommands: opts?.slashCommands,
    });
  } finally {
    // Uninstall BEFORE the final cleanup so a second SIGINT (a user
    // double-tapping Ctrl-C while the drain is in flight) propagates
    // to the default handler and force-kills the process — exactly
    // the behaviour terminal users expect.
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    await cleanup();
  }
}

/**
 * Project a Kimi SDK {@link SessionSummary} into the ACP
 * {@link SessionInfo} shape used by `session/list`.
 *
 * Field mapping (mirrors the Python reference at
 * `acp/server.py:303-322`):
 *  - `sessionId` ← `summary.id`.
 *  - `cwd`        ← `summary.workDir` (the SDK's name for the same
 *                    concept; ACP picked `cwd` and the rename happens
 *                    at every boundary in this adapter).
 *  - `title`      ← `summary.title` when present; otherwise omitted
 *                    (ACP's `title` is `string | null | undefined`).
 *                    Empty strings are normalized to `null` so the
 *                    client can detect "no title" via `=== null`
 *                    rather than chasing falsy semantics.
 *  - `updatedAt`  ← `new Date(summary.updatedAt).toISOString()`. The
 *                    SDK stores epoch ms (`number`); ACP wants ISO 8601.
 *                    Invalid timestamps fall back to `null` rather
 *                    than producing `Invalid Date` strings on the wire.
 */
// 中文：将 SDK 的 SessionSummary 投影为 ACP 的 SessionInfo 格式——处理字段名映射（workDir→cwd）、时间戳转换（epoch ms→ISO 8601）、空值规范化
function sessionSummaryToSessionInfo(summary: SessionSummary): SessionInfo {
  // 中文：时间戳转换：epoch 毫秒数 → ISO 8601 字符串，无效时间戳回退为 null
  let updatedAt: string | null = null;
  if (typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)) {
    const date = new Date(summary.updatedAt);
    if (!Number.isNaN(date.getTime())) {
      updatedAt = date.toISOString();
    }
  }
  // 中文：标题规范化：空字符串转为 null，便于客户端通过 === null 检测"无标题"状态
  const titleRaw = summary.title;
  const title = typeof titleRaw === 'string' && titleRaw.length > 0 ? titleRaw : null;
  return {
    sessionId: summary.id,
    cwd: summary.workDir,
    title,
    updatedAt,
  };
}

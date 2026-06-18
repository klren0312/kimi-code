import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deleteAllKittyImages,
  type Component,
  type Focusable,
  getCapabilities,
  Spacer,
} from '@earendil-works/pi-tui';
import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CreateSessionOptions,
  KimiHarness,
  PermissionMode,
  PromptPart,
  Session,
} from '@moonshot-ai/kimi-code-sdk';
import {
  isLlmCommunicationLogEnabled,
  triggerApprovalRequest,
  triggerApprovalResult,
  setApprovalResponseCallback,
} from '@moonshot-ai/kimi-code-sdk';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import { resolve } from 'pathe';

import type { CLIOptions } from '#/cli/options';
import { MigrationScreenComponent, type MigrationScreenResult } from '#/migration/index';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { openUrl } from '#/utils/open-url';
import { getInputHistoryFile } from '#/utils/paths';
import { detectFdPath, ensureFdPath } from '#/utils/process/fd-detect';
import { quoteShellArg } from '#/utils/shell-quote';

import { BannerProvider } from './banner/banner-provider';
import { readBannerDisplayState, writeBannerDisplayState } from './banner/state';
import {
  BUILTIN_SLASH_COMMANDS,
  buildSkillSlashCommands,
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
  sortSlashCommands,
  type KimiSlashCommand,
  type SkillListSession,
} from './commands';
import * as slashCommands from './commands/dispatch';
import { BannerComponent } from './components/chrome/banner';
import { DeviceCodeBoxComponent } from './components/chrome/device-code-box';
import { GutterContainer } from './components/chrome/gutter-container';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader';
import { WelcomeComponent } from './components/chrome/welcome';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from './components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from './components/dialogs/approval-preview';
import { CompactionComponent } from './components/dialogs/compaction';
import { HelpPanelComponent } from './components/dialogs/help-panel';
import { QuestionDialogComponent } from './components/dialogs/question-dialog';
import {
  SessionPickerComponent,
  type SessionRow,
} from './components/dialogs/session-picker';
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from './components/editor/file-mention-provider';
import { AssistantMessageComponent } from './components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from './components/messages/background-agent-status';
import { CronMessageComponent } from './components/messages/cron-message';
import { buildGoalMarker } from './components/messages/goal-markers';
import {
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
} from './components/messages/goal-panel';
import { SkillActivationComponent } from './components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { ThinkingComponent } from './components/messages/thinking';
import { ToolCallComponent } from './components/messages/tool-call';
import { UserMessageComponent } from './components/messages/user-message';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { TuiConfig } from './config';
import {
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  NO_ACTIVE_SESSION_MESSAGE,
  PRODUCT_NAME,
} from './constant/kimi-tui';
import { CHROME_GUTTER } from './constant/rendering';
import { MAX_TERMINAL_TITLE_LENGTH } from './constant/terminal';
import { AuthFlowController } from './controllers/auth-flow';
import { BtwPanelController } from './controllers/btw-panel';
import { EditorKeyboardController } from './controllers/editor-keyboard';
import { SessionEventHandler } from './controllers/session-event-handler';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StreamingUIController } from './controllers/streaming-ui';
import { TasksBrowserController } from './controllers/tasks-browser';
import { installRainbowDance } from './easter-eggs/dance';
import { adaptPanelResponse } from './reverse-rpc/approval/adapter';
import { ApprovalController } from './reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from './reverse-rpc/approval/handler';
import { registerReverseRPCHandlers } from './reverse-rpc/index';
import { QuestionController } from './reverse-rpc/question/controller';
import { createQuestionAskHandler } from './reverse-rpc/question/handler';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types';
import { currentTheme, getColorPalette, getBuiltInPalette, isBuiltInTheme } from './theme';
import type { ColorToken, ResolvedTheme, ThemeName } from './theme';
import { createTUIState, type TUIState } from './tui-state';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import { isExpandable } from './utils/component-capabilities';
import { isDeadTerminalError } from './utils/dead-terminal';
import { formatErrorMessage } from './utils/event-payload';
import { ImageAttachmentStore, type ImageAttachment } from './utils/image-attachment-store';
import { extractMediaAttachments } from './utils/image-placeholder';
import { hasPatchChanges } from './utils/object-patch';
import { sessionRowsForPicker } from './utils/session-picker-rows';
import { combineStartupNotice, isOAuthLoginRequiredError } from './utils/startup';
import { installTerminalFocusTracking } from './utils/terminal-focus';
import { notifyTerminalOnce } from './utils/terminal-notification';
import { installTerminalThemeTracking } from './utils/terminal-theme';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import { markTranscriptComponent } from './utils/transcript-component-metadata';
import { nextTranscriptId } from './utils/transcript-id';

export type { TUIState } from './tui-state';
export { createTUIState } from './tui-state';
export type {
  KimiTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from './types';

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  readonly migrationPlan?: MigrationPlan | null;
  /** 为 true 时仅运行迁移屏幕，然后退出（`kimi migrate` 命令）。 */
  readonly migrateOnly?: boolean;
}

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';

function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    sessionId: '',
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    swarmMode: false,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  state: TUIState;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly KimiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  private fdPath: string | null = detectFdPath();
  private fdDownloadStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private uninstallRainbowDance: () => void;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private readonly migrationPlan: MigrationPlan | null;
  private readonly migrateOnly: boolean;
  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private lastHistoryContent: string | undefined;
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly btwPanelController: BtwPanelController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly editorKeyboard: EditorKeyboardController;

  // 当前挂载的审批面板（如有）。保留该引用以便全屏预览查看器
  // 关闭时可以恢复焦点到同一个实例（及其选中/反馈状态）。
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // 当前活跃的全屏审批预览。设置期间，根 UI 的正常子组件
  // 暂存在 `savedChildren` 中；关闭时会恢复。
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        savedChildren: readonly Component[];
        panel: ApprovalPanelComponent;
      }
    | undefined;

  // 待处理审批请求 ID 到其回调函数的映射
  private pendingApprovals = new Map<string, (response: ApprovalPanelResponse) => void>();

  public onExit?: (exitCode?: number) => Promise<void>;

  track(event: string, properties?: Parameters<KimiHarness['track']>[1]): void {
    this.harness.track(event, properties);
  }

  constructor(harness: KimiHarness, startupInput: KimiTUIStartupInput) {
    this.harness = harness;
    const tuiOptions: KimiTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
      startup: {
        sessionFlag: startupInput.cliOptions.session,
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        auto: startupInput.cliOptions.auto,
        plan: startupInput.cliOptions.plan,
        model: startupInput.cliOptions.model,
        startupNotice: startupInput.startupNotice,
      },
    };
    this.options = tuiOptions;
    this.migrationPlan = startupInput.migrationPlan ?? null;
    this.migrateOnly = startupInput.migrateOnly ?? false;
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(tuiOptions);
    this.uninstallRainbowDance = installRainbowDance(() => {
      this.state.ui.requestRender();
    });

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(this.approvalController, this.questionController, {
        showApprovalPanel: (payload) => {
          this.showApprovalPanel(payload);
        },
        hideApprovalPanel: () => {
          this.hideApprovalPanel();
        },
        showQuestionDialog: (payload) => {
          this.showQuestionDialog(payload);
        },
        hideQuestionDialog: () => {
          this.hideQuestionDialog();
        },
      }),
    );

    // 注册 Web 查看器审批回调（始终注册，运行时检查是否启用）
    setApprovalResponseCallback((requestId, approved, scope) => {
      const pending = this.pendingApprovals.get(requestId);
      if (pending) {
        this.pendingApprovals.delete(requestId);
        if (approved) {
          pending({
            response: scope === 'session' ? 'approved_for_session' : 'approved',
            selected_label: scope === 'session' ? 'Approve for session' : 'Approve',
          });
        } else {
          pending({ response: 'rejected' });
        }
        // 收到响应后隐藏面板
        this.hideApprovalPanel();
      }
    });
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.btwPanelController = new BtwPanelController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.buildLayout();
  }

  // =========================================================================
  // 自动补全与技能命令
  // =========================================================================

  private getSlashCommands(): readonly KimiSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter((command) =>
      isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands];
  }

  private setupAutocomplete(): void {
    const slashCommands: SlashAutocompleteCommand[] = this.getSlashCommands().map((cmd) => {
      const completer = cmd.completeArgs;
      return {
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        ...(cmd.argumentHint !== undefined ? { argumentHint: cmd.argumentHint } : {}),
        ...(completer !== undefined
          ? { getArgumentCompletions: (prefix: string) => completer(prefix) }
          : {}),
      };
    });
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
    );
    this.state.editor.setAutocompleteProvider(provider);
  }

  refreshSlashCommandAutocomplete(): void {
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      this.skillCommands = [];
      this.skillCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  // =========================================================================
  // 生命周期
  // =========================================================================

  async start(): Promise<void> {
    // 信号处理器必须在启用原始模式之前安装，以避免 EIO 循环。
    this.registerSignalHandlers();
    // 外层 try 在启动失败时回滚信号监听器。
    try {
      if (this.migrationPlan !== null) {
        // 迁移需要先启动事件循环（pi-tui 组件）。
        this.startEventLoop();
        try {
          const migrationResult = await this.runMigrationScreen(this.migrationPlan);
          if (this.migrateOnly) {
            const failed = migrationResult.decision === 'now' && migrationResult.migrated === false;
            this.disposeTerminalTracking();
            this.state.ui.stop();
            await this.onExit?.(failed ? 1 : 0);
            return;
          }
          const shouldReplayHistory = await this.initMainTui();
          this.startBackgroundFdAutocomplete();
          await this.finishStartup(shouldReplayHistory);
        } catch (error) {
          this.disposeTerminalTracking();
          this.state.ui.stop();
          throw error;
        }
        return;
      }

      const shouldReplayHistory = await this.initMainTui();
      this.startEventLoop();
      try {
        this.startBackgroundFdAutocomplete();
        await this.finishStartup(shouldReplayHistory);
      } catch (error) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async loadBanner(): Promise<void> {
    const provider = new BannerProvider(this.state.appState.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const banner = await provider.load(fetch, {
      state: displayState,
      now,
    });
    this.state.appState.banner = banner;
    if (banner === null) return;

    this.renderBanner();
    this.state.ui.requestRender();

    if (banner.display === 'always') return;
    try {
      await writeBannerDisplayState({
        version: 1,
        shown: {
          ...displayState.shown,
          [banner.key]: { lastShownAt: now.toISOString() },
        },
      });
    } catch {
      // 尽力而为：横幅显示状态不应阻塞启动。
    }
  }

  private renderBanner(): void {
    if (this.state.appState.banner === null || this.state.appState.banner === undefined) {
      return;
    }
    if (this.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)) {
      return;
    }
    const welcomeIndex = this.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const banner = new BannerComponent(this.state.appState.banner);
    if (welcomeIndex >= 0) {
      this.state.transcriptContainer.children.splice(welcomeIndex + 1, 0, banner);
    } else {
      this.state.transcriptContainer.children.unshift(banner);
    }
    this.state.transcriptContainer.invalidate();
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    // 仅在 init() 成功后挂载；参见 mountFooter()。
    this.mountFooter();
    this.renderWelcome();
    void this.loadBanner();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    return shouldReplayHistory;
  }

  private startEventLoop(): void {
    this.state.ui.start();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state);
    this.refreshTerminalThemeTracking();
  }

  private startBackgroundFdAutocomplete(): void {
    if (this.fdPath !== null || this.fdDownloadStarted) return;
    this.fdDownloadStarted = true;

    void ensureFdPath()
      .then((fdPath) => {
        if (fdPath === null) return;
        this.fdPath = fdPath;
        this.setupAutocomplete();
      })
      .catch(() => {
        // 尽力而为的后台引导：自动补全继续使用文件系统回退方案。
      });
  }

  private async refreshProviderModelsInBackground(): Promise<void> {
    try {
      const result = await this.authFlow.refreshProviderModels();
      for (const c of result.changed) {
        if (c.added <= 0) continue;
        this.showStatus(
          `${c.providerName} · +${String(c.added)} model${c.added > 1 ? 's' : ''}.`,
        );
      }
      for (const f of result.failed) {
        this.showStatus(`Skipped refreshing ${f.provider}: ${f.reason}`, 'warning');
      }
    } catch {
      // 尽力而为：启动不应因后台刷新失败而崩溃。
    }
  }

  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    if (this.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) {
      await this.sessionReplay.hydrateFromReplay(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    const resumeState = this.session?.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
    }
    void this.fetchSessions();
    if (this.session !== undefined) {
      this.updateTerminalTitle();
    }
    void this.refreshSkillCommands(this.session);
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, 'warning');
  }

  private async init(): Promise<boolean> {
    setExperimentalFeatures(await this.harness.getExperimentalFeatures());
    await this.authFlow.refreshAvailableModels();
    void this.refreshProviderModelsInBackground();

    const { startup } = this.options;
    const { workDir } = this.state.appState;
    let session: Session | undefined;
    let shouldReplayHistory = false;
    const isResumeStartup = startup.sessionFlag !== undefined || startup.continueLast;
    const createSessionOptions: CreateSessionOptions = {
      workDir,
      model: startup.model,
      permission: startup.auto ? 'auto' : startup.yolo ? 'yolo' : undefined,
      planMode: startup.plan ? true : undefined,
    };

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === '') {
          this.state.startupState = 'picker';
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.harness.listSessions({
            sessionId: startup.sessionFlag,
            workDir,
          });
          const target = sessions[0];
          if (target === undefined) {
            throw new Error(`Session "${startup.sessionFlag}" not found.`);
          }
          if (resolve(target.workDir) !== resolve(workDir)) {
            this.state.ui.stop();
            process.stderr.write(
              `${currentTheme.fg(
                'warning',
                `Session "${startup.sessionFlag}" was created under a different directory.\n` +
                  `  cd "${target.workDir}" && kimi -r ${startup.sessionFlag}`,
              )}\n\n`,
            );
            throw new Error(
              `Session "${startup.sessionFlag}" was created under a different directory.`,
            );
          }
          session = await this.harness.resumeSession({ id: startup.sessionFlag });
          shouldReplayHistory = true;
        } else {
          const sessions = await this.harness.listSessions({ workDir });
          const target = sessions[0];
          if (target !== undefined) {
            session = await this.harness.resumeSession({ id: target.id });
            shouldReplayHistory = true;
          } else {
            session = await this.harness.createSession(createSessionOptions);
            this.startupNotice = combineStartupNotice(
              this.startupNotice,
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
            );
          }
        }
      } else {
        session = await this.harness.createSession(createSessionOptions);
      }
      if (session !== undefined && shouldReplayHistory) {
        await this.applyStartupModesToResumedSession(session);
        if (startup.model !== undefined) {
          await session.setModel(startup.model);
        }
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.authFlow.enterLoginRequiredStartupState();
      return false;
    }

    if (session === undefined) {
      throw new Error('Startup session was not initialized.');
    }
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.applyStartupPermissionAndPlanToAppState();
    this.state.startupState = 'ready';
    return shouldReplayHistory;
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    this.streamingUI.discardPending();
    this.editorKeyboard.clearPendingExit();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    await this.closeSession('shutting down');
    await this.harness.close();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.uninstallRainbowDance();
    await this.state.terminal.drainInput();
    this.state.ui.stop();
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // SIGHUP / 终端死亡 EIO → emergencyTerminalExit（不执行清理，避免
  // EIO 写循环导致 CPU 核心被占满）。SIGTERM → 正常 stop()。
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.emergencyTerminalExit();
          return;
        }
        // 注册 SIGTERM 监听器会禁用 Node 默认的 exit(143) 行为，
        // 因此必须在 stop() 之后或失败时手动恢复。
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // 退出码遵循 POSIX 128+信号编号规则：129 = SIGHUP，143 = SIGTERM。
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  private buildLayout(): void {
    const { ui } = this.state;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.todoPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.btwPanelContainer);
    ui.addChild(this.state.editorContainer);
    // Footer 稍后挂载（mountFooter），不在此处。
  }

  // Footer 是会话就绪前唯一有内容的固定 UI 元素，因此
  // 在构造时挂载会导致启动前的意外渲染泄露到终端——例如恢复缺失会话时
  // 出现在错误信息上方。仅在 init() 成功后挂载。FooterComponent 不是
  // Container，因此需要包装以获得与上方面板相同的外边距。
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    this.state.ui.addChild(footerWrap);
  }

  // =========================================================================
  // 输入分发
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this, next ? 'on' : 'off');
  }

  handleUserInput(text: string): void {
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError('Cannot send input while session history is replaying.');
      return;
    }
    void this.persistInputHistory(text);
    slashCommands.dispatchInput(this, text);
  }

  sendNormalUserInput(text: string): void {
    if (this.btwPanelController.sendUserInput(text)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    const extraction = extractMediaAttachments(text, this.imageStore);
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = this.session;
    if (session === undefined) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  private validateMediaCapabilities(
    extraction: ReturnType<typeof extractMediaAttachments>,
  ): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError('Current model does not support image input.');
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.showError('Current model does not support video input.');
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.state.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // 尽力而为
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): string | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const last = this.state.queuedMessages.at(-1)!;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    return last.text;
  }

  // =========================================================================
  // 会话请求 / 队列
  // =========================================================================

  private enqueueMessage(text: string, options?: SendMessageOptions): void {
    this.state.queuedMessages.push({
      text,
      agentId: this.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
    });
    this.track('input_queue');
  }

  beginSessionRequest(): void {
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();

    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    this.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts: item.parts,
        imageAttachmentIds: item.imageAttachmentIds,
      });
    });
  }

  requestQueuedGoalPromotion(): void {
    this.sessionEventHandler.requestQueuedGoalPromotion();
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    });

    this.beginSessionRequest();

    const sdkInput = options?.parts ?? input;
    void session.prompt(sdkInput).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Failed to send: ${message}`);
    });
  }

  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    this.beginSessionRequest();
    void session.activateSkill(skillName, skillArgs).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Skill "${skillName}" failed: ${message}`);
    });
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    if (
      this.deferUserMessages ||
      this.state.appState.streamingPhase !== 'idle' ||
      this.state.appState.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  steerMessage(session: Session, input: string[]): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      for (const part of input) {
        this.enqueueMessage(part);
      }
      return;
    }
    if (this.state.appState.streamingPhase === 'idle') {
      for (const part of input) {
        this.sendMessageInternal(session, part);
      }
      return;
    }

    for (const part of input) {
      this.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: part,
      });
    }

    void session.steer(input.join('\n\n')).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.showError(`Failed to steer: ${message}`);
    });
  }

  // =========================================================================
  // 状态与访问器
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = 'ready';
  }

  clearQueuedMessages(): void {
    this.state.queuedMessages = [];
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const [first, ...rest] = this.state.queuedMessages;
    this.state.queuedMessages = rest;
    return first;
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
  }

  setTasksBrowser(value: TUIState['tasksBrowser']): void {
    this.state.tasksBrowser = value;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  async getStartupMcpMs(): Promise<number> {
    const session = this.session;
    if (session === undefined) return 0;
    try {
      const metrics = await session.getMcpStartupMetrics();
      return metrics.durationMs;
    } catch {
      return 0;
    }
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) {
      this.updateQueueDisplay();
      this.sessionEventHandler.retryQueuedGoalPromotion();
    }
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  // =========================================================================
  // 会话运行时
  // =========================================================================

  requireSession(): Session {
    if (this.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.session;
  }

  private async createSessionFromCurrentState(): Promise<Session> {
    const model = this.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(LLM_NOT_SET_MESSAGE);
    }
    return this.harness.createSession({
      workDir: this.state.appState.workDir,
      model,
      thinking:
        this.session === undefined ? undefined : this.state.appState.thinking ? 'on' : 'off',
      permission: this.state.appState.permissionMode,
      planMode: this.state.appState.planMode ? true : undefined,
    });
  }

  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
  }

  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const [status, goalResult] = await Promise.all([session.getStatus(), session.getGoal()]);
    this.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinking: status.thinkingLevel !== 'off',
      permissionMode: status.permission,
      planMode: status.planMode,
      swarmMode: status.swarmMode ?? false,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      sessionTitle: session.summary?.title ?? null,
      goal: goalResult.goal,
    });
  }

  // 将 --auto/--yolo/--plan 启动标志应用到恢复的会话。恢复的会话
  // 可能已从持久化记录中处于计划模式，重复进入计划模式会抛出异常，
  // 因此仅在尚未激活时才启用。setPermission 是幂等的，无需此保护。
  private async applyStartupModesToResumedSession(session: Session): Promise<void> {
    const { startup } = this.options;
    if (startup.auto) {
      await session.setPermission('auto');
    } else if (startup.yolo) {
      await session.setPermission('yolo');
    }
    if (startup.plan) {
      const status = await session.getStatus();
      if (!status.planMode) {
        await session.setPlanMode(true);
      }
    }
  }

  // 重新应用用户在命令行显式传递的启动标志。
  // syncRuntimeState 和会话回放水合都可能读取过时的持久化值，
  // 因此此方法确保底栏反映 CLI 的实际意图。
  private applyStartupPermissionAndPlanToAppState(): void {
    const { startup } = this.options;
    if (startup.auto) {
      this.setAppState({ permissionMode: 'auto' });
    } else if (startup.yolo) {
      this.setAppState({ permissionMode: 'yolo' });
    }
    if (startup.plan) {
      this.setAppState({ planMode: true });
    }
  }

  // 计划模式已由 createSession 设置——此处不再重复进入。
  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.state.swarmModeEntry = undefined;
    this.harness.setTelemetryContext({ sessionId: null });
    this.setAppState({ goal: null });
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
  }

  private registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(this.approvalController, (request, response) => {
        this.appendApprovalTranscriptEntry(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.questionController));
  }

  async fetchSessions(scope: 'cwd' | 'all' = this.state.sessionsScope): Promise<void> {
    this.state.loadingSessions = true;
    this.state.sessionsScope = scope;
    try {
      const sessions =
        scope === 'all'
          ? await this.harness.listSessions({})
          : await this.harness.listSessions({ workDir: this.state.appState.workDir });
      this.state.sessions = sessionRowsForPicker(
        sessions,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
    } catch {
      /* 静默忽略 */
    } finally {
      this.state.loadingSessions = false;
    }
  }

  updateTerminalTitle(): void {
    const trimmed = this.state.appState.sessionTitle?.trim() ?? '';
    const label = trimmed.length > 0 ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH) : PRODUCT_NAME;
    this.state.terminal.setTitle(label);
  }

  resetSessionRuntime(): void {
    this.aborted = false;
    this.streamingUI.discardPending();
    this.state.queuedMessages = [];
    this.state.swarmModeEntry = undefined;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = `Current session is in a different working directory.\n  To resume, run: ${command}`;
    try {
      await copyTextToClipboard(command);
      this.showStatus(`${message}\n  Command copied to clipboard`, 'warning');
    } catch {
      this.showStatus(`${message}\n  Failed to copy command to clipboard`, 'warning');
    }
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus('Already on this session.');
      return true;
    }
    if (this.state.appState.streamingPhase !== 'idle') {
      this.showError('Cannot switch sessions while streaming — press Esc or Ctrl-C first.');
      return false;
    }
    if (this.state.appState.isReplaying) {
      this.showError('Cannot switch sessions while history is replaying.');
      return false;
    }

    let session: Session;
    try {
      session = await this.harness.resumeSession({ id: targetSessionId });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to resume session ${targetSessionId}: ${msg}`);
      return false;
    }

    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(this.session);
    } catch {
      /* 即使动态技能加载失败也保持切换后的会话可用 */
    }
    this.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to replay session history: ${msg}`);
    } finally {
      this.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    this.showStatus(statusMessage);
  }

  async reloadCurrentSessionView(session: Session, statusMessage: string): Promise<void> {
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    session.setApprovalHandler(undefined);
    session.setQuestionHandler(undefined);
    this.approvalController.cancelAll('reloading session');
    this.questionController.cancelAll('reloading session');

    this.resetSessionRuntime();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(session);
    } catch {
      /* 即使动态技能加载失败也保持重新加载的会话可用 */
    }
    this.sessionEventHandler.startSubscription();
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    this.showStatus(statusMessage);
  }

  async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError('Cannot start a new session while history is replaying.');
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a new session: ${msg}`);
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(`Post-create setup failed: ${msg}`);
      return;
    }
    try {
      await this.refreshSkillCommands(this.session);
    } catch {
      /* 即使动态技能加载失败也保持新会话可用 */
    }
    this.sessionEventHandler.startSubscription();
    this.clearTranscriptAndRedraw();
    this.showStatus(`Started a new session (${session.id}).`);
    void this.showConfigWarningsIfAny();
  }

  /** 在状态栏显示 config.toml 加载警告（降级或保留了旧配置）。 */
  private async showConfigWarningsIfAny(): Promise<void> {
    try {
      const { warnings } = await this.harness.getConfigDiagnostics();
      for (const warning of warnings) {
        this.showStatus(warning, 'warning');
      }
    } catch {
      /* 诊断为尽力而为 */
    }
  }

  // =========================================================================
  // 对话记录渲染
  // =========================================================================

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.state.ui, data.instruction);
      if (data.result === 'cancelled') {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter);
      }
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        return new UserMessageComponent(entry.content, images);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case 'cron':
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case 'goal':
        if (entry.goalData?.kind === 'created') {
          return new GoalSetMessageComponent();
        }
        if (entry.goalData?.kind === 'lifecycle') {
          return buildGoalMarker(entry.goalData.change, this.state.toolOutputExpanded);
        }
        return null;
      case 'assistant': {
        if (entry.content.trimStart().startsWith('✓ Goal complete')) {
          return new GoalCompletionMessageComponent(entry.content);
        }
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.ui,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      markTranscriptComponent(component, entry);
      this.state.transcriptContainer.addChild(component);
      this.state.ui.requestRender();
    }
  }

  private appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    if (request.toolName === 'ExitPlanMode' || request.display.kind === 'plan_review') return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(response.scope === 'session' ? 'Approved for session' : 'Approved');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: request.turnId === undefined ? undefined : String(request.turnId),
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  private renderWelcome(): void {
    if (
      this.state.transcriptContainer.children.some((child) => child instanceof WelcomeComponent)
    ) {
      return;
    }
    const welcome = new WelcomeComponent(this.state.appState);
    this.state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  private clearTranscriptAndRedraw(): void {
    this.streamingUI.discardPending();
    this.state.transcriptEntries = [];
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.state.transcriptContainer.clear();
    this.btwPanelController.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    this.imageStore.clear();
    this.renderWelcome();
  }

  showStatus(message: string, color?: ColorToken): void {
    this.state.transcriptContainer.addChild(new StatusMessageComponent(message, color));
    this.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(new NoticeMessageComponent(title, detail));
    this.state.ui.requestRender();
  }

  showError(message: string): void {
    this.showStatus(`Error: ${message}`, 'error');
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg('primary', s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? 'success' : 'error';
        const symbol = ok ? '✓' : '✗';
        spinner.setText(currentTheme.fg(tone, `${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
    };
  }

  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: 'Sign in to Kimi Code',
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: 'Press Ctrl-C to cancel',
      }),
    );
    this.state.ui.requestRender();
    return this.showLoginProgressSpinner('Waiting for authorization…');
  }

  // =========================================================================
  // 面板 / 展示状态
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const placeSpinnerInAgentSwarm = this.shouldPlaceActivitySpinnerInAgentSwarm(effectiveMode);
    const activityModeKey = `${effectiveMode}:${placeSpinnerInAgentSwarm ? 'swarm' : 'pane'}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === 'waiting' || effectiveMode === 'thinking' || effectiveMode === 'tool')
    ) {
      if (placeSpinnerInAgentSwarm) {
        this.syncAgentSwarmActivitySpinner(this.state.activitySpinner?.instance);
      }
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.ui.requestRender();
        return;
      case 'waiting': {
        const spinner = this.ensureActivitySpinner('moon');
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
          }),
        );
        break;
      }
      case 'thinking': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'working...', (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        break;
      }
    }
    this.state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.activeDialog === 'session-picker') return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.state.appState.streamingPhase;
    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.state.queuedMessages;
    if (queued.length === 0) return;

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.streamingPhase !== 'idle',
        canSteerImmediately: !this.deferUserMessages,
      }),
    );
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    for (const child of this.state.transcriptContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(this.state.toolOutputExpanded);
      }
    }
    this.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const highlighted = this.state.appState.planMode || trimmed.startsWith('/');
    this.state.editor.borderHighlighted = highlighted;
    this.state.editor.borderColor = (s: string) =>
      currentTheme.fg(highlighted ? 'primary' : 'border', s);
    this.state.ui.requestRender();
  }

  async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
    const palette = await getColorPalette(themeName === 'auto' ? (resolved ?? 'dark') : themeName);
    currentTheme.setPalette(palette);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // 强制所有历史消息重新渲染，以清除 Markdown/Text 缓存
    //（其中保存了旧的 ANSI 颜色代码）。
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (!isBuiltInTheme(this.state.appState.theme) || this.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.state, (resolved) => {
      void this.applyResolvedAutoTheme(resolved);
    });
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.state.appState.theme !== 'auto') return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
    // 重新绘制已渲染的对话条目（状态/Markdown 缓存保存了
    // 旧的 ANSI 代码），与 applyTheme() 的行为一致。
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private shouldPlaceActivitySpinnerInAgentSwarm(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    return (
      this.sessionEventHandler.hasActiveAgentSwarmToolCall() &&
      (effectiveMode === 'waiting' || effectiveMode === 'tool')
    );
  }

  private syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.sessionEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.state.terminalState.supportsProgress) return;
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === null) {
      const instance = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinner = { instance, style };
      return instance;
    }

    this.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.state.activitySpinner !== null) {
      this.state.activitySpinner.instance.stop();
      this.state.activitySpinner = null;
    }
  }

  // =========================================================================
  // 对话框 / 选择器
  // =========================================================================

  mountEditorReplacement(panel: Component & Focusable): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
  }

  restoreEditor(): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.state.ui.requestRender();
  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.state.editor.setText(text);
    this.updateEditorBorderHighlight(text);
    this.state.ui.requestRender();
  }

  private async runMigrationScreen(plan: MigrationPlan): Promise<MigrationScreenResult> {
    const result = await new Promise<MigrationScreenResult>((resolve) => {
      const screen = new MigrationScreenComponent({
        plan,
        sourceHome: plan.sourceHome,
        targetHome: this.harness.homeDir,
        skipDecisionStep: this.migrateOnly,
        requestRender: () => {
          this.state.ui.requestRender();
        },
        onComplete: (r) => {
          resolve(r);
        },
      });
      this.mountEditorReplacement(screen);
    });
    this.restoreEditor();
    if (result.decision === 'never') {
      // 持久化 `detectPendingMigration` 检查的跳过标记，使"不再询问"
      // 真正阻止提示在每次启动时重新出现。
      try {
        writeFileSync(join(this.harness.homeDir, '.skip-migration-from-kimi-cli'), '', 'utf-8');
      } catch {
        // 非阻塞：标记写入失败绝不能导致启动崩溃。
      }
    }
    return result;
  }

  showHelpPanel(): void {
    this.state.activeDialog = 'help';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.getSlashCommands(),
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  private hideHelpPanel(): void {
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private sessionPickerOptions: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  } = {
    applyStartupModes: false,
    closeOnCancel: false,
    forwardEditorExit: false,
  };
  private sessionPickerScopeRequestToken = 0;

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: true,
      closeOnCancel: true,
      forwardEditorExit: true,
    });
  }

  private async openSessionPicker(options: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.fetchSessions('cwd');
    this.mountSessionPicker({
      applyStartupModes: options.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (options.closeOnCancel) void this.stop();
      },
      onCtrlC: options.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: options.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  private async toggleSessionPickerScope(selectedSessionId: string): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    const nextScope = this.state.sessionsScope === 'cwd' ? 'all' : 'cwd';
    await this.fetchSessions(nextScope);
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.state.activeDialog !== 'session-picker') return;
    this.mountSessionPicker({
      initialSelectedSessionId: selectedSessionId,
      applyStartupModes: this.sessionPickerOptions.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.stop();
      },
      onCtrlC: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.editorKeyboard.clearPendingExit();
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    // CLI 模式标志（--auto/--yolo/--plan）针对启动时选择的会话
    // （裸 --session）；之后的 /sessions 切换保持所选会话自身的
    // 持久化模式。
    readonly applyStartupModes?: boolean;
  }): void {
    this.state.activeDialog = 'session-picker';
    this.mountEditorReplacement(
      new SessionPickerComponent({
        sessions: this.state.sessions,
        loading: this.state.loadingSessions,
        currentSessionId: this.state.appState.sessionId,
        scope: this.state.sessionsScope,
        initialSelectedSessionId: options.initialSelectedSessionId,
        pageSize: 50,
        onSelect: (session: SessionRow) => {
          void this.handleSessionPickerSelect(session, options.applyStartupModes === true).catch(
            (error) => {
              this.showError(`Failed to apply startup flags: ${formatErrorMessage(error)}`);
            },
          );
        },
        onCancel: options.onCancel,
        onCtrlC: options.onCtrlC,
        onCtrlD: options.onCtrlD,
        onToggleScope: (selectedSessionId: string) => {
          void this.toggleSessionPickerScope(selectedSessionId);
        },
      }),
    );
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    if (resolve(session.work_dir) !== resolve(this.state.appState.workDir)) {
      await this.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.stop(0);
      return;
    }

    const switched = await this.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      await this.applyStartupModesToResumedSession(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: 'Kimi Code approval required',
      body: payload.tool_name,
    });

    // 向 Web 查看器广播审批请求
    if (isLlmCommunicationLogEnabled()) {
      const toolInput = payload.description || payload.action || payload.tool_name;
      triggerApprovalRequest(payload.tool_name, toolInput, payload.id);
    }

    // 存储 Web 查看器审批回调
    const handleResponse = (response: ApprovalPanelResponse) => {
      this.pendingApprovals.delete(payload.id);
      // 向 Web 查看器广播审批结果
      if (isLlmCommunicationLogEnabled()) {
        const approved = response.response === 'approved' || response.response === 'approved_for_session';
        triggerApprovalResult(payload.id, approved, response.response === 'approved_for_session' ? 'session' : undefined);
      }
      this.approvalController.respond(adaptPanelResponse(response));
    };

    // 存储 Web 查看器审批回调（始终存储，运行时检查是否启用）
    this.pendingApprovals.set(payload.id, handleResponse);

    const panel = new ApprovalPanelComponent(
      { data: payload },
      handleResponse,
      () => {
        this.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  private hideApprovalPanel(): void {
    // 如果全屏预览处于打开状态，先将其折叠回去，以确保已保存的
    // 子组件栈与 mountEditorReplacement 设置的一致。
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  // 在当前审批面板上方挂载全屏审批预览查看器。使用与
  // openTaskOutputViewer 相同的嵌套接管模式：快照根容器的子组件，
  // 替换为查看器，关闭时恢复。审批面板实例保留在
  // `activeApprovalPanel` 中，以保留其选中状态。
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const savedChildren = [...this.state.ui.children];
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    this.state.ui.clear();
    this.state.ui.addChild(viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, savedChildren, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    this.state.ui.clear();
    for (const child of preview.savedChildren) {
      this.state.ui.addChild(child);
    }
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: 'Kimi Code needs your answer',
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      6,
      () => {
        this.toggleToolOutputExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }
}

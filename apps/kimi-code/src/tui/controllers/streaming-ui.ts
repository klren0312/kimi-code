import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { STREAMING_UI_FLUSH_MS } from '../constant/streaming';
import { hasDispose } from '../utils/component-capabilities';
import { appendStreamingArgsPreview, parseStreamingArgs } from '../utils/event-payload';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { nextTranscriptId } from '../utils/transcript-id';
import type { TodoItem } from '../components/chrome/todo-panel';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';

export interface StreamingUIHost {
  state: TUIState;
  session: Session | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
  shiftQueuedMessage(): QueuedMessage | undefined;
  pushTranscriptEntry(entry: TranscriptEntry): void;
}

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // 流式运行时状态（私有——通过下方的语义方法访问）
  // ---------------------------------------------------------------------------

  private _currentTurnId: string | undefined = undefined;
  private _currentStep = 0;
  private _assistantDraft = '';
  private _thinkingDraft = '';
  private _streamingBlock: { component: AssistantMessageComponent; entry: TranscriptEntry } | null = null;
  private _activeThinkingComponent: ThinkingComponent | undefined = undefined;
  private _activeCompactionBlock: CompactionComponent | undefined = undefined;
  private _activeToolCalls = new Map<string, ToolCallBlockData>();
  private _streamingToolCallArguments = new Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >();
  private _pendingToolComponents = new Map<string, ToolCallComponent>();
  private _pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: AgentGroupComponent;
  } | null = null;
  private _pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null = null;

  constructor(private readonly host: StreamingUIHost) {}

  // ---------------------------------------------------------------------------
  // 对话轮次上下文——读写访问器
  // ---------------------------------------------------------------------------

  getTurnContext(): { turnId: string | undefined; step: number } {
    return { turnId: this._currentTurnId, step: this._currentStep };
  }

  setTurnId(turnId: string | undefined): void {
    this._currentTurnId = turnId;
  }

  setStep(step: number): void {
    this._currentStep = step;
  }

  hasActiveTurn(): boolean {
    return this._currentTurnId !== undefined;
  }

  // ---------------------------------------------------------------------------
  // 文本流式传输——语义写入访问器
  // ---------------------------------------------------------------------------

  appendThinkingDelta(delta: string): void {
    this._thinkingDraft += delta;
    this.pendingThinkingFlush = true;
  }

  appendAssistantDelta(delta: string): void {
    if (this._streamingBlock === null) {
      this.onStreamingTextStart();
    }
    this._assistantDraft += delta;
    this.pendingAssistantFlush = true;
  }

  hasThinkingDraft(): boolean {
    return this._thinkingDraft.length > 0;
  }

  hasActiveThinkingComponent(): boolean {
    return this._activeThinkingComponent !== undefined;
  }

  hasStreamingBlock(): boolean {
    return this._streamingBlock !== null;
  }

  getStreamingBlockComponent(): AssistantMessageComponent | undefined {
    return this._streamingBlock?.component;
  }

  clearAssistantDraft(): void {
    this._assistantDraft = '';
  }

  // ---------------------------------------------------------------------------
  // 工具调用状态——语义访问器
  // ---------------------------------------------------------------------------

  getActiveToolCall(id: string): ToolCallBlockData | undefined {
    return this._activeToolCalls.get(id);
  }

  hasActiveToolCall(id: string): boolean {
    return this._activeToolCalls.has(id);
  }

  setActiveToolCall(id: string, toolCall: ToolCallBlockData): void {
    this._activeToolCalls.set(id, toolCall);
  }

  removeActiveToolCall(id: string): void {
    this._activeToolCalls.delete(id);
  }

  getToolComponent(id: string): ToolCallComponent | undefined {
    return this._pendingToolComponents.get(id);
  }

  removeToolComponent(id: string): void {
    this._pendingToolComponents.delete(id);
  }

  hasPendingAgentGroup(): boolean {
    return this._pendingAgentGroup !== null;
  }

  hasPendingReadGroup(): boolean {
    return this._pendingReadGroup !== null;
  }

  removeToolComponentIfInactive(toolCallId: string): void {
    if (!this._activeToolCalls.has(toolCallId)) {
      this._pendingToolComponents.delete(toolCallId);
    }
  }

  /**
   * 将后台 agent 任务的实际终端状态推送至匹配的 `Agent` 工具调用组件，
   * 使其快照阶段不再信任 spawn-success ToolResult（否则所有已终止的后台 agent——
   * 包括 `lost` 的——都会被标记为 `✓ Completed`）。
   *
   * 解析策略：`args.agentId` 被视为权威来源——我们查找 `getSubagentAgentId()` 返回
   * 相同 id 的卡片（实时前台的内存元数据、实时后台和回放卡片从 spawn-success 的
   * `agent_id: ...` 行解析），或者跳过。当提供了 `agentId` 时，我们故意不回退到
   * 描述匹配，因为：
   *   - 恢复时，`applyTerminalBackgroundAgentStatuses` 遍历每个已持久化的终态任务，
   *     包括那些工具调用落在 `REPLAY_TURN_LIMIT` 窗口之外的任务。描述回退会导致
   *     旧的 `lost` 任务将其状态附加到碰巧共享 `args.description` 的不相关近期
   *     Agent 卡片上。
   *   - 在实时 spawn / terminate 竞态中，同一卡片可能短暂同时出现在
   *     `_pendingToolComponents` 和 `transcriptContainer` 中，因此描述匹配可能
   *     两次访问同一组件并标记为模糊。agentId 匹配在首次命中时短路返回，不受此影响。
   *
   * 描述回退仅作为 `agentId` 未知时的尽力路径——即恢复预 PR 会话时，
   * 其磁盘记录早于 `agent_id` 持久化。
   *
   * 搜索范围包括进行中的组件和已挂载的卡片（一些独立存在于 `transcriptContainer` 中，
   * 其他被 `AgentGroupComponent` 借用，只能通过 `getToolComponents()` 访问）。
   *
   * 找到并更新了组件时返回 true。
   */
  applyBackgroundTaskTerminalStatus(args: {
    agentId?: string | undefined;
    description: string;
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
    /**
     * 在卡片上显示的真实失败消息。实时崩溃时传入 `subagent.failed` 事件的 `error`——
     * 比卡片回退使用的通用提示要有用得多。在恢复/终止路径中没有真实错误可用时省略。
     */
    errorText?: string | undefined;
  }): boolean {
    const useAgentIdOnly = args.agentId !== undefined;
    let agentIdMatch: ToolCallComponent | undefined;
    let descMatch: ToolCallComponent | undefined;
    let descAmbiguous = false;
    const visit = (tc: ToolCallComponent): void => {
      if (agentIdMatch !== undefined) return;
      if (useAgentIdOnly) {
        if (tc.getSubagentAgentId() === args.agentId) agentIdMatch = tc;
        return;
      }
      if (tc.getAgentToolDescription() !== args.description) return;
      if (descMatch !== undefined) {
        descAmbiguous = true;
        return;
      }
      descMatch = tc;
    };

    for (const tc of this._pendingToolComponents.values()) {
      visit(tc);
      if (agentIdMatch !== undefined) break;
    }
    if (agentIdMatch === undefined) {
      for (const child of this.host.state.transcriptContainer.children) {
        if (child instanceof ToolCallComponent) {
          visit(child);
        } else if (child instanceof AgentGroupComponent) {
          for (const tc of child.getToolComponents()) {
            visit(tc);
            if (agentIdMatch !== undefined) break;
          }
        }
        if (agentIdMatch !== undefined) break;
      }
    }
    const target = useAgentIdOnly
      ? agentIdMatch
      : descAmbiguous
        ? undefined
        : descMatch;
    if (target === undefined) return false;
    target.setBackgroundTaskTerminalStatus(args.status, { errorText: args.errorText });
    return true;
  }

  /** 注册通过 tool.call.started 到达的工具调用。
   *  清除此 id 的待处理流式状态，更新或创建组件，返回该调用是否为新的（无先前记录）。 */
  registerToolCall(toolCall: ToolCallBlockData): boolean {
    const existing = this._activeToolCalls.get(toolCall.id);
    this._activeToolCalls.set(toolCall.id, toolCall);
    this.pendingToolCallFlushIds.delete(toolCall.id);
    this._streamingToolCallArguments.delete(toolCall.id);
    const existingComponent = this._pendingToolComponents.get(toolCall.id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (existing === undefined) {
      this.finalizeLiveTextBuffers('tool');
      if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
        this.onToolCallStart(toolCall);
      }
    }
    return existing === undefined;
  }

  /** 累积流式工具调用参数增量。 */
  accumulateToolCallDelta(
    id: string,
    eventName: string | undefined,
    argumentsPart: string | null | undefined,
  ): void {
    const existing = this._streamingToolCallArguments.get(id);
    const argumentsText = appendStreamingArgsPreview(existing?.argumentsText, argumentsPart);
    const name = eventName ?? existing?.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool';
    const startedAtMs = existing?.startedAtMs ?? Date.now();
    this._streamingToolCallArguments.set(id, { name, argumentsText, startedAtMs });
    this.pendingToolCallFlushIds.add(id);
  }

  getStreamingToolCallPreview(
    id: string,
  ): { name: string; args: Record<string, unknown>; argumentsText: string; startedAtMs: number } | undefined {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return undefined;
    return {
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      argumentsText: streaming.argumentsText,
      startedAtMs: streaming.startedAtMs,
    };
  }

  /** 完成工具调用：交付结果并移除跟踪状态。
   *  返回匹配的 ToolCallBlockData，如果没有跟踪到调用则返回 undefined。 */
  completeToolResult(toolCallId: string, result: ToolResultBlockData): ToolCallBlockData | undefined {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    if (matchedCall !== undefined) {
      this.onToolCallEnd(toolCallId, result);
    }
    this._activeToolCalls.delete(toolCallId);
    this._streamingToolCallArguments.delete(toolCallId);
    return matchedCall;
  }

  /** 当步骤触发 max_tokens 时，将进行中的工具调用标记为截断。
   *  返回被截断的工具调用数量。 */
  markStepTruncated(turnId: string, step: number): number {
    let count = 0;
    for (const toolCall of this._activeToolCalls.values()) {
      if (toolCall.result !== undefined) continue;
      if (toolCall.streamingArguments === undefined) continue;
      if (toolCall.turnId !== turnId) continue;
      if (toolCall.step !== step) continue;
      toolCall.truncated = true;
      const component = this._pendingToolComponents.get(toolCall.id);
      if (component !== undefined) {
        component.updateToolCall(toolCall);
      }
      count += 1;
    }
    this._streamingToolCallArguments.clear();
    return count;
  }

  /** 会话历史渲染完成后，清理回放相关的状态。 */
  cleanupAfterReplay(completedToolCallIds: Set<string>): void {
    this._activeToolCalls.clear();
    for (const toolCallId of completedToolCallIds) {
      this._pendingToolComponents.delete(toolCallId);
    }
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this._currentTurnId = undefined;
    this._currentStep = 0;
    this._streamingToolCallArguments.clear();
    this.pendingToolCallFlushIds.clear();
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // 资源释放辅助方法（从 KimiTUI 迁移而来）
  // ---------------------------------------------------------------------------

  disposeActiveThinkingComponent(): void {
    if (this._activeThinkingComponent !== undefined) {
      this._activeThinkingComponent.dispose();
      this._activeThinkingComponent = undefined;
    }
  }

  disposeAndClearPendingToolComponents(): void {
    for (const component of this._pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this._pendingToolComponents.clear();
  }

  disposeActiveCompactionBlock(): void {
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.dispose();
      this._activeCompactionBlock = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // 刷新控制
  // ---------------------------------------------------------------------------

  hasPending(): boolean {
    return (
      this.pendingAssistantFlush ||
      this.pendingThinkingFlush ||
      this.pendingToolCallFlushIds.size > 0
    );
  }

  clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearFlushTimerIfIdle(): void {
    if (this.hasPending()) return;
    this.clearFlushTimer();
  }

  discardPending(): void {
    this.clearFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlushIds.clear();
  }

  scheduleFlush(): void {
    if (!this.hasPending()) return;
    if (this.flushTimer !== undefined) return;
    const delay =
      this.lastFlushAt === undefined
        ? 0
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  flushNow(): void {
    this.clearFlushTimer();
    this.flush();
  }

  private flush(): void {
    if (!this.hasPending()) return;
    this.lastFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    const toolCallIds = [...this.pendingToolCallFlushIds];
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;
    this.pendingToolCallFlushIds.clear();

    if (shouldFlushThinking && this._thinkingDraft.length > 0) {
      this.onThinkingUpdate(this._thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this._assistantDraft);
    }
    for (const id of toolCallIds) {
      this.flushToolCallPreview(id);
    }
  }

  markAssistantDirty(): void {
    this.pendingAssistantFlush = true;
  }

  markThinkingDirty(): void {
    this.pendingThinkingFlush = true;
  }

  // ---------------------------------------------------------------------------
  // 文本流式传输
  // ---------------------------------------------------------------------------

  flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushNow();
    this._thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this._streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this._assistantDraft = '';
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this._assistantDraft = '';
    this._streamingBlock = null;
    this._thinkingDraft = '';
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this._streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
  }

  resetToolCallState(): void {
    this._activeToolCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    const { state } = this.host;
    if (state.appState.streamingPhase === 'idle') return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      this._currentTurnId ?? `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    this.resetToolCallState();
    this._currentTurnId = undefined;

    const next = this.host.shiftQueuedMessage();
    if (next !== undefined) {
      this.host.setAppState({ streamingPhase: 'idle' });
      this.host.resetLivePane();
      setTimeout(() => {
        sendQueued(next);
      }, 0);
      return;
    }

    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    notifyTerminalOnce(state, `turn-complete:${completedTurnKey}`, {
      title: 'Kimi Code task complete',
      body: state.appState.sessionTitle ?? undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // 实时渲染钩子
  // ---------------------------------------------------------------------------

  onStreamingTextStart(): void {
    const { state } = this.host;
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: this._currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
    };
    const component = new AssistantMessageComponent();
    this._streamingBlock = { component, entry };
    this.host.pushTranscriptEntry(entry);
    state.transcriptContainer.addChild(component);
    state.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.entry.content = fullText;
      block.component.updateContent(fullText);
      this.host.state.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    this._streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    if (fullText.length === 0 && this._activeThinkingComponent === undefined) return;
    const { state } = this.host;
    if (this._activeThinkingComponent === undefined) {
      this._pendingAgentGroup = null;
      this._pendingReadGroup = null;
      this._activeThinkingComponent = new ThinkingComponent(
        fullText,
        true,
        'live',
        state.ui,
      );
      if (state.toolOutputExpanded) this._activeThinkingComponent.setExpanded(true);
      state.transcriptContainer.addChild(this._activeThinkingComponent);
    } else {
      this._activeThinkingComponent.setText(fullText);
    }
    state.ui.requestRender();
  }

  onThinkingEnd(): void {
    if (this._activeThinkingComponent === undefined) return;
    this._activeThinkingComponent.finalize();
    this._activeThinkingComponent = undefined;
    this.host.state.ui.requestRender();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const { state } = this.host;
    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      state.ui,
      state.appState.workDir,
    );
    if (state.toolOutputExpanded) tc.setExpanded(true);
    this._pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Agent') this._pendingAgentGroup = null;
    if (toolCall.name !== 'Read') this._pendingReadGroup = null;

    let handled = this.tryAttachAgentToolCall(toolCall, tc);
    if (!handled) handled = this.tryAttachReadToolCall(toolCall, tc);
    if (!handled) {
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
    }

    if (toolCall.name === 'ExitPlanMode' && typeof toolCall.args['plan'] !== 'string') {
      const session = this.host.requireSession();
      void (async () => {
        try {
          const plan = await session.getPlan();
          tc.setPlanInfo(plan === null ? {} : { plan: plan.content, path: plan.path });
        } catch {
          tc.setPlanInfo({});
        }
      })();
    }
  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const { state } = this.host;
    const matchedCall = this._activeToolCalls.get(toolCallId);
    const tc = this._pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this._pendingToolComponents.delete(toolCallId);
      state.ui.requestRender();
      return;
    }

    if (matchedCall?.name === 'AskUserQuestion') {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        state.ui,
        state.appState.workDir,
      );
      if (state.toolOutputExpanded) completed.setExpanded(true);
      state.transcriptContainer.addChild(completed);
      state.ui.requestRender();
    }
  }

  setTodoList(todos: readonly TodoItem[]): void {
    const { state } = this.host;
    state.todoPanel.setTodos(todos);
    state.todoPanelContainer.clear();
    if (!state.todoPanel.isEmpty()) {
      state.todoPanelContainer.addChild(state.todoPanel);
    }
    state.ui.requestRender();
  }

  beginCompaction(instruction?: string): void {
    const { state } = this.host;
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.markDone();
      this._activeCompactionBlock = undefined;
    }
    const block = new CompactionComponent(state.ui, instruction);
    this._activeCompactionBlock = block;
    state.transcriptContainer.addChild(block);
    state.ui.requestRender();
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter);
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  cancelCompaction(): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // 工具调用分组
  // ---------------------------------------------------------------------------

  private flushToolCallPreview(id: string): void {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this._currentStep,
      turnId: this._currentTurnId,
    };
    this._activeToolCalls.set(id, toolCall);

    if (this._thinkingDraft.length > 0 || this._streamingBlock !== null) {
      this.finalizeLiveTextBuffers('tool');
    }

    const existingComponent = this._pendingToolComponents.get(id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
      this.onToolCallStart(toolCall);
    }
  }

  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Agent') {
      this._pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingAgentGroup = null;
    }

    const cur = this._pendingAgentGroup;
    if (cur === null) {
      this._pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingAgentGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloAgentToGroup(solo: ToolCallComponent): AgentGroupComponent {
    const { state } = this.host;
    const group = new AgentGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
      state.transcriptContainer.invalidate();
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }

  private tryAttachReadToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Read') {
      this._pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingReadGroup = null;
    }

    const cur = this._pendingReadGroup;
    if (cur === null) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingReadGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const { state } = this.host;
    const group = new ReadGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
      state.transcriptContainer.invalidate();
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }
}

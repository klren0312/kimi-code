/**
 * AgentGroupComponent 将同一步骤中的 2 个以上 Agent 工具调用渲染为一组。
 *
 * 设计要点：
 * - 状态容器：每个子 Agent 的真实状态保存在其 `ToolCallComponent` 中
 *   （子代理元数据、阶段、子工具调用、token 数、文本）。AgentGroup 仅
 *   存储引用，不复制状态。事件处理器仍通过
 *   `state.pendingToolComponents.get(parent_tool_call_id)` 路由。
 * - 订阅：`attach` 在每个子节点上注册快照监听器，以便子节点状态变化时
 *   组可以刷新。
 * - 节流：普通变更每 200ms 合并为一次渲染。
 *   阶段转换（spawning -> running -> done/failed）立即刷新。
 * - 挂载：`KimiTUI` 在合适的时机将组附加到对话记录；组负责 `invalidate`
 *   和 `ui.requestRender`。
 * - 取消分组暂未实现。一旦组建成，将始终保持分组状态。
 */

import type { TUI } from '@earendil-works/pi-tui';
import { Container, Spacer, Text } from '@earendil-works/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import type { ToolCallComponent, ToolCallSubagentSnapshot } from './tool-call';

const THROTTLE_MS = 200;

interface AgentEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

interface PhaseCounts {
  readonly done: number;
  readonly failed: number;
  readonly backgrounded: number;
  readonly running: number;
  readonly waiting: number;
  readonly starting: number;
  readonly terminal: number;
}

export class AgentGroupComponent extends Container {
  private readonly entries: AgentEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallSubagentSnapshot['phase']>();
  private _invalidating = false;

  constructor(private readonly ui: TUI | undefined) {
    super();
    this.addChild(new Spacer(1));
    this.headerText = new Text('', 0, 0);
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
  }

  size(): number {
    return this.entries.length;
  }

  /**
   * 暴露借入的工具调用组件，以便外部代码（例如将后台任务终端事件路由回
   * 对应的 Agent 卡片）可以访问它们——组渲染这些 tc 的快照但从不将 tc
   * 挂载为 Container 子节点，因此仅通过 `transcriptContainer` 的普通
   * 树遍历无法发现它们。
   */
  getToolComponents(): readonly ToolCallComponent[] {
    return this.entries.map((entry) => entry.tc);
  }

  /**
   * 将独立的 `ToolCallComponent` 作为隐藏状态容器借入组内。
   * 快照变化会触发节流刷新。重复附加相同的 toolCallId 不会产生效果。
   */
  attach(toolCallId: string, tc: ToolCallComponent): void {
    if (this.entries.some((e) => e.toolCallId === toolCallId)) return;
    this.entries.push({ toolCallId, tc });
    tc.setSnapshotListener(() => {
      this.scheduleRender();
    });
    this.flushRender();
  }

  /**
   * 安排重绘。真正的阶段转换强制立即刷新；
   * latestActivity、tokens、toolCount 等其他变更则进行节流。
   */
  private scheduleRender(): void {
    if (this.detectPhaseTransition()) {
      this.flushRender();
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flushRender();
    }, THROTTLE_MS);
  }

  /**
   * 比较每个子节点的当前阶段与上次刷新时记录的阶段。
   * 任何变化均视为阶段转换。
   */
  private detectPhaseTransition(): boolean {
    let changed = false;
    for (const e of this.entries) {
      const phase = e.tc.getSubagentSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) {
        changed = true;
        break;
      }
    }
    return changed;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const snapshots = this.entries.map((e) => e.tc.getSubagentSnapshot());
    this.headerText.setText(this.buildHeader(snapshots));
    this.bodyContainer.clear();
    snapshots.forEach((snap, idx) => {
      const isLast = idx === snapshots.length - 1;
      this.appendLines(snap, isLast);
    });

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(snapshots: readonly ToolCallSubagentSnapshot[]): string {
    const total = snapshots.length;
    const counts = countPhases(snapshots);
    const allDone = counts.terminal === total;
    const bullet = allDone
      ? currentTheme.fg('success', STATUS_BULLET)
      : currentTheme.fg('text', STATUS_BULLET);
    const elapsedSeconds = maxElapsedSeconds(snapshots);

    if (allDone) {
      const types = new Set(snapshots.map((s) => s.agentName).filter((n) => n !== undefined));
      const headerLabel =
        types.size === 1
          ? `${String(total)} ${[...types][0]} agents finished`
          : `${String(total)} agents finished`;
      const totalTools = snapshots.reduce((acc, s) => acc + s.toolCount, 0);
      const totalTokens = snapshots.reduce((acc, s) => acc + s.tokens, 0);
      const tail = formatHeaderTail({ toolCount: totalTools, tokens: totalTokens, elapsedSeconds });
      return `${bullet}${currentTheme.boldFg('primary', headerLabel)}${tail}`;
    }

    const parts = formatBreakdownParts(counts);
    const headerText = parts.length > 0
      ? `Running ${String(total)} agents (${parts.join(', ')})`
      : `Running ${String(total)} agents`;
    const tail = formatHeaderTail({ toolCount: 0, tokens: 0, elapsedSeconds });
    return `${bullet}${currentTheme.boldFg('primary', headerText)}${tail}`;
  }

  private appendLines(snap: ToolCallSubagentSnapshot, isLast: boolean): void {
    const dim = (text: string) => currentTheme.dim(text);

    // 一级分支线。
    const branch1 = isLast ? '└─' : '├─';
    const agentType = snap.agentName ?? 'agent';
    const desc = snap.toolCallDescription || '(no description)';
    const tail = formatLineTail(snap);
    const namePart = currentTheme.fg('primary', agentType);
    const descPart = dim(`· ${desc}`);
    const stats = formatStats(snap);
    const line1 = `  ${branch1} ${namePart} ${descPart}${stats}${tail}`;
    this.bodyContainer.addChild(new Text(line1, 0, 0));

    // 二级行：最新活动，或失败时显示错误信息。
    const branch2 = isLast ? '   ' : '│  ';
    if (snap.phase === 'failed') {
      // 显示一行错误信息；错误消息可能很长。
      const errLine = (snap.errorText ?? 'Failed').split('\n').at(0) ?? 'Failed';
      const errStr = currentTheme.fg('error', `Error: ${errLine}`);
      this.bodyContainer.addChild(new Text(`  ${branch2}    ${errStr}`, 0, 0));
      return;
    }
    if (snap.phase === 'done' || snap.phase === 'backgrounded') {
      // 终止状态省略第二行。
      return;
    }
    // 运行中或尚未启动的代理显示最新活动，带有回退值。
    const activity = snap.latestActivity ?? fallbackActivityForPhase(snap.phase);
    this.bodyContainer.addChild(new Text(`  ${branch2}    ${dim(activity)}`, 0, 0));
  }

  /** 释放节流定时器，防止已销毁的组件稍后触发刷新。 */
  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    for (const e of this.entries) {
      e.tc.setSnapshotListener(undefined);
    }
  }
}

function countPhases(snapshots: readonly ToolCallSubagentSnapshot[]): PhaseCounts {
  let done = 0;
  let failed = 0;
  let backgrounded = 0;
  let running = 0;
  let waiting = 0;
  let starting = 0;

  for (const snap of snapshots) {
    switch (snap.phase) {
      case 'done':
        done += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'backgrounded':
        backgrounded += 1;
        break;
      case 'queued':
        waiting += 1;
        break;
      case 'running':
        running += 1;
        break;
      case 'spawning':
      case undefined:
        starting += 1;
        break;
    }
  }

  return {
    done,
    failed,
    backgrounded,
    running,
    waiting,
    starting,
    terminal: done + failed + backgrounded,
  };
}

function formatBreakdownParts(counts: PhaseCounts): string[] {
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${String(counts.done)} done`);
  if (counts.failed > 0) parts.push(`${String(counts.failed)} failed`);
  if (counts.backgrounded > 0) parts.push(`${String(counts.backgrounded)} backgrounded`);
  if (counts.running > 0) parts.push(`${String(counts.running)} running`);
  if (counts.waiting > 0) parts.push(`${String(counts.waiting)} waiting`);
  if (counts.starting > 0) parts.push(`${String(counts.starting)} starting`);
  return parts;
}

function formatStats(snap: ToolCallSubagentSnapshot): string {
  const parts = [`${String(snap.toolCount)} tool${snap.toolCount === 1 ? '' : 's'}`];
  if (snap.elapsedSeconds !== undefined) parts.push(formatElapsed(snap.elapsedSeconds));
  if (snap.tokens > 0) parts.push(formatTokens(snap.tokens));
  return currentTheme.dim(` · ${parts.join(' · ')}`);
}

function formatLineTail(snap: ToolCallSubagentSnapshot): string {
  const separator = currentTheme.dim(' · ');
  switch (snap.phase) {
    case 'done':
      return separator + currentTheme.fg('success', '✓ Completed');
    case 'failed':
      return separator + currentTheme.fg('error', '✗ Failed');
    case 'backgrounded':
      return separator + currentTheme.dim('◐ backgrounded');
    case 'queued':
      return separator + currentTheme.fg('primary', 'Waiting');
    case 'running':
      return separator + currentTheme.fg('primary', 'Running');
    case 'spawning':
    case undefined:
      return separator + currentTheme.fg('primary', 'Starting');
  }
}

function fallbackActivityForPhase(phase: ToolCallSubagentSnapshot['phase']): string {
  switch (phase) {
    case 'queued':
      return 'Waiting to start…';
    case 'running':
      return 'Still working…';
    case 'spawning':
    case undefined:
      return 'Starting…';
    case 'done':
    case 'failed':
    case 'backgrounded':
      return '';
  }
}

function formatHeaderTail(args: {
  readonly toolCount: number;
  readonly tokens: number;
  readonly elapsedSeconds: number | undefined;
}): string {
  const parts: string[] = [];
  if (args.toolCount > 0) parts.push(`${String(args.toolCount)} tool${args.toolCount === 1 ? '' : 's'}`);
  if (args.tokens > 0) parts.push(formatTokens(args.tokens));
  if (args.elapsedSeconds !== undefined) parts.push(formatElapsed(args.elapsedSeconds));
  return parts.length > 0 ? currentTheme.dim(` · ${parts.join(' · ')}`) : '';
}

function maxElapsedSeconds(snapshots: readonly ToolCallSubagentSnapshot[]): number | undefined {
  let max: number | undefined;
  for (const snap of snapshots) {
    const elapsed = snap.elapsedSeconds;
    if (elapsed === undefined) continue;
    max = max === undefined ? elapsed : Math.max(max, elapsed);
  }
  return max;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${String(n)} tok`;
}

/**
 * 在转录中渲染工具调用条目。
 * 支持通过 Ctrl+O 展开/折叠。
 */

import { isAbsolute, relative, sep } from 'node:path';

import { Container, Spacer, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import {
  COMMAND_PREVIEW_LINES,
  RESULT_PREVIEW_LINES,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import {
  STREAMING_ARGS_FIELD_RE,
  STREAMING_ARGS_PREVIEW_MAX_CHARS,
} from '#/tui/constant/streaming';
import { FAILURE_MARK, STATUS_BULLET, SUCCESS_MARK } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';
import { appendStreamingArgsPreview } from '#/tui/utils/event-payload';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';

import { agentSwarmResultSummaryFromOutput } from './agent-swarm-progress';
import { PlanBoxComponent } from './plan-box';
import { ShellExecutionComponent } from './shell-execution';
import { countNonEmptyLines, pickChip } from './tool-renderers/chip';
import { buildGoalToolHeader } from './tool-renderers/goal';
import { isGenericToolResult, pickResultRenderer } from './tool-renderers/registry';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

const MAX_ARG_LENGTH = 60;
const MAX_SUB_TOOL_CALLS_SHOWN = 4;
const MAX_SINGLE_SUBAGENT_TOOL_ROWS = 4;
// 子工具预览输出的悬挂缩进，嵌套在其活动行下方。
const SUBAGENT_SUBTOOL_OUTPUT_INDENT = 6;
const APPROVED_PLAN_MARKER = '## Approved Plan:';
const STREAMING_PROGRESS_INTERVAL_MS = 1000;
const SUBAGENT_ELAPSED_INTERVAL_MS = 1000;
const PROGRESS_URL_RE = /https?:\/\/\S+/g;
const ABORTED_MARK = '⊘';
const MAX_LIVE_OUTPUT_CHARS = 50_000;

/** Delay before a long-running foreground Bash/Agent card advertises Ctrl+B. */
const DETACH_HINT_DELAY_MS = 10_000;
const DETACH_HINT_TEXT = 'Press Ctrl+B to run in background';

type SubagentTextKind = 'thinking' | 'text';
type SubagentPhase = 'queued' | 'spawning' | 'running' | 'done' | 'failed' | 'backgrounded';

interface FinishedSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
}

interface OngoingSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly streamingArguments?: string | undefined;
}

interface SubToolActivity {
  readonly id: string;
  name: string;
  args: Record<string, unknown>;
  phase: 'ongoing' | 'done' | 'failed';
  output?: string;
  readonly orderSeq: number;
}

/**
 * 不可变的子代理状态快照。`AgentGroupComponent` 通过
 * `ToolCallComponent.getSubagentSnapshot()` 读取一次性视图并渲染自身的分支行；
 * `onSnapshotChange` 在状态变化时通知它。
 *
 * `latestActivity` 优先级，仅在运行时使用：
 *   1. 最近的进行中子工具 (`Using {name} ({keyArg})`)
 *   2. 最近完成的子工具 (`Used {name} ({keyArg})`)
 *   3. 累积子代理文本的最后一行非空行
 */
export interface ToolCallSubagentSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolCallDescription: string;
  readonly agentName: string | undefined;
  readonly phase: SubagentPhase | undefined;
  readonly toolCount: number;
  readonly elapsedSeconds: number | undefined;
  readonly tokens: number;
  readonly isError: boolean;
  readonly errorText: string | undefined;
  readonly latestActivity: string | undefined;
}

/**
 * 不可变的 Read 工具状态快照。`ReadGroupComponent` 通过
 * `ToolCallComponent.getReadSnapshot()` 读取一次性视图并汇总行数用于组标题。
 * `lines` 在等待或失败时为 0，完成时为非空结果行数，与单卡片芯片一致。
 */
export interface ToolCallReadSnapshot {
  readonly toolCallId: string;
  readonly filePath: string | undefined;
  readonly phase: 'pending' | 'done' | 'failed';
  readonly lines: number;
}

function backgroundFailureMessage(
  status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost' | undefined,
): string | undefined {
  switch (status) {
    case 'lost':
      return 'Background agent lost (session restarted before completion)';
    case 'killed':
      return 'Background agent killed';
    case 'timed_out':
      return 'Background agent timed out';
    case 'failed':
      return 'Background agent failed';
    case 'completed':
    case undefined:
      return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function formatSubagentContextTokens(contextTokens: number | undefined): string | undefined {
  if (contextTokens === undefined || contextTokens <= 0) return undefined;
  const formatted = contextTokens >= 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : String(contextTokens);
  return `${formatted} tok`;
}

function usageInputTotal(usage: TokenUsage): number {
  return (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
}

function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usageInputTotal(usage) + usage.output;
}

function formatSubagentTokens(usage: TokenUsage | undefined): string | undefined {
  const total = usageTotal(usage);
  if (total <= 0) return undefined;
  const formatted = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  return `${formatted} tok`;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function extractApprovedPlan(output: string): string {
  const markerIndex = output.indexOf(APPROVED_PLAN_MARKER);
  if (markerIndex < 0) return '';
  return output.slice(markerIndex + APPROVED_PLAN_MARKER.length).trim();
}

interface ExitPlanModeOutcome {
  readonly kind: 'approved' | 'rejected';
  readonly chosen?: string;
  readonly feedback?: string;
  readonly path?: string;
}

const REJECT_PREFIX = 'User rejected the plan.';
const REJECT_FEEDBACK_PREFIX = 'User rejected the plan. Feedback:';
const APPROVED_OPTION_RE = /^User approved option "([^"]+)"\./;
const PLAN_REJECT_PREFIX = 'Plan rejected by user.';
const SELECTED_APPROACH_RE = /^Exited plan mode\. Selected approach: ([^\n]+)\n/;
const PLAN_SAVED_TO_RE = /\nPlan saved to: ([^\n]+)\n/;

/**
 * 解析 ExitPlanMode 结果内容字符串以恢复审批结果和可选的计划路径。
 * 核心端模板位于 `packages/agent-core/src/tools/builtin/planning/exit-plan-mode.ts`：
 *   - 批准输出以 'Exited plan mode.' 开头，选定选项报告为 'Selected approach: <label>'。
 *     旧版输出可能以 'User approved option "<label>".' 开头。计划文件模式可能包含
 *     'Plan saved to: <path>'。
 *   - 拒绝输出以 'Plan rejected by user.' 或旧版 'User rejected the plan.' 开头；
 *     反馈使用 'User rejected the plan. Feedback:\n\n<text>'。
 * 这是字符串协议而非结构化载荷。如果核心开始发出结构化事件载荷，应优先使用。
 */
function interpretExitPlanModeOutcome(output: string): ExitPlanModeOutcome {
  if (output.startsWith(REJECT_PREFIX)) {
    if (output.startsWith(REJECT_FEEDBACK_PREFIX)) {
      const feedback = output.slice(REJECT_FEEDBACK_PREFIX.length).trimStart();
      return { kind: 'rejected', feedback };
    }
    return { kind: 'rejected' };
  }
  if (output.startsWith(PLAN_REJECT_PREFIX)) {
    return { kind: 'rejected' };
  }
  const pathMatch = PLAN_SAVED_TO_RE.exec(output);
  const path = pathMatch?.[1]?.trim();
  const optionMatch = SELECTED_APPROACH_RE.exec(output) ?? APPROVED_OPTION_RE.exec(output);
  if (optionMatch !== null) {
    return path !== undefined && path.length > 0
      ? { kind: 'approved', chosen: optionMatch[1], path }
      : { kind: 'approved', chosen: optionMatch[1] };
  }
  return path !== undefined && path.length > 0 ? { kind: 'approved', path } : { kind: 'approved' };
}

function isExitPlanModeOutcomeOutput(output: string): boolean {
  return (
    output.startsWith(REJECT_PREFIX) ||
    output.startsWith(PLAN_REJECT_PREFIX) ||
    output.startsWith('Exited plan mode.') ||
    APPROVED_OPTION_RE.test(output) ||
    output.includes(APPROVED_PLAN_MARKER)
  );
}

function unescapeJsonString(s: string): string {
  return s.replaceAll(/\\(["\\/bfnrt])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      default:
        return ch;
    }
  });
}

/**
 * 从部分流式传输的参数中提取 JSON 字符串字段的实时值，
 * 即使关闭引号尚未到达也能提取。处理常见的 JSON 字符串转义，
 * 使流式 `content` 中的 `\n` 变成可以高亮的真实换行符。
 * 如果字段尚未开始流式传输，返回 `undefined`。
 */
function extractPartialStringField(text: string, key: string): string | undefined {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = opener.exec(text);
  if (match === null) return undefined;
  const start = match.index + match[0].length;
  let out = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return out;
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'u': {
          if (i + 5 >= text.length) return out;
          const hex = text.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          if (Number.isNaN(code)) return out;
          out += String.fromCodePoint(code);
          i += 6;
          continue;
        }
        default:
          out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i++;
  }
  return out;
}

function parseArgsPreview(value: string): Record<string, unknown> {
  const previewText = value.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  if (previewText.trim().length === 0) return {};
  if (
    value.length <= STREAMING_ARGS_PREVIEW_MAX_CHARS &&
    previewText.trimEnd().endsWith('}')
  ) {
    try {
      const parsed = JSON.parse(previewText) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 跳转到部分扫描
    }
  }
  const result: Record<string, unknown> = {};
  for (const match of previewText.matchAll(STREAMING_ARGS_FIELD_RE)) {
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    if (!(key in result)) result[key] = unescapeJsonString(rawValue);
  }
  return result;
}

const PATH_KEYS = new Set(['path', 'file_path']);

function truncateArgValue(key: string, value: string): string {
  if (value.length <= MAX_ARG_LENGTH) return value;
  if (PATH_KEYS.has(key)) {
    // 保留尾部（文件名）——丢弃前缀，让用户仍能识别正在操作的文件。
    return '…' + value.slice(value.length - (MAX_ARG_LENGTH - 1));
  }
  return value.slice(0, MAX_ARG_LENGTH - 3) + '...';
}

function makeWorkspaceRelativePath(filePath: string, workspaceDir: string | undefined): string {
  if (workspaceDir === undefined || workspaceDir.length === 0 || !isAbsolute(filePath)) {
    return filePath;
  }
  const relativePath = relative(workspaceDir, filePath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return filePath;
  }
  return relativePath;
}

function formatKeyArgument(
  toolName: string,
  key: string,
  value: string,
  workspaceDir: string | undefined,
): string {
  const displayValue =
    toolName === 'Read' && PATH_KEYS.has(key)
      ? makeWorkspaceRelativePath(value, workspaceDir)
      : value;
  return truncateArgValue(key, displayValue);
}

function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const keyMap: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
    // 优先使用短的 `description`，避免头部预览将多行 `prompt` 溢出到 TUI 界面中。
    Agent: ['description', 'prompt'],
  };

  // Glob：将多个参数拼接为单个摘要，使头部显示 pattern、可选的显式路径和 include_dirs 覆盖。
  if (toolName === 'Glob') {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0) return null;
    let summary = pattern;
    const path = args['path'];
    if (typeof path === 'string' && path.length > 0) {
      summary += ` · ${makeWorkspaceRelativePath(path, workspaceDir)}`;
    }
    if (args['include_dirs'] === false) {
      summary += ' · no dirs';
    }
    return truncateArgValue('pattern', summary);
  }

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      const displayValue =
        toolName === 'Bash' && val.includes('\n') ? `${firstLine}…` : firstLine;
      return formatKeyArgument(toolName, key, displayValue, workspaceDir);
    }
  }
  return null;
}

function formatSubagentLabel(agentName: string | undefined): string {
  const raw = agentName?.trim();
  if (raw === undefined || raw.length === 0) return 'SubAgent';
  const label = raw
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  if (/\bagent$/i.test(label)) return label;
  return `${label} Agent`;
}

function tailNonEmptyLines(text: string, maxLines: number): string[] {
  if (text.length === 0) return [];
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines);
}

class PrefixedWrappedLine implements Component {
  constructor(
    private readonly firstPrefix: string,
    private readonly continuationPrefix: string,
    private readonly text: string,
    // 设置后，仅保留最后 N 行包装后的显示行，使长段落在固定窗口内滚动
    // 而非无限增长。保留的第一行仍使用 `firstPrefix`。
    private readonly tailLines?: number,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const prefixWidth = Math.max(
      visibleWidth(this.firstPrefix),
      visibleWidth(this.continuationPrefix),
    );
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const wrapped = new Text(this.text, 0, 0).render(contentWidth);
    const lines =
      this.tailLines !== undefined && wrapped.length > this.tailLines
        ? wrapped.slice(wrapped.length - this.tailLines)
        : wrapped;
    return lines
      .map((line, index) =>
        index === 0 ? `${this.firstPrefix}${line}` : `${this.continuationPrefix}${line}`,
      )
      .map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}

export class ToolCallComponent extends Container {
  private expanded = false;
  private toolCall: ToolCallBlockData;
  private readonly markdownTheme = createMarkdownTheme();
  private result: ToolResultBlockData | undefined;
  private ui: TUI | undefined;
  private planPath: string | undefined;
  /**
   * 当 LLM 使用计划文件模式且 `args.plan` 为空时的回退计划正文。
   * `KimiTUI` 使用 `session.getPlan()` 的内容调用 `setPlanInfo`，
   * 使计划框在审批待定期间可以渲染，且被拒绝或修改的结果仍能显示
   * 计划正文，即使没有 `## Approved Plan:` 标记。
   */
  private currentPlan: string | undefined;
  private headerText: Text;
  private callPreviewEndIndex = 0;

  // ── 子代理状态 ───────────────────────────────────────────────
  //
  // 当 KimiTUI 路由的 `subagent.event` 以此工具调用 id 作为其
  // `parent_tool_call_id` 时，由 `setSubagentMeta` / `appendSubToolCall` / `finishSubToolCall` 填充。
  // 渲染在 buildContent 的末尾，因此在流式传输期间和父工具调用解析后都会显示。
  private subagentAgentId: string | undefined;
  private subagentAgentName: string | undefined;
  private readonly ongoingSubCalls = new Map<string, OngoingSubCall>();
  private readonly finishedSubCalls: FinishedSubCall[] = [];
  private readonly subToolActivities = new Map<string, SubToolActivity>();
  private subToolOrderSeq = 0;
  private hiddenSubCallCount = 0;
  /**
   * 来自子代理的最近正常输出行。历史回放也可以在此存储混合文本。
   */
  private subagentText = '';
  private subagentThinkingText = '';
  // ── 来自 subagent.spawned/started/completed/failed 的子代理生命周期状态 ──
  private subagentPhase: SubagentPhase | undefined;
  /**
   * Distinguishes a foreground subagent that the user detached via Ctrl+B from
   * one that started in the background. Both set `subagentPhase = 'backgrounded'`,
   * but only the detached one should keep showing `◐ backgrounded` after its
   * spawn-success ToolResult lands — a started-in-background agent reads as
   * `done` once its result arrives.
   */
  private detachedFromForeground = false;
  /**
   * Authoritative terminal phase for a backgrounded subagent. Set from
   * `BackgroundTaskInfo.status` via `setBackgroundTaskTerminalStatus` once
   * the backing task reaches a terminal state — either live (a bg agent
   * fails / is killed) or on resume (reconcile reclassifies a still-running
   * task as `lost`). Beats the spawn-success ToolResult in both render
   * paths (`getDerivedSubagentPhase` for standalone, `getSubagentSnapshot`
   * for grouped), which would otherwise mislabel every terminated
   * background agent — including lost ones — as `✓ Completed`.
   */
  private backgroundTaskTerminalPhase: 'done' | 'failed' | undefined;
  private subagentContextTokens: number | undefined;
  private subagentUsage: TokenUsage | undefined;
  private subagentResultSummary: string | undefined;
  private subagentError: string | undefined;
  private streamingProgressTimer: ReturnType<typeof setInterval> | undefined;
  private subagentElapsedTimer: ReturnType<typeof setInterval> | undefined;
  private subagentStartedAtMs: number | undefined;
  private subagentEndedAtMs: number | undefined;

  // ── 实时进度行 ──────────────────────────────────────────
  //
  // 当工具在运行期间发出 `onUpdate({kind:'status', text})` 时由
  // `appendProgress` 填充。用于长时间阻塞的工具（例如 MCP `authenticate`
  // 合成工具，其 15 分钟的浏览器等待否则只会显示旋转指示器）。
  // 当结果到达时清除——结果是权威的最终状态。
  private progressLines: string[] = [];
  private static readonly MAX_PROGRESS_LINES = 24;
  private liveOutput = '';

  /**
   * Advertises `Ctrl+B` on a foreground Bash/Agent card that has been running
   * for {@link DETACH_HINT_DELAY_MS}. Cleared when the result lands.
   */
  private detachHintTimer: ReturnType<typeof setTimeout> | undefined;
  private detachHintVisible = false;

  /**
   * Registered by a group container (`AgentGroupComponent` or
   * `ReadGroupComponent`) when this component is borrowed as a hidden state
   * container. Any state change (subagent meta, phase, sub-tool, result, etc.)
   * triggers a throttled group re-render. `undefined` means no group is
   * subscribed and standalone rendering is unaffected. A ToolCallComponent can
   * only belong to one group at a time, so one listener slot is enough.
   */
  private onSnapshotChange: (() => void) | undefined;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    ui?: TUI,
    private readonly workspaceDir?: string,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = result;
    this.ui = ui;
    this.applySubagentReplay(toolCall.subagent);

    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.buildSubagentBlock();
    this.syncStreamingProgressTimer();
    this.syncSubagentElapsedTimer();
    this.startDetachHintTimer();
  }

  override invalidate(): void {
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    super.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    // rebuildBody（而非 rebuildContent），使参数驱动的调用预览
    // ——即承载 Write 内容 / Edit diff 的部分——使用新的行数上限重新渲染。
    // rebuildContent 只处理结果驱动的子项，会使调用预览卡在初始的折叠大小。
    this.rebuildBody();
  }

  setResult(result: ToolResultBlockData): void {
    this.result = result;
    // 结果取代任何实时进度信息；结果主体是权威的最终状态。
    // 如果不清除，已完成的工具会同时显示流式状态行和最终输出。
    this.progressLines = [];
    this.liveOutput = '';
    this.detachHintVisible = false;
    this.stopDetachHintTimer();
    this.finalizeSubagentElapsedIfNeeded();
    this.syncStreamingProgressTimer();
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    // rebuildBody（而非 rebuildContent），使调用预览在结果到达时
    // 使用折叠上限重新渲染——Write 流式预览和 Edit 的进度占位符
    // 需要在结果到达时切换到最终预览。
    this.rebuildBody();
    // 最终结果影响组摘要，特别是失败/完成计数。
    this.notifySnapshotChange();
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
    this.syncStreamingProgressTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * 追加工具通过 `onUpdate({kind:'status', text})` 发出的实时进度行。
   * 按换行符拆分，使多行状态载荷逐行渲染。当缓冲区超过
   * {@link ToolCallComponent.MAX_PROGRESS_LINES} 时丢弃旧行，
   * 防止行为异常的工具无限增长显示区域。
   */
  appendProgress(text: string): void {
    if (this.result !== undefined) return;
    for (const line of text.split('\n')) {
      this.progressLines.push(line);
    }
    while (this.progressLines.length > ToolCallComponent.MAX_PROGRESS_LINES) {
      this.progressLines.shift();
    }
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendLiveOutput(text: string): void {
    if (this.result !== undefined || text.length === 0) return;
    this.liveOutput += text;
    if (this.liveOutput.length > MAX_LIVE_OUTPUT_CHARS) {
      this.liveOutput = `[...truncated]\n${this.liveOutput.slice(
        this.liveOutput.length - MAX_LIVE_OUTPUT_CHARS,
      )}`;
    }
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopStreamingProgressTimer();
    this.stopSubagentElapsedTimer();
    this.stopDetachHintTimer();
  }

  /**
   * 异步注入计划正文/路径。仅 ExitPlanMode 卡片使用此方法：
   * 计划文件模式使 `args.plan` 为空，因此 `KimiTUI` 通过
   * `session.getPlan()` 获取计划并调用此方法渲染计划框。
   */
  setPlanInfo(info: { plan?: string; path?: string }): void {
    if (this.toolCall.name !== 'ExitPlanMode') return;
    let changed = false;
    if (info.plan !== undefined && info.plan.length > 0 && this.currentPlan !== info.plan) {
      this.currentPlan = info.plan;
      changed = true;
    }
    if (info.path !== undefined && info.path.length > 0 && this.planPath !== info.path) {
      this.planPath = info.path;
      changed = true;
    }
    if (!changed) return;
    this.rebuildBody();
    this.ui?.requestRender();
  }

  private applySubagentReplay(subagent: ToolCallBlockData['subagent']): void {
    if (subagent === undefined) return;
    this.subagentAgentId = subagent.id;
    this.subagentAgentName = subagent.name;
    this.subagentText = subagent.text ?? '';
    for (const call of subagent.toolCalls ?? []) {
      if (call.result === undefined) {
        this.ongoingSubCalls.set(call.id, { name: call.name, args: call.args });
        this.upsertSubToolActivity(call.id, call.name, call.args, 'ongoing');
        continue;
      }
      this.finishedSubCalls.push({
        name: call.name,
        args: call.args,
        output: call.result.output,
        isError: call.result.is_error ?? false,
      });
      this.upsertSubToolActivity(
        call.id,
        call.name,
        call.args,
        call.result.is_error === true ? 'failed' : 'done',
        call.result.output,
      );
    }
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
  }

  // ── 子代理 API（由 KimiTUI 事件路由调用）───────────────

  setSubagentMeta(agentId: string, agentName?: string): void {
    if (this.subagentAgentId === agentId && this.subagentAgentName === agentName) return;
    this.subagentAgentId = agentId;
    this.subagentAgentName = agentName;
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * 允许组容器（AgentGroup 或 ReadGroup）订阅此卡片的状态变化。
   * 注册时立即回调，使组无需单独调用 getSubagentSnapshot 或
   * getReadSnapshot 即可接收当前快照。传入 `undefined` 取消订阅。
   */
  setSnapshotListener(cb: (() => void) | undefined): void {
    this.onSnapshotChange = cb;
    if (cb !== undefined) cb();
  }

  getSubagentSnapshot(): ToolCallSubagentSnapshot {
    const finished = this.finishedSubCalls.length + this.hiddenSubCallCount;
    const contextTokens = this.subagentContextTokens;
    const tokens =
      contextTokens && contextTokens > 0
        ? contextTokens
        : (this.subagentUsage === undefined ? 0 : usageTotal(this.subagentUsage));
    const latestActivity = computeLatestActivity(
      this.ongoingSubCalls,
      this.finishedSubCalls,
      this.getCombinedSubagentText(),
      this.workspaceDir,
    );
    // Terminal-state priority: SDK `tool.result` is authoritative for Agent
    // tool calls. Once it arrives, force done/failed over intermediate
    // spawning/running states for two reasons:
    //   1. Replay does not replay spawned/completed/failed events, so
    //      `subagentPhase` stays undefined and result must be used.
    //   2. Live type-validation failures may skip `subagent.failed`, or
    //      `tool.result` may arrive first; otherwise the UI can stay stuck at
    //      'spawning' and keep showing `Initializing...`.
    // Intermediate states without a result still use `subagentPhase`.
    // `backgrounded` has no result because background agents do not enter the
    // transcript — but a foreground subagent detached via Ctrl+B keeps
    // `subagentPhase === 'backgrounded'` even after its ToolResult lands, so
    // the group card shows `◐ backgrounded` rather than `✓ Completed`. Reuse
    // the standalone derivation so both paths agree.
    const derivedPhase = this.getDerivedSubagentPhase();
    const errorText =
      this.subagentError ?? (derivedPhase === 'failed' ? this.result?.output : undefined);
    return {
      toolCallId: this.toolCall.id,
      toolName: this.toolCall.name,
      toolCallDescription: str(this.toolCall.args['description']) || str(this.toolCall.description),
      agentName: this.subagentAgentName,
      phase: derivedPhase,
      toolCount: finished,
      elapsedSeconds: this.getSubagentElapsedSeconds(),
      tokens,
      isError: derivedPhase === 'failed',
      errorText,
      latestActivity,
    };
  }

  /**
   * 由 `ReadGroupComponent` 用于汇总同一步骤中 Read 卡片的行数。
   * `lines` 与单卡片芯片（`pluralize(countNonEmptyLines(...), 'line')`）匹配，
   * 使组计数和卡片计数保持一致。
   */
  getReadSnapshot(): ToolCallReadSnapshot {
    const args = this.toolCall.args;
    const filePathRaw = args['file_path'] ?? args['path'];
    const filePath =
      typeof filePathRaw === 'string'
        ? makeWorkspaceRelativePath(filePathRaw, this.workspaceDir)
        : undefined;
    if (this.result === undefined) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'pending', lines: 0 };
    }
    if (this.result.is_error === true) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'failed', lines: 0 };
    }
    return {
      toolCallId: this.toolCall.id,
      filePath,
      phase: 'done',
      lines: countNonEmptyLines(this.result.output),
    };
  }

  // 只读视图，供组访问 toolCall 元数据（id、name、description）。
  get toolCallView(): Readonly<ToolCallBlockData> {
    return this.toolCall;
  }

  /** 当内部状态变化且已附加组时，通知监听器。 */
  private notifySnapshotChange(): void {
    this.onSnapshotChange?.();
  }

  private upsertSubToolActivity(
    id: string,
    name: string,
    args: Record<string, unknown>,
    phase: SubToolActivity['phase'],
    output?: string,
  ): void {
    const existing = this.subToolActivities.get(id);
    if (existing !== undefined) {
      existing.name = name;
      existing.args = args;
      existing.phase = phase;
      if (output !== undefined) existing.output = output;
      return;
    }
    this.subToolActivities.set(id, {
      id,
      name,
      args,
      phase,
      ...(output !== undefined ? { output } : {}),
      orderSeq: ++this.subToolOrderSeq,
    });
  }

  private getCombinedSubagentText(): string {
    return [this.subagentThinkingText, this.subagentText].filter((s) => s.length > 0).join('\n');
  }

  private isStreamingEditPreview(): boolean {
    return (
      this.toolCall.name === 'Edit' &&
      this.result === undefined &&
      this.toolCall.streamingArguments !== undefined
    );
  }

  private syncStreamingProgressTimer(): void {
    if (!this.isStreamingEditPreview()) {
      this.stopStreamingProgressTimer();
      return;
    }
    if (this.ui === undefined || this.streamingProgressTimer !== undefined) return;
    this.streamingProgressTimer = setInterval(() => {
      if (!this.isStreamingEditPreview()) {
        this.stopStreamingProgressTimer();
        return;
      }
      this.rebuildBody();
      this.ui?.requestRender();
    }, STREAMING_PROGRESS_INTERVAL_MS);
  }

  private stopStreamingProgressTimer(): void {
    if (this.streamingProgressTimer === undefined) return;
    clearInterval(this.streamingProgressTimer);
    this.streamingProgressTimer = undefined;
  }

  /** Only foreground Bash/Agent calls can be detached via Ctrl+B. */
  private isDetachHintEligible(): boolean {
    return this.toolCall.name === 'Bash' || this.toolCall.name === 'Agent';
  }

  private startDetachHintTimer(): void {
    if (!this.isDetachHintEligible()) return;
    if (this.result !== undefined) return;
    if (this.ui === undefined) return;
    if (this.toolCall.name === 'Agent') {
      // Subagents are long-running by nature; advertise Ctrl+B immediately
      // instead of waiting out the delay used for short Bash commands.
      if (this.detachHintVisible) return;
      this.detachHintVisible = true;
      this.rebuildBody();
      this.ui?.requestRender();
      return;
    }
    if (this.detachHintTimer !== undefined) return;
    this.detachHintTimer = setTimeout(() => {
      this.detachHintTimer = undefined;
      if (this.result !== undefined) return;
      this.detachHintVisible = true;
      this.rebuildBody();
      this.ui?.requestRender();
    }, DETACH_HINT_DELAY_MS);
  }

  private stopDetachHintTimer(): void {
    if (this.detachHintTimer === undefined) return;
    clearTimeout(this.detachHintTimer);
    this.detachHintTimer = undefined;
  }

  private buildDetachHintBlock(): void {
    if (!this.detachHintVisible) return;
    if (this.result !== undefined) return;
    this.addChild(new Text(currentTheme.dim(DETACH_HINT_TEXT), 2, 0));
  }

  private syncSubagentElapsedTimer(): void {
    const phase = this.getDerivedSubagentPhase();
    const shouldTick =
      this.isSingleSubagentView() &&
      this.subagentStartedAtMs !== undefined &&
      (phase === 'queued' || phase === 'spawning' || phase === 'running');
    if (!shouldTick) {
      this.stopSubagentElapsedTimer();
      return;
    }
    if (this.ui === undefined || this.subagentElapsedTimer !== undefined) return;
    this.subagentElapsedTimer = setInterval(() => {
      const latestPhase = this.getDerivedSubagentPhase();
      if (latestPhase !== 'queued' && latestPhase !== 'spawning' && latestPhase !== 'running') {
        this.stopSubagentElapsedTimer();
        return;
      }
      this.headerText.setText(this.buildHeader());
      this.invalidate();
      this.notifySnapshotChange();
      this.ui?.requestRender();
    }, SUBAGENT_ELAPSED_INTERVAL_MS);
  }

  private stopSubagentElapsedTimer(): void {
    if (this.subagentElapsedTimer === undefined) return;
    clearInterval(this.subagentElapsedTimer);
    this.subagentElapsedTimer = undefined;
  }

  private finalizeSubagentElapsedIfNeeded(): void {
    if (
      this.toolCall.name === 'Agent' &&
      this.subagentStartedAtMs !== undefined &&
      this.subagentEndedAtMs === undefined
    ) {
      this.subagentEndedAtMs = Date.now();
    }
  }

  /**
   * 处理 SDK `subagent.spawned`。子代理已注册到父调用，
   * 但其提示可能仍在其他子代理后面排队。
   * 当子轮次实际开始时，`subagent.started` 将其移至 'running'。
   */
  onSubagentSpawned(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagentAgentId = meta.agentId;
    this.subagentAgentName = meta.agentName;
    this.subagentPhase = meta.runInBackground ? 'backgrounded' : 'queued';
    this.subagentStartedAtMs = Date.now();
    this.subagentEndedAtMs = undefined;
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /** 当排队的子轮次开始时，处理 SDK `subagent.started`。 */
  onSubagentStarted(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagentAgentId = meta.agentId;
    this.subagentAgentName = meta.agentName;
    if (
      !meta.runInBackground &&
      (this.subagentPhase === undefined || this.subagentPhase === 'queued')
    ) {
      this.subagentPhase = 'running';
    }
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * 处理 SDK `subagent.completed`。将阶段移至 'done' 并记录
   * token 使用量和结果摘要，用于头部芯片和尾部摘要。
   */
  onSubagentCompleted(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
    resultSummary: string;
  }): void {
    this.subagentPhase = 'done';
    this.subagentEndedAtMs ??= Date.now();
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.subagentContextTokens = payload.contextTokens;
    }
    this.subagentUsage = payload.usage;
    this.subagentResultSummary =
      payload.resultSummary.length > 0 ? payload.resultSummary : undefined;
    if (this.subagentText.trim().length === 0 && this.subagentResultSummary !== undefined) {
      this.subagentText = this.subagentResultSummary;
    }
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /** 处理来自子代理的 SDK `agent.status.updated`。 */
  updateSubagentMetrics(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
  }): void {
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.subagentContextTokens = payload.contextTokens;
    }
    if (payload.usage !== undefined) {
      this.subagentUsage = payload.usage;
    }
    this.headerText.setText(this.buildHeader());
    this.invalidate();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /** 处理 SDK `subagent.failed`。 */
  onSubagentFailed(payload: { error: string }): void {
    this.subagentPhase = 'failed';
    this.subagentEndedAtMs ??= Date.now();
    this.subagentError = payload.error;
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * 记录后台任务的实际终端状态，使快照阶段不再依赖 spawn-success ToolResult。
   * 对 `agent-*` 后台任务在实时（后台代理非成功终止）和
   * 恢复时（协调器将先前运行的任务重新分类为 `lost`）都会调用。
   */
  setBackgroundTaskTerminalStatus(
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost',
    options: { errorText?: string | undefined } = {},
  ): void {
    const phase: 'done' | 'failed' = status === 'completed' ? 'done' : 'failed';
    const { errorText } = options;
    const phaseUnchanged = this.backgroundTaskTerminalPhase === phase;
    let errorChanged = false;
    if (phase === 'failed') {
      // 通过 `onSubagentFailed` 写入的同一 `subagentError` 槽位显示失败行。
      // 独立卡片在 `buildSingleSubagentBlock` 中读取；
      // 组卡片通过 `getSubagentSnapshot` 中的 `errorText` 读取。优先级：
      //   1. 调用方的显式 `errorText`（来自实时 `subagent.failed` 事件的真实消息）
      //      始终优先——它最具信息量。
      //   2. 现有的 `subagentError`（可能来自之前的 `onSubagentFailed` 或更早的显式覆盖）保留。
      //   3. 回退到友好的通用消息，使失败在没有任何来源提供信息时仍有可见的解释。
      if (errorText !== undefined && this.subagentError !== errorText) {
        this.subagentError = errorText;
        errorChanged = true;
      } else if (this.subagentError === undefined) {
        const generic = backgroundFailureMessage(status);
        if (generic !== undefined) {
          this.subagentError = generic;
          errorChanged = true;
        }
      }
    }
    if (phaseUnchanged && !errorChanged) return;
    this.backgroundTaskTerminalPhase = phase;
    this.subagentEndedAtMs ??= Date.now();
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
  }

  /**
   * Mark a foreground subagent as detached-to-background. Called when a
   * `background.task.started` event arrives for this agent (i.e. the user
   * pressed Ctrl+B). Keeps the card showing `◐ backgrounded` instead of
   * flipping to `✓ Completed` when the spawn-success ToolResult lands.
   */
  markBackgrounded(): void {
    if (this.detachedFromForeground) return;
    this.detachedFromForeground = true;
    this.subagentPhase = 'backgrounded';
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * Subagent id for the backing AgentTool call, used by routing to find a
   * tool call's backing subagent when reconciling background task lifecycle
   * events.
   *
   * 两个写入方，按优先级排列：
   *   1. 内存中的 `subagentAgentId`——由 `setSubagentMeta` /
   *      `onSubagentSpawned` 为前台代理接线。对于后台代理，此值保持
   *      undefined：`handleSubagentSpawned` 在调用 `tc.onSubagentSpawned`
   *      之前提前返回，且 `applySubagentReplay` 在传输载荷省略 `subagent`
   *      块时提前返回——每个重放的 Agent 调用都是如此。
   *   2. spawn-success ToolResult 主体——AgentTool 对每个 Agent 调用
   *     （前台和后台）无条件发出 `agent_id: agent-N`。解析它可以得到
   *      稳定标识符，即使内存字段为空。这是恢复路径能够可靠地将
   *      `background.task.terminated` 路由到正确卡片的唯一方式，
   *      也是实时路径避免通过描述匹配而意外更新共享相同 `args.description`
   *      的无关 Agent 卡片的唯一方式。
   */
  getSubagentAgentId(): string | undefined {
    if (this.subagentAgentId !== undefined) return this.subagentAgentId;
    if (this.toolCall.name !== 'Agent' || this.result === undefined) return undefined;
    const match = this.result.output.match(/^agent_id:\s*(agent-[A-Za-z0-9_-]+)/m);
    return match?.[1];
  }

  /** `Agent` 工具调用的 `args.description`，当传输格式早于持久化的子代理 id
   *  且唯一稳定的跨重启标识符是描述字符串时，用作恢复路径的回退。 */
  getAgentToolDescription(): string | undefined {
    if (this.toolCall.name !== 'Agent') return undefined;
    const desc = this.toolCall.args['description'];
    return typeof desc === 'string' ? desc : undefined;
  }

  appendSubagentText(text: string, kind: SubagentTextKind = 'text'): void {
    if (kind === 'thinking') {
      this.subagentThinkingText += text;
    } else {
      this.subagentText += text;
    }
    // 子代理活动意味着它正在运行，除非已处于终端/后台状态。
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === 'queued' ||
      this.subagentPhase === 'spawning'
    ) {
      this.subagentPhase = 'running';
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendSubToolCall(call: { id: string; name: string; args: Record<string, unknown> }): void {
    const existing = this.ongoingSubCalls.get(call.id);
    this.ongoingSubCalls.set(call.id, {
      name: call.name,
      args: call.args,
      ...(existing?.streamingArguments !== undefined
        ? { streamingArguments: existing.streamingArguments }
        : {}),
    });
    this.upsertSubToolActivity(call.id, call.name, call.args, 'ongoing');
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === 'queued' ||
      this.subagentPhase === 'spawning'
    ) {
      this.subagentPhase = 'running';
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendSubToolCallDelta(delta: {
    id: string;
    name?: string | undefined;
    argumentsPart: string | null;
  }): void {
    const existing = this.ongoingSubCalls.get(delta.id);
    const nextArgsText = appendStreamingArgsPreview(
      existing?.streamingArguments,
      delta.argumentsPart,
    );
    const parsed = parseArgsPreview(nextArgsText);
    this.ongoingSubCalls.set(delta.id, {
      name: delta.name ?? existing?.name ?? 'Tool',
      args: parsed,
      streamingArguments: nextArgsText,
    });
    this.upsertSubToolActivity(delta.id, delta.name ?? existing?.name ?? 'Tool', parsed, 'ongoing');
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === 'queued' ||
      this.subagentPhase === 'spawning'
    ) {
      this.subagentPhase = 'running';
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendSubToolLiveOutput(id: string, text: string): void {
    if (text.length === 0) return;
    const activity = this.subToolActivities.get(id);
    const ongoing = this.ongoingSubCalls.get(id);
    if (activity === undefined && ongoing === undefined) return;
    const name = activity?.name ?? ongoing?.name ?? 'Tool';
    const args = activity?.args ?? ongoing?.args ?? {};
    const existingOutput = activity?.output ?? '';
    let output = existingOutput + text;
    if (output.length > MAX_LIVE_OUTPUT_CHARS) {
      output = `[...truncated]\n${output.slice(output.length - MAX_LIVE_OUTPUT_CHARS)}`;
    }
    this.upsertSubToolActivity(id, name, args, activity?.phase ?? 'ongoing', output);
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  finishSubToolCall(result: {
    tool_call_id: string;
    output: string;
    is_error?: boolean | undefined;
  }): void {
    const ongoing = this.ongoingSubCalls.get(result.tool_call_id);
    if (ongoing === undefined) return;
    this.ongoingSubCalls.delete(result.tool_call_id);
    this.finishedSubCalls.push({
      name: ongoing.name,
      args: ongoing.args,
      output: result.output,
      isError: result.is_error ?? false,
    });
    this.upsertSubToolActivity(
      result.tool_call_id,
      ongoing.name,
      ongoing.args,
      result.is_error === true ? 'failed' : 'done',
      result.output,
    );
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  private buildHeader(): string {
    const { toolCall, result } = this;
    const isFinished = result !== undefined;
    const isError = result?.is_error ?? false;
    const isTruncated = toolCall.truncated === true && !isFinished;

    let bullet: string;
    if (isFinished) {
      bullet = isError ? currentTheme.fg('error', '✗ ') : currentTheme.fg('success', STATUS_BULLET);
    } else if (isTruncated) {
      bullet = currentTheme.fg('error', '✗ ');
    } else {
      // 进行中工具使用实心圆点——之前的标记↔空白切换在每次重渲染时会造成可见闪烁。
      bullet = currentTheme.fg('text', STATUS_BULLET);
    }

    if (toolCall.name === 'ExitPlanMode') {
      const label = currentTheme.boldFg('primary', 'Current plan');
      if (!isFinished || result === undefined || result.is_error === true) {
        return label;
      }
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === 'approved') {
        const chipText =
          outcome.chosen !== undefined && outcome.chosen.length > 0
            ? `Approved: ${outcome.chosen}`
            : 'Approved';
        return `${label}${currentTheme.fg('success', ` · ${chipText}`)}`;
      }
      return label;
    }

    if (toolCall.name === 'AskUserQuestion') {
      const isBackgroundAsk = toolCall.args['background'] === true;
      const label = isFinished
        ? isError
          ? 'Could not collect your input'
          : isBackgroundAsk
            ? 'Started background question'
          : 'Collected your answers'
        : isBackgroundAsk
          ? 'Starting background question'
          : 'Waiting for your input';
      const tone = isError ? 'error' : 'primary';
      return `${bullet}${currentTheme.boldFg(tone, label)}`;
    }

    const goalHeader = buildGoalToolHeader({
      toolCall,
      result,
      bullet,
      chip: isFinished && result !== undefined ? this.buildHeaderChip(result) : '',
    });
    if (goalHeader !== undefined) return goalHeader;

    if (this.isSingleSubagentView()) {
      return this.buildSingleSubagentHeader();
    }

    const verb = isFinished ? 'Used' : isTruncated ? 'Truncated' : 'Using';
    const keyArg = extractKeyArgument(toolCall.name, toolCall.args, this.workspaceDir);
    const decoded = decodeMcpToolName(toolCall.name);
    const verbStyled = isTruncated
      ? currentTheme.fg('error', verb)
      : verb;
    const toolLabel =
      decoded !== null
        ? `${currentTheme.boldFg('primary', decoded.toolName)}${currentTheme.dim(` · MCP/${decoded.serverName}`)}`
        : currentTheme.boldFg('primary', toolCall.name);
    const argStr = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
    let chipStr = '';
    if (isFinished && result) chipStr = this.buildHeaderChip(result);
    return `${bullet}${verbStyled} ${toolLabel}${argStr}${chipStr}`;
  }

  private buildHeaderChip(result: ToolResultBlockData): string {
    const provider = pickChip(this.toolCall.name);
    if (provider === undefined) return '';
    const text = provider(this.toolCall, result);
    if (text.length === 0) return '';
    if (result.is_error) return currentTheme.fg('error', ` · ${text}`);
    return currentTheme.dim(` · ${text}`);
  }

  private rebuildContent(): void {
    while (this.children.length > this.callPreviewEndIndex) {
      this.children.pop();
    }
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.buildSubagentBlock();
  }

  private rebuildBody(): void {
    while (this.children.length > 2) {
      this.children.pop();
    }
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.buildSubagentBlock();
  }

  /**
   * 在调用预览和结果主体之间渲染累积的 `progressLines`。
   * 行内的 URL 用 OSC 8 超链接序列包裹，使支持它的终端（iTerm2、Ghostty、kitty、
   * 现代 Terminal.app、VS Code）使 URL 可通过 Cmd 点击并从上下文菜单暴露"复制链接"
   * ——即使 pi-tui 将 URL 软换行到多行（pi-tui 的 wrapTextWithAnsi 在每个续行上
   * 重新打开活动的 OSC 8 链接）。每个嵌入的 URL 单独设置样式，
   * 使周围文本保持默认的暗淡色调。
   */
  private buildProgressBlock(): void {
    if (this.progressLines.length === 0) return;
    if (this.result !== undefined) return;
    for (const raw of this.progressLines) {
      if (raw.length === 0) {
        this.addChild(new Text('', 2, 0));
        continue;
      }
      PROGRESS_URL_RE.lastIndex = 0;
      const styled = PROGRESS_URL_RE.test(raw)
        ? raw.replace(PROGRESS_URL_RE, (url) => {
          const visible = currentTheme.underlineFg('warning', url);
          return `\u001B]8;;${url}\u001B\\${visible}\u001B]8;;\u001B\\`;
        })
        : currentTheme.dim(raw);
      PROGRESS_URL_RE.lastIndex = 0;
      this.addChild(new Text(styled, 2, 0));
    }
  }

  private buildLiveOutputBlock(): void {
    if (this.result !== undefined) return;
    if (this.liveOutput.length === 0) return;
    this.addChild(
      new ShellExecutionComponent({
        result: {
          tool_call_id: this.toolCall.id,
          output: this.liveOutput,
          is_error: false,
        },
        expanded: this.expanded,
        resultPreviewLines: RESULT_PREVIEW_LINES,
        tailOutput: true,
        expandHint: false,
      }),
    );
  }

  private buildSubagentBlock(): void {
    if (
      this.subagentAgentId === undefined &&
      this.ongoingSubCalls.size === 0 &&
      this.finishedSubCalls.length === 0 &&
      this.subagentText.length === 0 &&
      this.subagentPhase === undefined &&
      this.backgroundTaskTerminalPhase === undefined
    ) {
      return;
    }

    if (this.isSingleSubagentView()) {
      this.buildSingleSubagentBlock();
      return;
    }

    const phaseChip = this.formatPhaseChip();
    const headerLabel =
      this.subagentAgentName !== undefined
        ? `subagent ${this.subagentAgentName} (${this.formatAgentId()})`
        : `subagent (${this.formatAgentId()})`;
    this.addChild(new Text(`  ${currentTheme.dim(`↳ ${headerLabel}`)}${phaseChip}`, 0, 0));

    if (this.hiddenSubCallCount > 0) {
      const suffix = this.hiddenSubCallCount > 1 ? 's' : '';
      this.addChild(
        new Text(
          currentTheme.italic(currentTheme.dim(`    ${String(this.hiddenSubCallCount)} more tool call${suffix} ...`)),
          0,
          0,
        ),
      );
    }

    for (const sub of this.finishedSubCalls) {
      const mark = sub.isError
        ? currentTheme.fg('error', '✗')
        : currentTheme.fg('success', '•');
      const keyArg = extractKeyArgument(sub.name, sub.args, this.workspaceDir);
      const nameCol = currentTheme.fg('primary', sub.name);
      const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
      this.addChild(new Text(`    ${mark} Used ${nameCol}${argCol}`, 0, 0));
    }

    for (const [id, call] of this.ongoingSubCalls) {
      const keyArg = extractKeyArgument(call.name, call.args, this.workspaceDir);
      const nameCol = currentTheme.fg('primary', call.name);
      const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
      void id;
      this.addChild(new Text(`    ${currentTheme.dim('…')} Using ${nameCol}${argCol}`, 0, 0));
    }

    if (this.subagentText.length > 0) {
      const tailLines = this.subagentText.split('\n').slice(-3);
      for (const line of tailLines) {
        this.addChild(new Text(`    ${currentTheme.dim(line)}`, 0, 0));
      }
    }

    // 来自 subagent.completed 的结果摘要。
    if (this.subagentPhase === 'done' && this.subagentResultSummary !== undefined) {
      const summaryLines = this.subagentResultSummary.split('\n').slice(0, 2);
      for (const line of summaryLines) {
        this.addChild(new Text(`    ${currentTheme.dim('└')} ${line}`, 0, 0));
      }
    }

    // 来自 subagent.failed 的完整错误文本；不折叠。
    if (this.subagentPhase === 'failed' && this.subagentError !== undefined) {
      const errLines = this.subagentError.split('\n');
      for (const line of errLines) {
        this.addChild(new Text(`    ${currentTheme.fg('error', '└')} ${line}`, 0, 0));
      }
    }
  }

  /**
   * 头部阶段/token 芯片。阶段为 undefined 时不显示芯片。
   *   queued        -> queued
   *   spawning      -> starting
   *   running       -> running
   *   done          -> N tools, 8.4k tok
   *   failed        -> failed
   *   backgrounded  -> backgrounded
   */
  private formatPhaseChip(): string {
    if (this.subagentPhase === undefined) return '';
    const parts: string[] = [];
    switch (this.subagentPhase) {
      case 'queued':
        parts.push('○ queued');
        break;
      case 'spawning':
        parts.push('↻ starting…');
        break;
      case 'running':
        parts.push('↻ running');
        break;
      case 'done': {
        parts.push(currentTheme.fg('success', '✓ done'));
        const toolCount = this.finishedSubCalls.length + this.hiddenSubCallCount;
        if (toolCount > 0) parts.push(`${String(toolCount)} tool${toolCount > 1 ? 's' : ''}`);
        const tokens =
          formatSubagentContextTokens(this.subagentContextTokens) ??
          formatSubagentTokens(this.subagentUsage);
        if (tokens !== undefined) parts.push(tokens);
        break;
      }
      case 'failed':
        parts.push(currentTheme.fg('error', '✗ failed'));
        break;
      case 'backgrounded':
        parts.push('◐ backgrounded');
        break;
    }
    return parts.length > 0 ? currentTheme.dim(` · ${parts.join(' · ')}`) : '';
  }

  private formatAgentId(): string {
    const id = this.subagentAgentId ?? '';
    return id.length > 10 ? id.slice(0, 10) + '…' : id;
  }

  private hasSubagentState(): boolean {
    return (
      this.subagentAgentId !== undefined ||
      this.ongoingSubCalls.size > 0 ||
      this.finishedSubCalls.length > 0 ||
      this.subToolActivities.size > 0 ||
      this.subagentText.length > 0 ||
      this.subagentThinkingText.length > 0 ||
      this.subagentPhase !== undefined ||
      this.backgroundTaskTerminalPhase !== undefined
    );
  }

  private isSingleSubagentView(): boolean {
    return this.toolCall.name === 'Agent' && this.hasSubagentState();
  }

  private getDerivedSubagentPhase(): SubagentPhase | undefined {
    if (this.backgroundTaskTerminalPhase !== undefined) {
      return this.backgroundTaskTerminalPhase;
    }
    // A foreground subagent detached via Ctrl+B keeps showing `backgrounded`
    // even after its spawn-success ToolResult lands, so the card doesn't flip
    // to `✓ Completed` and look like the work actually finished. Agents that
    // started in the background (`detachedFromForeground === false`) read as
    // `done` once their result lands.
    if (this.detachedFromForeground && this.subagentPhase === 'backgrounded') {
      return 'backgrounded';
    }
    if (this.result !== undefined) return this.result.is_error ? 'failed' : 'done';
    return this.subagentPhase;
  }

  private buildSingleSubagentHeader(): string {
    const phase = this.getDerivedSubagentPhase();
    const isFailed = phase === 'failed';
    const isDone = phase === 'done';
    const bullet = isFailed
      ? currentTheme.fg('error', '✗ ')
      : isDone
        ? currentTheme.fg('success', STATUS_BULLET)
        : currentTheme.fg('text', STATUS_BULLET);
    const labelText = formatSubagentLabel(this.subagentAgentName);
    const label = currentTheme.boldFg('primary', labelText);
    const status = this.formatSingleSubagentStatus(phase);
    const description = str(this.toolCall.args['description']);
    const descriptionPlain = description.length > 0 ? ` (${description})` : '';
    const descriptionText = descriptionPlain.length > 0 ? currentTheme.dim(descriptionPlain) : '';
    const statsText = this.formatSingleSubagentStatsText();
    if (isDone) {
      return `${bullet}${currentTheme.boldFg('success', labelText)} ${currentTheme.fg('success', `Completed${descriptionPlain}${statsText}`)}`;
    }
    const stats = currentTheme.dim(statsText);
    return `${bullet}${label} ${status}${descriptionText}${stats}`;
  }

  private formatSingleSubagentStatus(phase: SubagentPhase | undefined): string {
    switch (phase) {
      case 'done':
        return currentTheme.fg('success', 'Completed');
      case 'failed':
        return currentTheme.fg('error', 'Failed');
      case 'running':
        return currentTheme.fg('primary', 'Running');
      case 'backgrounded':
        return 'Backgrounded';
      case 'queued':
        return currentTheme.fg('primary', 'Queued');
      case 'spawning':
      case undefined:
        return currentTheme.fg('primary', 'Starting');
    }
  }

  private formatSingleSubagentStatsText(): string {
    const parts = [
      `${String(this.subToolActivities.size)} tool${this.subToolActivities.size === 1 ? '' : 's'}`,
    ];
    const elapsed = this.getSubagentElapsedSeconds();
    if (elapsed !== undefined) parts.push(formatElapsed(elapsed));
    const tokens =
      this.subagentContextTokens && this.subagentContextTokens > 0
        ? this.subagentContextTokens
        : this.subagentUsage === undefined
          ? 0
          : usageTotal(this.subagentUsage);
    if (tokens > 0) parts.push(formatTokens(tokens));
    return ` · ${parts.join(' · ')}`;
  }

  private getSubagentElapsedSeconds(): number | undefined {
    if (this.subagentStartedAtMs === undefined) return undefined;
    const end = this.subagentEndedAtMs ?? Date.now();
    return Math.max(0, Math.floor((end - this.subagentStartedAtMs) / 1000));
  }

  private buildSingleSubagentBlock(): void {
    for (const activity of this.getRecentSubToolActivities()) {
      const mark =
        activity.phase === 'failed'
          ? currentTheme.fg('error', '✗')
          : activity.phase === 'done'
            ? currentTheme.fg('success', '•')
            : currentTheme.fg('text', '•');
      const verb = activity.phase === 'ongoing' ? 'Using' : 'Used';
      this.addChild(new Text(`  ${mark} ${this.formatSubToolActivity(verb, activity)}`, 0, 0));
      this.addSubToolOutputPreview(activity);
    }

    if (this.getDerivedSubagentPhase() === 'failed' && this.subagentError !== undefined) {
      const errorLine = tailNonEmptyLines(this.subagentError, 1).at(-1);
      if (errorLine !== undefined) {
        this.addChild(
          new PrefixedWrappedLine(
            `  ${currentTheme.fg('error', '└')} `,
            '    ',
            currentTheme.fg('error', errorLine),
          ),
        );
      }
      return;
    }

    const outputLine = tailNonEmptyLines(this.subagentText, 1).at(-1);
    if (
      this.getDerivedSubagentPhase() !== 'done' &&
      this.subagentThinkingText.trim().length > 0
    ) {
      // 在固定的两行窗口内滚动思考内容（宽度感知），匹配主代理的实时思考而非无限增长。
      this.addChild(
        new PrefixedWrappedLine(
          `  ${currentTheme.dim('◌')} `,
          '    ',
          currentTheme.dim(this.subagentThinkingText.trimEnd()),
          THINKING_PREVIEW_LINES,
        ),
      );
    }
    if (outputLine !== undefined) {
      this.addChild(
        new PrefixedWrappedLine(
          `  ${currentTheme.fg('text', '└')} `,
          '    ',
          currentTheme.fg('text', outputLine),
        ),
      );
    }
  }

  private addSubToolOutputPreview(activity: SubToolActivity): void {
    const output = activity.output;
    if (output === undefined || output.trim().length === 0) return;
    // 与主代理保持一致：Bash 和任何没有专用渲染器的工具（包括每个 MCP 工具）
    // 获得截断的输出预览。已识别的工具仅保留其紧凑的活动行。
    if (activity.name !== 'Bash' && !isGenericToolResult(activity.name)) return;
    this.addChild(
      new TruncatedOutputComponent(output, {
        // 子代理输出始终固定截断；不参与 ctrl+o 展开切换，因此也不提示展开。
        expanded: false,
        expandHint: false,
        isError: activity.phase === 'failed',
        maxLines: RESULT_PREVIEW_LINES,
        indent: SUBAGENT_SUBTOOL_OUTPUT_INDENT,
        tail: activity.phase === 'ongoing',
      }),
    );
  }

  private getRecentSubToolActivities(): SubToolActivity[] {
    return [...this.subToolActivities.values()]
      .toSorted((a, b) => a.orderSeq - b.orderSeq)
      .slice(-MAX_SINGLE_SUBAGENT_TOOL_ROWS);
  }

  private formatSubToolActivity(verb: string, activity: SubToolActivity): string {
    const keyArg = extractKeyArgument(activity.name, activity.args, this.workspaceDir);
    const nameCol = currentTheme.fg('primary', activity.name);
    const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
    return `${verb} ${nameCol}${argCol}`;
  }

  private buildCallPreview(): void {
    const name = this.toolCall.name;
    if (name === 'ExitPlanMode') {
      this.buildPlanPreview();
      return;
    }
    if (this.result === undefined && this.toolCall.truncated === true) {
      this.addChild(
        new Text(
          currentTheme.dim('Tool call arguments truncated by max_tokens — call never executed.'),
          2,
          0,
        ),
      );
      return;
    }
    if (this.result === undefined && this.toolCall.streamingArguments !== undefined) {
      this.buildStreamingPreview(this.toolCall.streamingArguments);
      return;
    }
    const shouldCap = this.result !== undefined && !this.expanded;
    if (name === 'Write') {
      const content = str(this.toolCall.args['content']);
      if (content.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      // 在参数确定后立即限制行数，而非等到结果到达。否则参数确定和结果到达之间
      // 的短暂渲染刻度会绘制完整文件，而快速回到折叠上限会触发 pi-tui 的
      // 全量重绘路径，清除终端回滚缓冲区（TUI 之前的历史记录）。
      const writeShouldCap = !this.expanded;
      const shown = writeShouldCap ? allLines.slice(0, COMMAND_PREVIEW_LINES) : allLines;
      const remaining = allLines.length - shown.length;
      for (const [i, line] of shown.entries()) {
        const lineNum = currentTheme.dim(String(i + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + line, 2, 0));
      }
      if (writeShouldCap && remaining > 0) {
        this.addChild(
          new Text(
            currentTheme.dim(
              `... (${String(remaining)} more lines, ${String(allLines.length)} total, ctrl+o to expand)`,
            ),
            2,
            0,
          ),
        );
      }
    } else if (name === 'Edit') {
      const oldStr = str(this.toolCall.args['old_string']);
      const newStr = str(this.toolCall.args['new_string']);
      if (oldStr.length === 0 && newStr.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const lines = renderDiffLinesClustered(oldStr, newStr, filePath, {
        contextLines: 3,
        ...(shouldCap ? { maxLines: COMMAND_PREVIEW_LINES } : {}),
      });
      for (const line of lines) {
        this.addChild(new Text(line, 2, 0));
      }
    } else if (name === 'Bash' && this.result === undefined) {
      // While a long-running Bash call is in-flight (args finalized, no result
      // yet), surface its command in the body so the user can see what is
      // running and expand it with ctrl+o. Once the result lands, buildContent's
      // shellExecutionResultRenderer takes over command rendering.
      const command = str(this.toolCall.args['command']);
      if (command.length === 0) return;
      this.addChild(
        new ShellExecutionComponent({
          command,
          showCommand: true,
          commandPreviewLines: this.expanded ? undefined : COMMAND_PREVIEW_LINES,
        }),
      );
    }
  }

  /**
   * `tool.call.delta` 流式传输窗口期间的实时渲染。
   *
   * 对于已识别的工具，我们通过 `extractPartialStringField` 深入部分 JSON
   * 并渲染稳定的高信号预览：Write 的 `content` 作为高亮代码、
   * Edit 的参数接收进度、Bash 的 `$ command` 等。参数仍在流式传输时
   * 从有界预览缓冲区渲染；结果到达后，预览切换到折叠上限，除非用户已展开。
   */
  private buildStreamingPreview(streamText: string): void {
    const name = this.toolCall.name;
    const previewText = streamText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
    if (name === 'Write') {
      const content = extractPartialStringField(previewText, 'content');
      if (content === undefined || content.length === 0) return;
      const filePath =
        extractPartialStringField(previewText, 'file_path') ??
        extractPartialStringField(previewText, 'path') ??
        '';
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      const maxLines = COMMAND_PREVIEW_LINES;
      const scrollLines =
        allLines.length > maxLines
          ? allLines.slice(allLines.length - maxLines)
          : allLines;
      for (const [i, line] of scrollLines.entries()) {
        const originalLineNumber =
          allLines.length > maxLines
            ? allLines.length - maxLines + i
            : i;
        const lineNum = currentTheme.dim(String(originalLineNumber + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + line, 2, 0));
      }
      return;
    }
    if (name === 'Edit') {
      const filePath =
        extractPartialStringField(previewText, 'file_path') ??
        extractPartialStringField(previewText, 'path') ??
        '';
      const bytes = Buffer.byteLength(previewText, 'utf8');
      const startedAtMs = this.toolCall.streamingStartedAtMs;
      const elapsedSeconds =
        startedAtMs === undefined ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
      const target = filePath.length > 0 ? ` for ${filePath}` : '';
      const progress = `Preparing changes${target}... ${formatByteSize(bytes)} · ${formatElapsed(
        elapsedSeconds,
      )} elapsed`;
      this.addChild(new Text(currentTheme.dim(progress), 2, 0));
      return;
    }
    if (name === 'Bash') {
      const cmd = extractPartialStringField(previewText, 'command');
      if (cmd === undefined || cmd.length === 0) return;
      this.addChild(
        new ShellExecutionComponent({
          command: cmd,
          showCommand: true,
          commandPreviewLines: COMMAND_PREVIEW_LINES,
        }),
      );
    }
    // 未知工具：没有 schema 无法进行有意义的流式传输，
    // 因此留空主体，让头部来传达信息。
  }

  private buildPlanPreview(): void {
    // 优先级：内联 `args.plan`、从结果解析的已批准计划，
    // 然后是审批进行中时异步注入的 currentPlan。
    // 找到计划后，PlanBoxComponent 进行渲染。
    const plan = this.resolvePlanForPreview();
    if (plan.length === 0) return;
    const path = this.resolvePlanPath();
    this.addChild(
      new PlanBoxComponent(plan, this.markdownTheme, currentTheme.color('success'), path, {
        status: this.resolvePlanBoxStatus(),
      }),
    );
  }

  private resolvePlanForPreview(): string {
    const inlinePlan = str(this.toolCall.args['plan']);
    if (inlinePlan.length > 0) return inlinePlan;
    if (this.result !== undefined && !this.result.is_error) {
      const approved = extractApprovedPlan(this.result.output);
      if (approved.length > 0) return approved;
    }
    return this.currentPlan ?? '';
  }

  // 优先级：result.output 中包含 'Plan saved to: <path>' 的已批准结果，
  // 然后是审批进行中时由 setPlanInfo 异步注入的 planPath。
  private resolvePlanPath(): string | undefined {
    if (this.result !== undefined && !this.result.is_error) {
      const fromResult = interpretExitPlanModeOutcome(this.result.output).path;
      if (fromResult !== undefined && fromResult.length > 0) return fromResult;
    }
    return this.planPath;
  }

  private resolvePlanBoxStatus(): { label: string; colorHex: string } | undefined {
    const result = this.result;
    if (this.toolCall.name !== 'ExitPlanMode' || result === undefined) return undefined;
    if (!isExitPlanModeOutcomeOutput(result.output)) return undefined;
    const outcome = interpretExitPlanModeOutcome(result.output);
    if (outcome.kind !== 'rejected') return undefined;
    return { label: 'Rejected', colorHex: currentTheme.color('error') };
  }

  private buildContent(): void {
    const { result } = this;
    if (result === undefined) return;

    if (this.toolCall.name === 'AgentSwarm') {
      this.buildAgentSwarmResultSummary(result);
      return;
    }

    if (!result.output) return;

    if (this.isSingleSubagentView()) {
      return;
    }

    // 以 `<system…>` 标签开头的输出是测试框架注入的提醒，搭载在工具结果上。
    // 对用户来说是噪音，因此抑制主体内容同时保持头部芯片完整。
    if (result.output.trimStart().startsWith('<system')) {
      return;
    }

    if (this.toolCall.name === 'ExitPlanMode' && isExitPlanModeOutcomeOutput(result.output)) {
      // 已批准的计划已由 buildCallPreview 通过 resolvePlanForPreview 渲染。
      // 拒绝或修改反馈使用警告标签加上普通主体文本，使其在转录中保持可见。
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === 'rejected' && outcome.feedback !== undefined) {
        const trimmed = outcome.feedback.trim();
        if (trimmed.length > 0) {
          const labelTone = (text: string) => currentTheme.boldFg('warning', text);
          this.addChild(new Text(labelTone('↪ Suggestion'), 2, 0));
          for (const line of trimmed.split('\n')) {
            this.addChild(new Text(line, 4, 0));
          }
        }
      }
      return;
    }

    // TodoList：权威列表在输入区域前的专用 TodoPanel 中显示，
    // 因此在此重复文本转储纯属冗余。保留标题，丢弃主体。
    if (this.toolCall.name === 'TodoList' && !result.is_error) {
      return;
    }

    if (this.toolCall.name === 'EnterPlanMode' && !result.is_error) {
      return;
    }

    if (
      this.toolCall.name === 'AskUserQuestion' &&
      this.toolCall.args['background'] !== true &&
      !result.is_error &&
      this.renderAskUserQuestionResult(result.output)
    ) {
      return;
    }

    const renderer = pickResultRenderer(this.toolCall.name);
    const components = renderer(this.toolCall, result, {
      expanded: this.expanded,
    });
    for (const component of components) {
      this.addChild(component);
    }
  }

  private buildAgentSwarmResultSummary(result: ToolResultBlockData): void {
    const summary = agentSwarmResultSummaryFromOutput(result.output);
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    const segments: string[] = [];

    if (summary.completed > 0) {
      segments.push(
        currentTheme.fg('success', `${SUCCESS_MARK.trimEnd()} ${String(summary.completed)} completed`),
      );
    }
    if (summary.failed > 0) {
      segments.push(
        currentTheme.fg('error', `${FAILURE_MARK.trimEnd()} ${String(summary.failed)} failed`),
      );
    }
    if (summary.aborted > 0) {
      segments.push(
        currentTheme.fg('warning', `${ABORTED_MARK} ${String(summary.aborted)} aborted`),
      );
    }

    if (segments.length > 0) {
      this.addChild(new Text(`${dim('Agent swarm: ')}${segments.join(dim(' · '))}`, 2, 0));
      return;
    }

    const isAborted = result.is_error === true && /\b(?:aborted|cancelled)\b/i.test(result.output);
    const colorToken = isAborted ? 'warning' : result.is_error === true ? 'error' : 'success';
    const label = isAborted
      ? `${ABORTED_MARK} Aborted.`
      : result.is_error === true
        ? `${FAILURE_MARK.trimEnd()} Failed.`
        : `${SUCCESS_MARK.trimEnd()} Completed.`;
    this.addChild(new Text(`${dim('Agent swarm: ')}${currentTheme.fg(colorToken, label)}`, 2, 0));
  }

  /**
   * 将 AskUserQuestion 的 JSON 载荷渲染为友好的问答列表。
   * 成功时返回 true（调用方跳过默认 JSON 转储）；
   * 解析失败时返回 false（调用方回退到原始显示）。
   */
  private renderAskUserQuestionResult(output: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;

    const accent = (text: string) => currentTheme.fg('primary', text);

    const answers = (parsed as { answers?: unknown }).answers;
    const note = (parsed as { note?: unknown }).note;

    const hasAnswers =
      typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0;

    if (!hasAnswers) {
      const noteText =
        typeof note === 'string' && note.length > 0 ? note : 'User dismissed the question.';
      this.addChild(new Text(currentTheme.dim(`  ${noteText}`), 0, 0));
      return true;
    }

    for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
      const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
      this.addChild(new Text(`  ${currentTheme.dim('Q')}  ${question}`, 0, 0));
      this.addChild(new Text(`  ${accent('→')}  ${answerText}`, 0, 0));
    }
    return true;
  }
}

/**
 * 计算组行的二级"最新活动"行：
 *   1. 最近的进行中子工具 (`Using {name} ({keyArg})`)
 *   2. 最近完成的子工具 (`Used {name} ({keyArg})`)
 *   3. 累积子代理文本的最后一行非空行
 */
function computeLatestActivity(
  ongoing: ReadonlyMap<string, OngoingSubCall>,
  finished: readonly FinishedSubCall[],
  text: string,
  workspaceDir?: string,
): string | undefined {
  if (ongoing.size > 0) {
    const lastOngoing = [...ongoing.values()].at(-1);
    if (lastOngoing !== undefined) {
      return formatActivityLine('Using', lastOngoing.name, lastOngoing.args, workspaceDir);
    }
  }
  if (finished.length > 0) {
    const last = finished.at(-1);
    if (last !== undefined) {
      return formatActivityLine('Used', last.name, last.args, workspaceDir);
    }
  }
  if (text.length > 0) {
    const tail = text
      .split('\n')
      .toReversed()
      .find((l) => l.trim().length > 0);
    if (tail !== undefined) return tail.trim();
  }
  return undefined;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${String(n)} tok`;
}

function formatActivityLine(
  verb: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string {
  const keyArg = extractKeyArgument(toolName, args, workspaceDir);
  return keyArg ? `${verb} ${toolName} (${keyArg})` : `${verb} ${toolName}`;
}

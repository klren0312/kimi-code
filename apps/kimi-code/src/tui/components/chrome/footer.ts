/**
 * 页脚/状态栏 —— TUI 底部的多行状态显示。
 *
 * 布局：
 *   第 1 行：[yolo] [plan] <模型> <工作目录>  <git 徽章>  <快捷键提示>
 *   第 2 行：context: XX.X% (tokens/max)
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";

import { ALL_TIPS, type ToolbarTip } from "#/tui/constant/tips";
import {
  isRainbowDancing,
  renderDanceFooterModel,
} from "#/tui/easter-eggs/dance";
import { currentTheme } from "#/tui/theme";
import type { ColorPalette } from "#/tui/theme/colors";
import type { AppState } from "#/tui/types";
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from "#/utils/git/git-status";
import { safeUsageRatio } from "#/utils/usage/usage-format";

const MAX_CWD_SEGMENTS = 3;
const GOAL_TIMER_INTERVAL_MS = 1_000;

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " | ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = " | ";

/**
 * 使用平滑加权轮询（nginx SWRR 算法）将提示展开为轮换序列。
 * `priority` 值较高的提示出现更频繁，同时保持均匀分布，
 * 因此提示通常不会与其自身副本相邻。结果是确定性的，
 * 在模块加载时计算一次。导出供单元测试使用。
 */
export function buildWeightedTips(
  tips: readonly ToolbarTip[],
): readonly ToolbarTip[] {
  const items = tips.map((t) => ({
    tip: t,
    weight: Math.max(1, Math.trunc(t.priority ?? 1)),
    current: 0,
  }));
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  const seq: ToolbarTip[] = [];
  for (let n = 0; n < total; n++) {
    let best = items[0]!;
    for (const it of items) {
      it.current += it.weight;
      if (it.current > best.current) best = it;
    }
    best.current -= total;
    seq.push(best.tip);
  }
  return seq;
}

const ROTATION: readonly ToolbarTip[] = buildWeightedTips(ALL_TIPS);

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

/**
 * 为轮换序列中的某个索引选取提示。`primary` 在适配时始终显示；
 * `pair`（primary + 下一个提示以分隔符连接）在宽终端中提供。
 * 当当前/下一个提示标记为 `solo` 或相邻提示与当前提示重复时
 * （可能发生在序列回绕边界处），跳过配对，使较长/较重要的
 * 提示保持独立，并避免出现 "X | X" 的情况。
 */
function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const n = ROTATION.length;
  if (n === 0) return { primary: "", pair: null };
  const offset = ((index % n) + n) % n;
  const current = ROTATION[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = ROTATION[(offset + 1) % n]!;
  if (next.solo || next.text === current.text)
    return { primary: current.text, pair: null };
  return {
    primary: current.text,
    pair: current.text + TIP_SEPARATOR + next.text,
  };
}

/**
 * 页脚目标徽章，例如 `[goal ● active · 4m · 7 turns]`。
 * 仅在活跃（active/paused/blocked）目标时显示；无目标时不显示徽章。
 * 回合计数为原始计数，除非设置了明确的回合预算，
 * 此时显示已使用/限制的格式。
 */
function formatGoalBadge(
  goal: AppState["goal"],
  colors: ColorPalette,
  wallClockMs?: number,
): string | null {
  if (goal === null || goal === undefined) return null;
  // 为每个已持久化、可恢复的状态显示徽章。`complete` 会清除目标，
  // 因此不会到达此处；只有未设置的情况才返回 null。
  if (
    goal.status !== "active" &&
    goal.status !== "paused" &&
    goal.status !== "blocked"
  ) {
    return null;
  }
  const dotColor =
    goal.status === "active"
      ? colors.primary
      : goal.status === "blocked"
        ? colors.warning
        : colors.textMuted;
  const turns =
    goal.budget.turnBudget !== null
      ? `${goal.turnsUsed}/${goal.budget.turnBudget} turns`
      : `${goal.turnsUsed} ${goal.turnsUsed === 1 ? "turn" : "turns"}`;
  const label = `${goal.status} · ${formatBadgeElapsed(wallClockMs ?? goal.wallClockMs)} · ${turns}`;
  return (
    chalk.hex(colors.textMuted)("[goal ") +
    chalk.hex(dotColor)("●") +
    chalk.hex(colors.textMuted)(` ${label}]`)
  );
}

function formatBadgeElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  return model?.displayName ?? model?.model ?? state.model;
}

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env["HOME"] ?? "";
  let work = path;
  if (home && path === home) {
    return "~";
  }
  if (home && path.startsWith(home + "/")) {
    work = "~" + path.slice(home.length);
  }

  const segments = work.split("/").filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join("/");
  return `…/${tail}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function safeUsage(usage: number): number {
  return safeUsageRatio(usage);
}

function formatContextStatus(
  usage: number,
  tokens?: number,
  maxTokens?: number,
): string {
  const pct = `${(safeUsage(usage) * 100).toFixed(1)}%`;
  if (maxTokens && maxTokens > 0 && tokens !== undefined) {
    return `context: ${pct} (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `context: ${pct}`;
}

export function formatFooterGitBadge(
  status: GitStatus,
  colors: ColorPalette,
): string {
  const base = chalk.hex(colors.textDim)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  private state: AppState;
  private readonly onRefresh: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  private goalSnapshotKey: string | null = null;
  private goalObservedAtMs = Date.now();
  private goalTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 非终态的后台任务计数，按类型分组，以便页脚渲染两种不同的徽章。
   * `bashTasks` 涵盖通过 `Shell run_in_background=true` 生成的 `bash-*` BPM 任务；
   * `agentTasks` 涵盖 `agent-*` BPM 任务（后台子代理）。
   * 任一计数为零时隐藏其对应的徽章。
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(state: AppState, onRefresh: () => void = () => {}) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, {
      onChange: this.onRefresh,
    });
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, {
        onChange: this.onRefresh,
      });
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.state = state;
  }

  /**
   * 短暂提示，替换第 1 行的轮换工具栏提示。
   * 用于退出确认的双击流程，显示"再按一次 Ctrl+C 退出"，
   * 而不需要 toast/覆盖层子系统。
   * 传入 `null` 清除提示。
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  getTransientHint(): string | null {
    return this.transientHint;
  }

  /**
   * 同步两个后台任务徽章的实时计数。每个非零计数
   * 在第 1 行生成各自的括号徽章；为零时各自独立隐藏。
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const colors = currentTheme.palette;
    const state = this.state;

    // ── 第 1 行：模式徽章 + 模型 + [N task(s) running] + [N agent(s) running] + 工作目录 + git + 提示 ──
    const left: string[] = [];
    const modes: string[] = [];
    if (state.permissionMode === "auto")
      modes.push(chalk.hex(colors.warning).bold("auto"));
    if (state.permissionMode === "yolo")
      modes.push(chalk.hex(colors.warning).bold("yolo"));
    if (state.planMode) modes.push(chalk.hex(colors.primary).bold("plan"));
    if (state.swarmMode) modes.push(chalk.hex(colors.accent).bold("swarm"));
    if (modes.length > 0) left.push(modes.join(" "));

    const goalBadge = formatGoalBadge(
      state.goal,
      colors,
      this.goalWallClockMs(state.goal),
    );
    if (goalBadge !== null) left.push(goalBadge);

    const model = modelDisplayName(state);
    if (model) {
      const thinkingLabel = state.thinking ? " thinking" : "";
      const modelLabel = `${model}${thinkingLabel}`;
      let renderedModelLabel = chalk.hex(colors.text)(modelLabel);
      if (isRainbowDancing()) {
        renderedModelLabel = renderDanceFooterModel(modelLabel);
      }
      left.push(renderedModelLabel);
    }

    // 后台任务徽章紧接在工作目录之前。`bash-*` 任务（shell 进程）
    // 和 `agent-*` 任务（后台子代理）各有独立徽章，方便用户一目了然地辨别。
    if (this.backgroundBashTaskCount > 0) {
      const noun = this.backgroundBashTaskCount === 1 ? "task" : "tasks";
      left.push(
        chalk.hex(colors.primary)(
          `[${String(this.backgroundBashTaskCount)} ${noun} running]`,
        ),
      );
    }
    if (this.backgroundAgentCount > 0) {
      const noun = this.backgroundAgentCount === 1 ? "agent" : "agents";
      left.push(
        chalk.hex(colors.primary)(
          `[${String(this.backgroundAgentCount)} ${noun} running]`,
        ),
      );
    }

    const cwd = shortenCwd(state.workDir);
    if (cwd) left.push(chalk.hex(colors.textDim)(cwd));

    const git = this.gitCache.getStatus();
    if (git !== null) {
      left.push(formatFooterGitBadge(git, colors));
    }

    const leftLine = left.join("  ");
    const leftWidth = visibleWidth(leftLine);

    // 轮换提示，填充第 1 行的剩余空间。
    const { primary, pair } = tipsForIndex(currentTipIndex());
    const gap = 2;
    const remaining = Math.max(0, width - leftWidth - gap);
    let tipText = "";
    if (pair && visibleWidth(pair) <= remaining) {
      tipText = pair;
    } else if (primary && visibleWidth(primary) <= remaining) {
      tipText = primary;
    }

    let line1: string;
    if (tipText) {
      const pad = width - leftWidth - visibleWidth(tipText);
      line1 =
        leftLine +
        " ".repeat(Math.max(0, pad)) +
        chalk.hex(colors.textMuted)(tipText);
    } else if (leftWidth <= width) {
      line1 = leftLine;
    } else {
      line1 = truncateToWidth(leftLine, width, "…");
    }

    // ── 第 2 行：短暂提示（左下角）+ 上下文（右侧）──
    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const contextWidth = visibleWidth(contextText);
    let line2: string;
    if (this.transientHint) {
      const maxHintWidth = Math.max(0, width - contextWidth - 1);
      const shownHint =
        visibleWidth(this.transientHint) <= maxHintWidth
          ? this.transientHint
          : truncateToWidth(this.transientHint, maxHintWidth, "…");
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - contextWidth);
      line2 =
        chalk.hex(colors.warning).bold(shownHint) +
        " ".repeat(pad) +
        chalk.hex(colors.text)(contextText);
    } else {
      const leftPad = Math.max(0, width - contextWidth);
      line2 = " ".repeat(leftPad) + chalk.hex(colors.text)(contextText);
    }

    return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
  }

  private syncGoalClock(goal: AppState["goal"]): void {
    const key = goalSnapshotKey(goal);
    if (key === this.goalSnapshotKey) return;
    this.goalSnapshotKey = key;
    this.goalObservedAtMs = Date.now();
  }

  private syncGoalTimer(goal: AppState["goal"]): void {
    if (goal?.status === "active") {
      if (this.goalTimer !== null) return;
      this.goalTimer = setInterval(() => {
        this.onRefresh();
      }, GOAL_TIMER_INTERVAL_MS);
      this.goalTimer.unref?.();
      return;
    }

    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
  }

  private goalWallClockMs(goal: AppState["goal"]): number | undefined {
    if (goal === null || goal === undefined) return undefined;
    if (goal.status !== "active") return goal.wallClockMs;
    return goal.wallClockMs + Math.max(0, Date.now() - this.goalObservedAtMs);
  }
}

function goalSnapshotKey(goal: AppState["goal"]): string | null {
  if (goal === null || goal === undefined) return null;
  return [
    goal.goalId,
    goal.status,
    goal.terminalReason ?? "",
    String(goal.turnsUsed),
    String(goal.tokensUsed),
    String(goal.wallClockMs),
    String(goal.budget.tokenBudget),
    String(goal.budget.turnBudget),
    String(goal.budget.wallClockBudgetMs),
  ].join("\u0000");
}

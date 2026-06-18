/**
 * 为 `/goal` 状态框构建行内容。这些行渲染在 {@link UsagePanelComponent}
 * 内部（与 `/usage` 相同的带边框框体），因此本模块仅负责目标专属的布局：
 *
 *   ▌ <目标> （引用块左侧竖线，自动换行）
 *   ▌ ✓ <完成标准>
 *
 *   Status     complete — <原因>         （仅终止目标显示）
 *   Running    4m 12s
 *   Turns      7
 *   Tokens     128.4k
 *   Stop       after 20 turns (7/20)     （或暗淡的"无停止条件"提示）
 */

import {
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';
import type { GoalSnapshot, GoalStatus } from '@moonshot-ai/kimi-code-sdk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { formatTokenCount } from '#/utils/usage/usage-format';
import { formatGoalElapsed } from './goal-format';
import { UsagePanelComponent } from './usage-panel';

const WRAP_WIDTH = 72;
const MAX_OBJECTIVE_LINES = 6;
const MAX_CRITERION_LINES = 3;
const LABEL_WIDTH = 11;

function renderLifecycleLine(label: string, width: number): string[] {
  if (width <= 0) return [''];

  const marker = currentTheme.boldFg('primary', STATUS_BULLET);
  const text = new Text(currentTheme.boldFg('primary', label), 0, 0);
  const contentWidth = Math.max(1, width - visibleWidth(STATUS_BULLET));
  return [
    '',
    ...text
      .render(contentWidth)
      .map((line, index) => (index === 0 ? marker : MESSAGE_INDENT) + line.trimEnd()),
  ];
}

/**
 * `/goal <目标>` 后显示的"已设定目标"确认消息。目标作为后续的用户提示
 * 渲染，因此此消息仅在对话记录中标记状态变更。
 */
export class GoalSetMessageComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return renderLifecycleLine('Goal set', width);
  }
}

export class UpcomingGoalAddedMessageComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return renderLifecycleLine(
      'Upcoming goal added. It will start after the current goal is complete.',
      width,
    );
  }
}

export class GoalCompletionMessageComponent implements Component {
  constructor(private readonly message: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    const [headline = '', ...details] = this.message.trim().split(/\r?\n/);
    if (headline.length === 0) return [];

    const bullet = currentTheme.boldFg('success', STATUS_BULLET);
    const bulletWidth = visibleWidth(STATUS_BULLET);
    const contentWidth = Math.max(1, width - bulletWidth);
    const lines: string[] = [''];

    const headlineText = new Text(currentTheme.boldFg('success', headline), 0, 0);
    const headlineLines = headlineText.render(contentWidth);
    for (let i = 0; i < headlineLines.length; i += 1) {
      lines.push((i === 0 ? bullet : MESSAGE_INDENT) + headlineLines[i]);
    }

    const detailText = details.join('\n').trim();
    if (detailText.length > 0) {
      const detailLines = new Text(currentTheme.fg('textDim', detailText), 0, 0).render(
        contentWidth,
      );
      for (const line of detailLines) {
        lines.push(MESSAGE_INDENT + line);
      }
    }

    return lines;
  }
}

export class GoalStatusMessageComponent implements Component {
  constructor(private readonly goal: GoalSnapshot) {}

  invalidate(): void {}

  render(width: number): string[] {
    const panelContentWidth = Math.max(1, width - 6);
    const panel = new UsagePanelComponent(
      () => buildGoalReportLines(this.goal, panelContentWidth),
      'primary',
      goalPanelTitle(this.goal),
    );
    return ['', ...panel.render(width)];
  }
}

/** 框体标题，例如 ` Goal · active `。 */
export function goalPanelTitle(goal: GoalSnapshot): string {
  return ` Goal · ${goal.status} `;
}

export function buildGoalReportLines(goal: GoalSnapshot, wrapWidth: number = WRAP_WIDTH): string[] {
  const statusColor = statusToken(goal.status);
  const bar = (s: string) => currentTheme.fg(statusColor, s);
  const value = (s: string) => currentTheme.fg('text', s);
  const muted = (s: string) => currentTheme.fg('textDim', s);
  // `complete` 是终止结果（完成卡片）；其他所有状态（active / paused / blocked）
  // 是可持久化、可恢复的目标，仍然显示其停止条件。停止/完成状态值得展示原因。
  const isComplete = goal.status === 'complete';
  const reason = goal.terminalReason;
  const showReason =
    (goal.status === 'paused' && reason !== undefined) || goal.status === 'blocked' || isComplete;
  const lines: string[] = [];

  // 目标条件作为引用块左侧竖线。在换行前预留可见的 "▌ " 前缀，
  // 以免面板裁剪恰好适配面板内部宽度的行。
  const blockquoteWrapWidth = Math.max(1, wrapWidth - visibleWidth('▌ '));
  for (const line of wrap(goal.objective, blockquoteWrapWidth, MAX_OBJECTIVE_LINES)) {
    lines.push(`${bar('▌')} ${value(line)}`);
  }
  if (goal.completionCriterion !== undefined) {
    for (const line of wrap(`✓ ${goal.completionCriterion}`, blockquoteWrapWidth, MAX_CRITERION_LINES)) {
      lines.push(`${bar('▌')} ${muted(line)}`);
    }
  }
  lines.push('');

  const row = (label: string, val: string): string => `${muted(label.padEnd(LABEL_WIDTH))}${val}`;

  if (showReason) {
    lines.push(
      row(
        'Status',
        currentTheme.fg(statusColor, goal.status) +
          (reason !== undefined ? muted(` — ${reason}`) : ''),
      ),
    );
  }
  lines.push(row('Running', value(formatGoalElapsed(goal.wallClockMs))));
  lines.push(row('Turns', value(`${goal.turnsUsed}`)));
  lines.push(row('Tokens', value(formatTokenCount(goal.tokensUsed))));
  if (!isComplete) {
    const stop = formatStopRow(goal);
    lines.push(
      stop !== null
        ? row('Stop', value(stop))
        : muted('No stop condition — runs until evaluated complete.'),
    );
  }
  return lines;
}

/** 已配置的硬停止条件，目标无界时返回 null。 */
function formatStopRow(goal: GoalSnapshot): string | null {
  const { budget } = goal;
  const parts: string[] = [];
  if (budget.turnBudget !== null) {
    parts.push(`after ${budget.turnBudget} turns (${goal.turnsUsed}/${budget.turnBudget})`);
  }
  if (budget.tokenBudget !== null) {
    parts.push(`at ${formatTokenCount(budget.tokenBudget)} tokens`);
  }
  if (budget.wallClockBudgetMs !== null) {
    parts.push(`after ${formatGoalElapsed(budget.wallClockBudgetMs)}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function statusToken(status: GoalStatus): ColorToken {
  switch (status) {
    case 'active':
      return 'primary';
    case 'complete':
      return 'success';
    case 'blocked':
      return 'warning';
    case 'paused':
      return 'textDim';
  }
}

/** 按 `width` 自动换行，限制为 `maxLines` 行（超出时末尾添加省略号）。 */
function wrap(text: string, width: number, maxLines: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines = wrapTextWithAnsi(text.replaceAll(/\s+/g, ' ').trim(), safeWidth);
  if (lines.length === 0) return [''];
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  const lastLine = clipped[maxLines - 1] ?? '';
  clipped[maxLines - 1] = truncateToWidth(`${lastLine}…`, safeWidth, '…');
  return clipped;
}

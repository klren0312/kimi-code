import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

interface GoalCompletionStats {
  readonly terminalReason?: string | undefined;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

/**
 * 当模型将目标标记为 `complete` 时，由 TUI 渲染的确定性目标完成文本。
 * 它基于最终快照构建，因此数据（轮次 / token / 时间）是精确的，
 * 不依赖于模型的自然语言描述。
 */
export function buildGoalCompletionMessage(goal: GoalSnapshot): string {
  return buildGoalCompletionMessageFromStats(goal);
}

export function buildGoalCompletionMessageFromStats(goal: GoalCompletionStats): string {
  const head = `✓ Goal complete${goal.terminalReason ? ` — ${goal.terminalReason}` : ''}.`;
  const turns = `${goal.turnsUsed} turn${goal.turnsUsed === 1 ? '' : 's'}`;
  const stats = `Worked ${turns} over ${formatElapsed(goal.wallClockMs)}, using ${formatTokens(goal.tokensUsed)} tokens.`;
  return `${head}\n${stats}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

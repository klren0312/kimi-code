/**
 * 摘要式渲染器 — 为原始输出量大但信息密度低的工具（Grep、Glob）
 * 生成可选的内联概览内容。数值摘要（行数、退出码、大小）位于
 * 头部芯片（参见 chip.ts），因此大多数工具会故意渲染空正文，
 * 仅在全局展开切换开启时才显示详情。
 *
 * 错误始终降级到截断渲染器，使用户看到的是实际错误消息而非合成摘要。
 */

import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

const GLANCE_SAMPLES = 3;

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => string;

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    if (result.is_error) return renderTruncated(toolCall, result, ctx);

    const out: Component[] = [];
    if (glance !== null) {
      const line = glance(toolCall, result);
      if (line.length > 0) {
        out.push(new Text(`  ${chalk.dim(line)}`, 0, 0));
      }
    }
    if (ctx.expanded && result.output.length > 0) {
      out.push(new Text(chalk.dim(result.output), 4, 0));
    }
    return out;
  };
}

function nonEmptyLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n').filter((line) => line.length > 0);
}

// 去除尾部的 `:行号:列号:文本`，使概览仅显示文件路径，
// 即使 grep 处于 `content` 模式（`src/foo.ts:42:    foo()`）。
function pathFromGrepLine(line: string): string {
  const idx = line.indexOf(':');
  if (idx <= 0) return line;
  const second = line.indexOf(':', idx + 1);
  if (second <= 0) return line;
  return line.slice(0, second);
}

const grepGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';
  const samples = lines.slice(0, GLANCE_SAMPLES).map(pathFromGrepLine);
  const remaining = lines.length - samples.length;
  const tail = remaining > 0 ? `, +${String(remaining)} more` : '';
  return `${samples.join(', ')}${tail}`;
};

const globGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';
  const samples = lines.slice(0, GLANCE_SAMPLES);
  const remaining = lines.length - samples.length;
  const tail = remaining > 0 ? `, +${String(remaining)} more` : '';
  return `${samples.join(', ')}${tail}`;
};

// ── 导出 ──────────────────────────────────────────────────────────

// 芯片已传达全部信息的工具 — 折叠状态下正文为空，
// 展开时仅显示原始输出。
export const readSummary: ResultRenderer = withGlance(null);
export const fetchSummary: ResultRenderer = withGlance(null);
export const webSearchSummary: ResultRenderer = withGlance(null);
export const thinkSummary: ResultRenderer = withGlance(null);
export const editSummary: ResultRenderer = withGlance(null);
export const writeSummary: ResultRenderer = withGlance(null);

// 芯片下方需要内联路径样本的工具。
export const grepSummary: ResultRenderer = withGlance(grepGlance);
export const globSummary: ResultRenderer = withGlance(globGlance);

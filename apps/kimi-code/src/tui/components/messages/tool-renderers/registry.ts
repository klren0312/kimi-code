/**
 * 工具结果渲染器注册表。
 *
 * 每个工具名称映射到一个 `ResultRenderer`，将工具的 `ToolResultBlockData`
 * 转换为可渲染的组件。没有显式条目的工具会降级到 `renderTruncated`
 * （原始的 3 行 + ctrl+o 展开行为）。
 *
 * 保持此分发结构扁平 — 工具名称与其选择的渲染器相邻存放，
 * 添加新工具只需追加一个 case。
 */

import { readMediaSummary } from './media';
import { shellExecutionResultRenderer } from '../shell-execution';
import { goalSummary } from './goal';
import {
  editSummary,
  fetchSummary,
  globSummary,
  grepSummary,
  readSummary,
  thinkSummary,
  webSearchSummary,
  writeSummary,
} from './summary';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

/**
 * 当工具没有专用渲染器、降级到通用截断输出时返回 true
 * （所有 MCP 工具及下方未列出的任何工具）。
 * 用于决定子代理的子工具输出是否应按主代理相同的方式预览。
 */
export function isGenericToolResult(toolName: string): boolean {
  return pickResultRenderer(toolName) === renderTruncated;
}

export function pickResultRenderer(toolName: string): ResultRenderer {
  switch (toolName) {
    case 'Read':
      return readSummary;
    case 'ReadMediaFile':
      return readMediaSummary;
    case 'Grep':
      return grepSummary;
    case 'Glob':
      return globSummary;
    case 'FetchURL':
      return fetchSummary;
    case 'WebSearch':
      return webSearchSummary;
    case 'Bash':
      return shellExecutionResultRenderer;
    case 'Think':
      return thinkSummary;
    case 'Edit':
      return editSummary;
    case 'Write':
      return writeSummary;
    case 'CreateGoal':
    case 'GetGoal':
    case 'SetGoalBudget':
    case 'UpdateGoal':
      return goalSummary;
    default:
      return renderTruncated;
  }
}

export type { ResultRenderer } from './types';

/**
 * 将 `BackgroundTaskInfo` 快照格式化为 `BackgroundAgentStatusComponent`
 * 消费的对话卡片数据。
 *
 * 后台任务有多种状态（运行中 / 已完成 / 已失败 /
 * 超时 / 已终止 / 丢失），但对话卡片只渲染三个
 * 视觉阶段（已启动 / 已完成 / 已失败）。
 * 映射将额外的细节——退出码、终止原因、丢失原因
 * ——压缩到暗色详情行中，用户仍然可以看到。
 */

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@moonshot-ai/kimi-code-sdk';

import type { BackgroundAgentStatusData, BackgroundAgentStatusPhase } from '@/tui/types';

const MAX_DETAIL_LENGTH = 240;

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, ' ');
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_DETAIL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH - 3)}...`;
}

export type BackgroundTaskTranscriptPhase = 'started' | 'updated' | 'terminal';

function phaseFromStatus(status: BackgroundTaskStatus): BackgroundAgentStatusPhase {
  switch (status) {
    case 'running':
      return 'started';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'failed';
  }
}

function subjectFor(info: BackgroundTaskInfo): string {
  if (info.kind === 'agent') return 'agent task';
  if (info.kind === 'question') return 'question task';
  return 'bash task';
}

function headlineFor(info: BackgroundTaskInfo): string {
  const subject = subjectFor(info);
  switch (info.status) {
    case 'running':
      return `${subject} started in background`;
    case 'completed':
      return `${subject} completed in background`;
    case 'failed':
      return `${subject} failed in background`;
    case 'timed_out':
      return `${subject} timed out`;
    case 'killed':
      return `${subject} stopped`;
    case 'lost':
      return `${subject} lost`;
  }
}

function detailFor(info: BackgroundTaskInfo): string | undefined {
  const parts: string[] = [];
  const description = truncate(info.description);
  if (description !== undefined) parts.push(description);

  if (info.status === 'completed' || info.status === 'failed') {
    if (info.kind === 'process' && info.exitCode !== null) {
      parts.push(`exit ${info.exitCode}`);
    }
  }
  if (info.status === 'killed') {
    const reason = truncate(info.stopReason);
    parts.push(reason !== undefined ? `stopped — ${reason}` : 'stopped');
  }
  if (info.status === 'failed') {
    const reason = truncate(info.stopReason);
    if (reason !== undefined) parts.push(reason);
  }
  if (info.status === 'timed_out') parts.push('timed out');
  if (info.status === 'lost') {
    parts.push('session restarted before completion');
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * 为后台任务生命周期快照构建对话卡片载荷。
 * 返回的阶段驱动渲染器（`BackgroundAgentStatusComponent`）中
 * 项目符号的颜色；详情行携带额外的状态细节
 * （退出码、终止原因等）。
 */
export function formatBackgroundTaskTranscript(
  info: BackgroundTaskInfo,
): BackgroundAgentStatusData {
  return {
    phase: phaseFromStatus(info.status),
    headline: headlineFor(info),
    detail: detailFor(info),
  };
}

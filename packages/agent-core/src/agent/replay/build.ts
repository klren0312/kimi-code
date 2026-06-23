/**
 * @module replay/build
 *
 * 独立的重放构建器，创建临时代理来重放持久化的记录并提取重放时间线。
 * 调试/可视化工具使用它来重建会话历史，
 * 无需活跃的代理会话。
 */

import { LocalKaos } from '@moonshot-ai/kaos';

import type { AgentReplayRecord } from '../../rpc/resumed';
import { Agent } from '../index';
import type { AgentRecordPersistence } from '../records';
import type { ReplayRangeOptions } from '.';

/**
 * 从持久化的代理记录构建重放。创建一次性代理，
 * 将记录重放其中，并返回捕获的重放时间线。
 *
 * @param persistence - 读取记录的记录持久化层。
 * @param range - 大型会话的可选分页约束。
 * @returns 指定范围内的有序重放记录。
 */
export async function buildReplay(
  persistence: AgentRecordPersistence,
  range?: ReplayRangeOptions,
): Promise<readonly AgentReplayRecord[]> {
  const agent = new Agent({
    kaos: await LocalKaos.create(),
    persistence,
    type: 'sub',
    replay: { range },
  });
  await agent.resume({ rewriteMigratedRecords: false });
  return agent.replayBuilder.buildResult();
}

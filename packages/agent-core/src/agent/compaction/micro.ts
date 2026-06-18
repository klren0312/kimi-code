/**
 * @module compaction/micro
 *
 * 微压缩是一种轻量级、非 LLM 的压缩路径，就地截断旧的工具结果消息。
 * 与完整压缩不同，它不生成摘要——只是用短标记字符串替换大型工具输出，
 * 以接近零的成本回收 token。
 *
 * 微压缩受 `micro_compaction` 实验性标志控制，仅在以下条件下激活：
 *   1. 提示缓存"未命中"（在 `cacheMissedThresholdMs` 内无 assistant 响应），且
 *   2. 上下文使用量超过 `minContextUsageRatio`。
 *
 * 截止索引单调递进；{@link reset} 可以降低它但不能升高，确保已截断的消息保持截断。
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import {
  estimateTokensForContentParts,
  estimateTokensForMessages,
} from '../../utils/tokens';

/**
 * 微压缩的配置项。所有阈值都故意设置得保守，以避免意外丢失有用的工具输出。
 */
export interface MicroCompactionConfig {
  /**
   * 从尾部开始的最近消息数量，微压缩不会触碰它们。
   * 保持活跃对话完整。
   */
  keepRecentMessages: number;
  /**
   * 工具结果消息必须达到的最小 token 数才能被截断。
   * 小型结果（例如单行确认）保持不变，因为它们以可忽略的成本提供有用的上下文。
   */
  minContentTokens: number;
  /**
   * 距上次 assistant 响应的时间（毫秒），超过此时间提示缓存被视为"未命中"。
   * 微压缩仅在缓存未命中时触发，因为截断消息会使热缓存失效，
   * 延迟损失大于收益。
   */
  cacheMissedThresholdMs: number;
  /** 插入被截断的工具结果消息中的替换文本。 */
  truncatedMarker: string;
  /**
   * 微压缩激活前必须使用的上下文窗口最小比例。
   * 在上下文压力低时防止不必要的工作。
   */
  minContextUsageRatio: number;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
  minContextUsageRatio: 0.5,
};

/**
 * 轻量级压缩，截断旧的工具结果消息以在不调用 LLM 的情况下回收 token。
 * 在滑动窗口上操作：`cutoff` 之前的大型工具结果消息被替换为短标记字符串。
 *
 * 截止点随上下文压力增长而前进，但不会退回到最近的 {@link reset} 值之前——
 * 这防止已截断的消息被恢复（这在语义上是错误的，因为原始内容已丢失）。
 */
export class MicroCompaction {
  /** 历史中可被截断的消息截止索引。 */
  private cutoff = 0;
  /** 解析后的配置（默认值与用户覆盖合并）。 */
  readonly config: MicroCompactionConfig;

  /**
   * @param agent - 所属 agent，检查其上下文和标志。
   * @param config - 可选的部分覆盖，与 {@link DEFAULT_CONFIG} 合并。
   */
  constructor(
    public readonly agent: Agent,
    config?: Partial<MicroCompactionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 降低截止点上限。在恢复历史时调用（例如撤回操作后），
   * 以防止截止点前进超过恢复后的历史所能支持的范围。
   * 截止点只向下移动，不向上——使用 {@link apply} 来推进它。
   */
  reset(maxCutoff = 0): void {
    this.cutoff = Math.min(this.cutoff, maxCutoff);
  }

  /**
   * 将截止点推进到指定索引并记录日志。索引 `< cutoff` 且具有大型工具结果的消息
   * 将在下次 {@link compact} 调用时被截断。
   */
  apply(cutoff: number): void {
    this.agent.records.logRecord({
      type: 'micro_compaction.apply',
      cutoff,
    });
    this.cutoff = cutoff;
  }

  /**
   * 基于缓存未命中时间和上下文使用率评估微压缩是否应激活。
   * 如果条件满足，推进截止点并记录遥测数据。由 agent 循环定期调用
   * （通常在步骤之前），调用开销很低——当实验标志关闭或条件不满足时立即短路返回。
   */
  detect(): void {
    if (!this.agent.experimentalFlags.enabled('micro_compaction')) return;

    const config = this.config;
    const { history, lastAssistantAt } = this.agent.context;
    const cacheAgeMs = lastAssistantAt === null ? null : Date.now() - lastAssistantAt;
    const cacheMissed = cacheAgeMs !== null && cacheAgeMs >= config.cacheMissedThresholdMs;
    if (!cacheMissed) return;

    const maxContextTokens = this.agent.config.modelCapabilities.max_context_tokens;
    const contextTokens = this.agent.context.tokenCountWithPending;
    const contextUsageRatio =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : 1;
    if (contextUsageRatio < config.minContextUsageRatio) return;

    const previousCutoff = this.cutoff;
    const nextCutoff = Math.max(0, history.length - config.keepRecentMessages);
    this.apply(nextCutoff);
    if (previousCutoff !== nextCutoff) {
      const effect = this.measureEffect(history, nextCutoff);
      const previousEffect = this.measureEffect(history, previousCutoff);
      const rawContextTokens = estimateTokensForMessages(history);
      // 此截止点变更前后的整体上下文长度，镜像 `compaction_finished` 上的
      // `tokensBefore`/`tokensAfter` 字段，以便两条压缩路径可在同一轴上比较。
      const tokensBefore =
        rawContextTokens -
        previousEffect.truncatedToolResultTokensBefore +
        previousEffect.truncatedToolResultTokensAfter;
      const tokensAfter =
        rawContextTokens -
        effect.truncatedToolResultTokensBefore +
        effect.truncatedToolResultTokensAfter;
      this.agent.telemetry.track('micro_compaction_finished', {
        ...config,
        ...effect,
        tokensBefore,
        tokensAfter,
        previous_cutoff: previousCutoff,
        cutoff: nextCutoff,
        message_count: history.length,
        cache_age_ms: cacheAgeMs,
      });
    }
  }

  /**
   * 对给定消息数组应用微压缩。`cutoff` 之前且内容超过
   * {@link MicroCompactionConfig.minContentTokens} 的工具结果消息被替换为截断标记。
   * 其他所有消息原样传递。
   *
   * 返回新数组（不修改输入）。
   */
  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.agent.experimentalFlags.enabled('micro_compaction')) return messages;

    const config = this.config;
    const result: ContextMessage[] = [];
    let i = 0;
    for (const msg of messages) {
      if (
        i < this.cutoff &&
        msg.role === 'tool' &&
        msg.toolCallId !== undefined &&
        estimateTokensForContentParts(msg.content) >= config.minContentTokens
      ) {
        result.push({
          ...msg,
          content: [{ type: 'text', text: config.truncatedMarker } satisfies ContentPart],
        });
      } else {
        result.push(msg);
      }
      i++;
    }
    return result;
  }

  /**
   * 衡量在给定截止点之前截断工具结果的 token 节省效果。
   * 返回受影响消息的数量和 token 差异（截断前 vs 截断后）。
   * 用于与完整压缩指标的遥测比较。
   */
  private measureEffect(
    messages: readonly ContextMessage[],
    cutoff: number,
  ) {
    let markerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let truncatedToolResultTokensBefore = 0;
    let truncatedToolResultTokensAfter = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens < this.config.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.config.truncatedMarker },
      ]);
      truncatedToolResultCount += 1;
      truncatedToolResultTokensBefore += contentTokens;
      truncatedToolResultTokensAfter += markerTokenCount;
    }
    return {
      truncatedToolResultCount,
      truncatedToolResultTokensBefore,
      truncatedToolResultTokensAfter,
    };
  }
}

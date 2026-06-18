/**
 * @module compaction/types
 *
 * 压缩子系统的核心类型定义。这些类型在完整压缩（基于 LLM 的摘要）和
 * 微压缩（工具结果截断）策略之间共享，并被 agent 循环、遥测和事件系统消费。
 */

/**
 * 单次压缩操作的结果，报告给遥测并作为 `compaction.completed` 事件的一部分发出。
 * Token 计数使用项目的 token 估算器（非提供者的 tokenizer），因此是近似值，
 * 主要用于相对比较。
 */
export interface CompactionResult {
  /** LLM 生成的摘要，替换被压缩的消息前缀。 */
  summary: string;
  /** 被摘要替换的历史消息数量。 */
  compactedCount: number;
  /** 压缩前对话的估算 token 数。 */
  tokensBefore: number;
  /** 摘要替换原始消息后的估算 token 数。 */
  tokensAfter: number;
}

/**
 * 区分压缩是由用户触发（例如 `/compact` 命令）还是由 agent 循环在
 * 上下文使用量超过阈值时自动触发。此值用作钩子匹配器，
 * 以便插件可以对不同触发源做出不同反应。
 */
export type CompactionSource = 'manual' | 'auto';

/**
 * 启动压缩时传递的数据载荷。对于手动压缩，用户可以提供额外指令
 * 来指导 LLM 的摘要风格或重点；自动压缩始终将其留为 undefined。
 */
export interface CompactionBeginData {
  /** 可选的用户提供的指令，追加到压缩提示词中。 */
  instruction?: string;
  /** 此压缩是用户发起还是自动触发。 */
  source: CompactionSource;
}

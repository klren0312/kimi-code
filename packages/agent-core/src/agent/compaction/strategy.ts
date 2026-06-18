/**
 * @module compaction/strategy
 *
 * 定义压缩策略抽象及其默认实现。
 * 策略为 agent 循环回答三个问题：
 *   1. **是否应该压缩？** — 上下文使用量是否足够高，值得启动后台压缩？
 *   2. **是否应该阻塞？** — 上下文使用量是否过高，agent 必须等待
 *      进行中的压缩完成后才能发起下一次 LLM 调用？
 *   3. **压缩多少条消息？** — 给定当前历史和压缩来源（手动 vs 自动），
 *      哪些消息前缀可以安全地发送给摘要 LLM？
 *
 * 默认实现（`DefaultCompactionStrategy`）使用相对于模型上下文窗口的
 * 比率阈值，并强制执行结构安全约束，确保 user/assistant/tool-call 边界
 * 不会被拆分。
 */

import type { Message } from "@moonshot-ai/kosong";
import { estimateTokensForMessage } from "../../utils/tokens";
import type { CompactionSource } from "./types";

/**
 * 可调节的配置项，控制压缩何时触发以及激进程度。
 * 所有比率均相对于模型的 `max_context_tokens`。
 */
export interface CompactionConfig {
  /** 触发后台压缩的上下文使用率（0–1）。 */
  triggerRatio: number;
  /**
   * 强制 agent 循环阻塞直到压缩完成的上下文使用率。
   * 当等于 `triggerRatio`（默认值）时，异步压缩实际上被禁用——压缩始终阻塞。
   */
  blockRatio: number;
  /**
   * 为压缩 LLM 调用本身预留的绝对 token 数。如果剩余空间小于此值，
   * 即使未达到 `triggerRatio` 也会触发压缩，以保证摘要提示词能够放入。
   */
  reservedContextSize: number;
  /**
   * 单个 agent 轮次中允许的最大压缩轮数。
   * `Infinity` 表示无限制。设为有限值以限制延迟。
   */
  maxCompactionPerTurn: number;
  /** 保持不压缩的最近消息最小数量。 */
  maxRecentMessages: number;
  /**
   * 保留的最近*用户*消息最大数量。有助于防止较长的多轮用户对话被完全摘要掉。
   */
  maxRecentUserMessages: number;
  /**
   * 保留的最近消息可占用上下文窗口的最大比例。
   * 防止少数非常大的消息被逐字保留而应被摘要。
   */
  maxRecentSizeRatio: number;
  /**
   * 上下文溢出错误后调用 `reduceCompactOnOverflow` 时必须回收的
   * 上下文窗口最小比例。确保重试确实释放了有意义的空间。
   */
  minOverflowReductionRatio: number;
}

/**
 * {@link CompactionConfig} 的工厂默认值。这些值设计为保守策略：
 * 压缩立即阻塞（无异步间隔），保留至少 4 条最近消息，
 * 溢出重试时至少回收 5% 的上下文窗口。
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.85,
  blockRatio: 0.85, // 与 triggerRatio 相同以禁用异步压缩
  reservedContextSize: 50_000,
  maxCompactionPerTurn: Infinity,
  maxRecentMessages: 4,
  maxRecentUserMessages: Infinity,
  maxRecentSizeRatio: 0.2,
  minOverflowReductionRatio: 0.05,
};

/**
 * 压缩决策的抽象接口。实现为纯逻辑——不调用 LLM 也不修改历史；
 * {@link FullCompaction} 类负责这些副作用。
 */
export interface CompactionStrategy {
  /**
   * 当上下文使用量足够高，值得启动一轮（可能后台的）压缩时返回 `true`。
   */
  shouldCompact(usedSize: number): boolean;
  /**
   * 当上下文使用量过高，agent 循环必须等待当前压缩完成才能发起下一次 LLM 调用时返回 `true`。
   */
  shouldBlock(usedSize: number): boolean;
  /**
   * 确定发送给摘要 LLM 的前导消息数量。
   * 返回值 `N` 表示 `messages.slice(0, N)` 将被压缩，
   * `messages.slice(N)` 将被逐字保留。当不存在安全的压缩点时返回 `0`。
   */
  computeCompactCount(messages: readonly Message[], source: CompactionSource): number;
  /**
   * 上下文溢出错误后调用，缩小压缩前缀直到摘要提示词本身能放入上下文窗口。
   * 返回修订后的压缩数量。
   */
  reduceCompactOnOverflow(messages: readonly Message[]): number;
  /**
   * 为 `true` 时，agent 循环应在每步之后（而非仅在之前）重新检查压缩。
   * 当 `triggerRatio < blockRatio` 时有用，以便在达到阈值后立即启动后台压缩。
   */
  readonly checkAfterStep: boolean;
  /** 每个 agent 轮次允许的最大压缩轮数。 */
  readonly maxCompactionPerTurn: number;
}

/**
 * 基于比率的压缩策略，使用模型的上下文窗口大小（从 `maxSizeProvider` 惰性获取）
 * 来决定何时触发和阻塞。消息选择遵循"保留近期、压缩旧消息"的方式，
 * 并通过结构安全检查避免拆分 tool-call/result 对。
 */
export class DefaultCompactionStrategy implements CompactionStrategy {
  /**
   * @param maxSizeProvider - 模型上下文窗口大小（token 数）的惰性访问器。
   *   每次检查时调用，以支持动态模型切换而无需重新创建策略。
   * @param config - 覆盖默认配置值的任意子集。
   */
  constructor(
    protected readonly maxSizeProvider: () => number,
    protected readonly config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
  ) { }

  /** 当前上下文窗口大小（token 数），委托给 provider。 */
  protected get maxSize(): number {
    return this.maxSizeProvider();
  }

  /**
   * 当使用量超过 `triggerRatio` 或剩余空间小于 `reservedContextSize` 时应启动压缩
   * （以保证摘要提示词能够放入）。
   */
  shouldCompact(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return (
      usedSize >= this.maxSize * this.config.triggerRatio ||
      this.shouldUseReservedContext(usedSize)
    );
  }

  /**
   * 当使用量超过 `blockRatio` 或预留上下文即将被消耗时，循环必须阻塞。
   */
  shouldBlock(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return (
      usedSize >= this.maxSize * this.config.blockRatio ||
      this.shouldUseReservedContext(usedSize)
    );
  }

  /**
   * 当剩余空间小于 `reservedContextSize` 时返回 `true`，表示摘要提示词可能无法放入。
   */
  private shouldUseReservedContext(usedSize: number): boolean {
    const reservedSize = this.config.reservedContextSize;
    return reservedSize > 0 && reservedSize < this.maxSize && usedSize + reservedSize >= this.maxSize;
  }

  /**
   * 确定可以压缩的最大安全消息前缀。
   *
   * 对于**手动**压缩，策略查找最新的安全分割点，
   * 使用户在摘要中获得最大上下文。
   *
   * 对于**自动**压缩，策略从尾部向后遍历，
   * 累积最近消息直到达到某个保留限制
   * （`maxRecentMessages`、`maxRecentUserMessages`、`maxRecentSizeRatio`），
   * 然后在该窗口内选择最新的安全分割点。这在满足保留约束的同时最小化压缩。
   *
   * 结果通过 {@link fitCompactCountToWindow} 进行限制，
   * 以确保摘要提示词本身能放入上下文窗口。
   */
  computeCompactCount(messages: readonly Message[], source: CompactionSource): number {
    // 返回值：N 条待压缩的消息（0 表示无法压缩）
    // LLM 输入：messages.slice(0, N) + [user:instruction]
    // 保留的最近消息：messages.slice(N)

    // 手动压缩
    if (source === 'manual') {
      for (let i = messages.length - 1; i > 0; i--) {
        if (canSplitAfter(messages, i)) {
          return this.fitCompactCountToWindow(messages, i + 1);
        }
      }
      return 0;
    }

    // 自动压缩规则（按优先级顺序）：
    // 1. messages[N-1] 之后的分割必须满足 `canSplitAfter` 的安全要求：
    //    messages[N-1] 不是 user 或带工具调用的 assistant，且保留的后缀
    //    messages.slice(N) 中没有孤立的工具结果。
    // 2. 至少保留一条最近消息
    // 3. 最多保留 maxRecentMessages 条最近消息
    // 4. 最多保留 maxRecentUserMessages 条最近用户消息
    // 5. 最多保留 maxRecentSizeRatio * maxSize 的最近消息
    // 6. N 应尽可能小

    let recentMessages = 1;
    let recentUserMessages = 0;
    let recentSize = 0;
    let bestN: number | undefined;

    for (; recentMessages < messages.length; recentMessages++) {
      const splitIndex = messages.length - recentMessages - 1;
      const m2 = messages[messages.length - recentMessages]!;

      if (m2.role === 'user') {
        recentUserMessages++;
      }
      recentSize += estimateTokensForMessage(m2);

      if (canSplitAfter(messages, splitIndex)) {
        bestN = splitIndex + 1;
      }

      const reachesMax = recentMessages >= this.config.maxRecentMessages
        || recentUserMessages >= this.config.maxRecentUserMessages
        || recentSize >= this.maxSize * this.config.maxRecentSizeRatio;
      if (reachesMax && bestN !== undefined) {
        break;
      }
    }

    return this.fitCompactCountToWindow(messages, bestN ?? 0);
  }

  /**
   * 压缩期间上下文溢出错误后调用。通过从压缩前缀尾部丢弃消息来缩小前缀，
   * 直到达到最小回收大小阈值或没有安全分割点。
   * 这确保重试确实释放了有意义的空间，而非用略微缩小的前缀重试。
   */
  reduceCompactOnOverflow(messages: readonly Message[]): number {
    const minReducedSize = Math.max(
      1,
      Math.ceil(this.maxSize * this.config.minOverflowReductionRatio),
    );
    let reducedSize = 0;
    let bestN: number | undefined;

    for (let i = messages.length - 2; i > 0; i--) {
      reducedSize += estimateTokensForMessage(messages[i + 1]!);
      if (canSplitAfter(messages, i)) {
        bestN = i + 1;
        if (reducedSize >= minReducedSize) {
          return i + 1;
        }
      }
    }
    return bestN ?? messages.length;
  }

  /**
   * 确保压缩前缀（发送给摘要 LLM 的消息）能放入上下文窗口。
   * 如果前缀过大，会从尾部逐步裁剪，直到剩余 token 能放入或没有安全分割点。
   */
  private fitCompactCountToWindow(
    messages: readonly Message[],
    compactedCount: number,
  ): number {
    if (this.maxSize <= 0 || compactedCount <= 0) {
      return compactedCount;
    }

    let compactedSize = 0;
    for (let i = 0; i < compactedCount; i++) {
      compactedSize += estimateTokensForMessage(messages[i]!);
    }
    if (compactedSize <= this.maxSize) {
      return compactedCount;
    }

    let bestN: number | undefined;
    for (let n = compactedCount - 1; n > 0; n--) {
      compactedSize -= estimateTokensForMessage(messages[n]!);
      if (!canSplitAfter(messages, n - 1)) {
        continue;
      }
      bestN = n;
      if (compactedSize <= this.maxSize) {
        return n;
      }
    }

    return bestN ?? compactedCount;
  }

  /**
   * 当 `triggerRatio < blockRatio` 时为 `true`，表示存在一个空间使压缩可以在步骤之后
   * 异步启动而不阻塞。
   */
  get checkAfterStep(): boolean {
    return this.config.triggerRatio !== this.config.blockRatio;
  }

  /** 单个 agent 轮次允许的最大压缩轮数。 */
  get maxCompactionPerTurn(): number {
    return this.config.maxCompactionPerTurn;
  }
}

/**
 * 判断压缩分割是否可以安全地放在 `messages[index]` 之后。分割安全的条件是：
 *   - `messages[index]` 本身不是 user 消息或带有待处理工具调用的 assistant 消息
 *     （将这两者与后续内容切断会破坏对话），且
 *   - 下一条消息不是工具结果。历史是格式良好的：
 *     工具结果仅出现在其所属的 `asst_w_tc` 之后，且一次交换的所有工具结果
 *     连续出现在下一条非工具消息之前。因此如果后缀以工具结果开头，
 *     其 `asst_w_tc` 必在压缩前缀中，这将使该结果成为孤立结果
 *     （例如在并行调用的 tool_a 和 tool_b 之间分割），且
 *   - 压缩前缀本身不以未解决的工具交换结束，因为待处理的工具结果必须保留在保留的尾部。
 *
 * @returns 当可以在 `messages[index]` 之后安全分割时返回 `true`。
 */
function canSplitAfter(messages: readonly Message[], index: number): boolean {
  const m = messages[index];
  if (m === undefined) return false;
  if (m.role === 'user') return false;
  if (m.role === 'assistant' && m.toolCalls.length > 0) return false;
  if (messages[index + 1]?.role === 'tool') return false;
  if (prefixEndsWithOpenToolExchange(messages, index)) return false;
  return true;
}

/**
 * 当 `index` 处的消息是工具结果，且其所属的 assistant 工具调用消息在前缀中，
 * 但工具结果少于工具调用时返回 `true`——这意味着工具调用交换仍然"开放"，
 * 剩余结果预期在后缀中。在此处分割会使这些待处理结果成为孤立结果。
 */
function prefixEndsWithOpenToolExchange(messages: readonly Message[], index: number): boolean {
  if (messages[index]?.role !== 'tool') return false;

  let toolResultCount = 0;
  for (let i = index; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) return false;
    if (message.role === 'tool') {
      toolResultCount++;
      continue;
    }
    return message.role === 'assistant' && message.toolCalls.length > toolResultCount;
  }
  return false;
}

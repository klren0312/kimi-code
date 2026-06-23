/**
 * 所有动态上下文注入器的基类。
 *
 * @module injector
 */

import type { Agent } from '..';

/**
 *
 * 动态注入器以受控节奏向代理的对话上下文追加系统提醒消息。子类实现
 * {@link getInjection} 来决定*注入什么*，并声明一个 {@link injectionVariant}
 * 标签，该标签会记录在生成的上下文消息上，用于后续的去重和生命周期追踪。
 *
 * **位置追踪** — 注入后，注入器记录注入*所在*的消息索引（`this.injectedAt`）。
 * 这使得基类可以在上下文被压缩或消息被移除时调整存储的位置，
 * 从而保证后续的节奏决策仍然正确。
 *
 * 子类可以覆盖生命周期钩子以添加自定义簿记
 * （例如记住上下文清除前计划模式是否处于激活状态）。
 */
export abstract class DynamicInjector {
  /** 上次注入所在的消息索引，若无注入则为 `null`。 */
  protected injectedAt: number | null = null;

  /**
   * @param agent - 此注入器向其对话上下文追加系统提醒的代理。
   */
  constructor(protected readonly agent: Agent) {}

  /**
   * 当对话上下文被完全清除时调用。重置存储的注入位置，
   * 使下一次 `inject()` 重新开始。
   */
  onContextClear(): void {
    this.injectedAt = null;
  }

  /**
   * 压缩从上下文头部移除消息后调用。调整 `injectedAt` 以补偿被移除的消息：
   * 存储的索引向下移动 `compactedCount - 1`（因为压缩会用一条摘要消息
   * 替代 N 条被移除的消息），如果结果低于零则使其失效。
   *
   * @param compactedCount - 压缩移除的消息数量。
   */
  onContextCompacted(compactedCount: number): void {
    if (this.injectedAt !== null) {
      const newInjectedAt = this.injectedAt - compactedCount + 1;
      this.injectedAt = newInjectedAt >= 0 ? newInjectedAt : null;
    }
  }

  /**
   * 当在 `index` 处移除单条消息时调用。如果存储的位置在被移除消息之后，
   * 则将其减一；如果指向被移除消息本身，则使其失效。
   *
   * @param index - 被移除消息在历史数组中的索引。
   */
  onContextMessageRemoved(index: number): void {
    if (this.injectedAt === null) return;
    if (index < this.injectedAt) {
      this.injectedAt--;
    } else if (index === this.injectedAt) {
      this.injectedAt = null;
    }
  }

  /**
   * 运行注入器：调用 {@link getInjection}，如果返回了内容，
   * 则向代理上下文追加系统提醒并记录注入位置。
   */
  async inject(): Promise<void> {
    const injection = await this.getInjection();
    if (injection) {
      this.injectedAt = this.agent.context.history.length;
      this.agent.context.appendSystemReminder(injection, {
        kind: 'injection',
        variant: this.injectionVariant,
      });
    }
  }

  /**
   * 记录在注入消息上的唯一标签，用于去重和生命周期过滤。
   * 每个子类声明自己的变体字符串。
   */
  protected abstract readonly injectionVariant: string;

  /**
   * 生成当前周期的注入内容。返回 `undefined`（或解析为它的 Promise）
   * 以跳过本轮注入。子类根据当前代理状态和自身的位置追踪来决定
   * 是否需要注入。
   */
  protected abstract getInjection(): string | Promise<string | undefined> | undefined;
}

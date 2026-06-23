/**
 * @module usage/index
 *
 * Agent 的 token 使用量统计。跟踪每个模型和每个 turn 的累积使用量，
 * 为 TUI 状态栏和遥测提供快照。使用量在 LLM 提供商返回时记录，
 * 并在内存中聚合——不进行磁盘持久化（使用量随会话重置）。
 */

import type { UsageStatus } from '#/rpc';
import { addUsage, type TokenUsage } from '@moonshot-ai/kosong';

import type { Agent } from '..';

/** 使用量记录的作用域：跨会话累积或仅限当前 turn。 */
export type UsageRecordScope = 'session' | 'turn';

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

/**
 * 记录和聚合 LLM API 响应中的 token 使用量。
 *
 * 维护两个视图：
 * - **会话级**：按模型名称分组的累积使用量，作为记录持久化用于回放/恢复。
 * - **Turn 级**：仅当前 turn 的使用量，通过 {@link beginTurn} / {@link endTurn}
 *   在 turn 边界重置。
 *
 * 所有快照返回防御性副本，调用方无法修改内部统计状态。
 */
export class UsageRecorder {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;

  constructor(protected readonly agent?: Agent) {}

  /** 在新 turn 开始时重置 turn 级使用量跟踪。 */
  beginTurn(): void {
    this.currentTurn = undefined;
  }

  /** 在 turn 结束时清除 turn 级使用量跟踪。 */
  endTurn(): void {
    this.currentTurn = undefined;
  }

  /**
   * 记录 LLM 响应中的 token 使用量。累积到会话级的每模型总量中，
   * 并可选地累积到当前 turn 的运行总计中。发出状态更新以便 TUI 刷新。
   *
   * @param model - 产生此使用量的模型名称。
   * @param usage - token 计数（提示词、补全等）。
   * @param scope - 是否同时累积到 turn 总计中。
   */
  record(model: string, usage: TokenUsage, scope: UsageRecordScope = 'session'): void {
    this.agent?.records.logRecord({
      type: 'usage.record',
      model,
      usage,
      usageScope: scope,
    });
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (scope === 'turn') {
      this.currentTurn =
        this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
    }
    this.agent?.emitStatusUpdated();
  }

  /**
   * 包含每模型细分、会话总计和当前 turn 使用量的完整使用量快照。
   * 返回所有数据的防御性副本。
   */
  data(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = this.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
    };
  }

  /**
   * TUI 使用的紧凑使用量状态，尚未记录任何使用量时返回 `undefined`。
   * 避免发出空快照。
   */
  status(): UsageStatus | undefined {
    const status = this.data();
    if (
      status.byModel === undefined &&
      status.total === undefined &&
      status.currentTurn === undefined
    ) {
      return undefined;
    }
    return status;
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

/** 将所有每模型使用量记录汇总为单个总计。 */
function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}

/**
 * @module replay/index
 *
 * Agent 会话的回放记录构建器。在 Agent 执行期间（或从持久化记录回放时）
 * 捕获结构化事件，以便 TUI 和调试工具重建会话历史。
 * 支持大范围会话的基于区间的分页，以及上下文压缩事件的撤销边界检测。
 */

import type { Agent } from '..';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '../../rpc/resumed';
import type { ContextMessage } from '../context';

/** 回放记录查询的分页选项。 */
export interface ReplayRangeOptions {
  /** 要包含的第一条记录的从零开始的索引。 */
  readonly start?: number;
  /** 要返回的最大记录数。 */
  readonly count?: number;
}

/** 回放构建器的配置。 */
export interface ReplayBuilderOptions {
  /** 分页回放的区间约束。 */
  readonly range?: ReplayRangeOptions;
}

const UNDO_BOUNDARY_RECORD_TYPES = new Set(['context.clear', 'context.apply_compaction']);

/**
 * 在 Agent 执行期间或基于记录的回放期间构建有序的回放记录列表。
 * 构建器支持两种模式：
 *
 * - **实时捕获**：在正常执行期间记录发生的事件。
 * - **回放**：在 `agent.resume()` 期间从持久化的 Agent 记录重建，
 *   并遵守基于区间的分页。
 *
 * 撤销边界（上下文清除/压缩）将回放分割为逻辑片段，
 * 使 TUI 能够展示有意义的会话片段，而非扁平的事件列表。
 */
export class ReplayBuilder {
  postRestoring = false;
  captureLiveRecords = false;
  protected readonly records: AgentReplayRecord[] = [];
  private frozen = false;
  private segmentStart = 0;

  constructor(
    public readonly agent: Agent,
    private readonly options: ReplayBuilderOptions = {},
  ) {}

  /**
   * 追加一条回放记录。仅当 Agent 处于恢复状态、正在实时捕获记录、
   * 或处于恢复后阶段时才会捕获记录。冻结的构建器会静默丢弃推入。
   */
  push(record: AgentReplayRecordPayload): void {
    if (this.captureLiveRecords || this.agent.records.restoring || this.postRestoring) {
      if (this.frozen) return;
      const stamped: AgentReplayRecord = {
        ...record,
        time: this.agent.records.restoring?.time ?? Date.now(),
      };
      this.records.push(stamped);
    }
  }

  /**
   * 在回放期间修补给定类型的最后一条记录。用于回填在记录初次创建时
   * 尚不可用的数据（例如在消息完全构建后添加消息 ID）。
   */
  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void {
    if (this.frozen) return;
    if (this.agent.records.restoring) {
      const last = this.records.at(-1);
      if (last && last.type === type) {
        Object.assign(last, patch);
      }
    }
  }

  /**
   * 移除其关联上下文消息已被删除的回放记录
   * （例如由上下文压缩或清除导致）。保持回放与实际对话状态同步。
   */
  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void {
    if (this.frozen) return;
    if (removedMessages.size === 0) return;
    this.removeMessagesFrom(this.records, removedMessages);
  }

  /**
   * 检查当前记录类型是否为撤销边界，以及构建器是否应冻结（停止接受更多记录）。
   * 当构建器已冻结且调用方应停止回放时返回 `true`。
   * 由记录回放循环用于实现基于区间的分页。
   */
  finishRestoringRecord(type: string): boolean {
    const range = this.options.range;
    if (range === undefined) return false;
    if (this.frozen) return true;
    if (!UNDO_BOUNDARY_RECORD_TYPES.has(type)) return false;
    if (range.start === undefined) return false;

    const start = range.start;
    const nextSegmentStart = this.segmentStart + this.records.length;
    if (nextSegmentStart > start) {
      this.frozen = true;
      return true;
    }

    this.segmentStart = nextSegmentStart;
    this.records.splice(0);
    return false;
  }

  /**
   * 生成最终的回放记录数组，如已配置则应用基于区间的分页。
   * 仅指定 `count` 时返回最后 N 条记录。指定 `start` 时
   * 返回从该偏移量开始的记录。
   */
  buildResult(): readonly AgentReplayRecord[] {
    const range = this.options.range;
    if (range !== undefined) {
      if (range.start === undefined && range.count !== undefined) {
        const offset = Math.max(0, this.records.length - range.count);
        return this.records.slice(offset);
      }
      const start = range.start ?? 0;
      const offset = Math.max(0, start - this.segmentStart);
      const count = range.count;
      const end = count === undefined ? undefined : offset + count;
      return this.records.slice(offset, end);
    }
    return this.records;
  }

  private removeMessagesFrom(
    records: AgentReplayRecord[],
    removedMessages: ReadonlySet<ContextMessage>,
  ): void {
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      if (record.type === 'message' && removedMessages.has(record.message)) {
        records.splice(i, 1);
      }
    }
  }
}

/**
 * `MessageService` — `IMessageService` 的实现。
 *
 * 历史来源：agent 的 `wire.jsonl` 记录日志，而非实时的 `getContext().history`。
 * 实时历史是模型的当前上下文——压缩后会折叠为 `[compaction_summary, ...tail]`，
 * 导致 `GET /sessions/{sid}/messages` 丢失折叠前的所有内容。wire 日志保留每条
 * 记录，因此 `readWireTranscript` 能重建完整的对话记录（与 TUI 在 resume 后
 * 显示的视图相同）。具体镜像语义见 `./transcript.ts`。
 *
 * 实时尾部合并：记录通过异步刷新队列写入磁盘，因此请求命中正在运行的会话时，
 * wire 文件可能比内存少几条记录。`WireTranscript.foldedLength` 是文件记录
 * 对应的实时历史长度；真实 `getContext().history` 中超出此长度的部分即为
 * 未刷新的尾部，会被追加。
 *
 * 降级策略：任何对话记录读取/解析失败都会降级到旧行为（实时上下文历史），
 * 而非使端点失败。
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { SessionSummary } from '../../rpc';
import type {
  Message,
  PageResponse,
} from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { SessionNotFoundError } from '../session/session';
import {
  IMessageService,
  MessageNotFoundError,
  parseMessageId,
  toProtocolMessage,
  type MessageListQuery,
} from './message';
import {
  readWireTranscript,
  type TranscriptEntry,
  type WireTranscript,
} from './transcript';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** 所有会话作用域 getContext 调用使用的 agent id（匹配 agent-core 约定；见 `core-impl.ts:788`）。 */
const MAIN_AGENT_ID = 'main';
/** 缓存在内存中的已解析 wire 对话记录（每会话一条，LRU 淘汰）。 */
const TRANSCRIPT_CACHE_LIMIT = 8;

interface TranscriptCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly transcript: WireTranscript;
}

export class MessageService extends Disposable implements IMessageService {
  readonly _serviceBrand: undefined;

  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sid: string, query: MessageListQuery): Promise<PageResponse<Message>> {
    const all = await this._getProtocolMessages(sid);
    // SCHEMAS §1.3: "缺省返回最近 N 条 (created_at desc)"——最新优先。
    const desc = [...all].reverse();

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.after_id);
    }

    let slice: Message[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = 更早的条目 → desc 数组的尾部，不包含 pivot。
      slice = desc.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = 更新的条目 → desc 数组的头部，不包含 pivot。
      slice = desc.slice(0, pivotIndex);
    } else {
      slice = desc;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const page = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // 角色过滤在分页之后应用——见文件头注释。
    const filtered =
      query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

    return { items: filtered, has_more: hasMore };
  }

  async get(sid: string, mid: string): Promise<Message> {
    // 先解析会话：未知 sid 必须映射为 40401，即使消息 id 格式错误或属于
    // 其他会话（40403）。
    const all = await this._getProtocolMessages(sid);
    const parsed = parseMessageId(mid);
    if (parsed === undefined || parsed.sessionId !== sid) {
      throw new MessageNotFoundError(sid, mid);
    }
    const entry = all[parsed.index];
    if (entry === undefined) {
      throw new MessageNotFoundError(sid, mid);
    }
    return entry;
  }

  /**
   * 确认会话存在并返回其摘要（用于时间戳基准）。
   * 未找到时抛出 `SessionNotFoundError`（→ 40401）。
   */
  private async _requireSession(sid: string): Promise<SessionSummary> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === sid);
    if (summary === undefined) {
      throw new SessionNotFoundError(sid);
    }
    return summary;
  }

  /**
   * 完整对话记录映射为协议消息。id 保持索引派生；
   * `created_at` 在已知时使用 wire 记录时间，调整为严格递增
   * 以使游标消费者保持稳定的全序关系。
   */
  private async _getProtocolMessages(sid: string): Promise<Message[]> {
    const summary = await this._requireSession(sid);
    const entries = await this._getTranscriptEntries(sid, summary);
    let previousMs = Number.NEGATIVE_INFINITY;
    return entries.map((entry, idx) => {
      const baseMs = entry.time ?? summary.createdAt + idx;
      const createdAtMs = Math.max(previousMs + 1, baseMs);
      previousMs = createdAtMs;
      return toProtocolMessage(sid, idx, entry.message, summary.createdAt, createdAtMs);
    });
  }

  /**
   * wire 对话记录 + 未刷新的实时尾部；当 wire 文件不可读时降级为
   * 仅实时上下文历史。读取顺序很重要：文件在 `getContext` 之前读取，
   * 以确保内存中的历史始终至少与文件快照一样新，尾部合并只能追加。
   */
  private async _getTranscriptEntries(
    sid: string,
    summary: SessionSummary,
  ): Promise<readonly TranscriptEntry[]> {
    await this._resumeSession(sid);
    const transcript = await this._readTranscriptCached(sid, summary.sessionDir);
    const context = await this.core.rpc.getContext({
      sessionId: sid,
      agentId: MAIN_AGENT_ID,
    });
    if (transcript === undefined) {
      return context.history.map((message) => ({ message }));
    }
    if (context.history.length <= transcript.foldedLength) {
      return transcript.entries;
    }
    const liveTail: TranscriptEntry[] = context.history
      .slice(transcript.foldedLength)
      .map((message) => ({ message }));
    return [...transcript.entries, ...liveTail];
  }

  private async _resumeSession(sid: string): Promise<void> {
    try {
      await this.core.rpc.resumeSession({ sessionId: sid });
    } catch {
      throw new SessionNotFoundError(sid);
    }
  }

  /**
   * 读取并 reduce wire 日志，按 `(size, mtimeMs)` 缓存，避免分页调用
   * 重复解析未变更的文件。文件缺失或不可读时返回 `undefined`
   *（调用方降级到实时视图）。
   */
  private async _readTranscriptCached(
    sid: string,
    sessionDir: string,
  ): Promise<WireTranscript | undefined> {
    try {
      const wirePath = path.join(sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl');
      const info = await stat(wirePath);
      const cached = this.transcriptCache.get(sid);
      if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        // 刷新 LRU 位置。
        this.transcriptCache.delete(sid);
        this.transcriptCache.set(sid, cached);
        return cached.transcript;
      }
      const transcript = await readWireTranscript(sessionDir, MAIN_AGENT_ID);
      this.transcriptCache.delete(sid);
      this.transcriptCache.set(sid, { size: info.size, mtimeMs: info.mtimeMs, transcript });
      while (this.transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
        const oldest = this.transcriptCache.keys().next().value;
        if (oldest === undefined) break;
        this.transcriptCache.delete(oldest);
      }
      return transcript;
    } catch {
      return undefined;
    }
  }
}

// 在全局单例注册表中自行注册。所有构造函数依赖均通过 `@I…` 注入；
// `staticArguments = []`。`supportsDelayedInstantiation = false`
// 保持当前的反向 dispose 语义。
registerSingleton(IMessageService, MessageService, InstantiationType.Delayed);

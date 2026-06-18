/**
 * wire 对话记录读取器——从会话 agent 的 `wire.jsonl` 记录日志中重建完整消息历史。
 *
 * 背景：`ContextMemory.applyCompaction` 会将内存中的历史重写为
 * `[compaction_summary, ...tail]`，因此 `getContext().history` 仅反映模型的
 * 当前上下文。但 wire 日志保留每条记录。TUI 在 resume 后显示完整对话记录，
 * 因为 `ReplayBuilder` 在记录回放期间捕获每次 `pushHistory`，且不会被压缩
 * 折叠。此模块为守护进程 REST 消费者（web）复现完全相同的视图，无需修改
 * agent-core：使用与 `ContextMemory` 恢复相同的语义重新 reduce `context.*` 记录，
 * 但 `context.apply_compaction` 在折叠点插入摘要消息，而非丢弃被压缩的前缀。
 *
 * 镜像 agent-core 语义（packages/agent-core/src/agent/context/index.ts）：
 *   - `context.append_message`      → 追加（在工具交换打开期间延迟执行）
 *   - `context.append_loop_event`   → step.begin/content.part/tool.call 修改打开的
 *                                     assistant 消息；tool.result 追加一条工具消息，
 *                                     使用与 `toolResultOutputForModel` 相同的
 *                                     `<system>` 状态包装
 *   - `context.apply_compaction`    → 保留前缀，在折叠点插入摘要消息
 *                                    （origin 为 `compaction_summary`）
 *   - `context.undo`                → 精确移除尾部消息，与 `ContextMemory.undo`
 *                                     一致（跳过注入消息，遇到压缩摘要/`context.clear`
 *                                     下限时停止）
 *   - `context.clear`               → 在对话记录中保留先前消息（TUI 回放也保留），
 *                                     但重置折叠视图
 *
 * blob 引用（`blobref:<mime>;<hash>` URL，由 `BlobStore` 卸载）从
 * `<agentDir>/blobs/<hash>` 还原为 data URI，镜像 `BlobStore.rehydrateParts`。
 *
 * 调用方必须在读取前先 `resumeSession`：回放会就地重写过时的 wire 协议版本，
 * 因此 resume 后的读取始终看到当前记录形状。读取正在运行的会话时，可能比
 * 内存中的历史少几条仍在持久化刷新队列中的记录——比较 `foldedLength` 与
 * 实时 `getContext().history` 长度并追加缺失的尾部（见 `MessageService`）。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentRecord } from '../../agent/records';
import type { ContextMessage } from '../../agent/context';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../loop';

type ContentPart = ContextMessage['content'][number];

const BLOBREF_PROTOCOL = 'blobref:';
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

// 状态字符串必须与 agent-core 的 toolResultOutputForModel 匹配，以使
// 对话记录渲染的工具结果与 getContext().history 字节级一致。
const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export interface TranscriptEntry {
  readonly message: ContextMessage;
  /** 产生该记录的 wall-clock 时间（如存在）。 */
  readonly time?: number | undefined;
}

export interface WireTranscript {
  /** 完整消息历史，包含被压缩的前缀。 */
  readonly entries: readonly TranscriptEntry[];
  /**
   * 实时（折叠后的）`context.history` 在这些记录之后应有的长度。
   * 供调用方检测并追加尚未刷新的实时尾部。
   */
  readonly foldedLength: number;
}

interface MutableMessage {
  role: ContextMessage['role'];
  content: ContentPart[];
  toolCalls: { type: 'function'; id: string; name: string; arguments: string | null }[];
  toolCallId?: string;
  isError?: boolean | undefined;
  origin?: ContextMessage['origin'];
}

interface MutableEntry {
  message: MutableMessage;
  time?: number | undefined;
}

/**
 * 将 wire 记录 reduce 为完整对话记录。纯函数（无 I/O）；导出供测试使用。
 * 未知或非 context 记录被忽略——只有 `context.*` 记录在 agent-core 中修改历史，
 * 每个其他修改路径都会记录一条。
 */
export function reduceWireRecords(records: Iterable<AgentRecord>): {
  entries: TranscriptEntry[];
  foldedLength: number;
} {
  const transcript: MutableEntry[] = [];
  /** 当前 `context.history.length` 的值（折叠后）。 */
  let foldedLength = 0;
  /** 对话记录索引，`context.undo` 不得跨越此下限（由 `context.clear` 设置）。 */
  let clearFloor = 0;
  const openSteps = new Map<string, MutableEntry>();
  const pendingToolResultIds = new Set<string>();
  let deferred: MutableEntry[] = [];

  const push = (...entries: MutableEntry[]): void => {
    transcript.push(...entries);
    foldedLength += entries.length;
  };
  const flushDeferredIfToolExchangeClosed = (): void => {
    if (pendingToolResultIds.size > 0 || deferred.length === 0) return;
    push(...deferred);
    deferred = [];
  };
  const resetOpenState = (): void => {
    openSteps.clear();
    pendingToolResultIds.clear();
    deferred = [];
  };

  const applyLoopEvent = (event: LoopRecordedEvent, time: number | undefined): void => {
    switch (event.type) {
      case 'step.begin': {
        const entry: MutableEntry = {
          message: { role: 'assistant', content: [], toolCalls: [] },
          time,
        };
        push(entry);
        openSteps.set(event.uuid, entry);
        return;
      }
      case 'step.end': {
        openSteps.delete(event.uuid);
        flushDeferredIfToolExchangeClosed();
        return;
      }
      case 'content.part': {
        // 比 ContextMemory 更宽松：损坏文件中的悬挂 part 不应拖垮整个消息端点。
        openSteps.get(event.stepUuid)?.message.content.push(event.part);
        return;
      }
      case 'tool.call': {
        const openStep = openSteps.get(event.stepUuid);
        if (openStep === undefined) return;
        openStep.message.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
        });
        pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        push({
          message: {
            role: 'tool',
            content: toolResultContent(event.result),
            toolCalls: [],
            toolCallId: event.toolCallId,
            isError: event.result.isError,
          },
          time,
        });
        pendingToolResultIds.delete(event.toolCallId);
        flushDeferredIfToolExchangeClosed();
        return;
      }
    }
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    let removedUserCount = 0;
    for (let i = transcript.length - 1; i >= clearFloor; i--) {
      const message = transcript[i]!.message;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      transcript.splice(i, 1);
      foldedLength = Math.max(0, foldedLength - 1);
      if (isRealUserPrompt(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }
    resetOpenState();
  };

  for (const record of records) {
    switch (record.type) {
      case 'context.append_message': {
        const entry: MutableEntry = {
          message: record.message as MutableMessage,
          time: record.time,
        };
        if (pendingToolResultIds.size > 0) {
          deferred.push(entry);
        } else {
          push(entry);
        }
        break;
      }
      case 'context.append_loop_event':
        applyLoopEvent(record.event, record.time);
        break;
      case 'context.apply_compaction': {
        // ContextMemory 丢弃 history[0..compactedCount] 并在头部插入摘要；
        // 我们保留前缀并在折叠点插入摘要，使对话记录同时展示两者。
        const tailLength = Math.max(0, foldedLength - record.compactedCount);
        transcript.splice(Math.max(0, transcript.length - tailLength), 0, {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: record.summary }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          },
          time: record.time,
        });
        foldedLength = tailLength + 1;
        openSteps.clear();
        flushDeferredIfToolExchangeClosed();
        break;
      }
      case 'context.undo':
        applyUndo(record.count);
        break;
      case 'context.clear':
        clearFloor = transcript.length;
        foldedLength = 0;
        resetOpenState();
        break;
      default:
        break;
    }
  }

  return { entries: transcript as TranscriptEntry[], foldedLength };
}

/** 镜像 agent-core 的 `isRealUserPrompt`（context undo 计数）。 */
function isRealUserPrompt(message: MutableMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  return false;
}

/** 镜像 agent-core 的 `toolResultOutputForModel` + `createToolMessage`。 */
function toolResultContent(result: ExecutableToolResult): ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    let text: string;
    if (result.isError === true) {
      if (output.length === 0) text = TOOL_EMPTY_ERROR_STATUS;
      else if (output.trimStart().startsWith('<system>ERROR:')) text = output;
      else text = `${TOOL_ERROR_STATUS}\n${output}`;
    } else {
      text =
        output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT
          ? TOOL_EMPTY_STATUS
          : output;
    }
    return [{ type: 'text', text }];
  }
  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output];
  }
  return [...output];
}

/**
 * 解析 `wire.jsonl` 文件。截断的最后一行（刷写中途崩溃）会被丢弃，
 * 与 `FileSystemAgentRecordPersistence.read` 一致；其他位置的损坏会抛出异常，
 * 以便调用方降级到实时上下文视图。
 */
export async function readWireRecords(wirePath: string): Promise<AgentRecord[]> {
  const raw = await readFile(wirePath, 'utf8');
  const lines = raw.split('\n');
  const records: AgentRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as AgentRecord);
    } catch (parseError) {
      if (i === lines.length - 1) break;
      throw new Error(
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        { cause: parseError },
      );
    }
  }
  return records;
}

/**
 * 重建单个会话 agent 的完整对话记录。调用方应已先 resume 会话
 *（wire 协议迁移——见文件头注释）。
 */
export async function readWireTranscript(
  sessionDir: string,
  agentId: string,
): Promise<WireTranscript> {
  const agentDir = path.join(sessionDir, 'agents', agentId);
  const records = await readWireRecords(path.join(agentDir, 'wire.jsonl'));
  const { entries, foldedLength } = reduceWireRecords(records);
  await rehydrateBlobRefs(entries, path.join(agentDir, 'blobs'));
  return { entries, foldedLength };
}

/**
 * 将 `blobref:<mime>;<hash>` 媒体 URL 替换为从 agent blob 存储中读取的
 * `data:` URI，镜像 `BlobStore.rehydrateParts`。无法解析的引用变为
 * `[media missing]`，与 agent-core 一致。
 */
async function rehydrateBlobRefs(
  entries: readonly TranscriptEntry[],
  blobsDir: string,
): Promise<void> {
  const cache = new Map<string, string | undefined>();
  for (const entry of entries) {
    for (const part of entry.message.content) {
      for (const value of Object.values(part as unknown as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        const media = value as { url?: unknown };
        if (typeof media.url !== 'string' || !media.url.startsWith(BLOBREF_PROTOCOL)) {
          continue;
        }
        media.url = (await resolveBlobRef(media.url, blobsDir, cache)) ?? MISSING_MEDIA_PLACEHOLDER;
      }
    }
  }
}

async function resolveBlobRef(
  url: string,
  blobsDir: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (cache.has(url)) return cache.get(url);
  let resolved: string | undefined;
  const rest = url.slice(BLOBREF_PROTOCOL.length);
  const semiIdx = rest.indexOf(';');
  if (semiIdx !== -1) {
    const mimeType = rest.slice(0, semiIdx);
    const hash = rest.slice(semiIdx + 1);
    // 哈希是 BlobStore 写入的十六进制摘要；拒绝任何可能逃逸出 blobs 目录的内容。
    if (/^[0-9a-f]{16,}$/i.test(hash)) {
      const payload = await readFile(path.join(blobsDir, hash)).catch(() => undefined);
      if (payload !== undefined) {
        resolved = `data:${mimeType};base64,${payload.toString('base64')}`;
      }
    }
  }
  cache.set(url, resolved);
  return resolved;
}

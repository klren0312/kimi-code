/**
 * `IMessageService` — daemon 面向的消息历史接口。
 *
 * 封装 `ICoreProcessService.rpc.getContext({sessionId, agentId})` 并将
 * agent-core 的 `ContextMessage` 历史形状（kosong `Message` + origin）适配为
 * 协议的 SCHEMAS.md §3 `Message` 按 content 判别的联合类型。
 *
 * 端点映射（REST.md §3.4）：
 *   GET  /v1/sessions/{sid}/messages         → list(sid, ListMessagesQuery)
 *   GET  /v1/sessions/{sid}/messages/{mid}   → get(sid, mid)
 *
 * 哨兵错误：
 *   - `SessionNotFoundError`   → 40401（路由层映射）
 *   - `MessageNotFoundError`   → 40403（路由层映射）
 *
 * 适配器在下方实现中记录。
 *
 * **字段映射**（kosong/agent-core → 协议）：
 *
 *   ContextMessage.role               →  Message.role            (1:1)
 *   ContextMessage.content[]          →  Message.content[]       （按 part 适配；见下）
 *   ContextMessage.toolCalls[]        →  Message.content[]       （追加为 `tool_use` content part）
 *   ContextMessage.toolCallId         →  Message.content[].tool_call_id  （role==='tool' 时 body 变为 tool_result）
 *   ContextMessage.isError            →  Message.content[0].is_error （仅在 tool_result 上）
 *
 * Content-part 适配器（kosong ContentPart → SCHEMAS MessageContent）：
 *
 *   { type:'text',      text }            → { type:'text', text }
 *   { type:'think',     think, encrypted? } → { type:'thinking', thinking:think, signature?:encrypted }
 *   { type:'image_url', imageUrl }        → { type:'image', source:{kind:'url', url:imageUrl.url } }
 *                                            （file/base64 保留给未来的 kosong 形状）
 *   { type:'audio_url', audioUrl }        → { type:'text', text:`[audio:${audioUrl.url}]` }
 *                                            （SCHEMAS §3 无 audio content 变体；有损展平）
 *   { type:'video_url', videoUrl }        → { type:'text', text:`[video:${videoUrl.url}]` }
 *                                            （同 audio — §3 无 video 变体）
 *
 * **ID 合成**：kosong 的 `Message` 没有 `id`。从 `(sessionId, history_index)` 推导
 * 确定性 id：
 *
 *     id = `msg_<sessionId>_<6-digit-index>`
 *
 * **分页**：SCHEMAS §1.3 / REST §3.4 规定默认 50、最大 100 — 在路由层应用。
 * 此实现接收完全验证过的查询。
 */

import { createDecorator } from '../../di';
import type { ContextMessage } from '../../agent/context';
import type {
  CursorQuery,
  Message,
  MessageContent,
  MessageRole,
  PageResponse,
  ToolUseContent,
} from '@moonshot-ai/protocol';

/**
 * 列表查询 — `before_id`/`after_id` + `page_size` 互斥约束由
 * `cursorQuerySchema` 强制。服务层添加可选的角色过滤器。
 */
export interface MessageListQuery extends CursorQuery {
  role?: MessageRole;
}

export interface IMessageService {
  readonly _serviceBrand: undefined;

  /**
   * `GET /v1/sessions/{sid}/messages` — 分页消息历史。
   *
   * 默认 `page_size = 50`，最大 100（REST.md §3.4 / SCHEMAS §1.3）。
   * 默认值在路由层应用。
   *
   * `before_id` / `after_id` 是基于消息 id（ULID，可按时间排序）的游标。
   * 结果顺序为 `created_at desc`；以升序显示的客户端应调用 `.reverse()`。
   *
   * `sid` 不存在时抛出 `SessionNotFoundError`（→ 40401）。
   */
  list(sid: string, query: MessageListQuery): Promise<PageResponse<Message>>;

  /**
   * `GET /v1/sessions/{sid}/messages/{mid}` — 按 id 获取单条消息。
   *
   * `sid` 不存在时抛出 `SessionNotFoundError`（→ 40401）。
   * session 已知但历史中不存在 `mid` 对应的消息时抛出
   * `MessageNotFoundError`（→ 40403）。
   */
  get(sid: string, mid: string): Promise<Message>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMessageService = createDecorator<IMessageService>('messageService');

/**
 * 哨兵错误 — daemon 的路由层捕获并映射为 `code: 40403`（message.not_found）。
 */
export class MessageNotFoundError extends Error {
  readonly sessionId: string;
  readonly messageId: string;
  constructor(sessionId: string, messageId: string) {
    super(`message ${messageId} does not exist in session ${sessionId}`);
    this.name = 'MessageNotFoundError';
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}

/**
 * 从 (sessionId, index) 推导稳定的消息 id。格式记录在模块头注释中。
 */
export function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

/**
 * `deriveMessageId` 的逆操作：将 `msg_<sessionId>_<index>` 解析回
 * `{sessionId, index}`。若 id 不符合 `MessageService` 的 ULID 形状约定，
 * 返回 `undefined`。
 */
export function parseMessageId(
  messageId: string,
): { sessionId: string; index: number } | undefined {
  if (!messageId.startsWith('msg_')) return undefined;
  const rest = messageId.slice('msg_'.length);
  // sessionId 本身可能包含下划线（sess_01HZZZ...），因此从右侧按 '_' 分割。
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore <= 0) return undefined;
  const sessionId = rest.slice(0, lastUnderscore);
  const indexStr = rest.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(indexStr)) return undefined;
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isFinite(index) || index < 0) return undefined;
  return { sessionId, index };
}

/**
 * kosong 的 `Message.role` 为 `'system' | 'user' | 'assistant' | 'tool'` —
 * 已与 SCHEMAS §3 的 `MessageRole` 对齐。直接透传。
 */
function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

/**
 * 将 kosong content part 转换为 SCHEMAS §3 content part。完整映射表见模块头注释。
 */
function mapContentPart(part: ContextMessage['content'][number]): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think': {
      const sig = part.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: part.think, signature: sig }
        : { type: 'thinking', thinking: part.think };
    }
    case 'image_url':
      return {
        type: 'image',
        source: { kind: 'url', url: part.imageUrl.url },
      };
    case 'audio_url':
      // SCHEMAS §3 无 audio content �变体；展平为 `text` 标记
      // 以保持线路形状类型合法，无需发明新 schema。
      return {
        type: 'text',
        text: `[audio:${part.audioUrl.url}]`,
      };
    case 'video_url':
      return {
        type: 'text',
        text: `[video:${part.videoUrl.url}]`,
      };
  }
}

/**
 * 为一个 ContextMessage 构建协议形状的 `Message.content[]`。
 *
 * 顺序：
 *   1. `tool` 角色：发出单个 `tool_result` part。输出是 kosong 消息的
 *      content part 的展平文本（大多数工具消息发出单个 text）。`is_error`
 *      来自 `ContextMessage.isError`。
 *   2. 其他角色：按 `mapContentPart` 映射每个 content part，
 *      然后为每个 `ToolCall` 追加一个 `tool_use` part（仅 assistant）。
 */
function buildProtocolContent(msg: ContextMessage): MessageContent[] {
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      // 防御性处理 — kosong 工具消息始终携带 toolCallId。若缺失，
      // 回退到文本透传以不丢失用户可见内容。
      return msg.content.map((p) => mapContentPart(p));
    }
    const flattenedOutput = msg.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    const part: MessageContent = msg.isError === true
      ? {
          type: 'tool_result',
          tool_call_id: msg.toolCallId,
          output: flattenedOutput,
          is_error: true,
        }
      : {
          type: 'tool_result',
          tool_call_id: msg.toolCallId,
          output: flattenedOutput,
        };
    return [part];
  }

  const base = msg.content.map((p) => mapContentPart(p));

  if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
    for (const call of msg.toolCalls) {
      let parsedInput: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          parsedInput = JSON.parse(call.arguments);
        } catch {
          parsedInput = call.arguments;
        }
      }
      const part: ToolUseContent = {
        type: 'tool_use',
        tool_call_id: call.id,
        tool_name: call.name,
        input: parsedInput,
      };
      base.push(part);
    }
  }

  return base;
}

/**
 * 将历史数组中的一个条目转换为协议的 `Message` 形状。
 *
 * `sessionCreatedAtMs` 是 session 的 `createdAt`（毫秒）。我们加上 index
 * 使每条消息的 `created_at` 在数组中单调递增。知道真实记录时间的调用方
 * 可传入 `createdAtMs` 覆盖合成值（MessageService 对线路来源的条目这样做）。
 */
export function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: ContextMessage,
  sessionCreatedAtMs: number,
  createdAtMsOverride?: number,
): Message {
  const id = deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = createdAtMsOverride ?? sessionCreatedAtMs + index;
  // 通过 metadata 暴露消息来源（kosong/agent-core 的 `origin`），使 REST 客户端
  //（如 web UI）能隐藏注入的/系统的 user 轮次 — 压缩摘要、注入、hook 结果、
  // 重试、系统触发、定时等 — 与 TUI 的方式相同（参见 isReplayUserTurnRecord）。
  // 普通的无 origin 的 user/assistant/tool 消息不带此字段。
  const metadata = msg.origin !== undefined ? { origin: msg.origin } : undefined;
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: new Date(createdAtMs).toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

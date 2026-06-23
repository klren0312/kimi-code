/**
 * @module compaction/render-messages
 *
 * 将对话历史渲染为人类和 LLM 可读的纯文本格式。
 * 压缩系统使用此模块将结构化的 {@link Message} 数组转换为
 * 摘要 LLM 作为输入看到的文本。
 *
 * 每条消息渲染为带有元数据头（role、name、toolCallId、partial 标志）
 * 的分隔块，后跟其内容部分和工具调用。媒体 URL 作为文本引用包含；
 * 思考块被逐字保留。输出设计为对文本内容无损，同时保持可被摘要模型解析。
 */

import type { Message } from '@moonshot-ai/kosong';

/**
 * 将消息数组渲染为单个文本字符串，每条消息之间用空行分隔。
 * 输出中消息索引从 1 开始，以符合人类可读惯例。
 */
export function renderMessagesToText(messages: readonly Message[]): string {
  return messages.map((message, index) => renderMessageToText(message, index)).join('\n\n');
}

/**
 * 将单条消息渲染为分隔文本块。头行包含 role、可选的 name/toolCallId/partial 元数据。
 * 内容部分和工具调用作为缩进块跟在后面。
 */
function renderMessageToText(message: Message, index: number): string {
  const header = [`message ${String(index + 1)}`, `role=${message.role}`];
  if (message.name !== undefined) {
    header.push(`name=${JSON.stringify(message.name)}`);
  }
  if (message.toolCallId !== undefined) {
    header.push(`toolCallId=${JSON.stringify(message.toolCallId)}`);
  }
  if (message.partial === true) {
    header.push('partial=true');
  }

  const lines = [`--- ${header.join(' ')} ---`];
  if (message.content.length === 0) {
    lines.push('[empty content]');
  } else {
    lines.push(...message.content.map(renderContentPartToText));
  }

  if (message.toolCalls.length > 0) {
    lines.push('tool calls:');
    for (const toolCall of message.toolCalls) {
      lines.push(renderToolCallToText(toolCall));
    }
  }

  return lines.join('\n');
}

/**
 * 将单个内容部分渲染为其文本表示。处理文本、思考、图片/音频/视频 URL
 * 和未知类型（序列化为 JSON）。
 */
function renderContentPartToText(part: Message['content'][number]): string {
  switch (part.type) {
    case 'text':
      return renderBlock('text', part.text);
    case 'think':
      return renderBlock('think', part.think);
    case 'image_url':
      return renderMediaPart('image_url', part.imageUrl.url, part.imageUrl.id);
    case 'audio_url':
      return renderMediaPart('audio_url', part.audioUrl.url, part.audioUrl.id);
    case 'video_url':
      return renderMediaPart('video_url', part.videoUrl.url, part.videoUrl.id);
    default:
      return renderBlock('content', stringifyJsonish(part));
  }
}

/**
 * 将工具调用渲染为文本：第一行为调用 ID 和名称，
 * 后跟（格式化的）参数和可选的附加信息作为缩进块。
 */
function renderToolCallToText(toolCall: Message['toolCalls'][number]): string {
  const lines = [
    `- ${toolCall.id}: ${toolCall.name}`,
    renderBlock('arguments', renderToolCallArguments(toolCall.arguments)),
  ];

  if (toolCall.extras !== undefined) {
    lines.push(renderBlock('extras', stringifyJsonish(toolCall.extras)));
  }

  return lines.join('\n');
}

/**
 * 格式化工具调用参数。如果参数是有效的 JSON 则带缩进重新序列化；
 * 否则返回原始字符串。
 */
function renderToolCallArguments(args: string | null): string {
  if (args === null) return 'null';

  try {
    return stringifyJsonish(JSON.parse(args));
  } catch {
    return args;
  }
}

/**
 * 将媒体内容部分（图片/音频/视频 URL）渲染为单行，
 * 如果存在则可选地包含媒体 ID。
 */
function renderMediaPart(type: string, url: string, id?: string | undefined): string {
  if (id === undefined) return `${type}: ${url}`;
  return `${type}: ${url} (id=${id})`;
}

/** 用标签头和缩进主体包装一个值。 */
function renderBlock(label: string, value: string): string {
  return `${label}:\n${indentBlock(value)}`;
}

/** 将 `value` 的每一行缩进两个空格以实现视觉嵌套。 */
function indentBlock(value: string): string {
  if (value.length === 0) return '  ';
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * JSON.stringify 封装，安全处理 BigInt、函数、symbol 和循环引用——
 * 这些值通常会抛出异常或被静默丢弃。这确保渲染输出始终是字符串，
 * 即使对于特殊的工具调用参数也是如此。
 */
function stringifyJsonish(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, nested: unknown): unknown => {
    if (typeof nested === 'bigint') return `${nested.toString()}n`;
    if (typeof nested === 'function') return `[Function ${nested.name || 'anonymous'}]`;
    if (typeof nested === 'symbol') return nested.toString();
    if (nested !== null && typeof nested === 'object') {
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
    }
    return nested;
  };

  try {
    return JSON.stringify(value, replacer, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

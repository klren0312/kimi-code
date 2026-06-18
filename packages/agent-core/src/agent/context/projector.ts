/**
 * 上下文投影器 — 将内部 {@link ContextMessage} 历史转换为
 * LLM Provider 所期望的普通 {@link Message} 数组。
 *
 * 投影器执行两个关键转换：
 *
 * 1. **剥离上下文元数据** — 移除仅在 Agent 上下文层有意义的 `origin`
 *    和 `isError` 字段。Provider 会拒绝或误解这些字段。
 *
 * 2. **合并相邻的用户消息** — 大多数 LLM API 要求严格的
 *    user/assistant 交替。当上下文包含连续的用户消息时（如用户提示词
 *    后紧跟系统提醒注入），投影器会将它们合并为单条用户消息以满足
 *    Provider 的格式要求。只有 `origin.kind === 'user'` 的消息才符合
 *    合并条件；来自技能、后台任务等的注入消息会保持独立，以保留其
 *    在投影输出中的不同来源身份。
 *
 * 此外，部分或空的助手占位符（来自中止或出错的轮次）会被过滤掉，
 * 以确保 Provider 不会看到格式错误的助手消息。
 */

import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import type { ContextMessage } from './types';

/**
 * 将内部上下文历史投影为 LLM Provider 所期望的普通消息格式。
 *
 * 过滤掉部分/空的助手占位符，合并连续的用户消息，然后从结果中
 * 剥离所有上下文层元数据（origin、isError）。
 *
 * @param history - 内部上下文消息历史。
 * @returns 适合发送给 LLM Provider 的干净消息数组。
 */
export function project(history: readonly ContextMessage[]): Message[] {
  // 保持部分或空的 assistant 占位符远离 Provider。
  // 它们可能在 Turn 被中止或在任何内容或工具调用追加之前出错时出现。
  const usable = history.filter((message) => {
    return (
      message.partial !== true &&
      !(message.role === 'assistant' && message.content.length === 0 && message.toolCalls.length === 0)
    );
  });
  return mergeAdjacentUserMessages(usable);
}

/**
 * 合并具有相同来源类型的连续用户消息。
 *
 * Provider 强制要求严格的用户/助手交替（user/assistant/user/...）。
 * 当上下文组装产生连续的用户消息时 — 例如用户提示词后紧跟
 * `kind: 'user'` 的系统提醒注入 — 此函数通过拼接文本部分并保留
 * 所有非文本部分（图片等）将它们合并为单条用户消息。
 *
 * 只有来源为 `'user'` 的消息才符合合并条件。所有其他来源保持不变，
 * 以维护其语义边界。
 */
function mergeAdjacentUserMessages(history: readonly ContextMessage[]): Message[] {
  const out: ContextMessage[] = [];
  for (const message of history) {
    const previous = out.at(-1);
    if (
      canMergeUserMessage(message) &&
      previous !== undefined &&
      canMergeUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    out.push(message);
  }
  return out.map(stripContextMetadata);
}

/** 检查消息是否符合与相邻用户消息合并的条件。 */
function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

/**
 * 通过拼接文本部分并将所有非文本部分（图片等）追加到末尾，
 * 将两条相邻的用户消息合并为一条。
 */
function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
    origin: a.origin,
  };
}

/** 提取消息中的所有文本部分并拼接为单个字符串。 */
function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** 从消息中移除上下文层元数据（origin、isError），生成干净的面向 Provider 的 Message。 */
function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}

/**
 * 当工具交换不完整（并非所有工具调用都有结果）时，移除尾部的
 * 助手消息及其关联的工具结果消息。
 *
 * 这用于投影另一个 Agent 的历史以进行恢复：尾部的不完整工具交换
 * 会让 Provider 困惑，因为它期望每个工具调用都有匹配的结果。
 * 通过裁剪不完整的尾部，恢复的 Agent 从一个干净的边界开始。
 *
 * 如果尾部助手消息中的所有工具调用都有匹配的结果，
 * 则历史保持不变。
 *
 * @param history - 已投影的（面向 Provider 的）消息数组。
 * @returns 移除了不完整尾部工具交换后的历史（如果存在的话）。
 */
export function trimTrailingOpenToolExchange(history: readonly Message[]): Message[] {
  let lastNonToolIndex = history.length - 1;
  while (lastNonToolIndex >= 0 && history[lastNonToolIndex]?.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const assistant = history[lastNonToolIndex];
  if (assistant === undefined) return [];
  if (assistant.role !== 'assistant' || assistant.toolCalls.length === 0) return [...history];

  const trailingToolCallIds = new Set(
    history
      .slice(lastNonToolIndex + 1)
      .map((message) => message.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  const closed = assistant.toolCalls.every((toolCall) => trailingToolCallIds.has(toolCall.id));
  return closed ? [...history] : history.slice(0, lastNonToolIndex);
}

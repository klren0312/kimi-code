import type { StreamedMessagePart, ToolCall } from '#/message';

export interface ChatCompletionStreamToolFunctionDelta {
  readonly name?: string;
  readonly arguments?: string;
}

export interface ChatCompletionStreamToolCallDelta {
  readonly index?: number | string;
  readonly id?: string;
  readonly function?: ChatCompletionStreamToolFunctionDelta | null;
}

export interface BufferedChatCompletionToolCall {
  id?: string;
  arguments: string;
  emitted: boolean;
}

/**
 * 将 OpenAI Chat Completions 风格的流式工具调用增量转换为
 * 标准化的 kosong 流式消息部件协议。
 *
 * OpenAI 兼容的提供商可能会在某个流索引的函数名之前先发送参数片段。
 * 将这些早期参数片段缓存起来，直到第一个带有名称的头部到达，
 * 然后将后续片段作为带索引的 `tool_call_part` 发出，
 * 以便共享的生成循环能够路由交错的并行调用。
 */
export function convertChatCompletionStreamToolCall(
  toolCall: ChatCompletionStreamToolCallDelta,
  bufferedByIndex: Map<number | string, BufferedChatCompletionToolCall>,
): StreamedMessagePart[] {
  if (toolCall.function === undefined || toolCall.function === null) {
    return [];
  }

  const streamIndex = toolCall.index;
  const functionName = toolCall.function.name;
  const functionArguments = toolCall.function.arguments;
  const hasConcreteName = typeof functionName === 'string' && functionName.length > 0;
  const hasArguments = typeof functionArguments === 'string' && functionArguments.length > 0;

  if (streamIndex === undefined) {
    if (hasConcreteName) {
      return [
        {
          type: 'function',
          id: toolCall.id ?? crypto.randomUUID(),
          name: functionName,
          arguments: functionArguments ?? null,
        } satisfies ToolCall,
      ];
    }

    if (hasArguments) {
      return [
        { type: 'tool_call_part', argumentsPart: functionArguments } satisfies StreamedMessagePart,
      ];
    }

    return [];
  }

  const buffered = bufferedByIndex.get(streamIndex) ?? { arguments: '', emitted: false };
  if (toolCall.id !== undefined) {
    buffered.id = toolCall.id;
  }

  if (!buffered.emitted) {
    if (!hasConcreteName) {
      if (hasArguments) {
        buffered.arguments += functionArguments;
      }
      bufferedByIndex.set(streamIndex, buffered);
      return [];
    }

    buffered.emitted = true;
    const initialArguments =
      buffered.arguments.length > 0
        ? buffered.arguments + (functionArguments ?? '')
        : (functionArguments ?? null);
    buffered.arguments = '';
    bufferedByIndex.set(streamIndex, buffered);

    const toolCallHeader: ToolCall = {
      type: 'function',
      id: buffered.id ?? toolCall.id ?? crypto.randomUUID(),
      name: functionName,
      arguments: initialArguments,
      _streamIndex: streamIndex,
    };
    return [toolCallHeader];
  }

  if (!hasArguments) {
    return [];
  }

  const part: StreamedMessagePart & { index: number | string } = {
    type: 'tool_call_part',
    argumentsPart: functionArguments,
    index: streamIndex,
  };
  return [part];
}

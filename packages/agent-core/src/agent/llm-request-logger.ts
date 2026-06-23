/**
 * @module llm-request-logger
 *
 * 记录 LLM 请求元数据（provider、模型、工具数、消息数）到 agent 的结构化日志器。
 * 通过内容哈希对配置日志去重，使重复的相同配置只产生一条 "llm config" 条目，
 * 而非每次请求一条。
 */

import { createHash } from 'node:crypto';

import type { Logger } from '#/logging/types';
import type { ChatProvider, GenerateOptions, Message, Tool } from '@moonshot-ai/kosong';

import type { LLMRequestLogFields } from '../loop';

/** 扩展的 {@link GenerateOptions}，携带每次请求的日志元数据。 */
export type GenerateOptionsWithRequestLogFields = GenerateOptions & {
  readonly requestLogFields?: LLMRequestLogFields;
};

/**
 * LLM API 请求的结构化日志记录器。通过对 provider/模型/工具/系统提示词元组
 * 进行哈希来追踪配置变化，使日志仅在实际发生变化时才显示配置条目，
 * 在长时间稳定配置的会话中保持低噪声。
 */
export class LlmRequestLogger {
  private lastConfigLogSignature: string | undefined;

  constructor(private readonly log: Logger) {}

  /**
   * 记录单次 LLM 请求。仅当 provider/模型/工具/系统提示词的组合自上次调用
   * 发生变化时才输出 "llm config" 信息行，并且始终输出带有每轮元数据的
   * "llm request" 行。
   *
   * @param input - 完整的请求上下文，包括 provider、工具、消息和可选的每次请求日志字段。
   */
  logRequest(input: {
    readonly provider: ChatProvider;
    readonly modelAlias?: string;
    readonly systemPrompt: string;
    readonly tools: readonly Tool[];
    readonly messages: readonly Message[];
    readonly fields: LLMRequestLogFields | undefined;
  }): void {
    const { provider, modelAlias, systemPrompt, tools, messages, fields } = input;
    const requestLogFields = fields ?? {};
    const config = {
      provider: provider.name,
      model: provider.modelName,
      modelAlias,
      thinkingEffort: provider.thinkingEffort ?? undefined,
      systemPromptChars: systemPrompt.length,
      toolCount: tools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(tools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info('llm config', { ...requestLogFields, ...config });
    }

    const partialMessageCount = messages.filter((message) => message.partial === true).length;
    const requestFields: {
      turnStep?: string;
      attempt?: string;
      partialMessageCount?: number;
    } = { ...requestLogFields };
    if (partialMessageCount > 0) requestFields.partialMessageCount = partialMessageCount;
    this.log.info('llm request', requestFields);
  }
}

/**
 * 将组合的生成选项拆分为日志字段和 provider 期望的干净 {@link GenerateOptions}。
 * 日志字段被剥离以避免泄漏到 API 请求体中。
 *
 * @param options - 组合选项，如果未提供则为 `undefined`。
 * @returns 一个包含分离后的 `requestLogFields` 和 `generateOptions` 的对象。
 */
export function splitGenerateOptions(options: GenerateOptionsWithRequestLogFields | undefined): {
  readonly requestLogFields: LLMRequestLogFields | undefined;
  readonly generateOptions: GenerateOptions | undefined;
} {
  if (options === undefined) {
    return { requestLogFields: undefined, generateOptions: undefined };
  }
  const { requestLogFields, ...generateOptions } = options;
  return { requestLogFields, generateOptions };
}

function toolSignature(tools: readonly Tool[]) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

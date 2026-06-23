/**
 * WebSearchTool — 宿主注入的网页搜索。
 *
 * kimi-core 定义接口；宿主通过 `WebSearchProvider` 提供实际的搜索实现。
 * 若未提供 provider，不应注册此工具（不暴露给 LLM）。
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './web-search.md?raw';

// ── 提供者接口（宿主注入） ───────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string | undefined;
  content?: string | undefined;
}

export interface WebSearchProvider {
  search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string },
  ): Promise<WebSearchResult[]>;
}

// ── 输入 schema ─────────────────────────────────────────────────────

export const WebSearchInputSchema = z.object({
  query: z.string().describe('The query text to search for.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe(
      'The number of results to return. Typically you do not need to set this value. When the results do not contain what you need, you probably want to give a more concrete query.',
    )
    .optional(),
  include_content: z
    .boolean()
    .default(false)
    .describe(
      'Whether to include the content of the web pages in the results. It can consume a large amount of tokens when this is set to true. You should avoid enabling this when `limit` is set to a large value.',
    )
    .optional(),
});

export type WebSearchInput = z.Infer<typeof WebSearchInputSchema>;

// ── 实现 ───────────────────────────────────────────────────

export class WebSearchTool implements BuiltinTool<WebSearchInput> {
  readonly name = 'WebSearch' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WebSearchInputSchema);
  constructor(private readonly provider: WebSearchProvider) {}

  resolveExecution(args: WebSearchInput): ToolExecution {
    const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
    return {
      accesses: ToolAccesses.none(),
      description: `Searching: ${preview}`,
      display: { kind: 'search', query: args.query },
      approvalRule: literalRulePattern(this.name, args.query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.query),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: WebSearchInput,
    {
    toolCallId,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const opts: { limit?: number; includeContent?: boolean; toolCallId?: string } = {
        toolCallId,
      };
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.include_content !== undefined) opts.includeContent = args.include_content;
      const results = await this.provider.search(args.query, opts);
      const builder = new ToolResultBuilder({ maxLineLength: null });

      if (results.length === 0) {
        builder.write('No search results found.');
        return builder.ok();
      }

      let first = true;
      for (const result of results) {
        if (!first) builder.write('---\n\n');
        first = false;

        builder.write(`Title: ${result.title}\n`);
        if (result.date) builder.write(`Date: ${result.date}\n`);
        builder.write(`URL: ${result.url}\n`);
        builder.write(`Snippet: ${result.snippet}\n\n`);
        if (result.content) builder.write(`${result.content}\n\n`);
      }

      return builder.ok();
    } catch (error) {
      return {
        isError: true,
        output: classifySearchError(error),
      };
    }
  }

}

// ── 错误分类 ─────────────────────────────────────────────

/**
 * 将抛出的搜索错误映射为分类化的、人类可读的消息。
 *
 * 原始错误文本始终保留，以便模型仍能看到底层细节；
 * 前缀仅添加分类，便于对失败进行推理（例如重试还是向用户展示）。
 */
function classifySearchError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (name === 'AbortError' || lower.includes('abort')) {
    return `Search cancelled: ${message}`;
  }
  if (name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    return `Search timed out: ${message}`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return `Search failed (authentication): ${message}`;
  }
  if (
    lower.includes('http ') ||
    lower.includes('network') ||
    lower.includes('fetch') ||
    name === 'TypeError'
  ) {
    return `Search failed (network): ${message}`;
  }
  return `Search failed: ${message}`;
}

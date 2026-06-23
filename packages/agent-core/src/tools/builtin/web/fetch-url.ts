/**
 * FetchURLTool — 宿主注入的 URL 获取器。
 *
 * kimi-core 定义接口；宿主通过 `UrlFetcher` 提供实际的 fetch 实现。
 * 若未提供 fetcher，不应注册此工具（不暴露给 LLM）。
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './fetch-url.md?raw';

// ── 提供者接口（宿主注入） ───────────────────────────────

/**
 * 返回内容与原始响应体的关系。
 *
 * - `passthrough` — 响应体已是纯文本 / markdown，原样完整返回。
 * - `extracted` — 响应体是 HTML 页面；仅提取并返回主要文章文本。
 */
export type UrlFetchKind = 'passthrough' | 'extracted';

export interface UrlFetchResult {
  /** 传递给 LLM 的文本。 */
  content: string;
  /** `content` 是原样透传还是已提取的主体文本。 */
  kind: UrlFetchKind;
}

export interface UrlFetcher {
  fetch(url: string, options?: { toolCallId?: string }): Promise<UrlFetchResult>;
}

/**
 * 当上游 HTTP 请求已完成但返回非成功状态时，由 `UrlFetcher` 抛出。
 * 工具据此分支在错误消息中展示 `Status: N`；非 HTTP 失败（DNS、超时、
 * 连接重置等）继续作为普通 `Error` 传递。
 */
export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ── 输入 schema ─────────────────────────────────────────────────────

export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
});

export type FetchURLInput = z.Infer<typeof FetchURLInputSchema>;

// ── 实现 ───────────────────────────────────────────────────

export class FetchURLTool implements BuiltinTool<FetchURLInput> {
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);
  constructor(private readonly fetcher: UrlFetcher) {}

  resolveExecution(args: FetchURLInput): ToolExecution {
    const preview = args.url.length > 50 ? `${args.url.slice(0, 50)}…` : args.url;
    return {
      accesses: ToolAccesses.none(),
      description: `Fetching: ${preview}`,
      display: { kind: 'url_fetch', url: args.url },
      approvalRule: literalRulePattern(this.name, args.url),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.url),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: FetchURLInput,
    {
    toolCallId,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const { content, kind } = await this.fetcher.fetch(args.url, { toolCallId });

      if (!content) {
        return {
          output: 'The response body is empty.',
          isError: false,
        };
      }

      const builder = new ToolResultBuilder({ maxLineLength: null });
      builder.write(content);
      // 告知 LLM 它收到的是完整响应体还是仅提取的文章文本，
      // 以便判断内容的完整程度。
      const message =
        kind === 'passthrough'
          ? 'The returned content is the full response body, returned verbatim.'
          : 'The returned content is the main text extracted from the page.';
      return builder.ok(message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpFetchError) {
        return {
          isError: true,
          output: `Failed to fetch URL. Status: ${String(error.status)}. ${msg}`,
        };
      }
      return {
        isError: true,
        output: `Failed to fetch URL due to network error: ${args.url}. ${msg}`,
      };
    }
  }

}

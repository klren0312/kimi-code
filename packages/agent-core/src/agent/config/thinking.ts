/**
 * @module config/thinking
 *
 * 通过协调用户的显式请求、每轮默认标志和 profile 级 thinking 配置，
 * 解析 LLM 请求的实际 thinking effort 级别。解析链为：
 * 显式请求 > defaultThinking 标志 > profile 配置 > 内置默认值。
 */

import type { ThinkingEffort } from '@moonshot-ai/kosong';

import type { ThinkingConfig } from '../../config/schema';

export type { ThinkingEffort };

const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

const THINKING_EFFORTS = new Set<ThinkingEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

/** 控制 thinking effort 解析方式的选项。 */
export interface ResolveThinkingLevelOptions {
  /** 为 `false` 时，除非显式请求否则禁用 thinking。 */
  readonly defaultThinking?: boolean | undefined;
  /** Profile 级 thinking 配置（effort 级别和模式）。 */
  readonly thinking?: ThinkingConfig | undefined;
}

/**
 * 解析一轮对话的 thinking effort，将用户的显式请求字符串与 profile 级默认值组合。
 *
 * 优先级：显式请求 → `defaultThinking === false` → profile 配置 → 内置默认值。
 *
 * @param requestedThinking - 用户的原始 thinking 级别字符串（如 "high"、"off"）。
 * @param options - Profile 和 default-thinking 标志。
 * @returns 解析后的 {@link ThinkingEffort}，传递给 provider。
 */
export function resolveThinkingLevel(
  requestedThinking: string | undefined,
  options: ResolveThinkingLevelOptions,
): ThinkingEffort {
  const resolvedRequest =
    requestedThinking !== undefined && requestedThinking.trim().length > 0
      ? requestedThinking
      : options.defaultThinking === false
        ? 'off'
        : undefined;

  return resolveThinkingEffort(resolvedRequest, options.thinking);
}

/**
 * 底层 effort 解析器，将规范化的请求字符串和 profile 配置映射为
 * 具体的 {@link ThinkingEffort}。处理特殊值 `"off"` 和 `"on"`
 *（后者映射为配置的 effort 或内置默认值）。
 *
 * @param requested - 规范化的请求字符串，或 `undefined` 表示使用默认值。
 * @param defaults - Profile 级 thinking 配置。
 */
export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
): ThinkingEffort {
  const configEffort = parseEffort(defaults?.effort) ?? DEFAULT_THINKING_EFFORT;
  const normalized = requested?.trim().toLowerCase();
  if (!normalized) {
    if (defaults?.mode === 'off') return 'off';
    return configEffort;
  }
  if (normalized === 'off') return 'off';
  if (normalized === 'on') return configEffort;
  return parseEffort(normalized) ?? configEffort;
}

function parseEffort(value: string | undefined): ThinkingEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && THINKING_EFFORTS.has(normalized as ThinkingEffort)
    ? (normalized as ThinkingEffort)
    : undefined;
}

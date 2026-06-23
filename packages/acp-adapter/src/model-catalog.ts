/**
 * ACP model catalog — adapter-local helper that turns the harness's
 * config snapshot into a flat list of selectable models for the ACP
 * `configOptions` picker (`packages/acp-adapter/src/config-options.ts`).
 *
 * Used to live inside `@moonshot-ai/kimi-code-sdk` as
 * `KimiHarness.listAvailableModels()`; moved here so the SDK keeps a
 * minimal surface and ACP-specific heuristics (thinking-capability
 * derivation, the toggleable-models allow-list) stay scoped to the
 * adapter.
 *
 * Iteration order mirrors `config.models` insertion order — Node's
 * `Object.entries` over plain object keys is insertion-ordered for
 * string keys, matching the Python reference's
 * `for model_key, model in models.items()`.
 *
 * `thinkingSupported` is true if any of:
 *   1. the alias's declared `capabilities` array contains `'thinking'`, or
 *   2. the underlying model name matches `/thinking|reason/i`
 *      (always-thinking variants), or
 *   3. the underlying model name is on the {@link TOGGLEABLE_THINKING_MODELS}
 *      allow-list (mirrors `kimi-cli/src/kimi_cli/llm.py:derive_model_capabilities`).
 */

import type { KimiHarness, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

// ── 中文概述 ──
// 本模块负责将 harness 的模型配置转换为 ACP `configOptions` 选择器所需的扁平模型列表。
// 核心功能：从 harness 配置中提取模型别名信息，派生 thinking（思考）能力标记，
// 输出可供 ACP 客户端渲染的模型目录。曾位于 SDK 中，后移至适配器以保持 SDK 接口精简。

/**
 * One catalog row per configured model alias, suitable for an ACP
 * picker. `description` is left optional so the harness can populate it
 * later without breaking callers; ACP UIs treat it as a flavour-text
 * subtitle.
 */
// 中文：ACP 模型目录的单条记录，供客户端模型选择器使用
export interface AcpModelEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly thinkingSupported: boolean;
  /** Declared 'always_thinking' capability — thinking cannot be turned off. */
  readonly alwaysThinking?: boolean;
}

/**
 * Models that support thinking by toggle (not by name match or
 * `capabilities` declaration). Kept here because the list is
 * ACP-picker-specific UX — moving it into the kernel would bake an
 * adapter concern into a place that doesn't need to know about ACP.
 */
// 中文：支持通过开关切换 thinking 模式的模型白名单（不依赖名称或能力声明）
const TOGGLEABLE_THINKING_MODELS = new Set(['kimi-for-coding', 'kimi-code']);

// 中文：派生模型是否支持 thinking 模式——通过能力声明、模型名称启发式或白名单判断
export function deriveThinkingSupported(alias: ModelAlias): boolean {
  // 中文：优先检查显式声明的能力
  const declared = alias.capabilities ?? [];
  if (declared.includes('thinking') || declared.includes('always_thinking')) return true;
  // 中文：其次通过模型名称中的关键词匹配（thinking/reason 为常开型）
  const lower = alias.model.toLowerCase();
  if (lower.includes('thinking') || lower.includes('reason')) return true;
  // 中文：最后检查是否在可切换 thinking 的白名单中
  if (TOGGLEABLE_THINKING_MODELS.has(alias.model)) return true;
  return false;
}

/**
 * Whether the alias declares the 'always_thinking' capability — the model
 * cannot run with thinking disabled, so the ACP toggle must lock to on.
 * Deliberately capability-only: the name heuristics above keep feeding
 * `thinkingSupported`, but only an explicit (server-derived) declaration
 * may remove the off option from the client.
 */
// 中文：判断模型是否为始终开启 thinking 模式（无法关闭），仅依据显式能力声明
export function deriveAlwaysThinking(alias: ModelAlias): boolean {
  return (alias.capabilities ?? []).includes('always_thinking');
}

/**
 * Project `harness.getConfig().models` into a flat catalog. Returns an
 * empty array when the harness has no models configured, when
 * `getConfig` is missing on the harness (partial test stubs), or when
 * `getConfig` throws — letting the caller decide how to surface a
 * degenerate config without forcing every test stub to provide every
 * field.
 */
// 中文：从 harness 配置中提取所有模型别名，转换为 ACP 模型目录条目列表
export async function listModelsFromHarness(
  harness: KimiHarness,
): Promise<readonly AcpModelEntry[]> {
  // 中文：兼容不完整测试桩——getConfig 不存在时返回空数组
  if (typeof harness.getConfig !== 'function') return [];
  let models: Record<string, ModelAlias> | undefined;
  try {
    const config = await harness.getConfig();
    models = config.models;
  } catch {
    return [];
  }
  if (models === undefined) return [];
  // 中文：遍历模型配置，生成扁平化的 AcpModelEntry 数组
  const out: AcpModelEntry[] = [];
  for (const [id, alias] of Object.entries(models)) {
    out.push({
      id,
      name: alias.displayName ?? alias.model ?? id,
      thinkingSupported: deriveThinkingSupported(alias),
      alwaysThinking: deriveAlwaysThinking(alias),
    });
  }
  return out;
}

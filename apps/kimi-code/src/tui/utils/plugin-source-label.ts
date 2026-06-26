import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

export const OFFICIAL_BADGE = 'official';
export const CURATED_BADGE = 'curated';
export const THIRD_PARTY_BADGE = 'third-party';

export type PluginTrustLabel = 'official' | 'curated' | 'third-party';

/**
 * 插件的可读来源标签，适用于 `/plugins` 概览和列表中的行内展示。
 *
 * - github 来源 → `github <owner>/<repo>@<ref>`
 * - 可解析 URL 的 zip-url → `via <host[:port]>`
 * - 其他情况 → 原始来源类型（`local-path`、`zip-url`）
 */
export function formatPluginSourceLabel(plugin: PluginSummary): string {
  if (plugin.source === 'github' && plugin.github !== undefined) {
    return `github ${plugin.github.owner}/${plugin.github.repo}@${plugin.github.ref.value}`;
  }
  if (plugin.source === 'zip-url' && plugin.originalSource !== undefined) {
    const host = hostFromUrl(plugin.originalSource);
    if (host !== undefined) return `via ${host}`;
  }
  return plugin.source;
}

/**
 * 返回插件的三个信任标签之一。只有 Kimi 托管的插件 zip 路径
 * 才会获得 official 或 curated 标记，其余均为 third-party。
 */
export function pluginTrustLabel(plugin: PluginSummary): PluginTrustLabel {
  if (plugin.source !== 'zip-url' || plugin.originalSource === undefined) {
    return 'third-party';
  }
  try {
    const url = new URL(plugin.originalSource);
    if (url.protocol !== 'https:' || url.hostname !== 'code.kimi.com') {
      return 'third-party';
    }
    if (url.pathname.startsWith('/kimi-code/plugins/official/')) {
      return 'official';
    }
    if (url.pathname.startsWith('/kimi-code/plugins/curated/')) {
      return 'curated';
    }
    return 'third-party';
  } catch {
    return 'third-party';
  }
}

/**
 * Returns true only for install sources that are unambiguously Kimi-built
 * official plugins — an https URL under the official Kimi CDN plugin path.
 * Everything else (local paths, GitHub repos, curated or third-party URLs)
 * is treated as unofficial and should be confirmed before install.
 */
export function isOfficialPluginSource(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    const url = new URL(trimmed);
    return (
      url.hostname === 'code.kimi.com' &&
      url.pathname.startsWith('/kimi-code/plugins/official/')
    );
  } catch {
    return false;
  }
}

function hostFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.port.length > 0) return `${url.hostname}:${url.port}`;
    return url.hostname;
  } catch {
    return undefined;
  }
}

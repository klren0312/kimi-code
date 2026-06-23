import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import {
  log,
  type PromptPart,
  type ToolInputDisplay,
  type ToolResultEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { isHideOutputMarker } from './marker';

// ── 中文概述 ──
// 本模块负责 ACP 协议内容块与 SDK 内部格式之间的双向转换。
// 核心功能：
//   1. acpBlocksToPromptParts —— 将 ACP ContentBlock[] 转换为 SDK PromptPart[]，
//      支持文本、图片、资源链接、内嵌资源等类型，不支持的类型会 warn 并丢弃。
//   2. displayBlockToAcpContent —— 将 SDK 的 ToolInputDisplay（diff/file_io/plan_review）
//      转换为 ACP ToolCallContent，用于工具调用时的可视化展示。
//   3. toolResultToAcpContent —— 将 SDK 的工具执行结果（ToolResultEvent）转换为
//      ACP ToolCallContent[]，包含 HideOutputMarker 机制以抑制特定工具的输出。

/**
 * Convert an array of ACP {@link ContentBlock}s into the SDK's
 * {@link PromptPart} array.
 *
 */
// 中文：将 ACP 内容块数组转换为 SDK 的 PromptPart 数组，用于将客户端发来的提示内容转为内部格式
export function acpBlocksToPromptParts(
  blocks: readonly ContentBlock[],
): readonly PromptPart[] {
  const out: PromptPart[] = [];
  // 中文：遍历每个 ACP 内容块，按类型分发转换逻辑
  for (const block of blocks) {
    if (block.type === 'text') {
      // 中文：文本块 —— 直接映射为 SDK text 类型
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      // 中文：图片块 —— 将 base64 数据组装为 data URI，映射为 image_url 类型
      const url = `data:${block.mimeType};base64,${block.data}`;
      out.push({ type: 'image_url', imageUrl: { url } });
      continue;
    }
    if (block.type === 'audio') {
      // 中文：音频块 —— 当前不支持，记录警告并丢弃
      log.warn('acp: dropping unsupported audio prompt block', {
        mimeType: block.mimeType,
      });
      continue;
    }
    if (block.type === 'resource_link') {
      // 中文：资源链接 —— 优先尝试转为文件路径引用（file:// URI → 本地路径）
      const fileRef = fileLinkToTextRef(block.uri);
      if (fileRef !== null) {
        out.push({ type: 'text', text: fileRef });
        continue;
      }
      // 中文：非文件链接 —— 序列化为 XML 标签嵌入文本，保留 uri 和 name 供模型参考
      const text = `<resource_link uri="${escapeXmlAttr(
        block.uri,
      )}" name="${escapeXmlAttr(block.name)}" />`;
      out.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource;
      if ('text' in resource) {
        // TextResourceContents — wrap as a `<resource>` element so the
        // model sees the uri provenance alongside the text body.
        // 中文：文本资源 —— 包裹为 <resource> 标签，让模型能看到来源 URI 和文本内容
        const text = `<resource uri="${escapeXmlAttr(resource.uri)}">${
          resource.text
        }</resource>`;
        out.push({ type: 'text', text });
        continue;
      }
      // BlobResourceContents — D3 mandates drop+warn.
      // 中文：二进制资源（blob）—— 按协议规范丢弃并记录警告
      log.warn('acp: dropping blob embedded resource', {
        uri: resource.uri,
        mimeType: resource.mimeType,
      });
      continue;
    }
    // Future-proof: anything else (new ACP block kinds) → warn and drop.
    // 中文：未知的内容块类型 —— 记录警告并丢弃，保持前向兼容
    log.warn('acp: dropping unsupported prompt content block', {
      type: (block as { type: string }).type,
    });
  }
  return out;
}

/**
 * Minimum-viable XML-attribute escaping for prompt-embedded resource
 * wrappers. The output is consumed by an LLM, not parsed by a canonical
 * XML parser, so we only escape the five characters that would change
 * the apparent tag structure: `&`, `<`, `>`, `"`, `'`. `&` must run
 * first to avoid double-escaping the entities introduced by the others.
 */
// 中文：XML 属性值的最小转义——仅转义会影响标签结构的 5 个字符（& 必须先执行以避免双重转义）
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 中文：将 file:// URI 转换为本地文件路径文本引用，支持 Windows UNC 路径和行号范围
function fileLinkToTextRef(uri: string): string | null {
  // 中文：解析 URI，失败则说明不是合法 URL，返回 null
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  // 中文：只处理 file:// 协议，其他协议不支持
  if (url.protocol !== 'file:') return null;

  // 中文：对路径进行 URI 解码（如 %20 → 空格）
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  // `file://server/share/a.ts` is the URI form of a Windows UNC path
  // (`\\server\share\a.ts`). `URL.pathname` only carries `/share/a.ts`; the
  // host is part of the file location, so keep it in the projected text ref.
  // `file://localhost/...` is still treated as local. Host is lower-cased so
  // `file://Server/...` and `file://server/...` collapse to one ref.
  // 中文：处理 Windows UNC 路径——file://server/share 形式的 URI 需要将 host 拼入路径
  const host = url.hostname.toLowerCase();
  const isUncHost = host !== '' && host !== 'localhost';

  // Drive-letter normalization is local-only: a UNC URI never legitimately
  // carries `/C:/...` in its path, so we leave such inputs untouched rather
  // than stripping a leading slash that would alter the UNC payload.
  // 中文：本地路径的盘符规范化——去掉 /C: 前的多余斜杠（UNC 路径不做此处理）
  if (!isUncHost && /^\/[A-Za-z]:/.test(path)) path = path.slice(1);

  // 中文：UNC 路径 —— 拼接为 //host/path 格式
  if (isUncHost) {
    path = `//${host}${path.startsWith('/') ? path : `/${path}`}`;
  }

  // 中文：尝试从 URI 的 hash（#L1-10）或 query（?lines=1-10）中解析行号范围
  const range = parseLineRange(url.hash) ?? parseLineRange(url.search);
  return range !== null ? `${path}:${range}` : path;
}

// 中文：解析 URI 片段或查询参数中的行号范围，支持 `#L1-10`、`#lines=1-10`、`?line=5` 等格式
function parseLineRange(suffix: string): string | null {
  if (!suffix) return null;
  const body = suffix.replace(/^[#?]/, '');
  const match = /^(?:lines?=|L)(\d+)(?:[-:]L?(\d+))?/i.exec(body);
  if (!match) return null;
  return match[2] !== undefined ? `${match[1]}-${match[2]}` : match[1]!;
}

// 中文：将 SDK 的工具输入展示（diff/file_io/plan_review）转换为 ACP 工具调用内容
export function displayBlockToAcpContent(
  block: ToolInputDisplay,
): ToolCallContent | null {
  if (block.kind === 'diff') {
    // 中文：diff 类型 —— 直接映射为 ACP diff，包含路径和新旧文本
    return {
      type: 'diff',
      path: block.path,
      oldText: block.before,
      newText: block.after,
    };
  }
  if (
    block.kind === 'file_io' &&
    block.before !== undefined &&
    block.after !== undefined
  ) {
    // 中文：file_io 类型 —— 当同时有前后内容时，也映射为 ACP diff 进行对比展示
    return {
      type: 'diff',
      path: block.path,
      oldText: block.before,
      newText: block.after,
    };
  }
  if (block.kind === 'plan_review') {
    // 中文：plan_review 类型 —— 渲染计划内容为纯文本，空计划返回 null
    const text = composePlanContent(block);
    if (text === null) return null;
    return { type: 'content', content: { type: 'text', text } };
  }
  return null;
}

/**
 * Render the text body of a `plan_review` display block:
 *  - When `block.plan` (after trimming) is empty, return `null` — the
 *    caller drops the content entry rather than surfacing a blank
 *    headline. The policy at
 *    `packages/agent-core/src/tools/builtin/planning/exit-plan-mode.ts:110`
 *    already guarantees a non-empty plan; this guard exists so the
 *    adapter does not depend on that invariant.
 *  - When `block.path` is set, prefix the plan with `Plan saved to:
 *    <path>` so the ACP client can show the on-disk location alongside
 *    the markdown body. Otherwise emit the plan markdown alone.
 *
 * The output is consumed by the ACP client as plain text inside a
 * `tool_call_update` content entry; no markdown-specific escaping is
 * needed (markdown is the content type, not a wire-format escape
 * concern).
 */
// 中文：渲染 plan_review 展示块的文本内容——空计划返回 null，有文件路径时加前缀
function composePlanContent(
  block: Extract<ToolInputDisplay, { kind: 'plan_review' }>,
): string | null {
  if (block.plan.trim().length === 0) return null;
  if (block.path !== undefined) {
    return `Plan saved to: ${block.path}\n\n${block.plan}`;
  }
  return block.plan;
}

/**
 * Convert a {@link ToolResultEvent}'s `output` into ACP
 * {@link ToolCallContent} entries.
 *
 * Phase 4 keeps the mapping intentionally simple: a non-empty string is
 * passed through as a text block; objects/arrays are JSON-stringified
 * (best-effort — falls back to `String(value)` on circular structures).
 * Empty/undefined/null output yields an empty array — the caller still
 * emits a `tool_call_update` so the client sees the status transition
 * to completed/failed.
 *
 * Diff content does NOT come from this function: `ToolResultEvent` has
 * no `display` field; diffs attach to `ToolCallStartedEvent.display`
 * and are emitted by `toolCallStartToSessionUpdate`.
 */
// 中文：将 SDK 的工具执行结果（ToolResultEvent）转换为 ACP 工具调用内容数组
export function toolResultToAcpContent(event: ToolResultEvent): ToolCallContent[] {
  const out = event.output;
  // Mechanism A — array output containing the HideOutputMarker tells
  // the adapter to suppress this tool's textual content entirely
  // (e.g. AcpTerminalTool emits via terminal/* reverse-RPC, so
  // routing the bytes through tool_call_update would double-render
  // in the client UI). Detected before any other processing so
  // mark-bearing outputs never leak even a stringified preview.
  // 中文：HideOutputMarker 机制——如果输出数组中包含隐藏标记，则完全抑制该工具的文本输出，
  // 防止通过 tool_call_update 重复渲染（如终端工具已通过 reverse-RPC 渲染）
  if (Array.isArray(out) && out.some(isHideOutputMarker)) {
    return [];
  }
  // 中文：空输出（undefined/null）返回空数组，客户端仍会收到状态变更通知
  if (out === undefined || out === null) return [];
  if (typeof out === 'string') {
    // 中文：字符串输出——非空则封装为文本内容块
    if (out.length === 0) return [];
    return [{ type: 'content', content: { type: 'text', text: out } }];
  }
  // Best-effort stringify for object/array outputs.
  // 中文：对象/数组输出——尽力 JSON 序列化，循环引用时降级为 '[object]'
  let text: string;
  try {
    text = JSON.stringify(out);
  } catch {
    // eslint-disable-next-line no-base-to-string
    text = typeof out === 'object' && out !== null ? '[object]' : String(out);
  }
  if (!text) return [];
  return [{ type: 'content', content: { type: 'text', text } }];
}

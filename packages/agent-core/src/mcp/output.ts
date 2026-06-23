/**
 * MCP 工具调用结果 → ExecutableTool 输出流水线。
 *
 * 拥有从"MCP 协议内容块"到"代理循环反馈给模型的内容"的完整路径：
 *  1. 将每个 {@link MCPContentBlock} 转换为 kosong `ContentPart`
 *    （丢弃不支持的形状）。
 *  2. 将纯媒体输出包裹在 `<mcp_tool_result name="…">` 标签中，
 *     以便模型在多个工具返回媒体时能归属二进制输出。
 *     与仓库内的 `ReadMediaFile` 惯例保持一致。
 *  3. 应用大小限制：文本/思考共享 100K 字符预算；二进制部分
 *   （image/audio/video URL）各有独立的 10 MB 上限，超时时折叠为通知，
 *     以免单张截图驱逐所有文本部分。
 *  4. 将单文本部分结果折叠为纯字符串输出；否则按原样发出 `ContentPart[]`。
 *
 * `mcpResultToExecutableOutput` 是唯一的入口；各步骤辅助函数保持私有，
 * 以防止调用方绕过限制。
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import type { MCPContentBlock, MCPToolResult } from './types';

// MCP 服务器可以产生任意大的输出；限制反馈给模型的大小，以免单个健谈的
// 服务器耗尽上下文窗口。通知文本原样传给模型，以便其做出响应（如分页），
// 这就是为什么限制放在代理层而非 kosong 中。
export const MCP_MAX_OUTPUT_CHARS = 100_000;
const MCP_OUTPUT_TRUNCATED_TEXT = `\n\n[Output truncated: exceeded ${String(
  MCP_MAX_OUTPUT_CHARS,
)} character limit. Use pagination or more specific queries to get remaining content.]`;

// 二进制部分（image_url / audio_url / video_url）有独立的每部分字节上限，
// 不共享文本字符预算。base64 长度不是多模态模型成本的有效代理，
// 如果两者竞争同一个 100k 预算，单张截图就足以驱逐所有文本部分。
export const MCP_MAX_BINARY_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_BINARY_PART_CHARS = Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3);

function binaryPartTooLargeNotice(kind: 'image' | 'audio' | 'video', urlLength: number): string {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_BINARY_PART_BYTES / (1024 * 1024));
  return `[${kind}_url dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]`;
}

/**
 * 将单个 MCP 内容块转换为 kosong {@link ContentPart}。
 *
 * 对于无法表示的块类型（如未知的资源形状）返回 `null`，
 * 以便调用方可以丢弃它们。
 */
export function convertMCPContentBlock(block: MCPContentBlock): ContentPart | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'image/png';
    return {
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  if (block.type === 'audio' && typeof block.data === 'string') {
    const mimeType = block.mimeType ?? 'audio/mpeg';
    return {
      type: 'audio_url',
      audioUrl: { url: `data:${mimeType};base64,${block.data}` },
    };
  }

  // EmbeddedResource：嵌套在 `resource` 下的载荷，为 TextResourceContents
  // （`text`）或 BlobResourceContents（`blob`）。
  if (block.type === 'resource' && typeof block.resource === 'object' && block.resource !== null) {
    const res = block.resource;
    if (typeof res.text === 'string') {
      return { type: 'text', text: res.text };
    }
    if (typeof res.blob === 'string') {
      const mimeType = res.mimeType ?? 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        return {
          type: 'image_url',
          imageUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('audio/')) {
        return {
          type: 'audio_url',
          audioUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      if (mimeType.startsWith('video/')) {
        return {
          type: 'video_url',
          videoUrl: { url: `data:${mimeType};base64,${res.blob}` },
        };
      }
      return null;
    }
    return null;
  }

  // ResourceLink：URL 引用，而非内联 blob。
  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = block.mimeType ?? 'application/octet-stream';
    if (mimeType.startsWith('image/')) {
      return { type: 'image_url', imageUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('audio/')) {
      return { type: 'audio_url', audioUrl: { url: block.uri } };
    }
    if (mimeType.startsWith('video/')) {
      return { type: 'video_url', videoUrl: { url: block.uri } };
    }
    return null;
  }

  return null;
}

/**
 * 将 `MCPToolResult` 转换为代理循环期望的成功形态 `ExecutableToolResult` 输出。
 *
 * `qualifiedToolName` 是代理侧的限定名称（如 `mcp__github__create_pr`）——
 * 当结果为纯媒体时嵌入到 `<mcp_tool_result name="…">` 包裹中，
 * 以便模型归属二进制部分。
 */
export function mcpResultToExecutableOutput(
  result: MCPToolResult,
  qualifiedToolName: string,
): { output: string | ContentPart[]; isError: boolean } {
  const converted: ContentPart[] = [];
  for (const block of result.content) {
    const part = convertMCPContentBlock(block);
    if (part !== null) {
      converted.push(part);
    }
  }

  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const limited = applyOutputLimits(wrapped);
  const output = collapseSingleText(limited);
  return { output, isError: result.isError };
}

/**
 * 如果 `parts` 包含媒体但没有非空文本，则用 `<mcp_tool_result name="…">`
 * 文本标签包裹，以便模型能归属二进制内容。否则原样返回输入。
 */
function wrapMediaOnly(parts: readonly ContentPart[], qualifiedToolName: string): ContentPart[] {
  const hasMedia = parts.some(
    (p) => p.type === 'image_url' || p.type === 'audio_url' || p.type === 'video_url',
  );
  const hasNonEmptyText = parts.some((p) => p.type === 'text' && p.text.length > 0);
  if (!hasMedia || hasNonEmptyText) return [...parts];
  return [
    { type: 'text', text: `<mcp_tool_result name="${qualifiedToolName}">` },
    ...parts,
    { type: 'text', text: '</mcp_tool_result>' },
  ];
}

/**
 * 应用 100K 文本/思考预算和每部分 10 MB 二进制上限。
 *
 * 当文本/思考部分被截断时，截断通知追加到最后存活的文本部分——
 * 这使得整个（超大）输入为单个文本块时，单文本部分折叠仍然有效。
 */
function applyOutputLimits(parts: readonly ContentPart[]): ContentPart[] {
  let remaining = MCP_MAX_OUTPUT_CHARS;
  let textTruncated = false;
  const out: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (remaining <= 0) {
        textTruncated = true;
        continue;
      }
      if (part.text.length > remaining) {
        out.push({ type: 'text', text: part.text.slice(0, remaining) });
        remaining = 0;
        textTruncated = true;
      } else {
        out.push(part);
        remaining -= part.text.length;
      }
      continue;
    }

    if (part.type === 'think') {
      const size = part.think.length + (part.encrypted?.length ?? 0);
      if (remaining <= 0) {
        textTruncated = true;
        continue;
      }
      if (size > remaining) {
        out.push({ type: 'think', think: part.think.slice(0, remaining) });
        remaining = 0;
        textTruncated = true;
      } else {
        out.push(part);
        remaining -= size;
      }
      continue;
    }

    // image_url / audio_url / video_url：每部分字节上限，独立于文本字符预算。
    // 超大部分折叠为每部分通知，以便模型可以选择更小的资源而非静默丢失 blob。
    const url =
      part.type === 'image_url'
        ? part.imageUrl.url
        : part.type === 'audio_url'
          ? part.audioUrl.url
          : part.videoUrl.url;
    if (url.length > MCP_MAX_BINARY_PART_CHARS) {
      const kind =
        part.type === 'image_url' ? 'image' : part.type === 'audio_url' ? 'audio' : 'video';
      out.push({ type: 'text', text: binaryPartTooLargeNotice(kind, url.length) });
      continue;
    }
    out.push(part);
  }

  if (textTruncated) {
    appendTruncationNotice(out);
  }
  return out;
}

function appendTruncationNotice(out: ContentPart[]): void {
  // 将通知合并到最后一个文本部分，使非常常见的"单个超大文本"情况
  // 仍折叠为纯字符串。如果没有可合并的文本部分，
  // 则回退到独立的通知部分。
  for (let i = out.length - 1; i >= 0; i--) {
    const candidate = out[i];
    if (candidate?.type === 'text') {
      out[i] = { type: 'text', text: candidate.text + MCP_OUTPUT_TRUNCATED_TEXT };
      return;
    }
  }
  out.push({ type: 'text', text: MCP_OUTPUT_TRUNCATED_TEXT });
}

function collapseSingleText(parts: readonly ContentPart[]): string | ContentPart[] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}

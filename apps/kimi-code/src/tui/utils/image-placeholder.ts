/**
 * 扫描提交文本中的媒体占位符，生成将发送到 SDK 提示端点的 `PromptPart[]`。
 *
 * 规则：
 *   - 只有在 `store` 中能找到对应附件的占位符才会被提取。
 *     用户自行输入的字面 `[image #999 ...]` 会保留在文本中（我们无法凭空生成文件）。
 *   - 文本/图片/视频段的顺序保持不变。图片占位符展开为图片内容部分，
 *     使提示无需依赖模型工具调用即可到达提供商。视频占位符仍展开为文件路径标签，
 *     以便 `ReadMediaFile` 掌控视频上传行为。
 *   - 相邻的文本段会被合并——空段或纯空白段会被丢弃，这样就不会在两个
 *     媒体部分之间产生 `{type:'text', text:' '}` 这样的噪声。
 */

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import type {
  ImageAttachment,
  ImageAttachmentStore,
  VideoAttachment,
} from './image-attachment-store';

const PLACEHOLDER_REGEX = /\[(image|video) #(\d+) (?:(\(\d+×\d+\))|([^\]]+))\]/g;

export interface ExtractionResult {
  /** 按输入顺序排列的扁平部分列表；无媒体匹配时为空数组。 */
  parts: PromptPart[];
  /**
   * 是否找到了至少一个匹配的附件？为 false 时，调用方应将提示
   * 保持在纯文本路径上。
   */
  hasMedia: boolean;
  /** 匹配到的图片附件 id，按出现顺序排列。 */
  imageAttachmentIds: number[];
  /** 匹配到的视频附件 id，按出现顺序排列。 */
  videoAttachmentIds: number[];
}

export function extractMediaAttachments(
  text: string,
  store: ImageAttachmentStore,
): ExtractionResult {
  const parts: PromptPart[] = [];
  const imageAttachmentIds: number[] = [];
  const videoAttachmentIds: number[] = [];
  let cursor = 0;
  let hasMedia = false;

  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [literal, kind, idStr] = match;
    if (kind !== 'image' && kind !== 'video') continue;
    if (idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    const attachment = store.get(id);
    if (attachment === undefined) continue; // 过期或用户手动输入的——保留为文本
    if (attachment.kind !== kind) continue;
    const before = text.slice(cursor, match.index);
    pushText(parts, before);
    if (attachment.kind === 'video') {
      const mediaText = tagTextForVideo(attachment);
      pushText(parts, mediaText);
      videoAttachmentIds.push(id);
    } else {
      parts.push(imagePartForAttachment(attachment));
      imageAttachmentIds.push(id);
    }
    hasMedia = true;
    cursor = match.index + literal.length;
  }
  const tail = text.slice(cursor);
  pushText(parts, tail);

  return {
    // 纯文本提交时丢弃合成的 parts 数组——调用方的约定是
    // "parts 仅在 hasMedia 为 true 时有意义"，而产生多余的
    // TextPart 会误导以 `parts.length > 0` 作为分支条件的消费者。
    parts: hasMedia ? parts : [],
    hasMedia,
    imageAttachmentIds,
    videoAttachmentIds,
  };
}

function pushText(parts: PromptPart[], segment: string): void {
  if (segment.length === 0) return;
  // 仅保留位于非空文本之间的纯空白段——这里采用更简单的规则
  // "丢弃所有纯空白段"，因为 LLM 不关心图片之间的空白。
  if (segment.trim().length === 0) return;
  const last = parts.at(-1);
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + segment };
    return;
  }
  parts.push({ type: 'text', text: segment });
}

function imagePartForAttachment(att: ImageAttachment): PromptPart {
  const base64 = Buffer.from(att.bytes).toString('base64');
  return {
    type: 'image_url',
    imageUrl: { url: `data:${att.mime};base64,${base64}` },
  };
}

function tagTextForVideo(att: VideoAttachment): string {
  return formatMediaTag('video', att.sourcePath);
}

function formatMediaTag(tag: 'image' | 'video', path: string): string {
  return `<${tag} path="${escapeAttribute(path)}"></${tag}>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

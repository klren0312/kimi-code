/**
 * 粘贴到输入框中的媒体资源注册表。
 *
 * 每次粘贴会生成一个带自增 id 的 `ImageAttachment`，或一个带可读占位符的
 * `VideoAttachment`（如 `[image #1 (640×480)]` / `[video #2 sample.mov]`）。
 * 占位符是用户在输入框中看到的内容；提交时，`extractMediaAttachments` 会
 * 遍历文本，将图片占位符展开为图片内容部分，将视频占位符展开为 `ReadMediaFile`
 * 所需的文件路径标签。
 *
 * 作用域为每个 `KimiTUI` 实例。重新加载（`/new`、`/clear`、切换会话）时
 * 会调用 `clear()`，使 id 从 1 重新开始，并丢弃过期的提示附件。我们有意
 * 不在会话之间持久化附件——coding-agent 也是如此，而且 `--resume` 也无法
 * 知道如何物化这些文件。
 */

export interface ImageAttachment {
  readonly id: number;
  readonly kind: 'image';
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** 渲染后的占位符字符串，例如 `[image #1 (640×480)]`。 */
  readonly placeholder: string;
}

export interface VideoAttachment {
  readonly id: number;
  readonly kind: 'video';
  readonly mime: string;
  readonly filename: string;
  readonly sourcePath: string;
  readonly label: string;
  /** 渲染后的占位符字符串，例如 `[video #1 sample.mov]`。 */
  readonly placeholder: string;
}

export type MediaAttachment = ImageAttachment | VideoAttachment;

export class ImageAttachmentStore {
  private nextId = 1;
  private readonly byId = new Map<number, MediaAttachment>();

  addImage(bytes: Uint8Array, mime: string, width: number, height: number): ImageAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const attachment: ImageAttachment = {
      id,
      kind: 'image',
      bytes,
      mime,
      width,
      height,
      placeholder: formatPlaceholder(id, width, height),
    };
    this.byId.set(id, attachment);
    return attachment;
  }

  addVideo(mime: string, sourcePath: string, filename?: string | undefined): VideoAttachment {
    const id = this.nextId;
    this.nextId += 1;
    const normalizedFilename = basenameLike(
      filename !== undefined && filename !== '' ? filename : sourcePath,
    );
    const label = sanitizeVideoLabel(normalizedFilename.length > 0 ? normalizedFilename : mime);
    const attachment: VideoAttachment = {
      id,
      kind: 'video',
      mime,
      filename: normalizedFilename,
      sourcePath,
      label,
      placeholder: formatVideoPlaceholder(id, label),
    };
    this.byId.set(id, attachment);
    return attachment;
  }

  get(id: number): MediaAttachment | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
    this.nextId = 1;
  }

  size(): number {
    return this.byId.size;
  }
}

export function formatPlaceholder(id: number, width: number, height: number): string {
  return `[image #${String(id)} (${String(width)}×${String(height)})]`;
}

export function formatVideoPlaceholder(id: number, label: string): string {
  return `[video #${String(id)} ${sanitizeVideoLabel(label)}]`;
}

function sanitizeVideoLabel(raw: string): string {
  let label = '';
  for (const char of raw) {
    const code = char.codePointAt(0);
    label +=
      code === undefined || code < 0x20 || code === 0x7f || char === '[' || char === ']'
        ? '_'
        : char;
  }
  label = label.trim();
  return label.length > 0 ? label : 'video';
}

function basenameLike(raw: string): string {
  const parts = raw.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? raw;
}

/**
 * 大型媒体载荷的 blob 引用卸载和再水合。
 *
 * 当 Agent 记录包含大型 base64 编码的媒体（图像、音频等）时，
 * {@link BlobStore} 将载荷提取到磁盘上的内容寻址文件，并将内联的 `data:` URI
 * 替换为紧凑的 `blobref:<mime>;<sha256>` URL。重放时，读回 blob 并恢复原始 `data:` URI。
 *
 * 这使 `wire.jsonl` 文件保持小巧且快速读取，同时通过 SHA-256 内容寻址
 * 对跨记录的相同载荷进行去重。
 *
 * 内存 LRU 缓存避免再水合期间的重复磁盘读取。
 *
 * @module records/blobref
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'pathe';
import type { ContentPart } from '@moonshot-ai/kosong';
import type { AgentRecord } from './types';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const BLOBREF_PROTOCOL = 'blobref:';
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

/**
 * 检查 URL 是否使用 `blobref:` 协议，表明它被 {@link BlobStore} 卸载，
 * 使用前需要再水合。
 *
 * @param url - 要检查的 URL。
 * @returns 如果 URL 以 `blobref:` 开头则返回 `true`。
 */
export function isBlobRef(url: string): boolean {
  return url.startsWith(BLOBREF_PROTOCOL);
}

/**
 * {@link BlobStore} 的配置选项。
 */
export interface BlobStoreOptions {
  /** 内容寻址 blob 文件的存储目录。 */
  readonly blobsDir: string;
  /**
   * 卸载到 blob 文件的最小载荷大小（字符数）。
   * 小于此阈值的载荷保持为内联 `data:` URI。
   * 默认为 4096 个字符。
   */
  readonly threshold?: number;
  /**
   * 再水合 blob 的内存 LRU 缓存最大大小（字节）。
   * 默认为 50 MiB。
   */
  readonly maxCacheSize?: number;
}

/**
 * 管理将大型 base64 媒体载荷卸载到磁盘上的内容寻址文件，
 * 以及在重放期间将其再水合回内联 `data:` URI。
 *
 * Blob 以 `<blobsDir>/<sha256>` 存储，目录权限为 `0o700`。
 * 相同的载荷会被去重（`open('wx')` 调用因 `EEXIST` 失败，被静默捕获）。
 *
 * 基于插入顺序 `Map` 的 LRU 缓存避免再水合期间的重复磁盘读取。
 * 当缓存超过 {@link BlobStoreOptions.maxCacheSize} 时驱逐条目。
 */
export class BlobStore {
  private readonly blobsDir: string;
  private readonly threshold: number;
  private readonly maxCacheSize: number;
  private readonly cache = new Map<string, Buffer>();
  private readonly cacheSizes = new Map<string, number>();
  private currentCacheSize = 0;

  /** @param options - Blob 存储配置。 */
  constructor(options: BlobStoreOptions) {
    this.blobsDir = options.blobsDir;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
  }

  /**
   * 将记录内容中的大型内联 `data:` URI 替换为紧凑的 `blobref:` URL，
   * 将载荷写入磁盘。如果无需卸载则返回原始记录。
   *
   * 处理携带媒体内容的记录类型：`turn.prompt`、`turn.steer`、
   * `context.append_message` 和 `context.append_loop_event`。
   *
   * @param record - 要卸载的记录。
   * @returns 带有 blobref URL 的新记录，未修改时返回原始记录。
   */
  async offload(record: AgentRecord): Promise<AgentRecord> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer': {
        const input = await this.offloadParts(record.input);
        return input === record.input ? record : { ...record, input };
      }
      case 'context.append_message': {
        const content = await this.offloadParts(record.message.content);
        return content === record.message.content
          ? record
          : { ...record, message: { ...record.message, content } };
      }
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type !== 'tool.result' || typeof event.result.output === 'string') {
          return record;
        }
        const output = await this.offloadParts(event.result.output);
        if (output === event.result.output) return record;
        return {
          ...record,
          event: {
            ...event,
            result: { ...event.result, output },
          },
        };
      }
      default:
        return record;
    }
  }

  /**
   * 卸载数组中的所有内容部分，将大型 `data:` URI 替换为 `blobref:` URL。
   * 如果没有任何部分被修改则返回原始数组引用，允许调用方跳过对象分配。
   */
  private async offloadParts(parts: readonly ContentPart[]): Promise<ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.offloadContentPart(part);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : (parts as ContentPart[]);
  }

  /**
   * 就地修改记录内容，通过从磁盘（或内存缓存）读取引用的 blob 文件，
   * 将 `blobref:` URL 替换为原始 `data:` URI。如果 blob 文件缺失，
   * URL 被替换为 `[media missing]` 占位符。
   *
   * @param record - 将被再水合内容的记录。
   */
  async rehydrate(record: AgentRecord): Promise<void> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer':
        await this.rehydrateParts(record.input);
        break;
      case 'context.append_message':
        await this.rehydrateParts(record.message.content);
        break;
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type === 'tool.result' && typeof event.result.output !== 'string') {
          await this.rehydrateParts(event.result.output);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 再水合数组中的所有内容部分，就地将 `blobref:` URL 修改为 `data:` URI。
   * 公开以便直接访问内容数组的调用方（例如重放后）无需完整记录即可再水合。
   *
   * @param parts - 要再水合的内容部分。
   */
  async rehydrateParts(parts: readonly ContentPart[]): Promise<void> {
    for (const part of parts) {
      await this.rehydrateContentPart(part);
    }
  }

  /**
   * 检查单个内容部分中的媒体容器（带有 `url` 属性的对象），卸载超过大小阈值的项。
   * 如果有任何 URL 被修改则返回新部分，否则返回原始部分。
   */
  private async offloadContentPart(part: ContentPart): Promise<ContentPart> {
    let updated: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(part)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string') continue;

      const newUrl = await this.maybeOffloadString(url);
      if (newUrl === url) continue;

      if (updated === undefined) updated = { ...part };
      updated[key] = { ...(value as object), url: newUrl };
    }
    return updated === undefined ? part : (updated as unknown as ContentPart);
  }

  /**
   * 检查单个内容部分中 `url` 为 `blobref:` 引用的媒体容器，
   * 通过从磁盘读取 blob 恢复原始 `data:` URI。缺失的 blob 使用
   * `[media missing]` 占位符。就地修改部分。
   */
  private async rehydrateContentPart(part: ContentPart): Promise<void> {
    const record = part as unknown as Record<string, unknown>;
    for (const value of Object.values(record)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string' || !isBlobRef(url)) continue;

      const newUrl = await this.rehydrateBlobRefUrl(url);
      mediaObj.url = newUrl ?? MISSING_MEDIA_PLACEHOLDER;
    }
  }

  /**
   * 解析 `blobref:<mime>;<hash>` URL，从磁盘读取引用的 blob，
   * 返回重建的 `data:` URI。如果 URL 格式错误或 blob 文件缺失则返回 `undefined`。
   */
  private async rehydrateBlobRefUrl(url: string): Promise<string | undefined> {
    const rest = url.slice(BLOBREF_PROTOCOL.length);
    const semiIdx = rest.indexOf(';');
    if (semiIdx === -1) {
      return undefined;
    }
    const mimeType = rest.slice(0, semiIdx);
    const hash = rest.slice(semiIdx + 1);
    if (hash.length === 0) {
      return undefined;
    }
    const payload = await this.readBlob(hash);
    if (payload === undefined) {
      return undefined;
    }
    return `data:${mimeType};base64,${payload.toString('base64')}`;
  }

  /**
   * 从内存缓存读取 blob（提升为最近使用）或从磁盘读取。
   * 如果文件不存在则返回 `undefined`。
   */
  private async readBlob(hash: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      // 将条目移到末尾，使其比最近最少使用的条目存活更久。
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    const payload = await readFile(join(this.blobsDir, hash)).catch(() => undefined);
    if (payload !== undefined) {
      this.setCache(hash, payload);
    }
    return payload;
  }

  /**
   * 检查字符串值：如果是带 base64 载荷且超过阈值的 `data:` URI，
   * 将其卸载到 blob 文件并返回 `blobref:` URL。
   * 否则原样返回原始字符串。
   */
  private async maybeOffloadString(value: string): Promise<string> {
    if (value.startsWith(BLOBREF_PROTOCOL)) {
      return value;
    }
    const match = DATA_URI_HEADER_RE.exec(value);
    if (match === null) {
      return value;
    }
    const mimeType = match[1]!;
    const payload = value.slice(match[0].length);
    if (payload.length < this.threshold) {
      return value;
    }
    return this.writeBlob(mimeType, payload);
  }

  /**
   * 将 base64 载荷写入磁盘上的内容寻址文件。文件名为 base64 字符串的 SHA-256 十六进制摘要。
   * 使用 `open('wx')` 排他创建，捕获 `EEXIST` 实现去重。
   * 将解码后的二进制数据缓存到 LRU 缓存并返回 `blobref:` URL。
   */
  private async writeBlob(mimeType: string, base64Payload: string): Promise<string> {
    await mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(base64Payload, 'utf8').digest('hex');
    const blobPath = join(this.blobsDir, hash);
    const binary = Buffer.from(base64Payload, 'base64');
    try {
      const fh = await open(blobPath, 'wx');
      try {
        await fh.writeFile(binary);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EEXIST 表示相同的载荷已写入；去重。
      if (code !== 'EEXIST') throw error;
    }
    this.setCache(hash, binary);
    return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
  }

  /**
   * 在 LRU 缓存中插入或更新 blob，如果缓存将超过大小限制则驱逐
   * 最近最少使用的条目。超过整个缓存容量的单个 blob 被跳过。
   */
  private setCache(hash: string, payload: Buffer): void {
    const size = payload.byteLength;
    const alreadyCached = this.cache.has(hash);
    if (alreadyCached) {
      const oldSize = this.cacheSizes.get(hash) ?? 0;
      this.currentCacheSize += size - oldSize;
      // 重新插入以更新 LRU 位置。
      this.cache.delete(hash);
    } else {
      if (size > this.maxCacheSize) {
        // 跳过缓存超过整个容量限制的单个 blob。
        return;
      }
      while (this.currentCacheSize + size > this.maxCacheSize && this.cache.size > 0) {
        this.evictLRU();
      }
      this.currentCacheSize += size;
    }
    this.cache.set(hash, payload);
    this.cacheSizes.set(hash, size);
  }

  /**
   * 从缓存中驱逐最近最少使用的条目。在插入顺序的 `Map` 中，
   * 第一个键是最旧的条目。
   */
  private evictLRU(): void {
    const lru = this.cache.keys().next().value;
    if (lru === undefined) return;
    const size = this.cacheSizes.get(lru) ?? 0;
    this.currentCacheSize -= size;
    this.cache.delete(lru);
    this.cacheSizes.delete(lru);
  }
}

/**
 * 类型守卫，检查值是否为媒体容器对象——带有 `url` 属性的普通对象。
 * 对 `null`、数组、基本类型和没有 `url` 键的对象返回 `undefined`。
 */
function asMediaContainer(value: unknown): { url: unknown } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  return 'url' in obj ? (obj as { url: unknown }) : undefined;
}

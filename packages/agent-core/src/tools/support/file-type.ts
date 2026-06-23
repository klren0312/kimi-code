/**
 * file-type ——魔数字节 + 扩展名检测。无 npm 依赖。
 */

export const MEDIA_SNIFF_BYTES = 512;

export interface FileType {
  readonly kind: 'text' | 'image' | 'video' | 'unknown';
  readonly mimeType: string;
}

export type DetectFileTypeMode = 'text' | 'media';

export const IMAGE_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.svgz': 'image/svg+xml',
});

export const VIDEO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
});

const TEXT_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.svg': 'image/svg+xml',
});

export const NON_TEXT_SUFFIXES: ReadonlySet<string> = new Set<string>([
  '.icns',
  '.psd',
  '.ai',
  '.eps',
  '.pdf',
  '.doc',
  '.docx',
  '.dot',
  '.dotx',
  '.rtf',
  '.odt',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlt',
  '.xltx',
  '.xltm',
  '.ods',
  '.ppt',
  '.pptx',
  '.pptm',
  '.pps',
  '.ppsx',
  '.odp',
  '.pages',
  '.numbers',
  '.key',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.zst',
  '.lz',
  '.lz4',
  '.br',
  '.cab',
  '.ar',
  '.deb',
  '.rpm',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aac',
  '.m4a',
  '.wma',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.apk',
  '.ipa',
  '.jar',
  '.class',
  '.pyc',
  '.pyo',
  '.wasm',
  '.dmg',
  '.iso',
  '.img',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.db3',
]);

const ASF_HEADER = Buffer.from([
  0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
]);

const FTYP_IMAGE_BRANDS: Readonly<Record<string, string>> = Object.freeze({
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  heix: 'image/heif',
  hevc: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
});

const FTYP_VIDEO_BRANDS: Readonly<Record<string, string>> = Object.freeze({
  isom: 'video/mp4',
  iso2: 'video/mp4',
  iso5: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  mp4v: 'video/mp4',
  m4v: 'video/x-m4v',
  qt: 'video/quicktime',
  '3gp4': 'video/3gpp',
  '3gp5': 'video/3gpp',
  '3gp6': 'video/3gpp',
  '3gp7': 'video/3gpp',
  '3g2': 'video/3gpp2',
});

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function startsWith(buf: Buffer, prefix: Buffer | readonly number[]): boolean {
  const needle = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix);
  if (buf.length < needle.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (buf[i] !== needle[i]) return false;
  }
  return true;
}

function sniffFtypBrand(header: Buffer): string | null {
  if (header.length < 12) return null;
  if (header.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  const raw = header.subarray(8, 12).toString('latin1').toLowerCase();
  // Python `.strip()` 通过 `decode(..., errors="ignore")` 语义移除
  // ASCII 空白（包括尾部 NUL）。我们近似处理：修剪空格和尾部 NUL，
  // 使 `qt  ` → `qt` 这样的 brand 正确解析。
  // oxlint-disable-next-line no-control-regex
  return raw.replaceAll(/[\s\u0000]+$/g, '').trim();
}

export function sniffMediaFromMagic(data: Buffer | Uint8Array): FileType | null {
  const buf = toBuffer(data);
  const header = buf.length > MEDIA_SNIFF_BYTES ? buf.subarray(0, MEDIA_SNIFF_BYTES) : buf;

  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mimeType: 'image/png' };
  }
  if (startsWith(header, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mimeType: 'image/jpeg' };
  }
  if (startsWith(header, Buffer.from('GIF87a')) || startsWith(header, Buffer.from('GIF89a'))) {
    return { kind: 'image', mimeType: 'image/gif' };
  }
  if (startsWith(header, Buffer.from('BM'))) {
    return { kind: 'image', mimeType: 'image/bmp' };
  }
  if (
    startsWith(header, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(header, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return { kind: 'image', mimeType: 'image/tiff' };
  }
  if (startsWith(header, [0x00, 0x00, 0x01, 0x00])) {
    return { kind: 'image', mimeType: 'image/x-icon' };
  }
  if (startsWith(header, Buffer.from('RIFF')) && header.length >= 12) {
    const chunk = header.subarray(8, 12).toString('latin1');
    if (chunk === 'WEBP') return { kind: 'image', mimeType: 'image/webp' };
    if (chunk === 'AVI ') return { kind: 'video', mimeType: 'video/x-msvideo' };
  }
  if (startsWith(header, Buffer.from('FLV'))) {
    return { kind: 'video', mimeType: 'video/x-flv' };
  }
  if (startsWith(header, ASF_HEADER)) {
    return { kind: 'video', mimeType: 'video/x-ms-wmv' };
  }
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) {
    const lowered = header.toString('latin1').toLowerCase();
    if (lowered.includes('webm')) return { kind: 'video', mimeType: 'video/webm' };
    if (lowered.includes('matroska')) return { kind: 'video', mimeType: 'video/x-matroska' };
  }
  const brand = sniffFtypBrand(header);
  if (brand !== null && brand !== '') {
    if (brand in FTYP_IMAGE_BRANDS) {
      return { kind: 'image', mimeType: FTYP_IMAGE_BRANDS[brand]! };
    }
    if (brand in FTYP_VIDEO_BRANDS) {
      return { kind: 'video', mimeType: FTYP_VIDEO_BRANDS[brand]! };
    }
  }
  return null;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * 尽力读取常见光栅格式的像素尺寸。
 *
 * 仅检查文件开头附近每种格式记录尺寸的固定区域（IHDR/DIB 头、
 * `WEBP` 标记后的 RIFF 块，或第一个 JPEG SOFn 段）。
 * 对于尺寸无法从该区域定位的格式，或提供的缓冲区太短时返回 `null`。
 */
export function sniffImageDimensions(data: Buffer | Uint8Array): ImageDimensions | null {
  const buf = toBuffer(data);

  // PNG ——IHDR 是第一个块；宽度/高度为大端 uint32，
  // 位于偏移 16 和 20。
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF ——逻辑屏幕宽度/高度为小端 uint16，
  // 位于偏移 6 和 8。
  if (
    (startsWith(buf, Buffer.from('GIF87a')) || startsWith(buf, Buffer.from('GIF89a'))) &&
    buf.length >= 10
  ) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // BMP ——DIB 头宽度/高度为小端 int32，位于偏移 18 和 22
  // （自上而下位图高度可能为负数）。
  if (startsWith(buf, Buffer.from('BM')) && buf.length >= 26) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }

  // WEBP ——RIFF 容器；VP8/VP8L/VP8X 各自在 'WEBP' 标记后的
  // 块中以不同方式存储尺寸。
  if (startsWith(buf, Buffer.from('RIFF')) && buf.length >= 30) {
    const fourCc = buf.subarray(12, 16).toString('latin1');
    if (fourCc === 'VP8 ') {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (fourCc === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (fourCc === 'VP8X') {
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { width, height };
    }
  }

  // JPEG ——扫描段标记以查找 Start-Of-Frame (SOFn) 标记，
  // 其载荷以大端 uint16 携带高度/宽度。
  if (startsWith(buf, [0xff, 0xd8])) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1]!;
      // SOFn 标记携带帧尺寸；跳过 SOF4/SOF8/SOF12 (0xc4/0xc8/0xcc)。
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      // 独立标记（RSTn、SOI、EOI）不携带长度字段。
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = buf.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
  }

  return null;
}

function getSuffix(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return '';
  // POSIX `.suffix` 将 `foo.tar.gz` → `.gz`，`foo/.bashrc` → ''（前导点视为"无后缀"）。
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (idx <= lastSep + 1) return '';
  return path.slice(idx).toLowerCase();
}

export function detectFileType(
  path: string,
  header?: Buffer | Uint8Array,
  type: DetectFileTypeMode = 'text',
): FileType {
  const suffix = getSuffix(path);
  let mediaHint: FileType | null = null;
  if (suffix in TEXT_MIME_BY_SUFFIX) {
    mediaHint = { kind: 'text', mimeType: TEXT_MIME_BY_SUFFIX[suffix]! };
  } else if (suffix in IMAGE_MIME_BY_SUFFIX) {
    mediaHint = { kind: 'image', mimeType: IMAGE_MIME_BY_SUFFIX[suffix]! };
  } else if (suffix in VIDEO_MIME_BY_SUFFIX) {
    mediaHint = { kind: 'video', mimeType: VIDEO_MIME_BY_SUFFIX[suffix]! };
  }

  // 当提供 header 时，默认与扩展名提示交叉验证：
  // 类型不匹配时报告 `unknown` 而非盲目信任任一信号。
  // 媒体读取器将字节视为权威来源，仅在 header 无法嗅探时
  // 回退到媒体后缀。
  if (header !== undefined) {
    const buf = toBuffer(header);
    const sniffed = sniffMediaFromMagic(buf);
    if (sniffed) {
      if (type === 'media') return sniffed;
      if (mediaHint) {
        if (sniffed.kind !== mediaHint.kind) {
          return { kind: 'unknown', mimeType: '' };
        }
        return mediaHint;
      }
      return sniffed;
    }
    // Sniff failed.
    // An image extension without confirming magic is not an image in any mode.
    // Every image format the model accepts (PNG/JPEG/GIF/WebP) has a reliable
    // signature, so trusting the extension would only mislead: in media mode it
    // builds a mismatched data URL the model API rejects; in text mode it
    // redirects the user to ReadMediaFile for a file that is not an image.
    if (mediaHint?.kind === 'image') {
      return { kind: 'unknown', mimeType: '' };
    }
    // In media mode, fall back to the extension for video: some containers
    // (e.g. MPEG-PS `.mpg`) have no magic we recognise, so the extension is
    // the only signal. Runs before the NUL check so a video extension wins
    // even when the header happens to contain a 0x00 byte.
    if (type === 'media' && mediaHint?.kind === 'video') {
      return mediaHint;
    }
    if (buf.includes(0x00)) {
      return { kind: 'unknown', mimeType: '' };
    }
    // No sniff, not an image hint, no NUL: fall through to the
    // hint / text / unknown logic.
  }

  if (mediaHint) return mediaHint;
  if (NON_TEXT_SUFFIXES.has(suffix)) {
    return { kind: 'unknown', mimeType: '' };
  }
  return { kind: 'text', mimeType: 'text/plain' };
}

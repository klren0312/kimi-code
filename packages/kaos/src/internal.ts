/**
 * 内部工具模块——提供文本解码、glob 匹配和流缓冲等底层能力。
 * 不对外导出，仅供 kaos 包内部使用。
 */

import { Readable } from "node:stream";

/** 判断一个字节是否为 UTF-8 多字节序列的后续字节（10xxxxxx） */
function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

/**
 * UTF-8 解码（ignore 模式）。
 *
 * 跳过无效的 UTF-8 字节序列，保留有效的 U+FFFD 替换字符。
 * 对应 Python 的 `errors='ignore'` 行为。
 *
 * 按 UTF-8 编码规则逐字节处理：
 * - 0x00-0x7F：单字节 ASCII
 * - 0xC2-0xDF：双字节序列
 * - 0xE0-0xEF：三字节序列
 * - 0xF0-0xF4：四字节序列
 */
function decodeUtf8Ignore(data: Buffer): string {
  let output = "";
  let i = 0;

  while (i < data.length) {
    const b0 = data[i];
    if (b0 === undefined) break;

    // 单字节 ASCII (0xxxxxxx)
    if (b0 <= 0x7f) {
      output += String.fromCodePoint(b0);
      i += 1;
      continue;
    }

    // 双字节序列 (110xxxxx 10xxxxxx)
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = data[i + 1];
      if (b1 !== undefined && isUtf8Continuation(b1)) {
        output += String.fromCodePoint(((b0 & 0x1f) << 6) | (b1 & 0x3f));
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // 三字节序列 (1110xxxx 10xxxxxx 10xxxxxx)
    if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      const validSecond =
        b1 !== undefined &&
        ((b0 === 0xe0 && b1 >= 0xa0 && b1 <= 0xbf) ||
          (b0 >= 0xe1 && b0 <= 0xec && isUtf8Continuation(b1)) ||
          (b0 === 0xed && b1 >= 0x80 && b1 <= 0x9f) ||
          (b0 >= 0xee && b0 <= 0xef && isUtf8Continuation(b1)));

      if (validSecond && b2 !== undefined && isUtf8Continuation(b2)) {
        output += String.fromCodePoint(
          ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f),
        );
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }

    // 四字节序列 (11110xxx 10xxxxxx 10xxxxxx 10xxxxxx)
    if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      const b3 = data[i + 3];
      const validSecond =
        b1 !== undefined &&
        ((b0 === 0xf0 && b1 >= 0x90 && b1 <= 0xbf) ||
          (b0 >= 0xf1 && b0 <= 0xf3 && isUtf8Continuation(b1)) ||
          (b0 === 0xf4 && b1 >= 0x80 && b1 <= 0x8f));

      if (
        validSecond &&
        b2 !== undefined &&
        b3 !== undefined &&
        isUtf8Continuation(b2) &&
        isUtf8Continuation(b3)
      ) {
        output += String.fromCodePoint(
          ((b0 & 0x07) << 18) |
            ((b1 & 0x3f) << 12) |
            ((b2 & 0x3f) << 6) |
            (b3 & 0x3f),
        );
        i += 4;
        continue;
      }
      i += 1;
      continue;
    }

    // 无效字节，跳过
    i += 1;
  }

  return output;
}

/**
 * UTF-16 LE 解码（ignore 模式）。
 *
 * 跳过无效的 UTF-16 代理对，保留有效的码点。
 * 处理高代理 (0xD800-0xDBFF) + 低代理 (0xDC00-0xDFFF) 的配对逻辑。
 */
function decodeUtf16LeIgnore(data: Buffer): string {
  let output = "";
  let i = 0;

  while (i + 1 < data.length) {
    const first = data[i];
    const second = data[i + 1];
    if (first === undefined || second === undefined) break;

    const codeUnit = first | (second << 8);

    // 高代理项：需要配对低代理项
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const lowFirst = data[i + 2];
      const lowSecond = data[i + 3];
      if (lowFirst !== undefined && lowSecond !== undefined) {
        const low = lowFirst | (lowSecond << 8);
        if (low >= 0xdc00 && low <= 0xdfff) {
          const codePoint =
            0x10000 + ((codeUnit - 0xd800) << 10) + (low - 0xdc00);
          output += String.fromCodePoint(codePoint);
          i += 4;
          continue;
        }
      }
      i += 2;
      continue;
    }

    // 孤立的低代理项，跳过
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      i += 2;
      continue;
    }

    // 普通 BMP 码点
    output += String.fromCodePoint(codeUnit);
    i += 2;
  }

  return output;
}

/**
 * 将 Buffer 解码为字符串，支持与 Python 兼容的 `errors` 处理模式。
 *
 * - `'strict'`（默认）：遇到无效序列时抛出异常（通过 TextDecoder `fatal: true`）
 * - `'replace'`：将每个无效序列替换为 U+FFFD（TextDecoder 默认行为）
 * - `'ignore'`：丢弃无效的输入字节，同时保留文件中原本有效的 U+FFFD 字符
 *
 * 对于 TextDecoder 不支持的编码（如 `hex`、`base64`、`binary`、`latin1`），
 * 回退到 `Buffer.toString(encoding)`——这些是无损的字节-字符映射，`errors` 参数无效。
 * @internal
 */
export function decodeTextWithErrors(
  data: Buffer,
  encoding: BufferEncoding,
  errors: "strict" | "replace" | "ignore" = "strict",
  ignoreBOM: boolean = false,
): string {
  // 将 Node 的 BufferEncoding 名称映射为 Web TextDecoder 标签。
  // 只有 UTF 系列编码参与 strict/replace/ignore 处理；
  // 其他编码是无损的，直接使用 Buffer.toString。
  let webLabel: string | undefined;
  // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
  switch (encoding) {
    case "utf-8":
    case "utf8":
      webLabel = "utf-8";
      break;
    case "utf16le":
    case "ucs2":
    case "ucs-2":
      webLabel = "utf-16le";
      break;
    default:
      webLabel = undefined;
  }

  if (webLabel === undefined) {
    // 非 UTF 编码（hex/base64/latin1/binary/ascii）是无损的字节↔字符映射，
    // `errors` 对它们没有意义，直接返回。
    return data.toString(encoding);
  }

  if (errors === "strict") {
    return new TextDecoder(webLabel, { fatal: true, ignoreBOM }).decode(data);
  }

  // 'ignore' 必须跳过无效的输入字节/码元，而不是删除解码输出中的每个
  // 替换字符。文件中可能包含原本有效的 U+FFFD，Python 在 errors="ignore"
  // 下会保留它。
  if (errors === "ignore") {
    return webLabel === "utf-8"
      ? decodeUtf8Ignore(data)
      : decodeUtf16LeIgnore(data);
  }

  // 'replace' → substitute each invalid sequence with U+FFFD (default).
  return new TextDecoder(webLabel, { fatal: false, ignoreBOM }).decode(data);
}

/**
 * 将 glob 模式段（如 `*.txt`、`file?.log`）转换为正则表达式。
 *
 * 匹配 Python pathlib 的行为：
 * - `*` 匹配任意数量的非斜杠字符（包含 dotfile）
 * - `?` 匹配单个非斜杠字符
 * - `[abc]` / `[!abc]` 字符类（`!` 取反，`^` 保持字面量）
 * - 默认大小写敏感
 * @internal
 */
export function globPatternToRegex(
  pattern: string,
  caseSensitive: boolean,
): RegExp {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === undefined) break;
    switch (ch) {
      case "*":
        // 匹配任意数量的非斜杠字符
        regex += "[^/]*";
        break;
      case "?":
        // 匹配单个非斜杠字符
        regex += "[^/]";
        break;
      case "[": {
        const end = pattern.indexOf("]", i + 1);
        if (end === -1) {
          // 没有闭合的 `[`，按字面量处理
          regex += "\\[";
        } else {
          // Glob 字符类只用 `!` 取反。字面前导 `^` 必须保持字面量，
          // 即使 JS 正则字符类在首位将其视为取反。
          let charClass = pattern.slice(i + 1, end);
          // 转义类内的反斜杠，避免尾部反斜杠意外转义闭合的 `]`
          charClass = charClass.replace(/\\/g, "\\\\");
          if (charClass.startsWith("!")) {
            charClass = "^" + charClass.slice(1);
          } else if (charClass.startsWith("^")) {
            charClass = "\\" + charClass;
          }
          regex += "[" + charClass + "]";
          i = end;
        }
        break;
      }
      case "\\": {
        if (i + 1 < pattern.length) {
          const next = pattern.charAt(i + 1);
          regex += next.replaceAll(/[{}()+.\\[\]^$|]/g, "\\$&");
          // 跳过已转义的字符，避免被当作正则元字符再次处理
          i++;
        } else {
          regex += "\\\\";
        }
        break;
      }
      default:
        // 普通字符：转义正则元字符
        regex += ch.replaceAll(/[{}()+.\\[\]^$|]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex, caseSensitive ? "" : "i");
}

/**
 * 带缓冲的 Readable 包装器。
 *
 * 保留源流的背压机制，同时允许消费者在源流结束后仍能读取已缓冲的输出。
 * 这对于进程执行场景至关重要：进程退出后，调用方仍需读取 stdout/stderr
 * 中剩余的缓冲数据。
 * @internal
 */
export class BufferedReadable extends Readable {
  private readonly _source: Readable;
  private _ended: boolean = false;

  constructor(source: Readable) {
    // 适度的预取窗口，确保 wait() 后再 read() 对常见的中小型输出仍然有效，
    // 同时不会无限消耗内存。
    super({ highWaterMark: 128 * 1024 });
    this._source = source;
    this._source.on("data", this._onData);
    this._source.on("end", this._onEnd);
    this._source.on("close", this._onClose);
    this._source.on("error", this._onError);
  }

  override _read(): void {
    // 恢复源流的读取（如果尚未结束或销毁）
    if (!this._ended && !this.destroyed) {
      this._source.resume();
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    // 清理所有事件监听器并销毁源流
    this._source.off("data", this._onData);
    this._source.off("end", this._onEnd);
    this._source.off("close", this._onClose);
    this._source.off("error", this._onError);
    this._source.destroy();
    callback(error);
  }

  /** 接收源流数据，通过 push 传递给消费者；如果背压信号触发则暂停源流 */
  private readonly _onData = (chunk: string | Uint8Array): void => {
    if (!this.push(chunk)) {
      this._source.pause();
    }
  };

  /** 源流正常结束，推送 null 通知消费者 EOF */
  private readonly _onEnd = (): void => {
    this._ended = true;
    this.push(null);
  };

  /** 源流关闭（可能在 end 之前触发），确保 EOF 被正确传播 */
  private readonly _onClose = (): void => {
    if (!this._ended) {
      this._ended = true;
      this.push(null);
    }
  };

  /** 源流出错，销毁此流并传播错误 */
  private readonly _onError = (error: Error): void => {
    this.destroy(error);
  };
}

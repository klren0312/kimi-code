/**
 * LocalFetchURLProvider — 宿主端 URL 抓取器。
 *
 * 流程：
 *   1. 使用类 Chrome UA 的 GET 请求获取 URL。
 *   2. HTTP >= 400 时以状态码拒绝。
 *   3. 响应超过 `maxBytes` 时拒绝（先检查 content-length，
 *      再以实际 body 长度作为防御性二次校验）。
 *   4. `text/plain` / `text/markdown` → 原样透传。
 *   5. 其他（视为 HTML）→ 对 linkedom 文档运行 Readability。
 *      返回 `# ${title}\n\n${text}`（标题不存在时省略）。
 *      若提取未获得有意义文本，回退到常见内容容器
 *      （`<article>` / `<main>` / `<body>`），然后抛出"有意义内容"错误。
 */

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../builtin';

// Readability 的 .d.ts 引用了全局 `Document` 类型，但本包编译时
// 使用 `lib: ES2023`（无 DOM）。提取构造函数参数类型可避免
// 引入全局 `Document` 名称，同时仍接受 Readability 所需的类型。
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// linkedom 的发布类型依赖于我们未加载的 DOM 库。声明我们实际使用的
// 最小接口，使文件其余部分在不引入 lib.dom.d.ts 的情况下保持类型安全。
interface DomElementLike {
  textContent: string | null;
  querySelector(selector: string): DomElementLike | null;
}
interface DomParseResult {
  document: DomElementLike;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DomParseResult;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface LocalFetchURLProviderOptions {
  userAgent?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  /**
   * 允许获取环回 / RFC 1918 / 链路本地 / ULA 地址。
   * 默认为 `false` ——仅用于测试及（未来）显式启用。
   * 防止被提示注入的 LLM 窃取 AWS/GCP 元数据（169.254.169.254）、
   * 探测内部服务（10.x、192.168.x）或读取本地守护进程（127.0.0.1:*）。
   */
  allowPrivateAddresses?: boolean;
}

/**
 * SSRF 防护 ——拒绝非 http(s) 协议以及（默认）任何属于私有 /
 * 环回 / 链路本地 / ULA IP 字面量的主机名。这是对 URL 字符串的
 * *静态*检查；它**不做** DNS 解析，因此通过 DNS 重绑定解析到
 * 私有 IP 的域名**不**会被捕获。该攻击是已知限制；
 * 缓解措施（如将解析的 IP 固定到 fetch）留待后续实现。
 */
function assertSafeFetchTarget(url: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`);
  }
  if (allowPrivate) return;
  // URL hostname 在某些（非全部）Node 版本上会为 IPv6 字面量
  // 保留外围的 `[ ]`。为统一比较而剥离它们。
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  // 字面量 "localhost" / 环回别名。
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // IPv6 环回 / ULA / 链路本地。在剥离方括号后检查。
  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // IPv4 字面量 ——仅在主机名为点分四组时检查；普通域名不会匹配。
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error(`Invalid IPv4 literal: "${host}"`);
    }
    const [a, b] = octets as [number, number, number, number];
    // 127.0.0.0/8 环回、10.0.0.0/8、192.168.0.0/16、
    // 172.16.0.0/12、169.254.0.0/16 链路本地 / AWS 元数据、
    // 0.0.0.0/8 "本网络"、100.64.0.0/10 CGNAT。
    const isLoopback = a === 127;
    const isPrivate10 = a === 10;
    const isPrivate192 = a === 192 && b === 168;
    const isPrivate172 = a === 172 && b >= 16 && b <= 31;
    const isLinkLocal = a === 169 && b === 254;
    const isZero = a === 0;
    const isCgnat = a === 100 && b >= 64 && b <= 127;
    if (
      isLoopback ||
      isPrivate10 ||
      isPrivate192 ||
      isPrivate172 ||
      isLinkLocal ||
      isZero ||
      isCgnat
    ) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
  }
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly allowPrivateAddresses: boolean;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  }

  async fetch(url: string, _options?: { toolCallId?: string }): Promise<UrlFetchResult> {
    assertSafeFetchTarget(url, this.allowPrivateAddresses);

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent },
    });

    if (response.status >= 400) {
      // 释放未使用的 body，使 undici 可将套接字归还
      // keep-alive 池，而非在错误路径上泄漏。
      await response.body?.cancel().catch(() => {
        /* 已关闭 */
      });
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    // 在缓冲整个 body 剉拒绝过大的响应。
    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        throw new Error(
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
    }

    const body = await response.text();

    // 服务器可能省略 content-length ——防御性地再次测量。
    const actualBytes = Buffer.byteLength(body, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error(
        `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return { content: body, kind: 'passthrough' };
    }

    return { content: this.extractMainContent(body), kind: 'extracted' };
  }

  private extractMainContent(html: string): string {
    // Readability 会变异其解析的 DOM，因此解析两次 ——一次用于
    // 主提取器，一次用于回退路径。
    const primary = parseHTML(html);
    try {
      const reader = new Readability(primary.document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      });
      const article = reader.parse();
      if (article !== null) {
        const text = (article.textContent ?? '').trim();
        if (text.length > 0) {
          const title = (article.title ?? '').trim();
          return title.length > 0 ? `# ${title}\n\n${text}` : text;
        }
      }
    } catch {
      // 回退到基于容器的提取路径。
    }

    const { document } = parseHTML(html);
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    const container =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('body');
    const fallbackText = (container?.textContent ?? '').trim();

    if (fallbackText.length === 0) {
      throw new Error(
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}

/**
 * `AcpKaos` — a {@link Kaos} that bridges file reads/writes through the
 * ACP client (e.g. Zed's unsaved-buffer view of the workspace) and
 * delegates every other operation to an `inner` {@link Kaos} (typically
 * a {@link LocalKaos}).
 *
 * Why a separate class instead of an `if (acpAvailable) { ... }` branch
 * inside `LocalKaos`? Because the SDK and the tooling code talk to a
 * single {@link Kaos} reference, and dependency-inverting the FS bridge
 * is the cheapest way to keep capability gating *out* of every tool.
 * When the client doesn't advertise `fs.read_text_file` / `write_text_file`
 * we simply never wrap — tools observe a plain `LocalKaos` and Phase 6
 * is invisible to them.
 *
 * Construction is cheap (no I/O, no probes); one per {@link AcpSession}
 * is the intended unit, but reusing across prompts is also fine.
 */

import { Buffer } from 'node:buffer';

import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import {
  KaosError,
  type Environment,
  type Kaos,
  type KaosProcess,
  type StatResult,
} from '@moonshot-ai/kaos';

// ── 中文概述 ──
// 本模块实现了 `AcpKaos` —— 一个桥接 ACP 客户端文件读写的 Kaos 适配器。
// 核心职责：将文本读写操作通过 ACP 反向 RPC 通道转发给客户端（如 Zed 编辑器），
// 其余操作（路径、进程执行、二进制读取等）委托给内部 Kaos 实例（通常是 LocalKaos）。
// 设计模式：装饰器/代理模式 —— 在不修改工具代码的前提下注入 ACP 文件桥接能力。
// 当客户端不支持 fs.read_text_file / write_text_file 时，直接使用底层 Kaos，对工具透明。

/**
 * `Kaos` that routes `read*` / `write*` through the ACP reverse-RPC
 * channel and delegates everything else to `inner`.
 *
 * Path semantics: the ACP spec requires absolute paths for
 * `fs/readTextFile` and `fs/writeTextFile`. This class does NOT resolve
 * relative paths — callers are expected to feed already-absolute paths
 * (mirrors `LocalKaos._resolvePath`'s public surface). If you need
 * cwd-relative resolution, route through `inner.normpath` first or use
 * `withCwd()` to bind a base.
 */
// 中文：ACP 文件系统桥接器 —— 将文件读写通过 ACP RPC 转发，其余操作委托给内部 Kaos
export class AcpKaos implements Kaos {
  constructor(
    private readonly conn: AgentSideConnection, // ACP 客户端连接实例
    private readonly sessionId: string,         // ACP 会话标识
    private readonly inner: Kaos,               // 内部 Kaos 实例，处理非文件操作
  ) {}

  // ── identity ────────────────────────────────────────────────────────

  /** Distinguishable name so logs / `name` checks can disambiguate. */
  // 中文：返回带前缀的标识名，用于日志区分 ACP 桥接与本地 Kaos
  get name(): string {
    return `acp(${this.inner.name})`;
  }

  get osEnv(): Environment {
    return this.inner.osEnv;
  }

  // ── 路径操作：全部委托给内部 Kaos ─────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return this.inner.pathClass();
  }

  normpath(path: string): string {
    return this.inner.normpath(path);
  }

  gethome(): string {
    return this.inner.gethome();
  }

  getcwd(): string {
    return this.inner.getcwd();
  }

  chdir(path: string): Promise<void> {
    return this.inner.chdir(path);
  }

  /**
   * Return a fresh `AcpKaos` wrapping the inner Kaos's cwd-derived
   * instance — so a `chdir` followed by `readText('relative.ts')`
   * continues to hit the ACP bridge rather than silently dropping back
   * to local filesystem reads.
   */
  // 中文：创建绑定新工作目录的 AcpKaos 实例，确保后续相对路径读写仍走 ACP 桥接
  withCwd(cwd: string): Kaos {
    return new AcpKaos(this.conn, this.sessionId, this.inner.withCwd(cwd));
  }

  withEnv(env: Record<string, string>): Kaos {
    return new AcpKaos(this.conn, this.sessionId, this.inner.withEnv(env));
  }

  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    return this.inner.stat(path, options);
  }

  iterdir(path: string): AsyncGenerator<string> {
    return this.inner.iterdir(path);
  }

  glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    return this.inner.glob(path, pattern, options);
  }

  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    return this.inner.mkdir(path, options);
  }

  // ── 文件读取：通过 ACP fs/readTextFile 路由 ─────────────────────────

  /**
   * Read the file via ACP. Decoding parameters (`encoding`, `errors`)
   * are accepted for interface compatibility but ignored — the ACP
   * `fs/readTextFile` response is already a decoded string, so we have
   * no bytes to re-decode. Tools that need byte-exact decoding control
   * should be routed through a non-ACP Kaos.
   */
  // 中文：通过 ACP RPC 读取文本文件内容；encoding 参数仅为接口兼容，实际被忽略
  async readText(
    path: string,
    _options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const rpcPath = this.toClientPath(path);
    try {
      const resp = await this.conn.readTextFile({ sessionId: this.sessionId, path: rpcPath });
      return resp.content;
    } catch (err) {
      throw wrapKaosError(`acp: readTextFile failed for ${rpcPath}`, err);
    }
  }

  /**
   * Binary reads bypass the ACP text RPC by design: `fs/readTextFile`
   * returns a decoded string and would corrupt or reject non-UTF-8
   * payloads (images, video, archives — anything `ReadMediaFile` may
   * touch). The ACP bridge only owns the *text* surface; raw bytes
   * stay on the local filesystem via `inner`.
   */
  // 中文：二进制读取绕过 ACP，直接走本地文件系统（ACP 仅支持文本，不能处理图片等二进制数据）
  readBytes(path: string, n?: number): Promise<Buffer> {
    return this.inner.readBytes(path, n);
  }

  /**
   * Return a small UTF-8 header derived from the same ACP text source as
   * `readText` / `readLines`, used only by text-read callers for sniffing.
   * Keep `readBytes` local so binary callers such as ReadMediaFile stay safe.
   */
  // 中文：从 ACP 读取文本并截取前 n 个字符的 UTF-8 字节预览，用于文件类型嗅探
  async readTextPreview(path: string, n: number): Promise<Buffer> {
    const text = await this.readText(path);
    return Buffer.from(text.slice(0, n), 'utf8');
  }

  /**
   * Yield lines from the file, each terminated by its `\n` (the final
   * line has no terminator if the file did not end with `\n`). Matches
   * {@link LocalKaos.readLines} so tools that depend on line terminators
   * (e.g. {@link ReadTool}, which renders CRLF endings) behave identically
   * whether the underlying Kaos is local or ACP-bridged.
   */
  // 中文：按行异步生成器读取文件内容，每行保留 \n 终止符，兼容 LocalKaos 行为
  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    if (text.length === 0) return;
    // 中文：逐字符扫描 \n，按行切分并 yield；保留每行末尾的换行符
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x0a /* \n */) {
        yield text.slice(start, i + 1);
        start = i + 1;
      }
    }
    // 中文：如果文件末尾没有 \n，最后一行也要 yield
    if (start < text.length) yield text.slice(start);
  }

  // ── 文件写入：通过 ACP fs/writeTextFile 路由 ─────────────────────────

  /**
   * Write text via ACP. `encoding` is ignored — ACP wire format is
   * always UTF-8 string content. `mode: 'a'` (append) emulates with a
   * read-then-write fallback: ACP has no native append, and the
   * intended audience (unsaved-buffer scratchpads) rarely needs it.
   * If the prior read fails because the file does not exist, the write
   * proceeds as if the existing content were empty — matching Python
   * `open('a')` which creates new files. Any other read failure
   * (permission, transport, internal) propagates so we never silently
   * destroy existing content.
   *
   * Returns `data.length` (chars) to match {@link LocalKaos.writeText}'s
   * contract.
   */
  // 中文：通过 ACP 写入文本文件；追加模式通过"先读后写"模拟（ACP 无原生 append 支持）
  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    if (options?.mode === 'a') {
      // 中文：追加模式 —— 先读取已有内容，拼接新内容后整体写回
      let existing = '';
      try {
        existing = await this.readText(path);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        // 中文：文件不存在时视为空内容（与 Python open('a') 行为一致）
        existing = '';
      }
      await this.acpWrite(path, existing + data);
      return data.length;
    }
    await this.acpWrite(path, data);
    return data.length;
  }

  /**
   * Write raw bytes via ACP by interpreting them as UTF-8. Non-UTF-8
   * payloads will be lossy; the intended use case is text writes
   * (Read/Write/Edit tools), not binary streaming.
   */
  // 中文：将原始字节按 UTF-8 编码写入文件（非 UTF-8 内容会损失，主要用于文本工具）
  async writeBytes(path: string, data: Buffer): Promise<number> {
    await this.acpWrite(path, data.toString('utf8'));
    return data.byteLength;
  }

  // 中文：内部方法 —— 通过 ACP RPC 调用 writeTextFile，失败时包装为 KaosError
  private async acpWrite(path: string, content: string): Promise<void> {
    const rpcPath = this.toClientPath(path);
    try {
      await this.conn.writeTextFile({ sessionId: this.sessionId, path: rpcPath, content });
    } catch (err) {
      throw wrapKaosError(`acp: writeTextFile failed for ${rpcPath}`, err);
    }
  }

  // 中文：Windows 路径适配 —— 将 / 分隔符替换为 \，非 Win32 系统直接返回原路径
  private toClientPath(path: string): string {
    if (this.inner.pathClass() !== 'win32') return path;
    return path.replaceAll('/', '\\');
  }

  // ── 进程执行：全部委托给内部 Kaos ────────────────────────────────

  exec(...args: string[]): Promise<KaosProcess> {
    return this.inner.exec(...args);
  }

  execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    return this.inner.execWithEnv(args, env);
  }
}

/**
 * Build a `KaosError` wrapping a raw RPC failure. We can't use the
 * `Error(message, { cause })` overload here because {@link KaosError}'s
 * constructor only accepts `(message: string)` (see
 * `packages/kaos/src/errors.ts`). Instead we synthesize the message
 * with the original error's `.message` appended and assign `.cause`
 * post-construction so structured-clone consumers (logs, debuggers)
 * can still walk the chain.
 */
// 中文：将原始 RPC 错误包装为 KaosError，手动挂载 cause 链以便调试器遍历错误链
function wrapKaosError(prefix: string, cause: unknown): KaosError {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const err = new KaosError(`${prefix}: ${causeMessage}`);
  // 中文：KaosError 构造函数不支持 cause 参数，因此在创建后手动赋值（避免修改 kaos 包）
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

/**
 * Return true iff `err` is a structured "file does not exist" failure on
 * the read side of an ACP append-mode write. We only trust the ACP SDK's
 * `RequestError.resourceNotFound` code (`-32002`), optionally wrapped in a
 * `KaosError` by `readText` above. Message substring matching is intentionally
 * avoided: wrapper messages include the path, so a path or non-ENOENT failure
 * mentioning "not found" could otherwise be misclassified and cause append
 * mode to overwrite existing content.
 */
// 中文：判断错误是否为"文件不存在"（通过遍历 cause 链查找 ACP SDK 的 resourceNotFound 错误码）
function isNotFoundError(err: unknown): boolean {
  // 中文：遍历错误链（cause 链），查找 RequestError 且错误码为 -32002（资源未找到）
  const visited = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !visited.has(cur)) {
    visited.add(cur);
    if (cur instanceof RequestError && cur.code === -32002) return true;
    if (cur instanceof Error) {
      cur = (cur as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

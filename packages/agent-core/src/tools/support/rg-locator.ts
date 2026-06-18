/**
 * rg-locator ——混合 ripgrep 二进制文件解析。
 *
 * 查找顺序（首次命中即返回）：
 *   1. 系统 PATH（`which rg`）——最快，尊重开发者环境配置
 *   2. 内置供应商二进制文件（钩子；尚未接入——`getVendorRgPath` 是存根）
 *   3. `<KIMI_CODE_HOME>/bin/rg` ——本应用的持久缓存。
 *   4. CDN 下载到 <KIMI_CODE_HOME>/bin/ ——一次性引导
 *
 * 若步骤 1-4 全部失败，调用方收到结构化错误，可将其转换为面向用户的
 * "安装 ripgrep" 提示，而非裸露的 `spawn rg ENOENT`。
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'pathe';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extract as extractTar } from 'tar';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

import { abortable } from '../../utils/abort';

const RG_VERSION = '15.0.0';
const RG_BASE_URL = 'https://code.kimi.com/kimi-code/rg';
const DOWNLOAD_TIMEOUT_MS = 600_000;
const RG_ARCHIVE_SHA256: Record<string, string> = {
  'ripgrep-15.0.0-aarch64-apple-darwin.tar.gz':
    '98bb2e61e7277ba0ea72d2ae2592497fd8d2940934a16b122448d302a6637e3b',
  'ripgrep-15.0.0-aarch64-pc-windows-msvc.zip':
    '572709c8770cb7f9385d725cb06d2bcd9537ec24d4dd17b1be1d65a876f8b591',
  'ripgrep-15.0.0-aarch64-unknown-linux-gnu.tar.gz':
    '15f8cc2fab12d88491c54d49f38589922a9d6a7353c29b0a0856727bcdf80754',
  'ripgrep-15.0.0-x86_64-apple-darwin.tar.gz':
    '44128c733d127ddbda461e01225a68b5f9997cfe7635242a797f645ca674a71a',
  'ripgrep-15.0.0-x86_64-pc-windows-msvc.zip':
    '21a98bf42c4da97ca543c010e764cc6dec8b9b7538d05f8d21874016385e0860',
  'ripgrep-15.0.0-x86_64-unknown-linux-musl.tar.gz':
    '253ad0fd5fef0d64cba56c70dccdacc1916d4ed70ad057cc525fcdb0c3bbd2a7',
};

export type RgResolutionSource =
  | 'system-path'
  | 'vendor'
  | 'share-bin-cached'
  | 'share-bin-downloaded';

export interface RgResolution {
  readonly path: string;
  readonly source: RgResolutionSource;
}

export interface EnsureRgPathOptions {
  readonly shareDir?: string | undefined;
  /**
   * 取消此调用方的等待。已在进行中的共享引导下载可能继续执行，
   * 使其他调用方仍可使用同一结果。
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * 解析可用 `rg` 二进制文件的绝对路径，必要时下载到
 * `<shareDir>/bin/`。多个并发调用通过模块级锁序列化，
 * 使下载在每个进程中最多执行一次。
 */
export async function ensureRgPath(options: EnsureRgPathOptions = {}): Promise<RgResolution> {
  options.signal?.throwIfAborted();
  const resolution = resolveRgPath(options.shareDir ?? getShareDir(), options.signal);
  return options.signal === undefined ? resolution : abortable(resolution, options.signal);
}

async function resolveRgPath(
  shareDir: string,
  signal?: AbortSignal | undefined,
): Promise<RgResolution> {
  const existing = await findExistingRg(shareDir);
  if (existing) return existing;
  signal?.throwIfAborted();
  return downloadRgWithLock(shareDir);
}

/**
 * 纯查找变体，用于希望断言解析顺序而不触发实际下载的测试环境。
 */
export async function findExistingRg(shareDir: string): Promise<RgResolution | undefined> {
  const binName = rgBinaryName();
  const systemRg = await whichRg();
  if (systemRg !== undefined) return { path: systemRg, source: 'system-path' };
  const vendorPath = getVendorRgPath(binName);
  if (vendorPath !== undefined && (await isExecutableFile(vendorPath))) {
    return { path: vendorPath, source: 'vendor' };
  }
  const cachePath = join(shareDir, 'bin', binName);
  if (await isExecutableFile(cachePath)) {
    return { path: cachePath, source: 'share-bin-cached' };
  }
  return undefined;
}

let downloadPromise: Promise<RgResolution> | undefined;
async function downloadRgWithLock(shareDir: string): Promise<RgResolution> {
  if (downloadPromise !== undefined) return downloadPromise;
  downloadPromise = (async () => {
    try {
      const existing = await findExistingRg(shareDir);
      if (existing) return existing;
      const binPath = await downloadAndInstallRg(shareDir);
      return { path: binPath, source: 'share-bin-downloaded' };
    } finally {
      downloadPromise = undefined;
    }
  })();
  return downloadPromise;
}

function rgBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function getShareDir(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.kimi-code');
}

function getVendorRgPath(_binName: string): string | undefined {
  return undefined;
}

async function whichRg(): Promise<string | undefined> {
  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const binName = rgBinaryName();
  for (const dir of pathEnv.split(sep)) {
    if (dir === '') continue;
    const candidate = join(dir, binName);
    try {
      const st = await stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* 不在此处，尝试下一个 */
    }
  }
  return undefined;
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** @internal 供测试使用 ——rust 风格 `<arch>-<vendor>-<os>` 目标三元组。 */
export function detectTarget(): string | undefined {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined;
  if (arch === undefined) return undefined;

  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'linux') {
    return arch === 'x86_64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-gnu';
  }
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  return undefined;
}

async function downloadAndInstallRg(shareDir: string): Promise<string> {
  const target = detectTarget();
  if (target === undefined) {
    throw new Error(
      `Unsupported platform/arch for ripgrep download: ${process.platform}/${process.arch}`,
    );
  }

  // Windows ripgrep 发行版为 `.zip`；macOS / Linux 为 `.tar.gz`。
  // try 块内的解压分支处理格式特定的解包；
  // fetch + 下载到临时目录的管道是相同的。
  const isWindows = target.includes('windows');
  const archiveExt = isWindows ? 'zip' : 'tar.gz';
  const archiveName = `ripgrep-${RG_VERSION}-${target}.${archiveExt}`;
  const expectedSha256 = RG_ARCHIVE_SHA256[archiveName];
  if (expectedSha256 === undefined) {
    throw new Error(`No pinned SHA-256 is configured for ripgrep archive ${archiveName}`);
  }
  const url = `${RG_BASE_URL}/${archiveName}`;

  const binDir = join(shareDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const destination = join(binDir, rgBinaryName());

  const tmp = await mkdtemp(join(tmpdir(), 'kimi-rg-'));
  try {
    const archivePath = join(tmp, archiveName);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!resp.ok || resp.body === null) {
      throw new Error(`Failed to download ripgrep: HTTP ${String(resp.status)} ${resp.statusText}`);
    }
    const write = createWriteStream(archivePath);
    // Readable.fromWeb 的类型签名接受 web ReadableStream；
    // undici/fetch body 在运行时匹配该形状。
    await pipeline(Readable.fromWeb(resp.body as never), write);
    await verifyArchiveChecksum(archivePath, archiveName, expectedSha256);

    if (isWindows) {
      await extractRgFromZip(archivePath, destination);
      // Windows 不需要 `chmod +x`：执行权限由 `.exe` 扩展名
      // + NTFS ACL 控制，这些已经正确设置。
    } else {
      const extractDir = join(tmp, 'extract');
      await mkdir(extractDir, { recursive: true });
      // tar.gz 使用硬编码前缀，因为 CDN 的 tar.gz 布局是稳定的，
      // 且已从上游发行版获知；zip 分支使用 basename 匹配作为更宽松的
      // 契约，使 CDN 前缀变更不会静默失败。
      await extractTar({
        file: archivePath,
        cwd: extractDir,
        gzip: true,
        filter: (entryPath: string) => entryPath.endsWith(`/${rgBinaryName()}`),
      });
      const extracted = join(extractDir, `ripgrep-${RG_VERSION}-${target}`, rgBinaryName());
      if (!existsSync(extracted)) {
        throw new Error(
          `Ripgrep archive did not contain expected binary at ${extracted}. ` +
            'CDN content may have changed.',
        );
      }
      const installDir = await mkdtemp(join(binDir, '.rg-install-'));
      const staged = join(installDir, rgBinaryName());
      try {
        await copyFile(extracted, staged);
        await chmod(staged, 0o755);
        await rename(staged, destination);
      } finally {
        await rm(installDir, { recursive: true, force: true });
      }
    }
    return destination;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** @internal 供测试使用 ——在提取下载字节前进行关闭失败校验。 */
export async function verifyArchiveChecksum(
  archivePath: string,
  archiveName: string,
  expectedSha256: string,
): Promise<void> {
  const actualSha256 = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Ripgrep archive checksum mismatch for ${archiveName}: expected ${expectedSha256}, ` +
        `got ${actualSha256}. CDN content may have changed.`,
    );
  }
}

/**
 * 读取已下载的 `.zip`（`archivePath`），查找 `rg.exe` 条目
 * （basename 匹配），并将其流式输出到 `destination`。当归档中
 * 无匹配条目时抛出共享的"CDN 内容可能已更改"哨兵错误 ——与
 * tar.gz 路径的 `existsSync(extracted)` 门控相同的失败语义，
 * 使调用方看到单一可操作的消息。
 */
export async function extractRgFromZip(archivePath: string, destination: string): Promise<void> {
  const buf = await readFile(archivePath);
  const binName = rgBinaryName(); // 'rg.exe' on win32
  await new Promise<void>((resolve, reject) => {
    yauzlFromBuffer(buf, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(new Error(`Failed to open ripgrep archive: ${openErr?.message ?? 'unknown error'}`));
        return;
      }
      let found = false;
      const onEntry = (entry: Entry): void => {
        // 按 basename（非全路径）匹配 ——保持匹配器对
        // CDN 重新打包调整（如意外的 `ripgrep-X.Y.Z-TARGET/`
        // 前缀变更）的健壮性。
        if (basename(entry.fileName) !== binName) {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null) {
            reject(
              new Error(`Failed to read ${entry.fileName} from archive: ${streamErr.message}`),
            );
            zipfile.close();
            return;
          }
          const out = createWriteStream(destination);
          void (async () => {
            try {
              await pipeline(stream, out);
              zipfile.close();
              resolve();
            } catch (error) {
              zipfile.close();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          })();
        });
      };
      zipfile.on('entry', onEntry);
      zipfile.on('end', () => {
        // 使用 lazyEntries:true 时，`end` 仅在对中央目录的每个条目
        // 调用 readEntry() 后才触发。`found` 变为 true 后停止调用
        // readEntry()，因此 `end` 仅在未找到路径上到达此分支。
        if (!found) {
          reject(
            new Error(
              `Ripgrep archive did not contain expected binary '${binName}'. ` +
                'CDN content may have changed.',
            ),
          );
        }
      });
      zipfile.on('error', (err: Error) => {
        reject(err);
      });
      zipfile.readEntry();
    });
  });
}

/**
 * `ensureRgPath` 抛出异常时显示的面向用户的错误消息。集中保存，
 * 使 Grep / Glob / Bash 管道可以复用。
 */
export function rgUnavailableMessage(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  const shareBin = join(getShareDir(), 'bin', rgBinaryName());
  return (
    `ripgrep (rg) is not available and the automatic bootstrap failed.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `  macOS:   brew install ripgrep\n` +
    `  Ubuntu:  sudo apt-get install ripgrep\n` +
    `  Other:   https://github.com/BurntSushi/ripgrep#installation\n` +
    `\n` +
    `Alternatively, drop a static rg binary at ${shareBin}`
  );
}

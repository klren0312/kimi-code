import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'pathe';
import type { Readable, Writable } from 'node:stream';

import { detectEnvironmentFromNode, type Environment } from './environment';
import { KaosFileExistsError } from './errors';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

const isWindows: boolean = process.platform === 'win32';

/**
 * 构建 `_globWalk` 访问集合所使用的 `(dev, ino)` 环检测键。
 * 当 `ino` 为 0 时返回 `null`，这在不支持 inode 的文件系统上会出现
 * （Windows FAT/exFAT、部分 SMB/NFS 挂载）。返回 null 表示
 * "该目录没有可靠的身份标识"，调用方会跳过该下降路径的访问追踪
 * —— 在这些文件系统上环安全性会减弱，但正常遍历仍可工作，
 * 而不是所有目录都撞在同一个共享键 `"<dev>:0"` 上。
 */
function cycleKey(s: { dev: number; ino: number }): string | null {
  if (s.ino === 0) return null;
  return `${String(s.dev)}:${String(s.ino)}`;
}

class LocalProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private _disposed = false;

  constructor(child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Process must be created with stdin/stdout/stderr pipes.');
    }

    this._child = child;
    this.stdin = child.stdin;
    this.stdout = new BufferedReadable(child.stdout);
    this.stderr = new BufferedReadable(child.stderr);
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    // 如果进程从未真正启动（spawn 失败），则直接返回。
    // pid <= 0 表示 ChildProcess.pid 为 undefined，这在 spawn()
    // 找不到/无法执行命令时会发生。在 POSIX 上对 -1 调用
    // process.kill(-1, ...) 会向整个进程组发信号，可能误杀无关进程。
    if (this.pid <= 0) {
      return Promise.resolve();
    }

    // 在 Windows 上，`ChildProcess.kill()` 只会向 shell 父进程发信号，
    // 子进程的子进程仍然存活。使用 `taskkill /T` 可以让调用方的优雅终止
    // 和强制终止阶段作用于整个进程树。
    if (isWindows) {
      const useForce = signal === 'SIGKILL';
      const taskkillArgs = useForce
        ? ['/T', '/F', '/PID', String(this.pid)]
        : ['/T', '/PID', String(this.pid)];
      return new Promise<void>((resolve) => {
        const killer = spawn('taskkill', taskkillArgs, {
          stdio: 'ignore',
          windowsHide: true,
        });
        const done = (): void => {
          resolve();
        };
        killer.once('error', done);
        killer.once('close', done);
      });
    }

    // 在 POSIX 上，`detached:true` 使子进程成为进程组领导者
    // （pgid === pid）。普通的 `ChildProcess.kill()` 仍然只向直接子进程
    // 发信号，因此像 `bash -c 'sleep 100 & sleep 100'` 这样的 shell 会留下
    // 孤立的孙进程。`process.kill(-pid, signal)` 向整个进程组发信号
    // （负 pid = POSIX kill(2) 下的进程组 id）。
    try {
      process.kill(-this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // ESRCH = 进程组已经退出（子进程在 `wait()` 与此次调用之间
      // 竞争 spawn 并已退出并被回收）。视为成功终止。
      if (err.code === 'ESRCH') return Promise.resolve();
      // EPERM 通常是配置错误（例如文件前面使用了非 detached 方式的 spawn）；
      // 回退到直接调用 `.kill()`，这样至少能向直接子进程发信号，而不是抛出异常。
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal ?? 'SIGTERM');
        } catch {
          /* 尽力而为 */
        }
        return Promise.resolve();
      }
      throw error;
    }
    return Promise.resolve();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }
}

/**
 * 直接与本地文件系统交互的 KAOS 实现。
 *
 * 注意：LocalKaos 维护自己的实例级工作目录（`_cwd`），
 * 而非修改 `process.cwd()`。这使得多个 LocalKaos 实例可以
 * 各自拥有独立的工作目录（例如通过 `runWithKaos` 切换上下文时），
 * 而不会相互污染相对路径解析。
 */
export class LocalKaos implements Kaos {
  readonly name: string = 'local';
  readonly osEnv: Environment;
  private _cwd: string;
  private readonly _envLayers: readonly Record<string, string>[];

  private constructor(
    osEnv: Environment,
    cwd?: string,
    envLayers: readonly Record<string, string>[] = [],
  ) {
    // 构造之后不再触碰 `process.cwd()` / `process.chdir()`
    // —— 所有路径解析都通过 `this._cwd` 进行。默认值从
    // `process.cwd()` 获取，但调用方可以通过 `withCwd`（或直接
    // 提供 `cwd` 参数）将其固定为任意路径。
    this._cwd = normalize(cwd ?? process.cwd());
    this.osEnv = osEnv;
    this._envLayers = envLayers;
  }

  /**
   * 探测宿主环境后创建一个新的 `LocalKaos` 实例。
   *
   * 每次调用都返回一个拥有独立 `_cwd` 的新实例；并发调用者
   * 因此可以在各自独立的工作目录上操作，互不干扰。
   */
  static async create(): Promise<LocalKaos> {
    const osEnv = await detectEnvironmentFromNode();
    return new LocalKaos(osEnv);
  }

  withCwd(cwd: string): LocalKaos {
    return new LocalKaos(this.osEnv, cwd, this._envLayers);
  }

  withEnv(env: Record<string, string>): LocalKaos {
    return new LocalKaos(this.osEnv, this._cwd, [...this._envLayers, env]);
  }

  private _resolvePath(path: string): string {
    if (isAbsolute(path)) return normalize(path);
    return join(this._cwd, path);
  }

  pathClass(): 'posix' | 'win32' {
    return isWindows ? 'win32' : 'posix';
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return normalize(homedir());
  }

  getcwd(): string {
    return this._cwd;
  }

  /**
   * 更改此 LocalKaos 实例的工作目录。
   *
   * 与 Python 的 `os.chdir` 不同，此操作限定在实例范围内，
   * 不会修改 `process.cwd()`。通过 {@link exec} 启动的子进程
   * 继承此实例的 `_cwd`；并发的 LocalKaos 实例各自拥有独立的 cwd。
   * 如果需要 Python 兼容的进程全局 cwd，请直接调用 `process.chdir(x)`。
   */
  async chdir(path: string): Promise<void> {
    const resolved = this._resolvePath(path);
    const s = await stat(resolved);
    if (!s.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this._cwd = resolved;
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const resolved = this._resolvePath(path);
    const followSymlinks = options?.followSymlinks ?? true;
    const s = followSymlinks ? await stat(resolved) : await lstat(resolved);
    return {
      stMode: s.mode,
      stIno: s.ino,
      stDev: s.dev,
      stNlink: s.nlink,
      stUid: s.uid,
      stGid: s.gid,
      stSize: s.size,
      stAtime: s.atimeMs / 1000,
      stMtime: s.mtimeMs / 1000,
      stCtime: isWindows ? s.birthtimeMs / 1000 : s.ctimeMs / 1000,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await readdir(resolved);
    for (const entry of entries) {
      // 使用 join 以避免当 basePath 为根路径（如 "/" 或 "C:\\"）时
      // 产生 "//entry" 或 "C:\\\\entry" —— join 会正确规范化尾部分隔符。
      yield join(resolved, entry);
    }
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    const patternParts = pattern.split('/');
    // 将 basePath 自身的 inode 预先加入 `visited`，这样 basePath 内部的
    // 符号链接如果指回 basePath，就能在首次遇到时就被捕获（而不是在第二层
    // 才被捕获 —— 如果调用方直接从循环根目录进行 glob，这个 "+1 深度" 的
    // 偏差会导致泄漏）。此处 `stat` 失败是容许的：`_globWalk` 会通过
    // readdir 遇到同样的错误并返回空结果。
    const initVisited = new Set<string>();
    try {
      const rootStat = await stat(resolved);
      const rootKey = cycleKey(rootStat);
      if (rootKey !== null) initVisited.add(rootKey);
    } catch {
      // basePath 不存在/不可访问 —— 遍历器会通过自身的 catch 处理
    }
    yield* this._globWalk(resolved, patternParts, caseSensitive, initVisited);
  }

  // `visited` 保存当前下降路径上目录的 `(stDev, stIno)` 键。
  // 在递归进入子目录之前，先检查其键是否在 `visited` 中；
  // 如果存在则跳过（检测到环），否则使用包含新增键的新 Set
  // 进行递归。每次递归时复制集合，使得检测具有路径局部语义：
  // 同一目标被两个不同分支中的合法符号链接引用时，两边都会遍历，
  // 这比 Python 标准库更宽松，同时仍然保证环安全。
  // 同目录自递归（例如 `**` 匹配零个目录且模式有剩余部分）时
  // 传递不变的 `visited` —— 无下降，无环风险。
  //
  // Windows 注意：Node 的 `fs.Stats.ino` 在不支持 inode 的文件系统上
  // 返回 `0`（FAT/exFAT、部分 SMB/NFS 挂载）。如果以 `ino=0` 作为键，
  // 该驱动器上的每个目录都会共享同一个键 `"<dev>:0"`，第一个目录
  // 会"访问"所有其他目录。模块级的 `cycleKey` 辅助函数在这种情况下
  // 返回 `null`，使调用处跳过该下降路径的访问追踪 ——
  // 在这些文件系统上失去了环安全性，但正常遍历仍可工作。
  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
    visited: Set<string>,
  ): AsyncGenerator<string> {
    if (patternParts.length === 0) {
      return;
    }

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      // `**` 匹配零个或多个目录层级。
      //
      // 正好有两种情况需要处理：
      //   (a) `**` 匹配零个目录 → 在 basePath 处继续使用剩余模式部分
      //       （当 `**` 是最后一个段时则 yield basePath 本身）。
      //   (b) `**` 匹配一个或多个目录 → 递归进入每个子目录，
      //       保留 `**`（即完整的 patternParts）在最前面。"零个目录"
      //       的情况会在子目录层级的递归调用中被重新评估。
      //
      // 我们不能对子目录额外用 `remainingParts` 进行递归 ——
      // 那会导致深度 ≥ 1 的每个匹配被重复计算，因为子递归中
      // 的情况 (a) 已经产出这些结果了。
      if (remainingParts.length > 0) {
        yield* this._globWalk(basePath, remainingParts, caseSensitive, visited);
      } else {
        // 模式以 `**` 结尾：yield basePath 本身（零目录匹配）。
        yield basePath;
      }

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        // 使用 join 以避免当 basePath 为文件系统根目录时产生 "//entry"。
        const fullPath = join(basePath, entry);
        let entryStat;
        try {
          entryStat = await stat(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          const key = cycleKey(entryStat);
          if (key !== null && visited.has(key)) continue;
          yield* this._globWalk(
            fullPath,
            patternParts,
            caseSensitive,
            key !== null ? new Set([...visited, key]) : visited,
          );
        } else if (remainingParts.length === 0) {
          // 模式以 `**` 结尾：非目录条目也会匹配
          //（因为 `**` 匹配"任意内容"）。
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!regex.test(entry)) {
          continue;
        }

        // 使用 join 以避免当 basePath 为文件系统根目录时产生 "//entry"。
        const fullPath = join(basePath, entry);

        if (remainingParts.length === 0) {
          yield fullPath;
        } else {
          let entryStat;
          try {
            entryStat = await stat(fullPath);
          } catch {
            continue;
          }
          if (entryStat.isDirectory()) {
            const key = cycleKey(entryStat);
            if (key !== null && visited.has(key)) continue;
            yield* this._globWalk(
              fullPath,
              remainingParts,
              caseSensitive,
              key !== null ? new Set([...visited, key]) : visited,
            );
          }
        }
      }
    }
  }

  async readBytes(path: string, n?: number): Promise<Buffer> {
    const resolved = this._resolvePath(path);
    if (n === undefined) {
      return Buffer.from(await readFile(resolved));
    }
    const fh = await open(resolved, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await readFile(resolved);
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const buf = await readFile(resolved);
    const content = decodeTextWithErrors(buf, encoding, errors);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (i < lines.length - 1) {
        yield line + '\n';
      } else if (line !== '') {
        yield line;
      }
    }
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    const resolved = this._resolvePath(path);
    await writeFile(resolved, data);
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const mode = options?.mode ?? 'w';
    if (mode === 'a') {
      await appendFile(resolved, data, encoding);
    } else {
      await writeFile(resolved, data, encoding);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;

    if (parents) {
      // `fs.mkdir(..., { recursive: true })` 在目标已存在时会静默成功 ——
      // 它不会抛出 EEXIST。为了遵守 `existOk: false` 的语义，
      // 必须在委托给递归 mkdir 之前自行探测是否存在。
      if (!existOk) {
        try {
          const s = await stat(resolved);
          if (s.isDirectory()) {
            throw new KaosFileExistsError(`${resolved} already exists`);
          }
          // 路径存在但不是目录 —— 让 `mkdir` 在下面抛出相应的错误
          // （EEXIST/ENOTDIR）。
        } catch (error: unknown) {
          if (error instanceof KaosFileExistsError) throw error;
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') throw error;
          // ENOENT：目标尚不存在 —— 继续执行 mkdir。
        }
      }
      await mkdir(resolved, { recursive: true });
      return;
    }

    // 非递归：fs.mkdir 在冲突时自然抛出 EEXIST。
    try {
      await mkdir(resolved);
    } catch (error: unknown) {
      if (
        existOk &&
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        // `existOk` 仅在冲突路径本身是目录时适用。如果一个普通文件
        // （或其他非目录）已经占据了该路径，静默返回就是一个谎言
        // —— 请求的目录仍然不存在。显式暴露冲突，这样调用方不会
        // 将"文件冲突"误认为"目录已存在"。
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          throw new KaosFileExistsError(`${resolved} already exists but is not a directory`);
        }
        return;
      }
      throw error;
    }
  }

  async exec(...args: string[]): Promise<KaosProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error('LocalKaos.exec(): at least one argument (the command to run) is required.');
    }
    const restArgs = args.slice(1);
    const child = spawn(command, restArgs, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX `detached:true` 使子进程成为进程组领导者，这样
      // `LocalProcess.kill()` 可以向整个进程树发信号。在 Windows 上无效
      // （那里由 `taskkill /T` 处理进程树）。我们不调用 `child.unref()`
      // 因为父进程仍然通过 `wait()` 等待子进程退出。
      detached: !isWindows,
      env: this._buildExecEnv(),
    });
    await waitForSpawn(child);
    return new LocalProcess(child);
  }

  async execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error(
        'LocalKaos.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    const restArgs = args.slice(1);
    const child = spawn(command, restArgs, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      env: this._buildExecEnv(env),
    });
    await waitForSpawn(child);
    return new LocalProcess(child);
  }

  private _buildExecEnv(invocationEnv?: Record<string, string>): Record<string, string> | undefined {
    if (this._envLayers.length === 0) return invocationEnv;
    const merged: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...invocationEnv,
    };
    for (const layer of this._envLayers) {
      Object.assign(merged, layer);
    }
    return merged;
  }
}

// 等待新创建的 ChildProcess 发出 'spawn'（成功）或 'error'
// （ENOENT / EACCES 等）。在此 Promise 解析之前，调用方不应
// 假定子进程已在运行 —— 否则可能向一个从未存在的进程的 stdin 写入。
function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

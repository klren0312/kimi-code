import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'pathe';
import type { Readable, Writable } from 'node:stream';

import * as ssh2 from 'ssh2';
import type {
  AnyAuthMethod,
  Client,
  ClientChannel,
  ConnectConfig,
  SFTPWrapper,
  Stats as SFTPStats,
} from 'ssh2';

import type { Environment } from './environment';
import { KaosError, KaosFileExistsError, KaosValueError } from './errors';
import { BufferedReadable, decodeTextWithErrors, globPatternToRegex } from './internal';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

// ── 文件类型 mode 常量 ────────────────────────────────────────────────
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFIFO = 0o010000;

const DEFAULT_SFTP_STATUS_CODE = {
  BAD_MESSAGE: 5,
  CONNECTION_LOST: 7,
  FAILURE: 4,
  NO_CONNECTION: 6,
  NO_SUCH_FILE: 2,
  OP_UNSUPPORTED: 8,
  PERMISSION_DENIED: 3,
} as const;

// ── SSH 选项 ────────────────────────────────────────────────────────

/**
 * 通过 `SSHKaosOptions.extraOptions` 传入的高级 ssh2 连接选项。
 *
 * 排除了 SSHKaos 自身管理的字段（`host`、`port`、`username`、`password`、
 * `privateKey`、`authHandler`、`hostVerifier`）——这些字段由顶层
 * `SSHKaosOptions` 的字段派生，不能在此处覆盖。
 */
export type SSHKaosExtraOptions = Omit<
  ConnectConfig,
  'host' | 'port' | 'username' | 'password' | 'privateKey' | 'authHandler' | 'hostVerifier'
>;

export interface SSHKaosOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  keyPaths?: string[];
  keyContents?: string[];
  cwd?: string;
  /**
   * 透传高级 ssh2 `ConnectConfig` 字段，如 `algorithms`、`keepaliveInterval`、
   * `readyTimeout`、`debug`、`tryKeyboard`、`agent` 等。
   *
   * 受管理的字段（`host`、`port`、`username`、`password`、`privateKey`、
   * `authHandler`、`hostVerifier`）已从此类型中排除，并优先于此处设置的任何值。
   */
  extraOptions?: SSHKaosExtraOptions;
}

// ── SSH 错误类型 ───────────────────────────────────────────────────

export class KaosSSHError extends KaosError {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'KaosSSHError';
    this.code = code;
  }
}

export class KaosFileNotFoundError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosFileNotFoundError';
  }
}

export class KaosPermissionError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosPermissionError';
  }
}

export class KaosConnectionError extends KaosSSHError {
  constructor(message: string, code?: number) {
    super(message, code);
    this.name = 'KaosConnectionError';
  }
}

// ── shell 引号转义 ──────────────────────────────────────────────────────

/**
 * 对单个参数进行 shell 转义（兼容 POSIX sh）。
 * 与 Python 的 shlex.quote() 行为一致。
 */
function shellQuote(arg: string): string {
  if (arg === '') return "''";
  // 如果字符串是安全的（只包含安全字符），则原样返回
  if (/^[A-Za-z0-9_./:=@%^,+-]+$/.test(arg)) return arg;
  // 否则用单引号包裹，并转义其中嵌入的单引号
  return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
}

// ── stat mode 构建器 ──────────────────────────────────────────────────

/**
 * 根据 SFTP Stats 构建 POSIX st_mode。
 * ssh2 的 Stats 已有 .mode 属性，同时包含文件类型位和权限位，
 * 但我们也检查布尔辅助方法作为后备方案。
 */
function buildStMode(attrs: SFTPStats): number {
  const raw = attrs.mode;
  // 如果 mode 已包含文件类型位，则原样返回
  if ((raw & S_IFMT) !== 0) return raw;

  // 从 is* 辅助方法推导文件类型位
  let typeBits = 0;
  if (attrs.isDirectory()) typeBits = S_IFDIR;
  else if (attrs.isFile()) typeBits = S_IFREG;
  else if (attrs.isSymbolicLink()) typeBits = S_IFLNK;
  else if (attrs.isSocket()) typeBits = S_IFSOCK;
  else if (attrs.isCharacterDevice()) typeBits = S_IFCHR;
  else if (attrs.isBlockDevice()) typeBits = S_IFBLK;
  else if (attrs.isFIFO()) typeBits = S_IFIFO;

  return (raw & ~S_IFMT) | typeBits;
}

function getSftpStatusCode(): typeof DEFAULT_SFTP_STATUS_CODE {
  return {
    ...DEFAULT_SFTP_STATUS_CODE,
    ...ssh2.utils?.sftp?.STATUS_CODE,
  };
}

function getErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === 'number' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function mapSftpError(operation: string, error: unknown): KaosSSHError {
  const code = getErrorCode(error);
  const message = `${operation} failed: ${getErrorMessage(error)}`;
  const statusCode = getSftpStatusCode();

  if (code === statusCode.NO_SUCH_FILE) {
    return new KaosFileNotFoundError(message, code);
  }
  if (code === statusCode.PERMISSION_DENIED) {
    return new KaosPermissionError(message, code);
  }
  if (code === statusCode.NO_CONNECTION || code === statusCode.CONNECTION_LOST) {
    return new KaosConnectionError(message, code);
  }
  return new KaosSSHError(message, code);
}

function buildAuthHandler(
  username: string,
  privateKeys: readonly (Buffer | string)[],
  password?: string,
): ConnectConfig['authHandler'] {
  const authQueue: AnyAuthMethod[] = privateKeys.map((key) => ({
    key,
    type: 'publickey',
    username,
  }));
  if (password !== undefined) {
    authQueue.push({
      password,
      type: 'password',
      username,
    });
  }

  let index = 0;
  return (_authsLeft, _partialSuccess, next) => {
    const nextAuth = authQueue[index];
    index += 1;
    const nextWithFalse = next as (auth: AnyAuthMethod | false) => void;
    nextWithFalse(nextAuth ?? false);
  };
}

// ── SSH 进程 ────────────────────────────────────────────────────────

/** 仅用于单元测试导出。请勿直接使用。 */
export class SSHProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number = -1;

  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private readonly _channel: ClientChannel;
  private _disposed = false;

  constructor(channel: ClientChannel) {
    this._channel = channel;
    this.stdin = channel;
    this.stdout = new BufferedReadable(channel as unknown as Readable);
    this.stderr = new BufferedReadable(channel.stderr);

    this._exitPromise = new Promise<number>((resolve) => {
      // 监听 channel 的 'close' 事件而非 'exit'，以确保所有缓冲输出
      // 在 resolve 之前已刷新。
      channel.on('close', (code: number | null) => {
        // 部分 ssh2 后端仅在 'close' 事件中暴露退出状态。
        this._exitCode ??= code ?? 1;
        resolve(this._exitCode);
      });
      channel.on('exit', (code: number | null) => {
        this._exitCode = code ?? 1;
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
    // SSH 信号必须去掉 "SIG" 前缀（RFC 4254 §6.9）：
    // 例如 'SIGTERM' → 'TERM'、'SIGKILL' → 'KILL'、'SIGINT' → 'INT'。
    // 遵循调用方请求的信号，以便远程进程可以执行 SIGTERM/SIGINT 优雅关闭。
    const rawSignal = signal ?? 'SIGTERM';
    const sshSignal = rawSignal.startsWith('SIG') ? rawSignal.slice(3) : rawSignal;
    this._channel.signal(sshSignal);
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

// ── Promise 化的 SSH 辅助函数 ────────────────────────────────────────────

function connectClient(config: ConnectConfig): Promise<Client> {
  const client = new ssh2.Client();
  return new Promise<Client>((resolve, reject) => {
    client.on('ready', () => {
      resolve(client);
    });
    client.on('error', (err: Error) => {
      reject(err);
    });
    client.connect(config);
  });
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err);
      } else {
        resolve(sftp);
      }
    });
  });
}

// 每个 Promise 化的 SFTP 辅助函数都通过 `mapSftpError` 过滤拒绝，
// 这样调用方看到的是 KaosSSHError 子类（KaosFileNotFoundError / KaosPermissionError /
// KaosConnectionError / 通用 KaosSSHError），而非原始的 ssh2 错误。
// 操作标签是底层 SFTP RPC 名称——会出现在错误消息中用于调试，
// 与 `stat()` 在提升到辅助函数之前使用的标签相同。

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.realpath(path, (err, absPath) => {
      if (err) {
        reject(mapSftpError('realpath', err));
      } else {
        resolve(absPath);
      }
    });
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<SFTPStats> {
  return new Promise<SFTPStats>((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) {
        reject(mapSftpError('stat', err));
      } else {
        resolve(stats);
      }
    });
  });
}

function sftpLstat(sftp: SFTPWrapper, path: string): Promise<SFTPStats> {
  return new Promise<SFTPStats>((resolve, reject) => {
    sftp.lstat(path, (err, stats) => {
      if (err) {
        reject(mapSftpError('lstat', err));
      } else {
        resolve(stats);
      }
    });
  });
}

interface SFTPFileEntry {
  filename: string;
  attrs: SFTPStats;
}

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<SFTPFileEntry[]> {
  return new Promise<SFTPFileEntry[]>((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) {
        reject(mapSftpError('readdir', err));
      } else {
        resolve(list as SFTPFileEntry[]);
      }
    });
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) {
        reject(mapSftpError('mkdir', err));
      } else {
        resolve();
      }
    });
  });
}

function sftpExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    sftp.exists(path, (exists) => {
      resolve(exists);
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    sftp.readFile(path, (err, data) => {
      if (err) {
        reject(mapSftpError('readFile', err));
      } else {
        resolve(data);
      }
    });
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, data: string | Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, data, (err) => {
      if (err) {
        reject(mapSftpError('writeFile', err));
      } else {
        resolve();
      }
    });
  });
}

function sftpAppendFile(sftp: SFTPWrapper, path: string, data: string | Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.appendFile(path, data, (err) => {
      if (err) {
        reject(mapSftpError('appendFile', err));
      } else {
        resolve();
      }
    });
  });
}

function clientExec(client: Client, command: string): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err) {
        reject(err);
      } else {
        resolve(channel);
      }
    });
  });
}

// ── SSHKaos ────────────────────────────────────────────────────────────

/**
 * 通过 SSH 和 SFTP 与远程机器交互的 KAOS 实现。
 */
export class SSHKaos implements Kaos {
  readonly name: string = 'ssh';

  private _client: Client;
  private _sftp: SFTPWrapper;
  private _home: string;
  private _cwd: string;
  private readonly _envLayers: readonly Record<string, string>[];

  // 占位：实际接线（通过 SSH 传输使用 `uname` / `$SHELL` 探测远程主机）已推迟。
  get osEnv(): Environment {
    throw new KaosError(
      'SSHKaos.osEnv is not yet wired — remote environment probing is not implemented.',
    );
  }

  private constructor(
    client: Client,
    sftp: SFTPWrapper,
    home: string,
    cwd: string,
    envLayers: readonly Record<string, string>[] = [],
  ) {
    this._client = client;
    this._sftp = sftp;
    this._home = home;
    this._cwd = cwd;
    this._envLayers = envLayers;
  }

  withCwd(cwd: string): SSHKaos {
    return new SSHKaos(this._client, this._sftp, this._home, cwd, this._envLayers);
  }

  withEnv(env: Record<string, string>): SSHKaos {
    return new SSHKaos(this._client, this._sftp, this._home, this._cwd, [...this._envLayers, env]);
  }

  private _resolvePath(path: string): string {
    if (isAbsolute(path)) return path;
    return join(this._cwd, path);
  }

  /**
   * 创建 SSHKaos 实例的工厂方法。
   * 建立 SSH 连接和 SFTP 会话。
   */
  static async create(options: SSHKaosOptions): Promise<SSHKaos> {
    // 从 extraOptions（高级 ssh2 选项）开始，使下面的受管理字段优先。
    const config: ConnectConfig = {
      ...options.extraOptions,
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
    };

    if (options.password !== undefined) {
      config.password = options.password;
    }

    // 从 keyContents 和 keyPaths 构建私钥
    const privateKeys: (Buffer | string)[] = [];
    if (options.keyContents) {
      for (const content of options.keyContents) {
        privateKeys.push(content);
      }
    }
    if (options.keyPaths) {
      const keyPromises = options.keyPaths.map((keyPath) => readFile(keyPath, 'utf-8'));
      const keyData = await Promise.all(keyPromises);
      for (const key of keyData) {
        privateKeys.push(key);
      }
    }
    if (privateKeys.length > 0) {
      const authHandler = buildAuthHandler(options.username, privateKeys, options.password);
      if (authHandler !== undefined) {
        config.authHandler = authHandler;
      }
    }

    // 禁用主机密钥验证（类似 asyncssh 的 known_hosts=None）
    config.hostVerifier = () => true;

    const client = await connectClient(config);
    try {
      const sftp = await getSftp(client);

      // 确定 home 目录和工作目录
      const home = await sftpRealpath(sftp, '.');
      let cwd: string;
      if (options.cwd === undefined) {
        cwd = home;
      } else {
        cwd = await sftpRealpath(sftp, options.cwd);
        const attrs = await sftpStat(sftp, cwd);
        if (!attrs.isDirectory()) {
          throw new KaosValueError(`${cwd} is not a directory`);
        }
      }

      return new SSHKaos(client, sftp, home, cwd);
    } catch (error) {
      client.end();
      throw error;
    }
  }

  // ── 路径操作（同步） ─────────────────────────────────────────

  pathClass(): 'posix' | 'win32' {
    return 'posix';
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return this._home;
  }

  getcwd(): string {
    return this._cwd;
  }

  // ── 目录操作（异步） ───────────────────────────────────────────

  async chdir(path: string): Promise<void> {
    let target: string;
    if (isAbsolute(path)) {
      target = path;
    } else {
      target = resolve(this._cwd, path);
    }
    // 通过 SFTP 解析为真实路径
    const resolved = await sftpRealpath(this._sftp, target);
    // 验证解析后的目标确实是目录。如果没有此守卫，
    // `realpath` 会直接返回文件路径，导致后续的相对读写/执行
    // 将普通文件当作工作目录使用。
    const attrs = await sftpStat(this._sftp, resolved);
    if (!attrs.isDirectory()) {
      throw new KaosValueError(`${resolved} is not a directory`);
    }
    this._cwd = resolved;
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
    const resolved = this._resolvePath(path);
    const followSymlinks = options?.followSymlinks ?? true;
    // sftpStat / sftpLstat 已通过 mapSftpError 包装错误。
    const st = followSymlinks
      ? await sftpStat(this._sftp, resolved)
      : await sftpLstat(this._sftp, resolved);

    return {
      stMode: buildStMode(st),
      // SFTP 不提供 inode
      stIno: 0,
      // SFTP 不提供设备号
      stDev: 0,
      // ssh2 Stats 不暴露 nlink
      stNlink: 0,
      stUid: st.uid,
      stGid: st.gid,
      stSize: st.size,
      stAtime: st.atime,
      stMtime: st.mtime,
      // SFTP v3 没有 ctime，回退到 mtime
      stCtime: st.mtime,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await sftpReaddir(this._sftp, resolved);
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue;
      yield join(resolved, entry.filename);
    }
  }

  async *glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const caseSensitive = options?.caseSensitive ?? true;
    if (!caseSensitive) {
      throw new KaosValueError('Case insensitive glob is not supported in current environment');
    }
    // 使用本地 glob 实现基于 SFTP readdir 进行匹配
    const patternParts = pattern.split('/');
    yield* this._globWalk(resolved, patternParts, caseSensitive);
  }

  private async *_globWalk(
    basePath: string,
    patternParts: string[],
    caseSensitive: boolean,
  ): AsyncGenerator<string> {
    if (patternParts.length === 0) return;

    const [currentPattern, ...remainingParts] = patternParts;

    if (currentPattern === '**') {
      // `**` 匹配零个或多个目录组件。
      //
      // 需要处理两种情况：
      //   (a) `**` 匹配零个目录 → 在 basePath 继续处理剩余的模式部分
      //       （或当 `**` 是最后一段时 yield basePath）。
      //   (b) `**` 匹配一个或多个目录 → 递归进入每个子目录，
      //       保留 `**`（完整的 patternParts）在前面。"零个目录"的情况
      //       会在子目录级别的递归调用中重新评估。
      //
      // 不要用 `remainingParts` 对子目录进行额外递归——
      // 这会导致深度 ≥ 1 的匹配被重复计算，因为 (a) 情况
      // 在子递归中已经 yield 了这些结果。
      if (remainingParts.length > 0) {
        yield* this._globWalk(basePath, remainingParts, caseSensitive);
      } else {
        // 模式以 `**` 结尾：yield basePath 本身（零目录匹配）。
        yield basePath;
      }

      let entries: SFTPFileEntry[];
      try {
        entries = await sftpReaddir(this._sftp, basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        const fullPath = join(basePath, entry.filename);
        if (entry.attrs.isDirectory()) {
          yield* this._globWalk(fullPath, patternParts, caseSensitive);
        } else if (remainingParts.length === 0) {
          // 模式以 `**` 结尾：非目录条目也会匹配。
          yield fullPath;
        }
      }
    } else {
      const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

      let entries: SFTPFileEntry[];
      try {
        entries = await sftpReaddir(this._sftp, basePath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (!regex.test(entry.filename)) continue;

        const fullPath = join(basePath, entry.filename);

        if (remainingParts.length === 0) {
          yield fullPath;
        } else if (entry.attrs.isDirectory()) {
          yield* this._globWalk(fullPath, remainingParts, caseSensitive);
        }
      }
    }
  }

  // ── 文件操作（异步） ────────────────────────────────────────

  async readBytes(path: string, n?: number): Promise<Buffer> {
    const data = await sftpReadFile(this._sftp, this._resolvePath(path));
    if (n === undefined) return data;
    return data.subarray(0, n);
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await sftpReadFile(this._sftp, this._resolvePath(path));
    return decodeTextWithErrors(data, encoding, errors);
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string> {
    // SFTP 不支持流式逐行读取；先读取全部内容再分割。
    // 与 Python 的 splitlines() 语义保持一致：返回的行不包含
    // 行终止符，且末尾换行不会产生额外的空行。
    const text = await this.readText(this._resolvePath(path), options);
    if (text === '') {
      return;
    }

    const lines = text.split(/\r\n|[\n\r]/u);
    if (/(?:\r\n|[\n\r])$/u.test(text)) {
      lines.pop();
    }
    for (const line of lines) {
      yield line ?? '';
    }
  }

  async writeBytes(path: string, data: Buffer): Promise<number> {
    await sftpWriteFile(this._sftp, this._resolvePath(path), data);
    return data.length;
  }

  async writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number> {
    const resolved = this._resolvePath(path);
    const mode = options?.mode ?? 'w';
    const encoding = options?.encoding ?? 'utf-8';
    const buf = Buffer.from(data, encoding);
    if (mode === 'a') {
      await sftpAppendFile(this._sftp, resolved, buf);
    } else {
      await sftpWriteFile(this._sftp, resolved, buf);
    }
    return data.length;
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this._resolvePath(path);
    const parents = options?.parents ?? false;
    const existOk = options?.existOk ?? false;

    if (parents) {
      await this._mkdirRecursive(resolved, existOk);
    } else {
      const exists = await sftpExists(this._sftp, resolved);
      if (exists) {
        if (!existOk) {
          throw new KaosFileExistsError(`${resolved} already exists`);
        }
        // `existOk` 仅在冲突路径本身是目录时适用。
        // 位于目标路径的普通文件仍然是冲突——
        // 我们不能假装 mkdir 成功了。
        const st = await sftpStat(this._sftp, resolved);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${resolved} already exists but is not a directory`);
        }
        return;
      }
      await sftpMkdir(this._sftp, resolved);
    }
  }

  private async _mkdirRecursive(path: string, existOk: boolean): Promise<void> {
    // 将路径拆分为组件，逐级创建。
    const parts = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? '/' : '';
    const lastIndex = parts.length - 1;
    for (const [i, part] of parts.entries()) {
      current = current ? join(current, part) : part;

      const isFinal = i === lastIndex;

      // eslint-disable-next-line no-await-in-loop
      const exists = await sftpExists(this._sftp, current);
      if (exists) {
        // 对于中间组件，路径已存在是正常的（也是预期的）。
        // 对于最终目标，遵循 `existOk` 参数。
        if (isFinal && !existOk) {
          throw new KaosFileExistsError(`${current} already exists`);
        }
        // 无论是中间组件还是最终组件，已存在的路径必须确实是目录。
        // 中间的非目录路径会导致后续 `sftpMkdir` 产生令人困惑的错误；
        // 最终的非目录路径在 `existOk` 为 true 时会被悄悄接受。
        // eslint-disable-next-line no-await-in-loop
        const st = await sftpStat(this._sftp, current);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${current} already exists but is not a directory`);
        }
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await sftpMkdir(this._sftp, current);
      } catch (error) {
        // 竞态条件：其他进程可能已经创建了该目录。
        // eslint-disable-next-line no-await-in-loop
        const nowExists = await sftpExists(this._sftp, current);
        if (!nowExists) throw new Error(`Failed to create directory: ${current}`, { cause: error });
        // 竞争产生的路径仍然必须是目录。另一个进程可能在我们的 exists()
        // 检查之后、mkdir() 之前在相同路径创建了普通文件，这仍然是硬冲突。
        // eslint-disable-next-line no-await-in-loop
        const st = await sftpStat(this._sftp, current);
        if (!st.isDirectory()) {
          throw new KaosFileExistsError(`${current} already exists but is not a directory`);
        }
        // 如果最终组件在竞争中失败且 existOk=false，抛出冲突错误，
        // 与上面的非竞争路径保持一致。
        if (isFinal && !existOk) {
          throw new KaosFileExistsError(`${current} already exists`);
        }
      }
    }
  }

  // ── 进程执行 ──────────────────────────────────────────────

  exec(...args: string[]): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'SSHKaos.exec(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args, this._buildExecEnv());
  }

  execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    if (args.length === 0) {
      throw new KaosValueError(
        'SSHKaos.execWithEnv(): at least one argument (the command to run) is required.',
      );
    }
    return this._execInternal(args, this._buildExecEnv(env));
  }

  private _buildExecEnv(invocationEnv?: Record<string, string>): Record<string, string> | undefined {
    if (this._envLayers.length === 0) return invocationEnv;
    const merged: Record<string, string> = { ...invocationEnv };
    for (const layer of this._envLayers) {
      Object.assign(merged, layer);
    }
    return merged;
  }

  /**
   * 构建将传递给 `client.exec` 的完整远程 shell 命令字符串。
   * 以静态方法形式暴露，以便在不需要活跃 SSH 连接的情况下进行单元测试
   * ——参见 `ssh.test.ts`。
   *
   * 格式：`cd '<cwd>' && KEY1='v1' KEY2='v2' <cmd> <arg1> <arg2> ...`
   *
   * 环境变量以 POSIX 内联赋值的形式注入，而非通过 ssh2 的 `ExecOptions.env` 传递。
   * env 请求路径会静默丢弃 sshd 的 `AcceptEnv` 指令未列入白名单的任何内容
   * （默认 OpenSSH 只允许 LANG/LC_*），这是从 Python / asyncssh 实现继承的
   * 众所周知的陷阱。内联赋值在远程 shell 内部运行，因此完全绕过 AcceptEnv，
   * 无论服务器配置如何都能传递到命令中。
   */
  private static _buildExecCommand(
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): string {
    let command = args.map((arg) => shellQuote(arg)).join(' ');

    if (env !== undefined) {
      const assignments: string[] = [];
      for (const [key, value] of Object.entries(env)) {
        // 拒绝任何不符合 POSIX 有效 shell 变量名的内容，
        // 以确保注入的前缀永远不会成为 shell 注入向量。
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new KaosValueError(
            `SSHKaos.execWithEnv(): invalid env variable name ${JSON.stringify(key)}`,
          );
        }
        assignments.push(`${key}=${shellQuote(value)}`);
      }
      if (assignments.length > 0) {
        command = `${assignments.join(' ')} ${command}`;
      }
    }

    if (cwd !== '') {
      command = `cd ${shellQuote(cwd)} && ${command}`;
    }

    return command;
  }

  private async _execInternal(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
    const command = SSHKaos._buildExecCommand(args, this._cwd, env);
    const channel = await clientExec(this._client, command);
    return new SSHProcess(channel);
  }

  // ── SSH 生命周期 ──────────────────────────────────────────────────

  /**
   * 关闭 SSH 连接。此后，SSHKaos 实例将不可用。
   */
  close(): Promise<void> {
    this._sftp.end();
    return new Promise<void>((resolve) => {
      this._client.once('close', () => {
        resolve();
      });
      this._client.end();
    });
  }
}

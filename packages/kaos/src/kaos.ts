import type { Environment } from './environment';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

/**
 * Kimi Agent Operating System (KAOS) 接口。
 *
 * 这是允许 Agent 通过统一 API 与不同执行环境（本地、SSH、容器等）
 * 交互的核心抽象。所有操作通过此接口进行，使得上层代码无需关心
 * 底层是本地文件系统还是远程连接。
 */
export interface Kaos {
  /** 此环境的可读名称（如 `"local"`、`"ssh:host"`） */
  readonly name: string;

  /**
   * 描述目标环境的 OS/Shell 探测结果。由具体的 Kaos 实现填充
   * （如 `LocalKaos` 使用 `detectEnvironmentFromNode()`，
   * `SSHKaos` 使用远程探测）。
   */
  readonly osEnv: Environment;

  // ── 路径操作（同步）──────────────────────────────────────────────

  /** 返回此环境使用的路径风格（POSIX 或 Windows）。 */
  pathClass(): 'posix' | 'win32';
  /** 规范化给定路径字符串（解析 `.` / `..` 段）。 */
  normpath(path: string): string;
  /** 返回当前用户的主目录。 */
  gethome(): string;
  /** 返回当前工作目录。 */
  getcwd(): string;

  // ── 目录操作（异步）───────────────────────────────────────────────

  /** 将工作目录切换到 `path`。 */
  chdir(path: string): Promise<void>;
  /** 返回一个设置了新 `cwd` 的 Kaos 副本。 */
  withCwd(cwd: string): Kaos;
  /**
   * 返回一个为每个启动的进程叠加了 `env` 环境变量的 Kaos 副本。
   *
   * 提供的记录在进程启动时读取，因此调用方可修改稳定的记录对象
   * 来影响后续的执行。
   */
  withEnv(env: Record<string, string>): Kaos;
  /** 返回 `path` 的文件状态元数据。 */
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult>;
  /** 逐个产出 `path` 目录下的条目名称。 */
  iterdir(path: string): AsyncGenerator<string>;
  /** 产出 `path` 下匹配 `pattern` 的路径。 */
  glob(
    path: string,
    pattern: string,
    options?: { caseSensitive?: boolean },
  ): AsyncGenerator<string>;

  // ── 文件操作（异步）────────────────────────────────────────────────

  /** 从 `path` 读取最多 `n` 字节（省略 `n` 则读取全部）。 */
  readBytes(path: string, n?: number): Promise<Buffer>;
  /**
   * 将 `path` 处的文件作为字符串读取。
   *
   * `errors` 控制解码错误的处理方式——对应 Python 的 `open(..., errors=)` 参数：
   * - `'strict'`（默认）：遇到无效字节时抛出异常
   * - `'replace'`：将每个无效字节替换为 U+FFFD（替换字符）
   * - `'ignore'`：静默丢弃无效字节
   */
  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string>;
  /** 逐行产出 `path` 文件的内容。 */
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): AsyncGenerator<string>;
  /** 将原始字节写入 `path`，返回写入的字节数。 */
  writeBytes(path: string, data: Buffer): Promise<number>;
  /** 将文本写入 `path`，返回写入的字符数。 */
  writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<number>;
  /** 在 `path` 创建目录。 */
  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void>;

  // ── 进程执行 ───────────────────────────────────────────────────────

  /** 使用给定参数启动进程。 */
  exec(...args: string[]): Promise<KaosProcess>;
  /** 使用显式环境变量启动进程。 */
  execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess>;
}

/**
 * Environment — 跨平台 OS / Shell 探测。
 *
 * 探测是注入探测函数（`platform` / `arch` / `release` / `env` / `isFile` /
 * `execFileText`）的纯函数，因此同一测试套件在任何宿主 OS 上运行结果一致。
 * `detectEnvironmentFromNode()` 为生产调用方打包了 Node 默认值。
 *
 * 在 Windows 上，探测期望找到 Git Bash（Git for Windows 附带的规范 POSIX shell）。
 * 如果找不到，函数抛出 `KaosShellNotFoundError`；SDK 层可将其包装为面向用户的
 * 安装提示。设置 `KIMI_SHELL_PATH` 可手动覆盖 shell 路径。
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { KaosShellNotFoundError } from './errors';

// `OsKind` 对已知平台携带 'macOS' / 'Linux' / 'Windows'，对未知平台
//（如 'freebsd'）回退到原始 `process.platform` 字符串。
// 类型为 `string` 以避免联合类型被字符串字面量穷尽。
export type OsKind = string;
/** Shell 名称：bash 或 sh */
export type ShellName = 'bash' | 'sh';

/** 探测到的环境信息 */
export interface Environment {
  /** 操作系统类型（'macOS' / 'Linux' / 'Windows' 或原始平台字符串） */
  readonly osKind: OsKind;
  /** CPU 架构（如 'x64'、'arm64'） */
  readonly osArch: string;
  /** 操作系统版本号 */
  readonly osVersion: string;
  /** 检测到的 shell 名称 */
  readonly shellName: ShellName;
  /** 检测到的 shell 可执行文件路径 */
  readonly shellPath: string;
}

/** 环境探测的依赖注入接口 */
export interface EnvironmentDeps {
  // 接受完整的 Node `Platform` 枚举以及任意字符串，以兼容未来的 OS 类型。
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly env: Record<string, string | undefined>;
  /** 检查给定路径是否为文件 */
  readonly isFile: (path: string) => Promise<boolean>;
  /** 执行文件并返回其 stdout 文本 */
  readonly execFileText: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string | undefined>;
}

/** git --exec-path 命令的超时时间（毫秒） */
const GIT_EXEC_PATH_TIMEOUT_MS = 5_000;

/** 将 Node 的 process.platform 映射为可读的操作系统类型名称 */
function resolveOsKind(platform: string): OsKind {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}

/**
 * 探测当前执行环境的 OS 和 Shell 信息。
 *
 * 在 Unix 上依次查找 `/bin/bash`、`/usr/bin/bash`、`/usr/local/bin/bash`，
 * 都找不到则回退到 `/bin/sh`。在 Windows 上查找 Git Bash。
 */
export async function detectEnvironment(deps: EnvironmentDeps): Promise<Environment> {
  const osKind = resolveOsKind(deps.platform);
  const osArch = deps.arch;
  const osVersion = deps.release;

  // Windows：定位 Git Bash
  if (deps.platform === 'win32') {
    const shellPath = await locateWindowsGitBash(deps);
    return { osKind, osArch, osVersion, shellName: 'bash', shellPath };
  }

  // Unix/macOS：按优先级查找 bash
  const candidates: readonly string[] = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
  let found: string | undefined;
  for (const p of candidates) {
    if (await deps.isFile(p)) {
      found = p;
      break;
    }
  }
  if (found !== undefined) {
    return { osKind, osArch, osVersion, shellName: 'bash', shellPath: found };
  }
  // bash 不可用，回退到 sh
  return { osKind, osArch, osVersion, shellName: 'sh', shellPath: '/bin/sh' };
}

/**
 * 在 Windows 上定位 Git Bash 的 bash.exe。
 *
 * 查找顺序：
 * 1. `KIMI_SHELL_PATH` 环境变量覆盖
 * 2. 从 PATH 中找到的 git.exe 推断 bash 位置
 * 3. 通过 `git --exec-path` 推断
 * 4. 常见安装路径探测（Program Files、LOCALAPPDATA）
 *
 * 找不到时抛出 `KaosShellNotFoundError`，携带所有已探测路径。
 */
async function locateWindowsGitBash(deps: EnvironmentDeps): Promise<string> {
  const checked: string[] = [];

  // 1. 检查 KIMI_SHELL_PATH 环境变量覆盖
  const override = deps.env['KIMI_SHELL_PATH']?.trim();
  if (override !== undefined && override.length > 0) {
    checked.push(override);
    if (await deps.isFile(override)) {
      return override;
    }
  }

  // 2. 从 PATH 中找到 git.exe，然后推断 bash 位置
  const gitExecutables = await findExecutablesOnPath(
    'git.exe',
    deps.env['PATH'],
    deps.platform,
    deps.isFile,
  );

  for (const gitExe of gitExecutables) {
    // 根据 git.exe 的路径结构推断 bash.exe 位置
    const inferred = gitBashCandidatesFromGitExe(gitExe);
    if (inferred !== undefined) {
      for (const candidate of inferred) {
        checked.push(candidate);
        if (await deps.isFile(candidate)) {
          return candidate;
        }
      }
    }

    // 通过 git --exec-path 获取 Git 内部执行路径，再推断 bash
    const gitExecPath = await readGitExecPath(deps, gitExe);
    if (gitExecPath === undefined) {
      continue;
    }
    for (const candidate of gitBashCandidatesFromGitExecPath(gitExecPath)) {
      checked.push(candidate);
      if (await deps.isFile(candidate)) {
        return candidate;
      }
    }
  }

  // 3. 尝试常见安装路径
  const candidates: string[] = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ];
  const localAppData = deps.env['LOCALAPPDATA']?.trim();
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
    candidates.push(`${localAppData}\\Programs\\Git\\usr\\bin\\bash.exe`);
  }
  for (const candidate of candidates) {
    checked.push(candidate);
    if (await deps.isFile(candidate)) {
      return candidate;
    }
  }

  // 4. 所有路径都未找到，抛出错误
  throw new KaosShellNotFoundError(
    `Git Bash was not found on this Windows host. Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe. Checked: ${checked.join(', ')}.`,
  );
}

/**
 * 执行 `git --exec-path` 获取 Git 内部执行路径。
 * 用于从 Git 安装目录推断 bash.exe 位置。
 */
async function readGitExecPath(
  deps: EnvironmentDeps,
  gitExe: string,
): Promise<string | undefined> {
  if (deps.platform === 'win32' && !isAbsoluteWindowsPath(gitExe)) return undefined;

  const stdout = await deps.execFileText(gitExe, ['--exec-path'], GIT_EXEC_PATH_TIMEOUT_MS);
  if (stdout === undefined) return undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const execPath = line.trim();
    if (execPath.length > 0) {
      return execPath;
    }
  }
  return undefined;
}

/**
 * 从 git.exe 的路径推断 bash.exe 候选路径。
 *
 * 大多数 Git for Windows 安装将 `git.exe` 放在 `<root>\cmd\git.exe`，
 * bash 在 `<root>\bin\bash.exe`。便携版有时将两者都放在 `<root>\bin\`。
 * 只从这些有固定结构的布局推断；包管理器的 shim 需要通过 `git --exec-path` 解析。
 */
function gitBashCandidatesFromGitExe(gitExe: string): readonly string[] | undefined {
  const normalizedGitExe = nodePath.win32.normalize(normalizeWindowsPath(gitExe));
  const gitDir = nodePath.win32.dirname(normalizedGitExe);
  const gitDirName = nodePath.win32.basename(gitDir).toLowerCase();
  if (gitDirName !== 'cmd' && gitDirName !== 'bin') {
    return undefined;
  }
  return gitBashCandidatesFromGitRoot(nodePath.win32.dirname(gitDir));
}

/**
 * 从 `git --exec-path` 的输出推断 bash.exe 候选路径。
 *
 * 在 exec-path 中向上查找 mingw32/mingw64 段作为 Git 根目录，
 * 然后在根目录下查找 bin/bash.exe 和 usr/bin/bash.exe。
 */
function gitBashCandidatesFromGitExecPath(execPath: string): readonly string[] {
  const normalized = nodePath.win32.normalize(normalizeWindowsPath(execPath));
  const parts = normalized.split('\\');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i]?.toLowerCase();
    if (segment === 'mingw32' || segment === 'mingw64') {
      const root = parts.slice(0, i).join('\\');
      if (root.length > 0) {
        return gitBashCandidatesFromGitRoot(root);
      }
    }
  }

  return gitBashCandidatesFromGitRoot(nodePath.win32.join(normalized, '..', '..'));
}

/** 从 Git 根目录生成 bash.exe 的标准候选路径 */
function gitBashCandidatesFromGitRoot(root: string): readonly string[] {
  return [
    nodePath.win32.normalize(nodePath.win32.join(root, 'bin', 'bash.exe')),
    nodePath.win32.normalize(nodePath.win32.join(root, 'usr', 'bin', 'bash.exe')),
  ];
}

/** 将路径中的正斜杠统一替换为反斜杠 */
function normalizeWindowsPath(path: string): string {
  return path.replaceAll('/', '\\');
}

/** 判断是否为 Windows 绝对路径 */
function isAbsoluteWindowsPath(path: string): boolean {
  return nodePath.win32.isAbsolute(normalizeWindowsPath(path));
}

/** 去重 Windows 路径（大小写不敏感） */
function dedupeWindowsPaths(paths: readonly string[]): readonly string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const key = normalizeWindowsPath(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(path);
  }
  return deduped;
}

/**
 * 生产便捷函数——从 Node 环境变量派生探测依赖。
 *
 * 结果会被缓存：后续调用返回同一个 Promise。
 * `Environment` 在进程生命周期内不可变（派生自 `process.platform`、
 * `process.arch`、`os.release()` 和一次性的 shell 路径发现），
 * 因此缓存是安全的。需要使用不同输入探测的测试应直接调用
 * {@link detectEnvironment} 并注入自定义依赖。
 */
let detectedEnvironment: Promise<Environment> | undefined;

export function detectEnvironmentFromNode(): Promise<Environment> {
  if (detectedEnvironment !== undefined) return detectedEnvironment;
  const platform = process.platform;
  const env = process.env as Record<string, string | undefined>;
  const isFile = async (path: string): Promise<boolean> => {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  detectedEnvironment = detectEnvironment({
    platform,
    arch: process.arch,
    release: nodeOs.release(),
    env,
    isFile,
    execFileText,
  });
  return detectedEnvironment;
}

/**
 * 在 PATH 环境变量中查找指定名称的可执行文件。
 *
 * 遍历 PATH 中的每个目录，检查是否存在名为 `name` 的文件。
 * 在 Windows 上跳过非绝对路径的目录条目，并对结果去重。
 */
async function findExecutablesOnPath(
  name: string,
  pathEnv: string | undefined,
  platform: string,
  isFile: (p: string) => Promise<boolean>,
): Promise<readonly string[]> {
  if (pathEnv === undefined || pathEnv.length === 0) return [];
  const listSep = platform === 'win32' ? ';' : ':';
  const dirSep = platform === 'win32' ? '\\' : '/';
  const paths: string[] = [];
  for (const rawDir of pathEnv.split(listSep)) {
    const dir = rawDir.trim();
    if (dir.length === 0) continue;
    if (platform === 'win32' && !isAbsoluteWindowsPath(dir)) continue;
    const candidate = dir.endsWith(dirSep) ? `${dir}${name}` : `${dir}${dirSep}${name}`;
    if (await isFile(candidate)) {
      paths.push(candidate);
    }
  }
  return platform === 'win32' ? dedupeWindowsPaths(paths) : paths;
}

/**
 * 执行外部文件并返回其 stdout 文本。
 * 超时或出错时返回 `undefined`。
 */
async function execFileText(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    nodeExecFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

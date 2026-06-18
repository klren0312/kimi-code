/**
 * 基于 AsyncLocalStorage 的当前 Kaos 上下文管理。
 *
 * 提供全局便捷函数，允许在不显式传递 Kaos 实例的情况下访问当前上下文中的
 * Kaos 实例。上下文通过 AsyncLocalStorage 实现，天然支持并发隔离。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { KaosError } from './errors';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

/** 异步上下文存储，持有当前绑定的 Kaos 实例 */
const kaosStorage = new AsyncLocalStorage<Kaos>();

/**
 * 返回绑定到当前异步上下文的 {@link Kaos} 实例。
 *
 * 如果没有绑定任何实例则抛出异常——调用方必须在启动时调用
 * {@link setCurrentKaos}，或用 {@link runWithKaos} 包裹入口点。
 */
export function getCurrentKaos(): Kaos {
  const store = kaosStorage.getStore();
  if (store === undefined) {
    throw new KaosError(
      'No Kaos is bound to the current async context. Call `setCurrentKaos(await LocalKaos.create())` once at startup, or wrap the call in `runWithKaos(...)`.',
    );
  }
  return store;
}

/**
 * 将 `kaos` 绑定为当前运行中异步上下文树的当前实例。
 *
 * 适用于进程启动时的一次性调用（如测试初始化）。同一上下文中
 * 后续的代码——包括嵌套的 await——都会通过 {@link getCurrentKaos}
 * 解析到此实例，除非被 {@link runWithKaos} 覆盖。
 */
export function setCurrentKaos(kaos: Kaos): void {
  kaosStorage.enterWith(kaos);
}

/**
 * 在 `kaos` 绑定为当前实例的异步子树中运行 `fn`。
 *
 * 并发调用互不干扰——绑定作用域限定在 {@link AsyncLocalStorage} 上下文内。
 */
export function runWithKaos<T>(kaos: Kaos, fn: () => T): T {
  return kaosStorage.run(kaos, fn);
}

// ── 模块级便捷函数：委托给当前 Kaos 实例 ──────────────────────────

/** 读取文件文本内容 */
export function readText(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): Promise<string> {
  return getCurrentKaos().readText(path, options);
}

/** 写入文本到文件 */
export function writeText(
  path: string,
  data: string,
  options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
): Promise<number> {
  return getCurrentKaos().writeText(path, data, options);
}

/** 逐行读取文件 */
export function readLines(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): AsyncGenerator<string> {
  return getCurrentKaos().readLines(path, options);
}

/** 执行命令 */
export function exec(...args: string[]): Promise<KaosProcess> {
  return getCurrentKaos().exec(...args);
}

/** 读取文件原始字节 */
export function readBytes(path: string, n?: number): Promise<Buffer> {
  return getCurrentKaos().readBytes(path, n);
}

/** 写入原始字节到文件 */
export function writeBytes(path: string, data: Buffer): Promise<number> {
  return getCurrentKaos().writeBytes(path, data);
}

/** 获取文件状态信息 */
export function stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
  return getCurrentKaos().stat(path, options);
}

/** 创建目录 */
export function mkdir(
  path: string,
  options?: { parents?: boolean; existOk?: boolean },
): Promise<void> {
  return getCurrentKaos().mkdir(path, options);
}

/** 列出目录下的条目 */
export function iterdir(path: string): AsyncGenerator<string> {
  return getCurrentKaos().iterdir(path);
}

/** 按 glob 模式匹配路径 */
export function glob(
  path: string,
  pattern: string,
  options?: { caseSensitive?: boolean },
): AsyncGenerator<string> {
  return getCurrentKaos().glob(path, pattern, options);
}

/** 切换工作目录 */
export function chdir(path: string): Promise<void> {
  return getCurrentKaos().chdir(path);
}

/** 获取当前工作目录 */
export function getcwd(): string {
  return getCurrentKaos().getcwd();
}

/** 获取用户主目录 */
export function gethome(): string {
  return getCurrentKaos().gethome();
}

/** 规范化路径 */
export function normpath(path: string): string {
  return getCurrentKaos().normpath(path);
}

/** 获取路径风格（POSIX 或 Windows） */
export function pathClass(): 'posix' | 'win32' {
  return getCurrentKaos().pathClass();
}

/** 使用显式环境变量执行命令 */
export function execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
  return getCurrentKaos().execWithEnv(args, env);
}

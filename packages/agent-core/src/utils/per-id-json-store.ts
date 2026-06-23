/**
 * 按 ID 的 JSON 记录存储——将每个值写为 `<rootDir>/<subdir>/<id>.json`。
 *
 * 从 `tools/background/persist.ts` 中提取出来，以便 cron / background /
 * 未来的"会话范围、按 ID、小型 JSON"持久化可以共享相同的原子写入 +
 * 路径遍历保护的 readdir 循环。存储对 `T` 不做假设——调用方提供 id 正则
 * （同时也是文件名验证器），并可选择性地提供廉价的形状检查器用于在
 * `list()` 时忽略不兼容的文件。
 *
 * 崩溃安全：写入通过 `atomicWrite`（写入临时文件、fsync、重命名），
 * 因此写入中途被 kill 不会留下损坏的文件。`list()` 静默丢弃不匹配
 * `idRegex` 的文件名、读取失败的文件、JSON 解析错误，以及在提供
 * 验证器时未通过 `isValid` 的值——调用方需要的是"所有可安全加载的内容"，
 * 而非部分抛出。
 *
 * 本身不支持并发进程安全：两个 CLI 进程写入同一个 id 会在重命名时竞争。
 * 我们接受这一点，因为会话模型已假设每个会话同时只有一个活跃进程
 * （resume 会终止之前的进程）。
 */

import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'pathe';

import { atomicWrite } from './fs';

export interface PerIdJsonStore<T> {
  /**
   * 将 `value` 原子写入 `<rootDir>/<subdir>/<id>.json`。按需创建子目录。
   * `id` 不匹配 `idRegex` 时抛出（路径遍历保护在任何 FS 调用前触发），
   * 写入本身失败时也抛出。
   */
  write(id: string, value: T): Promise<void>;
  /**
   * 读取单条记录。缺失文件、不可读文件、解析错误或在提供验证器时
   * 未通过 `isValid` 的值返回 `undefined`。仅在 id 无效时抛出
   *（路径遍历保护）。
   */
  read(id: string): Promise<T | undefined>;
  /**
   * 枚举子目录中所有文件名匹配 `idRegex` 且在提供验证器时解析内容
   * 满足 `isValid` 的记录。静默丢弃其他所有内容（损坏的 JSON、
   * 杂散文件、写了一半的文件）。
   */
  list(): Promise<readonly T[]>;
  /**
   * 幂等删除 `<rootDir>/<subdir>/<id>.json`。ENOENT 不是错误。
   * id 无效或任何其他 FS 失败时抛出。
   */
  remove(id: string): Promise<void>;
}

export interface PerIdJsonStoreOptions<T> {
  /** 会话范围的根目录（如 agent 的主目录）。 */
  readonly rootDir: string;
  /** `rootDir` 下的功能叶子目录（如 `'cron'`、`'tasks'`）。 */
  readonly subdir: string;
  /**
   * 严格的 id 格式。同时充当路径遍历保护——包含 `..` / `/` / 杂散点的
   * 内容在文件名接触文件系统之前就被正则拒绝。
   */
  readonly idRegex: RegExp;
  /**
   * 可选的廉价结构验证器。对每个解析后的 JSON 值运行；
   * 未通过的值从 `list()` 中静默丢弃（`read()` 返回 `undefined`）。
   * 应该廉价——每次 `list()` 每个文件运行一次。
   */
  readonly isValid?: (obj: unknown) => obj is T;
  /**
   * Human-readable name used in path-traversal rejection errors —
   * `Invalid <entityName>: "<id>"`. Lets each caller preserve its own
   * pre-refactor wording (`'task id'`, `'cron job id'`, ...) so error
   * messages stay stable across the abstraction. Defaults to `'id'`.
   */
  readonly entityName?: string;
}

export function createPerIdJsonStore<T>(
  opts: PerIdJsonStoreOptions<T>,
): PerIdJsonStore<T> {
  const { rootDir, subdir, idRegex, isValid, entityName = 'id' } = opts;
  const dir = join(rootDir, subdir);

  function fileFor(id: string): string {
    if (!idRegex.test(id)) {
      throw new Error(`Invalid ${entityName}: "${id}"`);
    }
    return join(dir, `${id}.json`);
  }

  async function write(id: string, value: T): Promise<void> {
    const target = fileFor(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(target, JSON.stringify(value, null, 2));
  }

  async function read(id: string): Promise<T | undefined> {
    const path = fileFor(id);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (isValid !== undefined && !isValid(parsed)) return undefined;
    return parsed as T;
  }

  async function list(): Promise<readonly T[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!idRegex.test(id)) continue;
      const value = await read(id);
      if (value === undefined) continue;
      out.push(value);
    }
    return out;
  }

  async function remove(id: string): Promise<void> {
    const path = fileFor(id);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return { write, read, list, remove };
}

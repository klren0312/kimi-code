/**
 * Cron 任务持久化。
 *
 * 对 `createPerIdJsonStore` 的薄封装，固定磁盘布局
 * (`<sessionDir>/cron/<task_id>.json`)、cron id 格式（8 位小写
 * 十六进制字符 — 与 `SessionCronStore` 生成的格式相同）以及
 * `CronTask` 的形状守卫。
 *
 * 无 `PersistedCronTask` 类型：`CronTask` 已是纯普通数据，
 * 因此磁盘记录是内存记录的逐字副本。可选的 `recurring` 被尊重：
 * 缺失字段往返为 `undefined`，cron 栈其余部分按约定视为"重复"。
 *
 * 存储是崩溃安全的（底层原子写入）并静默忽略杂散文件、损坏的
 * JSON 以及未通过形状守卫的记录 — cron 栈宁可丢失格式错误的任务
 * 也不拒绝启动。
 */

import { createPerIdJsonStore, type PerIdJsonStore } from '../../utils/per-id-json-store';
import type { CronTask } from './types';

/**
 * 磁盘 id 格式。镜像 `SessionCronStore` 生成 id 时使用的正则，
 * 同时兼作通用逐 id 存储内的路径遍历防护。
 */
export const CRON_ID_REGEX: RegExp = /^[0-9a-f]{8}$/;

/**
 * 廉价形状守卫。在从 `list()` / `read()` 暴露之前对每个解析的
 * JSON 值运行；失败的值被静默丢弃。
 */
export function isValidCronTask(obj: unknown): obj is CronTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || !CRON_ID_REGEX.test(o['id'])) return false;
  if (typeof o['cron'] !== 'string') return false;
  if (typeof o['prompt'] !== 'string') return false;
  if (typeof o['createdAt'] !== 'number') return false;
  if (o['recurring'] !== undefined && typeof o['recurring'] !== 'boolean') return false;
  if (
    o['lastFiredAt'] !== undefined &&
    (typeof o['lastFiredAt'] !== 'number' || !Number.isFinite(o['lastFiredAt']))
  ) {
    return false;
  }
  return true;
}

/**
 * 在 `sessionDir` 下为 cron 任务构建逐 id JSON 存储。存储是无状态的 —
 * 调用方可以按需创建。
 */
export function createCronPersistStore(sessionDir: string): PerIdJsonStore<CronTask> {
  return createPerIdJsonStore<CronTask>({
    rootDir: sessionDir,
    subdir: 'cron',
    idRegex: CRON_ID_REGEX,
    isValid: isValidCronTask,
    entityName: 'cron job id',
  });
}

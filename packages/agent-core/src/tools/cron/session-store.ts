/**
 * SessionCronStore — 单个 CLI 会话的内存 cron 任务存储。
 *
 * 存储本身是纯内存的；跨重启持久化由 `CronManager.addTask` /
 * `removeTasks` 在上层叠加，将每个变更镜像到
 * `<sessionDir>/cron/<id>.json`。在 resume 时管理器调用
 * {@link adopt} 将每个持久化任务放回存储中，保留原始 id 和 `createdAt`。
 *
 * 存储有意与时钟无关：它自身不调用 `Date.now()`。调用方传递
 * `nowMs`（cron 管理器从 `ClockSources.wallNow()` 获取），
 * 因此测试和基准中注入的时钟保持权威。`no-date-now` 守卫目前
 * 未列出此文件，但纪律匹配。
 *
 * 插入顺序通过依赖 `Map` 迭代顺序保留 — 调用方（CronList、
 * 调度器 `source: () => CronTask[]`）想要与用户"先添加的先出现"
 * 心智模型匹配的稳定排序。
 */

import { randomBytes } from 'node:crypto';

import type { CronTask } from './types';

/**
 * {@link SessionCronStore.add} 的输入：调用方提供的所有内容，
 * 减去由存储生成的 `id` 和 `createdAt`。
 */
export type SessionCronTaskInit = Omit<CronTask, 'id' | 'createdAt'>;

/** 匹配规范 cron 任务 id 格式（8 位小写十六进制字符）。 */
const ID_REGEX = /^[0-9a-f]{8}$/;

/**
 * id 碰撞重试上限。32 位熵和每会话最多几十个活跃任务，
 * 即使一次碰撞的概率也在 1e-8 量级。八次尝试是硬上限，
 * 用于暴露真实 bug（例如 PRNG 退化）而非静默旋转。
 */
const MAX_ID_ATTEMPTS = 8;

export class SessionCronStore {
  /**
   * 底层映射。`Map` 在 JS 中保留插入顺序，我们依赖它实现 {@link list}。
   */
  private readonly tasks = new Map<string, CronTask>();

  /**
   * 生成新的 8 位十六进制 id 并添加任务。`createdAt` 设为提供的
   * `nowMs` — 存储从不读取自身时钟。
   *
   * 如果 PRNG 在 {@link MAX_ID_ATTEMPTS} 次尝试内未能产生未使用的 id
   * 则抛出。实践中应不可达；将其作为抛出比静默无限重试更好。
   */
  add(init: SessionCronTaskInit, nowMs: number): CronTask {
    const id = this.generateUniqueId();
    const task: CronTask = {
      ...init,
      id,
      createdAt: nowMs,
    };
    this.tasks.set(id, task);
    return task;
  }

  /**
   * 逐字插入先前持久化的任务 — id 和 createdAt 保持磁盘上的原样。
   * 由 `CronManager.loadFromDisk()` 用于在 resume 时重新填充存储。
   * 与 {@link add} 不同，这不生成新 id；调用方负责确保 id 匹配
   * 预期形状（持久化层的正则/形状守卫在上游处理此问题）。
   *
   * 覆盖任何具有相同 id 的现有内存任务 — 重载是"替换"操作，
   * 而非"合并"。需要合并语义的调用方应先清空存储。
   */
  adopt(task: CronTask): void {
    this.tasks.set(task.id, task);
  }

  /**
   * 在内存任务上盖章 `lastFiredAt`。由调度器游标推进回调使用，
   * 使值通过管理器的持久化路径流回磁盘。返回更新的记录（以便
   * 管理器可以直接交给逐 id JSON 写入器），或当没有该 id 的
   * 任务时返回 `undefined` — 后者在调度器触发和游标回调之间
   * 任务被并发移除时无害发生。
   */
  markFired(id: string, lastFiredAt: number): CronTask | undefined {
    const existing = this.tasks.get(id);
    if (existing === undefined) return undefined;
    const updated: CronTask = { ...existing, lastFiredAt };
    this.tasks.set(id, updated);
    return updated;
  }

  /** 返回任务或 `undefined`。 */
  get(id: string): CronTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * 按插入顺序的快照。每次调用返回新数组 — 调用方可以修改返回的
   * 数组而不影响存储，且连续调用返回不同的数组引用。
   */
  list(): readonly CronTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 移除给定 id。返回实际存在的子集（以便调用方可以检测已缺失的
   * id 并报告）。返回的 id 顺序遵循输入顺序，而非插入顺序。
   */
  remove(ids: readonly string[]): readonly string[] {
    const removed: string[] = [];
    for (const id of ids) {
      if (this.tasks.delete(id)) {
        removed.push(id);
      }
    }
    return removed;
  }

  /** 清空存储。测试/关闭的便利方法。 */
  clear(): void {
    this.tasks.clear();
  }

  private generateUniqueId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = randomBytes(4).toString('hex');
      // randomBytes(4).toString('hex') 始终是 8 位小写十六进制字符，
      // 因此正则检查是对未来可能替换 id 来源的重构的双保险。
      if (!ID_REGEX.test(candidate)) continue;
      if (!this.tasks.has(candidate)) return candidate;
    }
    throw new Error(
      `SessionCronStore: failed to generate a unique 8-hex id after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }
}

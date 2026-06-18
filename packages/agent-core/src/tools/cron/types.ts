/**
 * cron 任务的持久化表示。
 *
 *   - `id` — 8 位十六进制；抖动从此哈希派生，因此稳定 id == 跨调度
 *     重写的稳定抖动。
 *   - `cron` — 5 字段表达式，在本地时间中求值。
 *   - `createdAt` — 原始调度时的墙钟纪元毫秒。调度器触发时不更新；
 *     重复任务在未记录 `lastFiredAt` 时将其作为基线下限。也是
 *     7 天过期判断的输入。
 *   - `recurring` — undefined / true 表示"重复触发直到删除或自动过期"；
 *     false 表示"触发一次然后自动删除"。
 *   - `lastFiredAt` — 抖动传递实际完成的最后一次理想触发的墙钟
 *     纪元毫秒。持久化以便 `kimi resume` 不会重放已传递的重复触发：
 *     没有它，调度器会回退到 `createdAt` 并将昨天已触发的 09:00
 *     合并到今天的 tick 中。大于当前墙钟的值被视为损坏，
 *     调度器为该任务回退到 `createdAt`。
 */
export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly recurring?: boolean;
  readonly lastFiredAt?: number;
}

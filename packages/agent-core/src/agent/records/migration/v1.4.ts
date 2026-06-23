/**
 * 从协议 v1.3 到 v1.4 的线路迁移。
 *
 * v1.3 使用多个带 `goalId` 字段的目标相关记录类型：
 * `goal.create`、`goal.update`、`goal.account_usage`、`goal.continuation`
 * 和 `goal.clear`。
 *
 * v1.4 简化了目标记录模型：
 * - `goal.create` 和 `goal.clear` 移除了 `goalId`（目标现在是隐式的——
 *   同一时间最多只有一个活跃目标）。
 * - `goal.update` 移除了 `goalId`。
 * - `goal.account_usage` 和 `goal.continuation` 合并到 `goal.update` 中，
 *   仅携带其相关字段。
 *
 * @module records/migration/v1.4
 */
import type { WireMigration, WireMigrationRecord } from './index';

/** v1.3 线路记录中持久化的目标状态值。 */
type V1_3GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

/** v1.3 线路记录中持久化的参与者值。 */
type V1_3GoalActor = 'user' | 'model' | 'runtime' | 'system';

/** 带有可选时间戳的线路记录，所有目标记录通用。 */
interface TimedWireMigrationRecord extends WireMigrationRecord {
  readonly time?: number;
}

/** v1.3 的 `goal.create` 记录形状。 */
interface V1_3GoalCreateRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.create';
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
}

/** v1.3 的 `goal.update` 记录形状。 */
interface V1_3GoalUpdateRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.update';
  readonly goalId: string;
  readonly status: V1_3GoalStatus;
  readonly reason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
  readonly actor?: V1_3GoalActor;
}

/** v1.3 的 `goal.account_usage` 记录形状（在 v1.4 中合并到 `goal.update`）。 */
interface V1_3GoalAccountUsageRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.account_usage';
  readonly goalId: string;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
}

/** v1.3 的 `goal.continuation` 记录形状（在 v1.4 中合并到 `goal.update`）。 */
interface V1_3GoalContinuationRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.continuation';
  readonly goalId: string;
  readonly turnsUsed?: number;
}

/** v1.3 的 `goal.clear` 记录形状。 */
interface V1_3GoalClearRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.clear';
  readonly goalId: string;
}

/** v1.3 → v1.4 迁移，简化目标记录类型并移除 goalId。 */
export const migrateV1_3ToV1_4: WireMigration = {
  sourceVersion: '1.3',
  targetVersion: '1.4',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    switch (record.type) {
      case 'goal.create':
        return migrateGoalCreate(record as V1_3GoalCreateRecord);
      case 'goal.update':
        return migrateGoalUpdate(record as V1_3GoalUpdateRecord);
      case 'goal.account_usage':
        return migrateGoalAccountUsage(record as V1_3GoalAccountUsageRecord);
      case 'goal.continuation':
        return migrateGoalContinuation(record as V1_3GoalContinuationRecord);
      case 'goal.clear':
        return migrateGoalClear(record as V1_3GoalClearRecord);
      default:
        return record;
    }
  },
};

/** 从 `goal.create` 记录中移除 `goalId`。 */
function migrateGoalCreate(record: V1_3GoalCreateRecord): WireMigrationRecord {
  return {
    type: 'goal.create',
    goalId: record.goalId,
    objective: record.objective,
    completionCriterion: record.completionCriterion,
    time: record.time,
  };
}

/** 从 `goal.update` 记录中移除 `goalId`。 */
function migrateGoalUpdate(record: V1_3GoalUpdateRecord): WireMigrationRecord {
  return {
    type: 'goal.update',
    status: record.status,
    reason: record.reason,
    turnsUsed: record.turnsUsed,
    tokensUsed: record.tokensUsed,
    wallClockMs: record.wallClockMs,
    actor: record.actor,
    time: record.time,
  };
}

/**
 * 将 `goal.account_usage` 记录合并到 `goal.update` 记录中，
 * 仅携带使用量相关字段。
 */
function migrateGoalAccountUsage(record: V1_3GoalAccountUsageRecord): WireMigrationRecord {
  return {
    type: 'goal.update',
    tokensUsed: record.tokensUsed,
    wallClockMs: record.wallClockMs,
    time: record.time,
  };
}

/**
 * 将 `goal.continuation` 记录合并到 `goal.update` 记录中，
 * 仅携带轮次计数字段。
 */
function migrateGoalContinuation(record: V1_3GoalContinuationRecord): WireMigrationRecord {
  return {
    type: 'goal.update',
    turnsUsed: record.turnsUsed,
    time: record.time,
  };
}

/** 从 `goal.clear` 记录中移除 `goalId`。 */
function migrateGoalClear(record: V1_3GoalClearRecord): WireMigrationRecord {
  return {
    type: 'goal.clear',
    time: record.time,
  };
}

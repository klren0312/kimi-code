/**
 * 从协议 v1.1 到 v1.2 的线路迁移。
 *
 * v1.1 使用人类可读的 `action` 标签存储会话范围的审批结果
 * （如 `'run command'`、`'edit file'`）。v1.2 用结构化的 `sessionApprovalRule`
 * 字段替换它，该字段使用工具名称模式（如 `'Bash'`、`'Write'`），
 * 使权限系统能够通过程序化匹配规则而非字符串比较。
 *
 * 仅 `permission.record_approval_result` 记录中 `decision: 'approved'`
 * 且 `scope: 'session'` 的受影响。某些旧操作标签无法安全迁移
 * （如 `'run background command'`），因为新规则格式无法表达原始约束——
 * 这些记录保持不变。
 *
 * @module records/migration/v1.2
 */
import type { WireMigration, WireMigrationRecord } from './index';

/** v1.1 线路记录中审批结果的形状。 */
interface V1_1ApprovalResult {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

/** v1.1 线路记录中完整审批结果记录的形状。 */
interface V1_1ApprovalResultRecord extends WireMigrationRecord {
  readonly type: 'permission.record_approval_result';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: V1_1ApprovalResult;
}

/**
 * 将旧版 v1.1 人类可读操作标签映射到 v1.2 工具名称模式。
 * 这些是安全映射，旧标签直接对应单个工具名称。
 */
const LEGACY_SESSION_APPROVAL_ACTION_TO_PATTERN: Readonly<Record<string, string>> = {
  'run command': 'Bash',
  'stop background task': 'TaskStop',
  'edit file': 'Write',
  'edit file outside of working directory': 'Write',
  'write file': 'Write',
};

/**
 * 无法安全迁移到 v1.2 规则的旧版操作标签。
 *
 * v1.1 直接缓存了这些操作标签，但没有足够稳定的数据来重建等效的 v1.2 规则。
 * 迁移到宽泛的 `Bash` 会扩大审批范围，且没有安全的 `Bash(...)` 主体可恢复——
 * 特别是 `run background command` 需要编码 `run_in_background=true`，
 * 而 `Bash` 的 `matchesRule` 无法表达。
 */
const LEGACY_SESSION_APPROVAL_UNRESTORABLE_ACTIONS = new Set<string>([
  'run command in plan mode',
  'run background command',
]);

/** v1.1 → v1.2 迁移，将旧版审批操作标签转换为结构化规则。 */
export const migrateV1_1ToV1_2: WireMigration = {
  sourceVersion: '1.1',
  targetVersion: '1.2',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'permission.record_approval_result') return record;
    const approvalRecord = record as V1_1ApprovalResultRecord;
    if (
      approvalRecord.result.decision !== 'approved' ||
      approvalRecord.result.scope !== 'session'
    ) {
      return record;
    }
    if (approvalRecord.sessionApprovalRule !== undefined) return record;

    const pattern = LEGACY_SESSION_APPROVAL_UNRESTORABLE_ACTIONS.has(approvalRecord.action)
      ? undefined
      : LEGACY_SESSION_APPROVAL_ACTION_TO_PATTERN[approvalRecord.action] ??
        approvalRecord.toolName;
    if (pattern === undefined) return record;

    return {
      ...record,
      sessionApprovalRule: pattern,
    };
  },
};

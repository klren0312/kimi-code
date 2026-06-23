/**
 * Agent 记录的线路协议迁移框架。
 *
 * Agent 记录以换行分隔的 JSON（`wire.jsonl`）持久化。当 schema 演进时，
 * 旧记录在重放前必须被转换。本模块提供链式迁移架构：
 *
 * 1. 每个迁移声明 `sourceVersion` → `targetVersion` 对和一个转换单条记录的 `migrateRecord` 函数。
 * 2. {@link resolveWireMigrations} 计算从给定版本到当前协议版本的最小迁移链。
 * 3. {@link migrateWireRecord} 将迁移链应用于单条记录。
 * 4. {@link migrateWireRecords} 将完整链应用于记录数组。
 *
 * 当前协议版本存储在 {@link AGENT_WIRE_PROTOCOL_VERSION} 中。
 * 仅在需要迁移现有记录或改变现有记录解释方式时提升版本——
 * 不要仅因为新功能添加了旧版本可以安全忽略的新记录类型而提升。
 *
 * @module records/migration
 */
import { migrateV1_0ToV1_1 } from './v1.1';
import { migrateV1_1ToV1_2 } from './v1.2';
import { migrateV1_2ToV1_3 } from './v1.3';
import { migrateV1_3ToV1_4 } from './v1.4';

/**
 * Agent 记录的当前线路协议版本。
 *
 * 线路协议版本目前仅支持 `number.number` 格式。
 * 仅在需要迁移现有记录或改变现有记录解释方式时提升此版本。
 * 不要仅因为新功能添加了新的线路记录类型而提升：旧版本不实现该功能，
 * 无需理解新记录类型。
 */
export const AGENT_WIRE_PROTOCOL_VERSION = '1.4';

/**
 * 磁盘上的原始线路记录，在应用任何迁移之前。
 * `type` 字段是必需的；所有其他字段为 unknown 类型，
 * 以便迁移可以自由转换形状。
 */
export interface WireMigrationRecord {
  readonly type: string;
  [key: string]: unknown;
}

/**
 * 迁移链中的单个步骤，将记录从一个协议版本转换到下一个。
 */
export interface WireMigration {
  /** 此迁移读取的协议版本（如 `'1.0'`）。 */
  readonly sourceVersion: string;
  /** 此迁移写入的协议版本（如 `'1.1'`）。 */
  readonly targetVersion: string;
  /**
   * 转换单条记录。如果记录不受此迁移影响则必须原样返回。
   */
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord;
}

const MIGRATIONS: readonly WireMigration[] = [
  migrateV1_0ToV1_1,
  migrateV1_1ToV1_2,
  migrateV1_2ToV1_3,
  migrateV1_3ToV1_4,
];

/**
 * 检查持久化的版本是否比当前协议版本更新，表明 Agent 不应尝试迁移
 * （记录由更新版本的软件写入）。
 *
 * @param readVersion - 从持久化元数据中读取的版本。
 * @returns 如果 `readVersion` 比当前版本更新则返回 `true`。
 */
export function isNewerWireVersion(readVersion: string): boolean {
  return compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) > 0;
}

/**
 * 计算将记录从 `readVersion` 升级到当前协议版本所需的最小迁移链。
 * 如果版本已经匹配则返回空数组。
 *
 * @param readVersion - 持久化记录的协议版本。
 * @returns 要应用的有序迁移数组。
 * @throws 如果中间版本没有对应迁移。
 */
export function resolveWireMigrations(readVersion: string): readonly WireMigration[] {
  if (compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) >= 0) {
    return [];
  }

  const migrations: WireMigration[] = [];
  let version = readVersion;
  while (compareWireVersions(version, AGENT_WIRE_PROTOCOL_VERSION) < 0) {
    const migration = findMigration(version);
    if (migration === undefined) {
      throw new Error(`Missing wire migration for version ${version}`);
    }
    migrations.push(migration);
    version = migration.targetVersion;
  }

  return migrations;
}

/**
 * 将迁移链按顺序应用于单条记录。返回最终迁移后的记录。
 *
 * @param record - 要迁移的原始线路记录。
 * @param migrations - 有序迁移链。
 * @returns 迁移后的记录。
 */
export function migrateWireRecord(
  record: WireMigrationRecord,
  migrations: readonly WireMigration[],
): WireMigrationRecord {
  return migrations.reduce(
    (current, migration) => migration.migrateRecord(current),
    record,
  );
}

/**
 * 将迁移应用于记录数组。如果提供了 `readVersion`，仅应用从该版本开始的
 * 必要迁移；否则应用完整迁移链（用于处理版本未知的记录）。
 *
 * @param records - 要迁移的记录。
 * @param readVersion - 记录的协议版本，或 `undefined` 以应用所有迁移。
 * @returns 迁移后的记录。
 */
export function migrateWireRecords(
  records: readonly WireMigrationRecord[],
  readVersion: string | undefined,
): WireMigrationRecord[] {
  const migrations =
    readVersion === undefined ? MIGRATIONS : resolveWireMigrations(readVersion);
  return records.map((record) => migrateWireRecord(record, migrations));
}

/** 查找 `sourceVersion` 匹配给定版本的迁移。 */
function findMigration(sourceVersion: string): WireMigration | undefined {
  for (const migration of MIGRATIONS) {
    if (migration.sourceVersion === sourceVersion) return migration;
  }
}

/**
 * 数值比较两个 `major.minor` 版本字符串。
 * `a < b` 返回负数，相等返回零，`a > b` 返回正数。
 */
function compareWireVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const maxLength = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLength; i++) {
    const diff = Number(partsA[i] ?? '0') - Number(partsB[i] ?? '0');
    if (diff !== 0) return diff;
  }

  return 0;
}

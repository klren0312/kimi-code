/**
 * 从协议 v1.2 到 v1.3 的线路迁移。
 *
 * 这是仅提升版本的迁移——不需要记录转换。
 * v1.3 引入了大型 base64 媒体载荷的 blobref 卸载，但线路格式未变。
 * v1.3+ 写入的记录可能包含 `blobref:<mime>;<hash>` URL 而非内联 `data:` URI，
 * 但这由 {@link BlobStore} 在读写时透明处理。
 *
 * 版本提升的目的是让旧版 Agent 能够检测到会话可能包含 blob 引用，
 * 并适当处理（或发出警告）。
 *
 * @module records/migration/v1.3
 */
import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.2 -> v1.3 是仅提升版本的迁移。
 *
 * v1.3 引入了大型 base64 媒体载荷的 blobref 卸载。
 * v1.3+ 写入的记录可能在消息内容中包含 `blobref:<mime>;<hash>` URL
 * 而非内联 `data:` URI。线路记录仍然是有效的 JSON，不需要转换；
 * blobref 格式由 BlobStore 在读写时透明处理。
 */
export const migrateV1_2ToV1_3: WireMigration = {
  sourceVersion: '1.2',
  targetVersion: '1.3',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};

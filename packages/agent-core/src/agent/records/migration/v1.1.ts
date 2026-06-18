/**
 * 从协议 v1.0 到 v1.1 的线路迁移。
 *
 * v1.0 的工具调用使用嵌套的 `function` 包装器：
 *   `{ function: { name: 'xxx', arguments: 'yyy' } }`
 *
 * v1.1 将其展平为：
 *   `{ name: 'xxx', arguments: 'yyy' }`
 *
 * 仅 `context.append_message` 记录受影响；所有其他记录类型原样通过。
 *
 * @module records/migration/v1.1
 */
import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.0 线路记录中持久化的工具调用形状。嵌套的 `function` 包装器
 * 将被此迁移移除。
 */
interface V1_0ContextAppendMessageRecord extends WireMigrationRecord {
  readonly type: 'context.append_message';
  readonly message: V1_0ContextMessage;
}

/** v1.0 线路记录中持久化的上下文消息形状。 */
interface V1_0ContextMessage {
  readonly toolCalls: readonly V1_0ToolCall[];
  readonly [key: string]: unknown;
}

/** v1.0 线路记录中持久化的工具调用形状。 */
interface V1_0ToolCall {
  readonly type: 'function';
  readonly id: string;
  readonly function: {
    readonly name?: string;
    readonly arguments?: string | null;
  };
}

/** 将 v1.0 嵌套的 `function` 包装器展平为 v1.1 的扁平工具调用。 */
function migrateToolCall(toolCall: V1_0ToolCall): WireMigrationRecord {
  const { function: fn, ...rest } = toolCall;
  return {
    ...rest,
    name: fn.name,
    arguments: fn.arguments,
  };
}

/** v1.0 → v1.1 迁移，展平嵌套的工具调用包装器。 */
export const migrateV1_0ToV1_1: WireMigration = {
  sourceVersion: '1.0',
  targetVersion: '1.1',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'context.append_message') return record;
    const appendMessageRecord = record as V1_0ContextAppendMessageRecord;

    return {
      ...appendMessageRecord,
      message: {
        ...appendMessageRecord.message,
        toolCalls: appendMessageRecord.message.toolCalls.map(migrateToolCall),
      },
    };
  },
};

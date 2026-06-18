/**
 * Agent 记录——有序事件日志，持久化 {@link Agent} 在会话期间执行的每个状态变更操作。
 *
 * 记录是 Agent 状态的唯一来源。恢复时，它们通过 {@link restoreAgentRecord} 重放
 * 以确定性地重建内存状态，无副作用（无 UI 事件、LLM 调用、工具执行、后台工作、
 * 网络请求或记录文件本身的文件系统写入之外的文件系统操作）。
 *
 * 本模块重新导出记录子系统的公共表面：
 * - 来自 {@link ./types} 的记录类型和持久化接口
 * - 来自 {@link ./migration} 的线路协议版本
 * - {@link FileSystemAgentRecordPersistence} 和 {@link InMemoryAgentRecordPersistence}
 * - {@link BlobStore} 和 {@link isBlobRef} 用于大媒体卸载
 *
 * @module records
 */
import type { Agent } from '..';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from './migration';
import type { AgentRecord, AgentRecordPersistence } from './types';

export * from './types';
export { AGENT_WIRE_PROTOCOL_VERSION } from './migration';
export {
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
} from './persistence';
export type { FileSystemAgentRecordPersistenceOptions } from './persistence';
export { BlobStore, isBlobRef } from './blobref';
export type { BlobStoreOptions } from './blobref';

/**
 * 将单条持久化的 {@link AgentRecord} 重放到 {@link Agent} 上，
 * 重建内存状态而无外部副作用。
 *
 * 契约：此函数必须仅重建内存状态。不得发出 UI 事件、调用 LLM、
 * 执行工具、启动后台工作、发起网络请求，或以触发外部副作用的方式
 * 操作文件系统。
 *
 * 它优先通过调用写入记录的相同方法来恢复，使实时执行和恢复共享
 * 一条状态变更路径。例如，`permission.set_mode` 通过
 * `agent.permission.setMode(input.mode)` 重放，而非直接赋值 `modeOverride`。
 * `records.logRecord`、`emitEvent` 和 `emitStatusUpdated` 已在
 * `records.restoring` 上设置门控，因此这些调用在恢复期间是安全的。
 *
 * @param agent - 将被变更状态的 Agent 实例。
 * @param input - 要重放的记录。
 */
function restoreAgentRecord(agent: Agent, input: AgentRecord): void {
  switch (input.type) {
    case 'metadata':
      return;
    case 'forked':
      agent.goal.restoreForked(input);
      return;
    case 'turn.prompt':
      agent.turn.restorePrompt();
      return;
    case 'turn.steer':
      agent.turn.restoreSteer(input.input, input.origin);
      return;
    case 'turn.cancel':
      agent.turn.cancel(input.turnId);
      return;
    case 'config.update':
      agent.config.update(input);
      return;
    case 'permission.set_mode':
      agent.permission.setMode(input.mode);
      return;
    case 'permission.record_approval_result':
      agent.permission.recordApprovalResult(input);
      return;
    case 'usage.record':
      agent.usage.record(input.model, input.usage, 'session');
      return;
    case 'full_compaction.begin':
      agent.fullCompaction.begin(input);
      return;
    case 'full_compaction.cancel':
      agent.fullCompaction.cancel();
      return;
    case 'full_compaction.complete':
      agent.fullCompaction.markCompleted();
      return;
    case 'micro_compaction.apply':
      agent.microCompaction.apply(input.cutoff);
      return;
    case 'plan_mode.enter':
      agent.planMode.restoreEnter(input);
      return;
    case 'plan_mode.cancel':
      agent.planMode.cancel(input.id);
      return;
    case 'plan_mode.exit':
      agent.planMode.exit(input.id);
      return;
    case 'swarm_mode.enter':
      agent.swarmMode.restoreEnter(input.trigger);
      return;
    case 'swarm_mode.exit':
      agent.swarmMode.exit();
      return;
    case 'context.append_message':
      agent.context.appendMessage(input.message);
      return;
    case 'context.append_loop_event':
      agent.context.appendLoopEvent(input.event);
      // 将 turn 计数器推进到内部驱动的 turn（目标延续、引导启动的 turn）之后，
      // 这些 turn 分配了 turnId 但没有 `turn.prompt` 记录。
      // 它们的循环事件仍然携带真实的 turnId。
      if ('turnId' in input.event) {
        const restoredTurnId = Number.parseInt(input.event.turnId, 10);
        if (!Number.isNaN(restoredTurnId)) {
          agent.turn.observeRestoredTurnId(restoredTurnId);
        }
      }
      return;
    case 'context.clear':
      agent.context.clear();
      return;
    case 'context.apply_compaction':
      agent.context.applyCompaction(input);
      return;
    case 'context.undo':
      agent.context.undo(input.count);
      return;
    case 'tools.register_user_tool':
      agent.tools.registerUserTool(input);
      return;
    case 'tools.unregister_user_tool':
      agent.tools.unregisterUserTool(input.name);
      return;
    case 'tools.set_active_tools':
      agent.tools.setActiveTools(input.names);
      return;
    case 'tools.update_store':
      agent.tools.updateStore(input.key, input.value);
      return;
    case 'goal.create':
      agent.goal.restoreCreate(input);
      return;
    case 'goal.update':
      agent.goal.restoreUpdate(input);
      return;
    case 'goal.clear':
      agent.goal.restoreClear(input);
      return;
  }
}

/**
 * 在记录恢复期间捕获的上下文，用于抑制不应在重放期间运行的操作
 * （如发出事件、写入新记录）。
 */
export interface RestoringContext {
  /** 正在恢复的记录的时间戳，用作参考时钟。 */
  time?: number;
}

/**
 * {@link AgentRecords.replay} 的选项。
 */
export interface AgentRecordsReplayOptions {
  /**
   * 当为 `true`（默认值）时，迁移后的记录被重写到持久化层，
   * 以便将来的重放跳过迁移。设为 `false` 可在不修改后端存储的情况下
   * 执行只读重放。
   */
  readonly rewriteMigratedRecords?: boolean;
}

/**
 * 管理 {@link AgentRecord} 的生命周期：在实时执行期间记录新记录，
 * 在重放期间恢复记录，以及编排带有自动线路协议迁移的完整会话重放。
 *
 * 该类充当 {@link Agent} 和其 {@link AgentRecordPersistence} 后端之间的桥梁，
 * 确保记录带时间戳、感知迁移，并在恢复期间正确门控。
 */
export class AgentRecords {
  private _restoring: RestoringContext | null = null;
  private metadataInitialized = false;

  /**
   * @param agent - 恢复/重放期间将被变更状态的 Agent。
   * @param persistence - 可选的持久化后端。省略时，实例只能记录记录
   *   （记录被静默丢弃）且重放将抛出异常。
   */
  constructor(
    private readonly agent: Agent,
    private readonly persistence?: AgentRecordPersistence,
  ) {}

  /**
   * 返回当前恢复上下文，如果 Agent 处于实时执行模式则返回 `null`。
   * 其他子系统用于检测和抑制重放期间的副作用。
   */
  get restoring() {
    return this._restoring;
  }

  /**
   * 持久化实时执行期间产生的新记录。
   *
   * 如果没有 `time`，记录使用 `Date.now()` 作为时间戳。
   * 在第一条非 metadata 记录之前自动插入合成的 `metadata` 记录，
   * 以确保 wire 文件始终以版本头开始。恢复期间的调用被静默忽略
   * 以防止递归写入。
   *
   * @param record - 要记录的记录。
   */
  logRecord(record: AgentRecord): void {
    if (this._restoring !== null) return;
    const stamped: AgentRecord =
      record.time !== undefined ? record : { ...record, time: Date.now() };
    if (
      this.persistence !== undefined &&
      !this.metadataInitialized &&
      stamped.type !== 'metadata'
    ) {
      this.persistence.append({
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
      });
      this.metadataInitialized = true;
    }
    if (stamped.type === 'metadata') {
      this.metadataInitialized = true;
    }
    this.persistence?.append(stamped);
  }

  /**
   * 将单条记录重放到 Agent 上，通过恢复上下文抑制副作用。
   * 如果重放被中断（例如由 `replayBuilder` 信号触发）则返回 `true`，
   * 表示调用方应停止。
   *
   * @param record - 要恢复的记录。
   * @returns 如果应在此记录后停止重放则返回 `true`。
   */
  restore(record: AgentRecord): boolean {
    this._restoring = { time: record.time ?? Date.now() };
    try {
      restoreAgentRecord(this.agent, record);
      return this.agent.replayBuilder.finishRestoringRecord(record.type);
    } finally {
      this._restoring = null;
    }
  }

  /**
   * 执行完整会话重放：读取所有持久化记录，根据需要应用线路协议迁移，
   * 将每条记录恢复到 Agent 上，并可选地将迁移后的记录重写回持久化层。
   *
   * 所有记录重放后，重新水合上下文历史中的任何 blob 引用，
   * 使下游消费者看到内联的 `data:` URI。
   *
   * @param options - 重放配置。
   * @returns 带有可选 `warning` 的对象，如果持久化版本比当前协议版本更新。
   * @throws 如果未提供持久化后端，或第一条记录不是 `metadata` 记录。
   */
  async replay(options: AgentRecordsReplayOptions = {}): Promise<{ warning?: string }> {
    if (!this.persistence) throw new Error('No persistence provided for AgentRecords');
    const rewriteMigratedRecords = options.rewriteMigratedRecords ?? true;
    let migrations: readonly WireMigration[] = [];
    let hasMetadata = false;
    let shouldRewrite = false;
    let warning: string | undefined;
    const replayedRecords: AgentRecord[] | undefined = rewriteMigratedRecords ? [] : undefined;
    let completed = true;
    for await (const record of this.persistence.read()) {
      if (!hasMetadata) {
        if (record.type !== 'metadata') {
          throw new Error('AgentRecords replay expected metadata as the first record');
        }
        hasMetadata = true;
        this.metadataInitialized = true;
        const readVersion = record.protocol_version;
        if (isNewerWireVersion(readVersion)) {
          warning = `Session wire protocol version ${readVersion} is newer than the current version ${AGENT_WIRE_PROTOCOL_VERSION}. Records will be replayed without migration.`;
          shouldRewrite = false;
        } else {
          migrations = resolveWireMigrations(readVersion);
          shouldRewrite = readVersion !== AGENT_WIRE_PROTOCOL_VERSION;
        }
      }
      let migratedRecord = migrateWireRecord(
        record as WireMigrationRecord,
        migrations,
      ) as AgentRecord;
      if (migratedRecord.type === 'metadata') {
        migratedRecord = {
          ...migratedRecord,
          protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        };
      }
      replayedRecords?.push(migratedRecord);
      if (this.restore(migratedRecord)) {
        completed = false;
        break;
      }
    }
    if (completed && shouldRewrite && replayedRecords !== undefined) {
      this.persistence.rewrite(replayedRecords);
      await this.persistence.flush();
    }
    if (completed && this.agent.blobStore !== undefined) {
      for (const msg of this.agent.context.history) {
        await this.agent.blobStore.rehydrateParts(msg.content);
      }
    }
    return { warning };
  }

  /**
   * 刷新所有待写入到持久化后端，确保持久性。
   * 未配置持久化时为空操作。
   */
  async flush(): Promise<void> {
    await this.persistence?.flush();
  }
}

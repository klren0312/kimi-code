/**
 * Agent 记录事件日志的类型定义。
 *
 * Agent 记录是用于在恢复时重建 Agent 状态的有序事件日志。
 * 本模块通过 {@link AgentRecordEvents} 定义每种记录类型的形状，
 * 判别联合类型 {@link AgentRecord}，以及后端必须实现的
 * 持久化接口 {@link AgentRecordPersistence}。
 *
 * 当正确性依赖于状态转换发生的顺序时，使用记录而非 `state.json`。
 * 每种持久化的记录类型必须在 `restoreAgentRecord` 中有明确的恢复语义；
 * 仅写入的记录不算持久化。
 *
 * @module records/types
 */
import type { ContentPart, TokenUsage } from '@moonshot-ai/kosong';

import type { LoopRecordedEvent } from '../../loop';
import type { GoalActor, GoalBudgetLimits, GoalStatus } from '../goal';
import type { ToolStoreUpdate } from '../../tools/store';
import type { CompactionBeginData, CompactionResult } from '../compaction';
import type { AgentConfigUpdateData } from '../config';
import type { ContextMessage, PromptOrigin } from '../context';
import type { PermissionApprovalResultRecord, PermissionMode } from '../permission';
import type { UserToolRegistration } from '../tool';
import type { UsageRecordScope } from '../usage';
import type { SwarmModeTrigger } from '../swarm';

/**
 * 将每种记录类型标签映射到其载荷形状。
 *
 * 每个键代表一个可被持久化和稍后重放的独立状态转换。
 * 此映射是判别联合 {@link AgentRecord} 的来源——
 * 在此处添加新记录类型会自动扩展联合。
 *
 * Agent 记录是用于在恢复时重建 Agent 状态的有序事件日志。
 * 当正确性依赖于状态转换发生的顺序时，使用记录而非 state.json。
 * 每种持久化的记录类型必须在 restoreAgentRecord 中有明确的恢复语义；
 * 仅写入的记录不算持久化。
 */
export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };

  forked: {};

  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };

  'config.update': AgentConfigUpdateData;

  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;

  'full_compaction.begin': CompactionBeginData;

  'plan_mode.enter': {
    id: string;
  };
  'plan_mode.cancel': {
    id?: string;
  };
  'plan_mode.exit': {
    id?: string;
  };

  'swarm_mode.enter': {
    trigger: SwarmModeTrigger;
  };
  'swarm_mode.exit': {};

  'tools.register_user_tool': UserToolRegistration;
  'tools.unregister_user_tool': {
    name: string;
  };
  'tools.set_active_tools': {
    names: readonly string[];
  };

  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };

  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  'micro_compaction.apply': { cutoff: number };

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.clear': {};
  'context.apply_compaction': CompactionResult;
  'context.undo': { count: number };

  'tools.update_store': ToolStoreUpdate;

  'goal.create': {
    goalId: string;
    objective: string;
    completionCriterion?: string;
  };
  'goal.update': {
    status?: GoalStatus;
    tokensUsed?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    budgetLimits?: GoalBudgetLimits;
    reason?: string;
    actor?: GoalActor;
  };
  'goal.clear': {};
}

/**
 * 所有 Agent 记录类型的判别联合。
 *
 * 每个变体携带 `type` 标签和可选的 `time` 时间戳。
 * 联合从 {@link AgentRecordEvents} 派生，因此向事件映射添加新键
 * 会自动在此处添加新变体。
 */
export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

/**
 * 从 {@link AgentRecord} 中按类型标签提取单个记录变体。
 *
 * 适用于在函数签名或类型守卫中将记录窄化为特定类型。
 *
 * @typeParam K - 要提取的记录类型标签。
 */
export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

/**
 * 持久化 Agent 记录的存储后端抽象。
 *
 * 实现必须保证 {@link read} 返回的记录与 {@link append} 的顺序相同，
 * 且 {@link rewrite} 原子地替换整个日志。{@link flush} 方法确保
 * 所有缓冲写入在返回前持久化。
 *
 * 开箱即用提供两种实现：
 * - {@link InMemoryAgentRecordPersistence} 用于测试和临时会话
 * - {@link FileSystemAgentRecordPersistence} 用于持久化的 `wire.jsonl` 文件
 */
export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

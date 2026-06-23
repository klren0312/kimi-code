/**
 * Agent 上下文子系统的类型定义。
 *
 * 本模块定义了描述消息为何进入对话上下文（其**提示词来源**）的
 * 判别联合类型，以及 agent-core 中使用的增强消息包装器
 * （`ContextMessage`）。
 *
 * 提示词来源使下游逻辑 — 撤销、压缩、重放和投影器规则 — 能够
 * 基于每条消息的来源（而非检查原始内容）做出决策。
 */

import type { ContentPart, Message } from '@moonshot-ai/kosong';

import type { SkillSource } from '../../skill';
import type { BackgroundTaskStatus } from '../background';

/** 直接来自终端用户的消息的来源描述符。 */
export interface UserPromptOrigin {
  readonly kind: 'user';
}

/** 复用的单例实例，避免为每条用户消息分配新对象。 */
export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

/**
 * 由已激活的技能注入的消息的来源描述符。
 *
 * 技能可由用户斜杠命令触发、由模型通过工具调用触发，
 * 或作为另一个技能的嵌套激活。`trigger` 字段记录了产生此激活
 * 的路径，以便撤销和重放逻辑能区分用户发起的技能输出和模型的
 * 自主输出。
 */
export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  /** 此特定激活实例的唯一标识符。 */
  readonly activationId: string;
  /** 被激活的技能的人类可读名称。 */
  readonly skillName: string;
  /** 调用时传递给技能的可选参数。 */
  readonly skillArgs?: string | undefined;
  /** 触发此激活的方式：用户命令、模型工具调用或嵌套技能。 */
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  /** 可选的技能类型分类（如 "system"、"personal"）。 */
  readonly skillType?: string | undefined;
  /** 可选的技能定义文件所在路径。 */
  readonly skillPath?: string | undefined;
  /** 可选的来源元数据，指示技能的加载来源。 */
  readonly skillSource?: SkillSource | undefined;
}

/**
 * 注入消息的来源描述符 — 通常是系统生成的内容，如系统提醒块
 * 或动态指令更新，这些内容不由用户或模型编写。
 */
export interface InjectionOrigin {
  readonly kind: 'injection';
  /** 标识产生此消息的注入变体（如 "system-reminder"）。 */
  readonly variant: string;
}

/**
 * 压缩过程生成的摘要消息的来源描述符。
 *
 * 压缩将一组较早的消息替换为单条摘要以保持在上下文窗口内。
 * 此来源使撤销逻辑能在压缩边界处停止，而非静默丢弃摘要。
 */
export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

/**
 * 由内部系统触发器产生的消息的来源描述符
 * （如自动重试、错误恢复或生命周期钩子）。
 */
export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  /** 产生此消息的触发器名称。 */
  readonly name: string;
}

/**
 * 从后台任务投递的通知消息的来源描述符。
 *
 * 后台任务异步运行，可能在 Agent 处于不同的对话轮次时完成。
 * 此来源携带将通知与其来源任务关联所需的元数据。
 */
export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  /** 产生此通知的后台任务标识符。 */
  readonly taskId: string;
  /** 通知投递时任务的当前状态。 */
  readonly status: BackgroundTaskStatus;
  /** 此特定通知投递的唯一标识符。 */
  readonly notificationId: string;
}

/**
 * 定时任务消息的来源描述符。
 *
 * 定时任务可按周期性计划触发，也可作为一次性计时器。此来源
 * 为重放和压缩捕获了足够的元数据以理解时间上下文：多次错过
 * 的触发是否被合并为单次投递，以及周期性任务是否已过期
 * （超过 7 天阈值）。
 */
export interface CronJobOrigin {
  readonly kind: 'cron_job';
  /** 定时任务定义的标识符。 */
  readonly jobId: string;
  /** 定义调度计划的 cron 表达式。 */
  readonly cron: string;
  /** 此任务是否按计划重复（true）或为一次性计时器（false）。 */
  readonly recurring: boolean;
  /** 被合并为此次单次投递的理论触发次数（>= 1）。 */
  readonly coalescedCount: number;
  /** 对于超过 7 天期限阈值的周期性任务为 true。 */
  readonly stale: boolean;
}

/**
 * 一次性定时任务错过触发的通知的来源描述符。
 *
 * 当一次性定时任务在触发前过期时，它们会被打包成单条摘要通知，
 * 以便 Agent 能一次性确认所有错过的截止时间，而无需为每个任务
 * 发送单独的消息。
 */
export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  /** 打包在此错过触发通知中的一次性任务数量。 */
  readonly count: number;
}

/**
 * 生命周期钩子结果产生的消息的来源描述符。
 *
 * 钩子可以选择性地阻塞触发它的操作；`blocked` 标志指示
 * 该钩子是否阻止了原始操作继续执行。
 */
export interface HookResultOrigin {
  readonly kind: 'hook_result';
  /** 产生此结果的钩子事件名称（如 "pre-tool-call"）。 */
  readonly event: string;
  /** 该钩子是否阻塞了触发操作。 */
  readonly blocked?: boolean;
}

/**
 * 作为自动重试一部分注入的消息的来源描述符。
 *
 * 当 Agent 重试失败的操作（如网络调用或工具执行）时，
 * 重试相关的消息携带此来源，以便撤销和压缩能将重试序列
 * 视为一个逻辑单元。
 */
export interface RetryOrigin {
  readonly kind: 'retry';
  /** 可选的重试触发原因描述。 */
  readonly trigger?: string;
}

/**
 * 所有提示词来源变体的判别联合。
 *
 * Agent 上下文中的每条消息都携带一个可选的来源，解释它为何被添加。
 * 下游消费者（撤销、压缩、投影器、重放构建器）通过 `kind` 标签进行
 * 模式匹配，以做出基于来源的决策。
 */
export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | InjectionOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

/**
 * 带有上下文层元数据的对话消息。
 *
 * 扩展了 kosong Provider 层的基础 {@link Message} 类型，添加了
 * 可选的 {@link PromptOrigin}（来源）和错误标志。投影器在消息发送
 * 给 LLM Provider 之前会剥离来源信息，因此它仅存在于上下文子系统内部。
 */
export type ContextMessage = Message & {
  /** 此消息被添加到上下文的原因（Provider 产生的消息为 undefined）。 */
  readonly origin?: PromptOrigin | undefined;
  /** 此消息是否代表错误状态（如失败的工具结果）。 */
  readonly isError?: boolean;
};

/**
 * 已追加到上下文的用户消息记录，用于重放和撤销记账。
 * 同时捕获内容和来源，以便重放构建器能忠实还原对话。
 */
export interface UserMessageRecord {
  /** 组成用户消息的内容部分。 */
  content: readonly ContentPart[];
  /** 附加到此用户消息的提示词来源。 */
  origin: PromptOrigin;
}

/**
 * 系统提醒注入的记录，用于重放记账。
 * 与用户消息不同，系统提醒始终携带纯文本内容。
 */
export interface SystemReminderRecord {
  /** 系统提醒的文本内容。 */
  content: string;
  /** 附加到此提醒的提示词来源。 */
  origin: PromptOrigin;
}

/**
 * Agent 上下文状态的快照，由 {@link ContextMemory.data} 返回。
 *
 * 携带完整的消息历史和 token 计数估算，以便调用者在不修改上下文的
 * 情况下进行检查。服务器 API 层使用它向客户端报告上下文窗口的使用情况。
 */
export interface AgentContextData {
  /** 当前对话历史（只读快照）。 */
  history: readonly ContextMessage[];
  /** 历史的估算 token 计数。 */
  tokenCount: number;
}

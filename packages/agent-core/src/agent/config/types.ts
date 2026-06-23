/**
 * @module config/types
 *
 * Agent 实例的核心配置数据结构。这些类型表示 agent 配置中
 * 在构造时传入、在运行时更新的可变和不可变部分。
 */

import type { ModelCapability, ProviderConfig } from '@moonshot-ai/kosong';

/**
 * agent 构造时提供的不可变配置快照。包含 agent 启动所需的全部信息：
 * 工作目录、provider 凭据、模型能力和系统提示词。
 */
export interface AgentConfigData {
  /** 文件操作和相对路径解析的工作目录。 */
  cwd: string;
  /** LLM provider 配置（API key、base URL 等）。 */
  provider?: ProviderConfig;
  /** 由 provider 解析为具体模型名称的模型别名。 */
  modelAlias?: string;
  /** 所选模型的能力标志（图片输入、视频等）。 */
  modelCapabilities: ModelCapability;
  /** 控制工具选择、系统提示词和行为的命名 profile。 */
  profileName?: string;
  /** 初始 thinking effort 级别（如 "high"、"medium"、"off"）。 */
  thinkingLevel: string;
  /** 注入每轮对话的系统提示词。 */
  systemPrompt: string;
}

/** 可在运行时对活跃 agent 配置更新的字段。 */
export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

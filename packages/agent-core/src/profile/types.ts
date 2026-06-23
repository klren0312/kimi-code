import type { Environment } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { SkillRegistry } from '../agent/skill/types';

export const RawSubagentProfileSchema = z.object({
  description: z.string().optional(),
});

export type RawSubagentProfile = z.infer<typeof RawSubagentProfileSchema>;

export const RawAgentProfileSchema = z.object({
  extends: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPromptPath: z.string().optional(),
  systemPromptTemplate: z.string().optional(),
  promptVars: z.record(z.string(), z.string()).optional(),
  // 精确的内置/用户工具名称，加上可选的 MCP 通配符模式
  // （`mcp__*`、`mcp__github__*`）用于控制配置可见的 MCP 工具。
  tools: z.array(z.string()).optional(),
  whenToUse: z.string().optional(),
  subagents: z.record(z.string(), RawSubagentProfileSchema).optional(),
});

export type RawAgentProfile = z.infer<typeof RawAgentProfileSchema>;

/**
 * 供应给系统提示词渲染器的运行时上下文。
 *
 * 捕获在渲染时而非配置加载时确定的所有内容：
 * 操作系统/Shell、工作目录、AGENTS.md 指令、可用技能等。
 * 加载器返回渲染器；调用方在需要具体提示词时用实时上下文调用它们。
 */
export interface SystemPromptContext {
  readonly osEnv: Environment;
  readonly cwd: string;
  readonly now?: string | Date;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly skills?: SkillRegistry | string;
  readonly additionalDirsInfo?: string;
  readonly roleAdditional?: string;
}

export type SystemPromptRenderer = (context: SystemPromptContext) => string;

export interface ResolvedAgentProfile {
  name: string;
  description?: string;
  systemPrompt: SystemPromptRenderer;
  tools: string[];
  whenToUse?: string;
  subagents?: Record<string, ResolvedAgentProfile>;
}

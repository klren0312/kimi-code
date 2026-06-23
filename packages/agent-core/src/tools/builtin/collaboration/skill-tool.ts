/**
 * SkillTool — 调用已注册的技能。
 *
 * 协作工具，允许 LLM 主动调用内联注册的技能。内联技能通过
 * 所属代理记录其激活；在 v1 默认运行时中，非内联技能类型
 * 不允许模型调用。
 *
 * 防循环：`MAX_SKILL_QUERY_DEPTH` 限制 Skill→Skill 递归深度，
 * 防止技能重新调用自身（或链式调用另一个技能）时无限递归。
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { SkillActivationOrigin } from '../../../agent/context';
import { renderModelToolSkillPrompt } from '../../../agent/skill/prompt';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { isInlineSkillType, type SkillDefinition } from '../../../skill';
import { renderPrompt } from '../../../utils/render-prompt';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import skillDescriptionTemplate from './skill-tool.md?raw';

export const MAX_SKILL_QUERY_DEPTH = 3;

export class NestedSkillTooDeepError extends Error {
  readonly skillName?: string;
  readonly depth: number;

  constructor(depth: number, skillName?: string) {
    const label = skillName !== undefined ? ` "${skillName}"` : '';
    super(
      `Nested skill invocation${label} exceeded the maximum depth of ${String(depth)} — refusing to recurse further.`,
    );
    this.name = 'NestedSkillTooDeepError';
    this.depth = depth;
    if (skillName !== undefined) this.skillName = skillName;
  }
}

export interface SkillToolInput {
  skill: string;
  args?: string;
}

export const SkillToolInputSchema: z.ZodType<SkillToolInput> = z.object({
  skill: z.string(),
  args: z.string().optional(),
});

export interface SkillToolOptions {
  /**
   * 当前内联技能递归深度。
   */
  readonly queryDepth?: number;
  /**
   * `queryDepth` 的别名。保留以便旧调用方在不知道内部字段名的情况下
   * 设置内联递归深度。
   */
  readonly initialQueryDepth?: number;
}

export class SkillTool implements BuiltinTool<SkillToolInput> {
  readonly name = 'Skill';
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema);

  constructor(
    private readonly agent: Agent,
    private readonly options: SkillToolOptions = {},
  ) {}

  resolveExecution(args: SkillToolInput): ToolExecution {
    return {
      description: `Invoke skill ${args.skill}`,
      display: { kind: 'skill_call', skill_name: args.skill, args: args.args },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.skill),
      execute: () => this.execution(args),
    };
  }

  withInitialQueryDepth(initialQueryDepth: number): SkillTool {
    return new SkillTool(this.agent, {
      ...this.options,
      initialQueryDepth,
    });
  }

  private async execution(args: SkillToolInput): Promise<ExecutableToolResult> {
    // 递归硬上限。一旦 `currentDepth` 达到 MAX_SKILL_QUERY_DEPTH，
    // 再发起 Skill 调用会使子级深度变为 depth+1，违反不变量。
    // 抛出结构化错误（而非软工具错误）以便 Runtime 能区分
    // "LLM 错误分派" 和 "安全网触发"。
    const currentDepth = this.options.initialQueryDepth ?? this.options.queryDepth ?? 0;
    if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
      throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
    }

    const skills = this.agent.skills;
    if (skills === null) {
      return errorResult(`Skill "${args.skill}" not found in the current skill listing.`);
    }
    const skill = skills.registry.getSkill(args.skill);
    if (skill === undefined) {
      return errorResult(`Skill "${args.skill}" not found in the current skill listing.`);
    }
    if (skill.metadata.disableModelInvocation === true) {
      // 保持措辞 "can only be triggered by the user" 不变，以便
      // 合约审计和集成测试保持确定性。
      return errorResult(
        `Skill "${args.skill}" can only be triggered by the user (model invocation is disabled).`,
      );
    }

    const skillArgs = args.args ?? '';
    if (!isInlineSkillType(skill.metadata.type)) {
      return errorResult(
        `Skill "${skill.name}" is not an inline skill and cannot be invoked by the model in v1.`,
      );
    }

    const origin = skillOrigin(skill, skillArgs, currentDepth);
    const promptTrigger = origin.trigger === 'nested-skill' ? 'nested-skill' : 'model-tool';
    skills.recordActivation(origin);
    const skillContent = skills.registry.renderSkillPrompt(skill, skillArgs);
    this.agent.context.appendUserMessage(
      [
        {
          type: 'text' as const,
          text: renderModelToolSkillPrompt({
            skillName: skill.name,
            skillArgs,
            skillContent,
            skillSource: skill.source,
            skillDir: skill.dir,
            trigger: promptTrigger,
          }),
        },
      ],
      origin,
    );
    return {
      output: `Skill "${skill.name}" loaded inline. Follow its instructions.`,
    };
  }
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}

function skillOrigin(
  skill: SkillDefinition,
  skillArgs: string,
  currentDepth: number,
): SkillActivationOrigin {
  return {
    kind: 'skill_activation',
    activationId: randomUUID(),
    skillName: skill.name,
    skillArgs: skillArgs.length > 0 ? skillArgs : undefined,
    trigger: currentDepth > 0 ? 'nested-skill' : 'model-tool',
    skillType: skill.metadata.type,
    skillPath: skill.path,
    skillSource: skill.source,
  };
}

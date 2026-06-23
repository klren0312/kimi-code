/**
 * @module skill/prompt
 *
 * 将技能内容渲染为模型在对话中看到的 XML 包裹的 `<kimi-skill-loaded>` 块。
 * 不同的触发类型（用户斜杠命令、模型工具调用、嵌套技能）产生略微不同的
 * 前导文本，但共享相同的块结构。
 */

import { escapeXml } from '#/utils/xml-escape';
import type { SkillSource } from '../../skill';

/** 标识技能的触发方式——影响前导文本内容。 */
export type SkillPromptTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

/** 所有技能提示渲染器共享的输入参数。 */
export interface RenderSkillPromptInput {
  readonly skillName: string;
  readonly skillArgs: string;
  readonly skillContent: string;
  readonly skillSource?: SkillSource | undefined;
  /**
   * 包含技能 SKILL.md 及其捆绑资源（脚本、模板、数据文件）的绝对目录。
   * 在已加载块上展示，以便代理能够使用相对路径定位这些资源——
   * 如果没有此属性，包含辅助脚本的技能将无法使用，
   * 除非作者在正文中手动嵌入 `${KIMI_SKILL_DIR}`。
   */
  readonly skillDir?: string | undefined;
}

interface RenderSkillLoadedBlockInput extends RenderSkillPromptInput {
  readonly trigger: SkillPromptTrigger;
}

/**
 * 为用户发起的斜杠命令激活渲染技能提示。
 * 前置人类可读的前导文本，指示模型遵循已加载的技能指令。
 */
export function renderUserSlashSkillPrompt(input: RenderSkillPromptInput): string {
  return [
    `User activated the skill "${escapeXml(input.skillName)}". Follow the loaded skill instructions.`,
    '',
    renderSkillLoadedBlock({ ...input, trigger: 'user-slash' }),
  ].join('\n');
}

/** 模型工具和嵌套技能提示渲染的输入。 */
export interface RenderModelToolSkillPromptInput extends RenderSkillPromptInput {
  readonly trigger: Extract<SkillPromptTrigger, 'model-tool' | 'nested-skill'>;
}

/**
 * 为模型发起的工具调用或嵌套技能渲染技能提示。
 * 使用中性的前导文本（"Skill tool loaded instructions"）而非用户激活的文案。
 */
export function renderModelToolSkillPrompt(input: RenderModelToolSkillPromptInput): string {
  return [
    'Skill tool loaded instructions for this request. Follow them.',
    '',
    renderSkillLoadedBlock({ ...input, trigger: input.trigger }),
  ].join('\n');
}

/**
 * 渲染包含技能内容和元数据属性（name、trigger、source、dir、args）的
 * `<kimi-skill-loaded>` XML 块。这是用户斜杠命令和模型工具渲染器
 * 共享的构建块。
 */
export function renderSkillLoadedBlock(input: RenderSkillLoadedBlockInput): string {
  return [
    `<kimi-skill-loaded${renderSkillAttributes(input)}>`,
    input.skillContent,
    '</kimi-skill-loaded>',
  ].join('\n');
}

function renderSkillAttributes(input: RenderSkillLoadedBlockInput): string {
  const attrs: ReadonlyArray<readonly [string, string | undefined]> = [
    ['name', input.skillName],
    ['trigger', input.trigger],
    ['source', input.skillSource],
    ['dir', input.skillDir],
    ['args', input.skillArgs],
  ];

  return attrs
    .filter((item): item is readonly [string, string] => item[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
}

/**
 * @module skill/types
 *
 * {@link SkillManager} 使用的技能注册表抽象。
 * 将代理级别的管理器与具体的注册表实现解耦，
 * 以便测试和替代运行时可以提供自己的技能存储。
 */

import type { SkillDefinition } from '../../skill';

/**
 * {@link SkillManager} 使用的技能注册表的只读接口。
 *
 * 实现负责技能发现、存储和提示渲染的完整生命周期。
 * 代理只需要查找、列出和渲染——它从不直接修改注册表。
 */
export interface SkillRegistry {
  /** 按全局唯一名称查找技能。 */
  getSkill(name: string): SkillDefinition | undefined;
  /** 查找特定插件作用域内的技能。 */
  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
  /** 使用用户提供的参数渲染技能的提示模板。 */
  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string;
  /** 列出所有可调用的技能（非纯信息性的）。 */
  listInvocableSkills(): readonly SkillDefinition[];
  /** 返回技能资源存储的根目录。 */
  getSkillRoots(): readonly string[];
  /** 生成模型可读的可用技能列表。 */
  getModelSkillListing(): string;
}

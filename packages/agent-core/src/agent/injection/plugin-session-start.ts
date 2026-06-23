/**
 * 插件会话开始注入器。
 *
 * 将声明了会话开始钩子的插件的技能提示渲染为 `<plugin_session_start>` 块，
 * 在每个会话开始时追加一次。
 *
 * @module plugin-session-start
 */

import type { EnabledPluginSessionStart } from '../../plugin/types';
import type { SkillDefinition } from '../../skill';
import { escapeXmlAttr } from '../../utils/xml-escape';
import { DynamicInjector } from './injector';

/**
 * 向代理上下文注入插件会话开始的技能提示。
 *
 * 当插件声明了会话开始钩子时，此注入器解析关联的技能定义并将其提示内容
 * 渲染为 `<plugin_session_start>` 块。注入在每个会话中仅运行一次 —
 * 在生成新内容之前检查上下文是否已包含会话开始注入（如来自重放的历史），
 * 以防止在上下文恢复时产生重复注入。
 */
export class PluginSessionStartInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'plugin_session_start';

  /**
   * 生成所有已注册插件的组合会话开始注入。如果注入已应用（通过 `injectedAt`
   * 追踪）、没有插件拥有会话开始钩子、或技能注册表不可用，则返回 `undefined`。
   */
  protected override async getInjection(): Promise<string | undefined> {
    if (this.injectedAt !== null) return undefined;
    const replayedAt = this.agent.context.history.findIndex(
      (message) =>
        message.origin?.kind === 'injection' &&
        message.origin.variant === this.injectionVariant,
    );
    if (replayedAt >= 0) {
      this.injectedAt = replayedAt;
      return undefined;
    }
    const sessionStarts = this.agent.pluginSessionStarts ?? [];
    if (sessionStarts.length === 0) return undefined;
    const registry = this.agent.skills?.registry;
    if (registry === undefined) return undefined;
    const blocks: string[] = [];
    for (const sessionStart of sessionStarts) {
      const skill = registry.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
      if (skill === undefined) {
        this.agent.log.warn('plugin sessionStart skill not found', {
          pluginId: sessionStart.pluginId,
          skillName: sessionStart.skillName,
        });
        continue;
      }
      blocks.push(renderSessionStartBlock(sessionStart, skill, registry.renderSkillPrompt(skill, '')));
    }
    if (blocks.length === 0) return undefined;
    return blocks.join('\n');
  }
}

/**
 * 将单个插件会话开始块渲染为类 XML 元素，以插件 ID 和技能名称作为属性，
 * 包含渲染后的技能提示作为内容。
 */
function renderSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  skill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeXmlAttr(skill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}

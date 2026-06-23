/**
 * @module skill/index
 *
 * Agent 级别的技能生命周期管理器。负责用户触发的技能激活流程
 * （通过斜杠命令），并将每次激活记录为持久化记录和遥测事件。
 * 将提示词渲染委托给 {@link ./prompt}，技能查找委托给注入的
 * {@link SkillRegistry}。
 */

import { randomUUID } from 'node:crypto';

import type { ActivateSkillPayload } from '#/rpc';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '#/errors';
import { isUserActivatableSkillType } from '../../skill';
import type { SkillActivationOrigin } from '../context';
import { renderUserSlashSkillPrompt } from './prompt';
import type { SkillRegistry } from './types';

export type { SkillRegistry } from './types';

/**
 * 管理 Agent 的技能激活和记录。
 *
 * 该管理器桥接 RPC 层（斜杠命令载荷）和 Agent 的 turn/context 系统。
 * 它验证技能元数据、将技能提示词渲染到对话中，并发出遥测事件
 * 以便仪表盘按触发类型跟踪技能使用情况。
 */
export class SkillManager {
  constructor(
    protected readonly agent: Agent,
    public readonly registry: SkillRegistry,
  ) {}

  /**
   * 通过用户斜杠命令载荷激活技能。
   *
   * 验证技能存在且可被用户激活，将其提示词内容渲染到标准的
   * 技能加载块中，并记录激活。如果技能缺失或不可被用户激活，
   * 则抛出 {@link KimiError}。
   *
   * @param input - 包含技能名称和可选参数的 RPC 载荷。
   */
  activate(input: ActivateSkillPayload): void {
    const skill = this.registry.getSkill(input.name);
    if (skill === undefined) {
      throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new KimiError(ErrorCodes.SKILL_TYPE_UNSUPPORTED, `Skill "${skill.name}" cannot be activated by the user`);
    }

    const skillArgs = input.args ?? '';
    const skillContent = this.registry.renderSkillPrompt(skill, skillArgs);
    const wrapped = [
      {
        type: 'text' as const,
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
    ];

    this.recordActivation(
      {
        kind: 'skill_activation',
        activationId: randomUUID(),
        skillName: skill.name,
        trigger: 'user-slash',
        skillType: skill.metadata.type,
        skillPath: skill.path,
        skillSource: skill.source,
        skillArgs: input.args,
      },
      wrapped,
    );
  }

  /**
   * 记录技能激活：发出事件、跟踪遥测，并可选地将技能提示词注入当前 turn。
   *
   * 由 {@link activate} 用于用户斜杠触发，由技能工具用于模型发起的激活。
   * 当提供 `input` 时，内容将转发给 {@link Agent.turn.prompt}，
   * 使技能指令成为对话的一部分。
   *
   * @param origin - 描述谁触发了技能以及如何触发的元数据。
   * @param input - 可选的已渲染技能内容，用于注入 turn。
   */
  recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[] | undefined,
  ): void {
    this.agent.emitEvent({
      type: 'skill.activated',
      activationId: origin.activationId,
      skillName: origin.skillName,
      trigger: origin.trigger,
      skillArgs: origin.skillArgs,
      skillPath: origin.skillPath,
      skillSource: origin.skillSource,
    });
    this.agent.telemetry.track('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (origin.skillType === 'flow') {
      this.agent.telemetry.track('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
    if (input !== undefined) {
      this.agent.turn.prompt(input, origin);
    }
  }
}

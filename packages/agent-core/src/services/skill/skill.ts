/**
 * `ISkillService` — 面向守护进程的技能服务层。
 *
 * 封装 `ICoreProcessService.rpc.{listSkills, activateSkill}`，并将 agent-core
 * 的 `SkillSummary`（驼峰式）转换为线协议 `SkillDescriptor`（下划线式）。
 * 适配器辅助函数 `toProtocolSkill` 在此文件中同位定义。
 *
 * **使用的 CoreAPI 表面**：
 *   - `core.rpc.listSkills({sessionId}) => readonly SkillSummary[]`
 *     （packages/agent-core/src/rpc/core-api.ts:347, SessionAPI）。
 *   - `core.rpc.activateSkill({sessionId, agentId, name, args})`
 *     （第 324 行, AgentAPI）— 渲染技能 prompt 并以 `skill_activation` 来源
 *     （trigger 'user-slash'）启动一轮 turn，复现 TUI 的斜杠命令路径。
 *     它不经过 `IPromptService`，因此不会生成 `prompt_id`；客户端通过 WS 流
 *     上的 `skill.activated` + `turn.*` 事件观察进度。
 *
 * **会话作用域**：技能注册表是按会话的（项目技能从会话 cwd 发现），因此两个方法
 * 均为会话作用域，且实现会在分发前恢复会话——即使会话仅存在于磁盘而非守护进程
 * 重启后的活跃映射中，仍可正常解析。
 *
 * **错误模型**：
 *   - `SkillSessionNotFoundError` 不在此处定义——实现抛出共享的
 *     `SessionNotFoundError`（→ 40401）。
 *   - 当 agent-core 报告 `skill.not_found` 时抛出 `SkillNotFoundError`（→ 40415）。
 *   - 当 agent-core 报告 `skill.type_unsupported`（如 `reference` 类型技能）时
 *     抛出 `SkillNotActivatableError`（→ 40912）。
 *
 * **防腐层**：仅从 `@moonshot-ai/agent-core` 导入 `createDecorator` 值和
 * `SkillSummary` 类型。
 */

import { createDecorator } from '../../di';
import type { SkillSummary as AgentCoreSkillSummary } from '../../rpc';
import type { SkillDescriptor } from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// 适配器辅助函数
// ---------------------------------------------------------------------------

export function toProtocolSkill(info: AgentCoreSkillSummary): SkillDescriptor {
  const base: SkillDescriptor = {
    name: info.name,
    description: info.description,
    path: info.path,
    source: info.source,
  };
  return {
    ...base,
    ...(info.type !== undefined ? { type: info.type } : {}),
    ...(info.disableModelInvocation !== undefined
      ? { disable_model_invocation: info.disableModelInvocation }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 接口 + 错误类型
// ---------------------------------------------------------------------------

export interface ISkillService {
  readonly _serviceBrand: undefined;

  /**
   * 返回会话可用的技能列表（项目 + 用户 + 额外 + 内置）。
   * 对未知会话抛出 `SessionNotFoundError`（→ 40401）。
   */
  list(sessionId: string): Promise<readonly SkillDescriptor[]>;

  /**
   * 在会话中按名称激活技能——等同于 REST 层面输入 `/<skill> <args>`。
   * 在会话的主 agent 上启动一轮 turn。抛出
   * `SessionNotFoundError`（→ 40401）、`SkillNotFoundError`（→ 40415）
   * 或 `SkillNotActivatableError`（→ 40912）。
   */
  activate(sessionId: string, skillName: string, args?: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISkillService = createDecorator<ISkillService>('skillService');

/**
 * 哨兵错误——守护进程的路由层会捕获此错误并映射为信封 `code:
 * 40415 skill.not_found`。其他抛出的错误会传递到 `installErrorHandler`（→ 50001）。
 */
export class SkillNotFoundError extends Error {
  readonly skillName: string;
  constructor(skillName: string, message?: string) {
    super(message ?? `skill ${skillName} does not exist`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

/**
 * 哨兵错误——映射为信封 `code: 40912 skill.not_activatable`。当技能存在
 * 但其类型不支持用户激活时抛出（如 `reference` 类型）。
 */
export class SkillNotActivatableError extends Error {
  readonly skillName: string;
  constructor(skillName: string, message?: string) {
    super(message ?? `skill ${skillName} cannot be activated`);
    this.name = 'SkillNotActivatableError';
    this.skillName = skillName;
  }
}

void ISkillService;

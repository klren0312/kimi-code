/**
 * `SkillService` — implementation of `ISkillService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { ErrorCodes, KimiError } from '../../errors';
import type { SkillDescriptor } from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { SessionNotFoundError } from '../session/session';
import {
  ISkillService,
  SkillNotActivatableError,
  SkillNotFoundError,
  toProtocolSkill,
} from './skill';

/** 与其他服务保持一致（prompt-service 使用 'main'）。 */
const MAIN_AGENT_ID = 'main';

export class SkillService extends Disposable implements ISkillService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sessionId: string): Promise<readonly SkillDescriptor[]> {
    await this._requireLoadedSession(sessionId);
    const raw = await this.core.rpc.listSkills({ sessionId });
    return raw.map(toProtocolSkill);
  }

  async activate(sessionId: string, skillName: string, args?: string): Promise<void> {
    await this._requireLoadedSession(sessionId);
    try {
      await this.core.rpc.activateSkill({
        sessionId,
        agentId: MAIN_AGENT_ID,
        name: skillName,
        args,
      });
    } catch (error) {
      if (error instanceof KimiError) {
        if (error.code === ErrorCodes.SKILL_NOT_FOUND || error.code === ErrorCodes.SKILL_NAME_EMPTY) {
          throw new SkillNotFoundError(skillName, error.message);
        }
        if (error.code === ErrorCodes.SKILL_TYPE_UNSUPPORTED) {
          throw new SkillNotActivatableError(skillName, error.message);
        }
      }
      throw error;
    }
  }

  /**
   * 验证 session 存在，并确保已加载到活跃 session 映射中（已加载时幂等），
   * 以避免 daemon 重启后 SessionAPI 分发失败。与 `PromptService.submit` /
   * `SessionService.undo` 模式相同。
   */
  private async _requireLoadedSession(sessionId: string): Promise<void> {
    const all = await this.core.rpc.listSessions({});
    if (!all.some((s) => s.id === sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
    await this.core.rpc.resumeSession({ sessionId });
  }
}

// 在全局单例注册表中自注册。所有构造函数依赖通过 `@I…` 注入；`staticArguments = []`。
// `supportsDelayedInstantiation = false` 保留当前反向释放语义。
registerSingleton(ISkillService, SkillService, InstantiationType.Delayed);

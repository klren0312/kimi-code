/**
 * `ToolService` — `IToolService` 的实现。
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IToolService, toProtocolTool, type AgentCoreToolInfoLike } from './tool';

/** 与其他服务保持一致（message-service 使用 'main'）。 */
const MAIN_AGENT_ID = 'main';

export class ToolService extends Disposable implements IToolService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sessionId?: string): Promise<readonly import('@moonshot-ai/protocol').ToolDescriptor[]> {
    const resolvedSid = sessionId ?? (await this._anyKnownSessionId());
    if (resolvedSid === undefined) return [];
    let raw: readonly unknown[];
    try {
      raw = await this.core.rpc.getTools({
        sessionId: resolvedSid,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session 未加载到活跃 session 映射中；返回空列表而非抛出 500 错误 —
      // 全局列表查询的语义为"尽力而为"。
      return [];
    }
    return raw.map((t) => toProtocolTool(t as AgentCoreToolInfoLike));
  }

  /**
   * 在调用方未提供 session id 时查找可用的 session id。返回最近创建的
   * session id，若无 session 则返回 `undefined`。
   */
  private async _anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.core.rpc.listSessions({});
    if (all.length === 0) return undefined;
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }
}

// 在全局单例注册表中自注册。所有构造函数依赖通过 `@I…` 注入；`staticArguments = []`。
// `supportsDelayedInstantiation = false` 保留当前反向释放语义。
registerSingleton(IToolService, ToolService, InstantiationType.Delayed);

/**
 * `McpService` — `IMcpService` 的实现。
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { McpServer } from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import {
  IMcpService,
  McpServerNotFoundError,
  toProtocolMcpServer,
} from './mcp';

export class McpService extends Disposable implements IMcpService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(): Promise<readonly McpServer[]> {
    // `listMcpServers` 位于 SessionAPI 接口上；需要 session id 进行分发。
    // 选择最近创建的 session。若无 session，返回空列表（MCP 注册器可能已启动
    // 但 RPC 管道在 session 打开前不可达）。
    const sessionId = await this._anyKnownSessionId();
    if (sessionId === undefined) return [];
    const raw = await this.core.rpc.listMcpServers({ sessionId });
    return raw.map(toProtocolMcpServer);
  }

  async restart(serverId: string): Promise<{ restarting: true }> {
    const sessionId = await this._anyKnownSessionId();
    if (sessionId === undefined) {
      // 无 session => 无法到达 MCP 注册器 => 服务端不可达。
      throw new McpServerNotFoundError(serverId);
    }
    // 存在性检查：线路 id 是 agent-core 的 `name`。重连调用会对未知 name
    // reject；预先检查以使路由能发出确定性的 40408 信封，而不依赖
    // agent-core 错误消息的形状。
    const known = await this.core.rpc.listMcpServers({ sessionId });
    if (!known.some((s) => s.name === serverId)) {
      throw new McpServerNotFoundError(serverId);
    }
    await this.core.rpc.reconnectMcpServer({ sessionId, name: serverId });
    return { restarting: true };
  }

  /**
   * 查找可用于分发 SessionAPI 调用的 session id。返回最近创建的 session id，
   * 无 session 时返回 `undefined`。
   */
  private async _anyKnownSessionId(): Promise<string | undefined> {
    const all = await this.core.rpc.listSessions({});
    if (all.length === 0) return undefined;
    // 按 createdAt 降序排序 — 最新的 session 最可能有活跃的 MCP RPC 绑定。
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    return sorted[0]?.id;
  }
}

// 在全局单例注册表中自注册。所有构造函数依赖通过 `@I…` 注入；
// `staticArguments = []`。`supportsDelayedInstantiation = false`
// 保留当前反向释放语义。

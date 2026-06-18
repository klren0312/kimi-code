/**
 * `EventService` — `IEventService` 的实现。
 *
 * 纯进程内 pub-sub：`Emitter<Event>` 的薄封装。无 sessionId 提取、
 * 无 session 级序列号、无环形缓冲区、无 WS 扇出 — 这些 daemon 传输层关注点
 * 位于 `@moonshot-ai/server/services/WSBroadcastService`，后者通过 `onDidPublish`
 * 订阅此总线并处理广播/回放机制。
 *
 * 监听器异常在 `Emitter.fire()` 内部路由至 `onUnexpectedError`
 *（遵循 agent-core 的 `Emitter` 约定）。不会包装单个处理器。
 *
 * `dispose()` 后再 publish 是空操作。
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';

import { IEventService } from './event';

export class EventService extends Disposable implements IEventService {
  readonly _serviceBrand: undefined;

  /**
   * VSCode 风格的 Emitter。通过 `_register` 拥有，随服务销毁时释放。
   * 监听器异常在 `Emitter.fire()` 内部路由至 `onUnexpectedError`。
   */
  private readonly _onDidPublish = this._register(new Emitter<ProtocolEvent>());
  readonly onDidPublish = this._onDidPublish.event;

  publish(event: ProtocolEvent): void {
    if (this._store.isDisposed) return;
    this._onDidPublish.fire(event);
  }
}

// 在全局单例注册表中自注册。无构造函数参数 — 该服务无依赖。
registerSingleton(IEventService, EventService, InstantiationType.Delayed);

/**
 * `IEventService` — 进程内 pub-sub 总线，将 `KimiCore` 产出的 `Event`
 *（以及 daemon 侧服务发出的合成事件）扇出至所有进程内订阅者。
 * 与传输层无关：此接口不知道 WS 扇出、环形缓冲区、序列号或回放 —
 * 这些是 daemon 传输层的关注点，由 `@moonshot-ai/server` 中的
 * `IWSBroadcastService` 处理。
 *
 * 此服务位于进程内 RPC 适配器的接收端：当 agent 步骤发出事件时，
 * `CoreProcessService` 的 `BridgeClientAPI.emitEvent` 将其转发至
 * `IEventService.publish(event)`。其他进程内生产者
 *（`PromptService` 合成生命周期事件、`ApprovalService` /
 * `QuestionService` broker 事件）直接调用 `publish`。
 *
 * 实现（`./eventService.ts` 中的 `EventService`）是 `Emitter<Event>` 的
 * 薄封装 — 无 session 级账务、无传输层。daemon 侧的 `WSBroadcastService`
 * 订阅 `onDidPublish` 来完成传输工作。
 *
 * 装饰器名称 `'eventService'` 是 `CyclicDependencyError.path` 和
 * `'No service registered for identifier ...'` 消息中出现的诊断字符串。
 *
 * 角色：pub-sub 总线 — 参见 `packages/services/AGENTS.md`。每个领域的
 * 类型化 `onDidXxx: Event<T>` 访问器在此中心流之上分层（例如
 * `PromptService.onDidComplete`、`SessionService.onDidCreate`）。
 */

import { createDecorator } from '../../di';
import type { Event } from '../../base/common/event';
import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';

/**
 * 本文件中的命名约定：
 *
 * - `Event`（来自 `@moonshot-ai/agent-core/base/common/event`）— 通用的
 *   VSCode 风格 emitter 访问器类型。`Event<T>` 是用于声明
 *   `readonly onDidXxx: Event<T>` 的监听器元组类型。
 * - `ProtocolEvent`（`@moonshot-ai/protocol` 的 `Event` 的别名）— 通过总线
 *   发布的线路级事件联合类型。此处使用别名是因为顶层 `Event` 符号必须
 *   指向 emitter 类型，以使访问器声明读起来自然（`Event<ProtocolEvent>` 而非
 *   `import('…/base/common/event').Event<Event>`）。
 */
export interface IEventService {
  readonly _serviceBrand: undefined;

  /**
   * VSCode 风格访问器 — 使用监听器订阅；返回一个 `IDisposable`，
   * 调用其 `dispose()` 可取消订阅。处理器在 `publish(event)` 内部同步触发。
   *
   * 调用方通过 `Disposable._register(svc.onDidPublish(handler))` 保存返回的
   * `IDisposable`，使订阅随拥有者一起销毁。
   */
  readonly onDidPublish: Event<ProtocolEvent>;

  /**
   * 向所有订阅者发布一个完整的 `Event`。同步操作；适配器不会等待传递完成。
   */
  publish(event: ProtocolEvent): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventService = createDecorator<IEventService>('eventService');

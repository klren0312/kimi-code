/**
 * 注入管理器 — 编排代理的所有动态上下文注入器。
 *
 * @module manager
 */

import type { Agent } from '..';
import { GoalInjector } from './goal';
import type { DynamicInjector } from './injector';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { TodoListReminderInjector } from './todo-list';

/**
 * 编排代理的所有动态上下文注入器。
 *
 * 每个注入器按照特定节奏（每个模型步骤、续行边界或每会话一次）向对话上下文
 * 追加系统提醒。管理器拥有两个节奏组：
 *
 * - **逐步注入器**（`this.injectors`）— 在每次 `inject()` 调用时运行，
 *   位于模型步骤之前。当前包括：插件会话开始、待办列表提醒、计划模式提醒
 *   和权限模式提醒。
 * - **边界目标注入器**（`this.goalInjector`）— 仅在续行边界（轮次开始、
 *   每次续行、压缩后）通过 `injectGoal()` 运行。边界节奏可避免 O(n²) 的
 *   上下文增长并保留提示缓存前缀。仅为主代理实例化。
 *
 * 生命周期钩子（`onContextClear`、`onContextCompacted`、
 * `onContextMessageRemoved`）广播到所有活跃的注入器，使其在上下文
 * 发生变化时调整内部簿记。
 */
export class InjectionManager {
  private readonly injectors: DynamicInjector[];
  // 目标上下文在续行边界（Turn 开始、每次续行、压缩后）通过 `injectGoal()` 注入，
  // 而非在逐步 `inject()` 循环中。边界节奏的追加式注入在尾部附近保留一份新鲜副本
  // 而不修改前缀，因此提示缓存得以保留且上下文不会像逐步注入那样 O(n^2) 增长。
  private readonly goalInjector: GoalInjector | null;

  /**
   * 创建注入管理器并为给定代理连接所有注入器。目标注入器仅为主代理创建，
   * 因为子代理不参与目标驱动的续行循环。
   *
   * @param agent - 接收注入的代理实例。
   */
  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginSessionStartInjector(agent),
      new TodoListReminderInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
    ];
    this.goalInjector = agent.type === 'main' ? new GoalInjector(agent) : null;
  }

  /**
   * 运行所有逐步注入器。在每个模型步骤之前调用，将待处理的系统提醒
   * （如计划模式、权限模式、待办列表提醒）追加到对话上下文中。
   */
  async inject(): Promise<void> {
    for (const injector of this.injectors) {
      await injector.inject();
    }
  }

  /**
   * 在续行边界追加新的目标上下文提醒。仅追加（不修改前缀），因此提示缓存
   * 得以保留；当目标模式关闭、非主代理或无内容可注入时为空操作。
   */
  async injectGoal(): Promise<void> {
    await this.activeGoalInjector()?.inject();
  }

  /**
   * 通知所有注入器对话上下文已被清除。注入器重置内部位置追踪器，
   * 使下一次注入被视为全新插入。
   */
  onContextClear(): void {
    for (const injector of this.lifecycleInjectors()) {
      injector.onContextClear();
    }
  }

  /**
   * 通知所有注入器压缩操作从上下文头部移除了 `compactedCount` 条消息。
   * 注入器调整其存储的消息索引以继续追踪正确的位置。
   *
   * @param compactedCount - 压缩移除的消息数量。
   */
  onContextCompacted(compactedCount: number): void {
    for (const injector of this.lifecycleInjectors()) {
      try {
        injector.onContextCompacted(compactedCount);
      } catch {
        continue;
      }
    }
  }

  /**
   * 通知所有注入器在 `index` 处移除了一条消息。注入器将存储的位置减一
   * （如果位于被移除消息之后），或使其失效（如果指向被移除消息本身）。
   *
   * @param index - 被移除消息在历史数组中的索引。
   */
  onContextMessageRemoved(index: number): void {
    for (const injector of this.lifecycleInjectors()) {
      injector.onContextMessageRemoved(index);
    }
  }

  /** 逐步注入器加上边界目标注入器，用于生命周期事件。 */
  private lifecycleInjectors(): DynamicInjector[] {
    const goalInjector = this.activeGoalInjector();
    return goalInjector === null ? this.injectors : [goalInjector, ...this.injectors];
  }

  private activeGoalInjector(): GoalInjector | null {
    return this.goalInjector;
  }
}

/**
 * @module swarm/index
 *
 * Swarm 模式管理。Swarm 模式允许 Agent 并行委派工作给多个子 Agent。
 * 可以通过手动方式（持久化切换）、一次性任务提示或 AgentSwarm 工具进入。
 * 该模式注入/移除系统提醒，以便模型理解 swarm 上下文。
 */

import type { Agent } from '..';

import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';

/**
 * Swarm 模式的激活方式：
 * - `manual`：通过 `/swarm on` 持久化切换。
 * - `task`：一次性 `/swarm` 提示（完成后自动退出）。
 * - `tool`：AgentSwarm 工具调用（完成后自动退出）。
 */
export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

/**
 * 管理 Agent 的 Swarm 模式生命周期。Swarm 模式是一个布尔开关，
 * 带有关联的触发器，控制模式是否在 turn 完成后自动退出
 * （`task` 和 `tool` 会自动退出，`manual` 不会）。
 */
export class SwarmMode {
  protected active: SwarmModeTrigger | null = null;

  constructor(protected readonly agent: Agent) {}

  /**
   * 进入 Swarm 模式。如果已激活则为空操作。记录进入事件并注入系统提醒
   * （由工具触发时除外，该场景会自行管理上下文）。
   */
  enter(trigger: SwarmModeTrigger): void {
    if (this.active !== null) return;
    this.agent.records.logRecord({ type: 'swarm_mode.enter', trigger });
    this.active = trigger;
    if (trigger !== 'tool') {
      this.agent.context.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode',
      });
    }
    this.agent.emitStatusUpdated();
  }

  /** 从回放的记录恢复 Swarm 模式状态（无副作用）。 */
  restoreEnter(trigger: SwarmModeTrigger): void {
    this.active = trigger;
  }

  /**
   * 退出 Swarm 模式。如果未激活则为空操作。从上下文中移除进入提醒，
   * 并可选地注入退出提醒，以便模型知道 Swarm 模式已结束。
   */
  exit(): void {
    if (this.active === null) return;
    this.agent.records.logRecord({ type: 'swarm_mode.exit' });
    const trigger = this.active;
    this.active = null;
    this.agent.emitStatusUpdated();
    if (trigger === 'tool') return;
    if (this.agent.context.popMatchedMessage((origin) => origin?.kind === 'injection' && origin.variant === 'swarm_mode')) {
      return;
    }
    if (!this.agent.records.restoring) {
      this.agent.context.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode_exit',
      });
    }
  }

  /** Swarm 模式是否当前处于激活状态。 */
  get isActive(): boolean {
    return this.active !== null;
  }

  /** 当前触发器是否应在 turn 完成后自动退出。 */
  get shouldAutoExit(): boolean {
    return this.active === 'task' || this.active === 'tool';
  }
}

/**
 * 权限模式转换注入器。
 *
 * 当代理的权限模式转入或转出 `auto` 时发出系统提醒，
 * 使模型知道是跳过审批提示还是恢复正常权限检查。
 *
 * @module permission-mode
 */

import type { PermissionMode } from '../permission';
import { DynamicInjector } from './injector';

/** 进入自动权限模式时注入的提醒。 */
const AUTO_MODE_ENTER_REMINDER = [
  'Auto permission mode is active. Tool approvals will be handled automatically while this mode remains enabled.',
  '  - Continue normally without pausing for approval prompts.',
  '  - Do NOT call AskUserQuestion while auto mode is active. Make a reasonable decision and continue without asking the user.',
].join('\n');

/** 退出自动权限模式时注入的提醒。 */
const AUTO_MODE_EXIT_REMINDER = [
  'Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode.',
  '  - Continue normally, but expect approval prompts or denials when a tool requires them.',
].join('\n');

/**
 * 向代理上下文注入权限模式转换提醒。
 *
 * 注入器监视代理权限模式的变化，当模式转入或转出 `auto` 时发出系统提醒。
 * 在自动模式下，模型被告知跳过审批提示并自主做出合理决策；退出时被告知
 * 恢复正常权限检查。
 *
 * 非自动模式之间的转换不发出提醒，因为模型不需要对这些变化的行为指导
 * — 权限系统会透明地处理执行。
 */
export class PermissionModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'permission_mode';

  /** 上次 `getInjection` 调用时观察到的权限模式。 */
  private lastMode: PermissionMode | undefined;

  /**
   * 如果自上次调用以来权限模式发生了变化，返回转换提醒；
   * 如果未变化则返回 `undefined`。仅涉及 `auto` 模式的转换才会产生提醒。
   */
  getInjection(): string | undefined {
    const mode = this.agent.permission.mode;
    const previousMode = this.lastMode;

    if (mode === previousMode) return undefined;

    this.lastMode = mode;
    if (mode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  }
}

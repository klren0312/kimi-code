/**
 * @module plan/index
 *
 * 代理的计划模式管理。计划模式允许代理在执行工作前
 * 制定结构化计划（存储为 Markdown 文件）。该模式具有清晰的进入/退出生命周期，
 * 支持可选的文件持久化，使计划能够在多轮对话间保留，
 * 并可供用户或 TUI 检查。
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import type { Agent } from '..';
import { generateHeroSlug } from '../../utils/hero-slug';

/** 由 {@link PlanMode.data} 返回的持久化计划数据。 */
export type PlanData = null | {
  /** 计划会话的唯一标识符。 */
  id: string;
  /** 计划文件的 Markdown 内容（文件不存在时为空字符串）。 */
  content: string;
  /** 计划 Markdown 文件在磁盘上的绝对路径。 */
  path: string;
};
/** 当前计划文件的绝对路径，无活跃计划时为 `null`。 */
export type PlanFilePath = string | null;

/**
 * 管理代理的计划模式：进入、退出、取消和读取计划数据。
 * 计划模式是有状态的开关——同时只能有一个计划处于活跃状态。
 * 计划以 Markdown 文件形式持久化在代理的主目录下（临时代理则在 cwd 下）。
 *
 * 生命周期：
 * - {@link enter} 激活计划模式并可选地创建文件。
 * - {@link exit} / {@link cancel} 停用并发出状态更新事件。
 * - {@link data} 读取当前计划内容供 TUI 或工具使用。
 * - {@link restoreEnter} 在恢复期间从记录中重放计划状态。
 */
export class PlanMode {
  protected _isActive = false;
  protected _planId: null | string = null;
  protected _planFilePath: PlanFilePath = null;

  constructor(protected readonly agent: Agent) {}

  /** 从随机 UUID 生成人类可读的计划 ID。 */
  createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  /**
   * 进入计划模式。如果已在计划模式中则抛出错误。
   *
   * @param id - 计划标识符；默认为随机生成的 slug。
   * @param createFile - 为 `true` 时，立即向磁盘写入空计划文件。
   * @param emitStatus - 为 `true`（默认）时，向 TUI 发出状态更新事件。
   */
  async enter(id = this.createPlanId(), createFile = false, emitStatus = true): Promise<void> {
    if (this._isActive) {
      throw new Error('Already in plan mode');
    }

    this._isActive = true;
    this._planId = id;
    this._planFilePath = null;

    let enterRecorded = false;
    try {
      const planFilePath = this.planFilePathFor(id);
      this._planFilePath = planFilePath;
      await this.ensurePlanDirectory(planFilePath);
      this.agent.records.logRecord({ type: 'plan_mode.enter', id });
      enterRecorded = true;
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
      }
    } catch (error) {
      if (enterRecorded) {
        this.cancel(id);
      } else {
        this._isActive = false;
        this._planId = null;
        this._planFilePath = null;
      }
      throw error;
    }

    if (emitStatus) this.agent.emitStatusUpdated();
  }

  /**
   * 在代理恢复期间从重放记录中恢复计划模式状态。
   * 不创建文件也不发出状态事件——由重放系统处理。
   */
  restoreEnter({ id }: { readonly id: string }): void {
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: true,
    });

    this._isActive = true;
    this._planId = id;
    this._planFilePath = this.planFilePathFor(id);
  }

  /**
   * 取消计划模式而不进行正常退出——用于用户中止时。
   * 记录取消事件并发出状态更新。
   */
  cancel(id?: string): void {
    this.agent.records.logRecord({ type: 'plan_mode.cancel', id });
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.agent.emitStatusUpdated();
  }

  /** 清空计划文件内容（写入空文件）而不退出计划模式。 */
  async clear(): Promise<void> {
    if (!this._planFilePath) return;
    await this.writeEmptyPlanFile(this._planFilePath);
  }

  /**
   * 正常退出计划模式。记录退出事件，发出状态更新，
   * 并重置内部状态。
   */
  exit(id?: string): void {
    this.agent.records.logRecord({ type: 'plan_mode.exit', id });
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.agent.emitStatusUpdated();
  }

  /** 计划模式是否当前处于活跃状态。 */
  get isActive() {
    return this._isActive;
  }

  /** 当前计划文件的绝对路径，未激活时为 `null`。 */
  get planFilePath(): PlanFilePath {
    return this._planFilePath;
  }

  /**
   * 从磁盘读取当前计划数据。计划模式未激活时返回 `null`。
   * 如果计划文件尚不存在，返回空内容。
   */
  async data(): Promise<PlanData> {
    if (!this._planId || !this._planFilePath) return null;
    let content = '';
    try {
      content = await this.agent.kaos.readText(this._planFilePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: this._planId,
      content,
      path: this._planFilePath,
    };
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.agent.kaos.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.agent.kaos.mkdir(dirname(path), {
      parents: true,
      existOk: true,
    });
  }

  private planFilePathFor(id: string): string {
    const plansDir =
      this.agent.homedir === undefined
        ? join(this.agent.config.cwd, 'plan')
        : join(this.agent.homedir, 'plans');
    return join(plansDir, `${id}.md`);
  }
}

/** 检查错误是否表示文件缺失（ENOENT）。 */
function isMissingFileError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

/**
 * CronManager — 面向 Agent 的定时调度器门面。
 *
 * 本层位于原始 `CronScheduler`（不了解 Agent）和 Agent 运行时
 * （Agent / 轮次 / 遥测 / 工具层）之间。职责虽小但重要：
 *
 *   - 拥有本会话的 `SessionCronStore`；
 *   - 向调度器提供 `() => store.list()`，使新增/删除在每次 tick 时自动生效；
 *   - 基于 `agent.turn.hasActiveTurn` 门控触发，而非维护重复的空闲标志——
 *     轮次机制已经掌握此信息；
 *   - 将触发的 `CronTask` 转换为携带 `CronJobOrigin` 的 `steer(...)` 调用，
 *     以及 `cron_fired` 遥测事件；
 *   - 通过 {@link addTask} / {@link removeTasks} 将每次存储变更镜像到
 *     `<sessionDir>/cron/<id>.json`，以便 `kimi resume` 能调用
 *     {@link loadFromDisk} 重新水合先前调度的任务。当未提供 `sessionDir`
 *     （子 Agent、测试、临时会话）时，管理器完全以内存模式运行。
 *   - 提供 `handleMissed(...)` 入口，供未来启动时遗漏任务通知调用。
 *     当前调度器的 `coalescedCount` 语义已内联处理遗漏触发，
 *     因此框架未接入此入口——保持暴露状态以便后续添加通知横幅时
 *     无需变更 API。
 *
 * 管理器不直接读取 `Date.now()`；所有挂钟读取均通过
 * `this.clocks.wallNow()`。`no-date-now.test.ts` 守卫未列出此文件
 * （它覆盖调度器/抖动层），但相同的纪律是有意为之，以便
 * 基准测试/测试的时钟注入能端到端生效。
 *
 * 关于 `recurring` 语义：规范的任务表示使用
 * `recurring: boolean | undefined`，其中 `undefined` 表示循环
 * （定时任务默认为重复）。一次性任务通过显式的 `recurring === false` 选择退出。
 * 本文件中的每次检查均使用 `task.recurring !== false`，即使调用方
 * 省略该字段也能保持默认行为。
 */
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../index';
import type { CronJobOrigin, CronMissedOrigin } from '../context/types';
import {
  resolveClockSources,
  SYSTEM_CLOCKS,
  type ClockSources,
} from '../../tools/cron/clock';
import { renderCronFireXml } from '../../tools/cron/cron-fire-xml';
import { createCronPersistStore } from '../../tools/cron/persist';
import { SessionCronStore } from '../../tools/cron/session-store';
import {
  createCronScheduler,
  type CronScheduler,
} from '../../tools/cron/scheduler';
import {
  CRON_DELETED,
  CRON_FIRED,
  CRON_MISSED,
  CRON_SCHEDULED,
} from '../../tools/cron/telemetry-events';
import type { CronTask } from '../../tools/cron/types';
import type { PerIdJsonStore } from '../../utils/per-id-json-store';

import type { SessionCronTaskInit } from '../../tools/cron/session-store';

/**
 * 循环任务被标记为 `stale: true` 的阈值（应用于触发 `origin`）。
 * 一次性任务从不携带过期标志——它们按设计只触发一次，
 * "最多触发一次"。通过 `KIMI_CRON_NO_STALE=1` 禁用（基准/验收测试）。
 *
 * 七天对应我们希望 LLM 注意到的"此任务已被遗忘"的挂钟窗口；
 * 该数值也与面向用户的调度说明中记录的自动过期周期一致。
 */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface CronManagerOptions {
  /**
   * 测试/基准覆盖。默认为
   * `resolveClockSources(process.env.KIMI_CRON_CLOCK)`，生产环境
   * 自动获取 `KIMI_CRON_CLOCK=file:...`。
   * 未设置时回退到 {@link SYSTEM_CLOCKS}。
   */
  readonly clocks?: ClockSources;

  /**
   * 覆盖调度器轮询间隔。默认值由调度器处理
   * （1000ms，除非 `KIMI_CRON_MANUAL_TICK=1`，此时强制为 `null`
   * 使自动 tick 的 `setInterval` 不会被安装）。`null` 或 `0`
   * 表示"无自动定时器——调用方手动驱动 `tick()`"。
   */
  readonly pollIntervalMs?: number | null;
}

export class CronManager {
  /** 内存任务存储。构造时为空；由 {@link addTask}
   * （以及恢复时的 {@link loadFromDisk}）填充。 */
  readonly store: SessionCronStore;

  /**
   * 用于过期判断的时钟源。同时传递给调度器，
   * 使整个技术栈共享同一"当前时间"概念。
   */
  readonly clocks: ClockSources;

  private readonly scheduler: CronScheduler;
  private readonly agent: Agent;
  /**
   * 跟踪是否已调用 `start()` 但尚未匹配 `stop()`。
   * 用于保持 `start()` / `stop()` 的幂等性，以及——
   * 对 P1.8 更重要的——门控 SIGUSR1 绑定，防止在重复 start() 调用时
   * 累积处理器。
   */
  private started = false;
  /**
   * 管理器运行期间已绑定的 SIGUSR1 监听器引用。
   * 保留此引用以便 `stop()` 能用相同的函数引用调用
   * `process.off('SIGUSR1', handler)`，避免在 vitest 文件之间
   * 泄漏处理器。当管理器未启动或运行在不支持 SIGUSR1 的平台
   * （Windows）上时为 `null`。
   */
  private sigusr1Handler: NodeJS.SignalsListener | null = null;

  /**
   * {@link store} 的文件镜像。当未提供 `sessionDir` 时为 `undefined`
   * ——此时管理器以纯内存模式运行，与持久化之前的语义一致。
   * 当定义时，`addTask` / `removeTasks` 调度即发即忘写入，
   * 以便后续 `kimi resume` 能通过 {@link loadFromDisk} 重新加载。
   */
  private readonly persistStore: PerIdJsonStore<CronTask> | undefined;

  /**
   * 按 ID 的持久化写入序列化器。防止同一 ID 上快速的
   * `add` → `remove` 序列在重命名时产生竞争——
   * 删除必须等待先前写入的重命名文件完成。
   * 突发之间为空；条目在其尾部 promise 解决后删除，
   * 使 Map 不会因频繁变更而无限增长。
   */
  private readonly persistQueues: Map<string, Promise<void>> = new Map();

  constructor(agent: Agent, opts: CronManagerOptions = {}) {
    this.agent = agent;
    this.store = new SessionCronStore();
    this.clocks =
      opts.clocks ??
      resolveClockSources(process.env['KIMI_CRON_CLOCK']) ??
      SYSTEM_CLOCKS;
    this.persistStore =
      agent.homedir === undefined
        ? undefined
        : createCronPersistStore(agent.homedir);

    this.scheduler = createCronScheduler({
      clocks: this.clocks,
      source: () => this.store.list(),
      isIdle: () => !agent.turn.hasActiveTurn,
      isKilled: () => process.env['KIMI_DISABLE_CRON'] === '1',
      onFire: (task, ctx) => {
        this.handleFire(task, ctx);
      },
      removeOneShot: (id) => {
        this.removeTasks([id]);
      },
      onAdvanceCursor: (id, lastFiredAt) => {
        this.advanceCursor(id, lastFiredAt);
      },
      // P1.8: `KIMI_CRON_MANUAL_TICK=1` 强制调度器进入手动驱动模式
      // （无 setInterval），以便基准/时间注入测试能推进时间并显式调用
      // `tick()`，而不会与 1 秒自动 tick 产生竞争。显式调用方覆盖
      // （`opts.pollIntervalMs`）优先级低于环境变量，以便基准测试
      // 能从外部切换开关而无需重建管理器接线。
      pollIntervalMs:
        process.env['KIMI_CRON_MANUAL_TICK'] === '1'
          ? null
          : opts.pollIntervalMs,
    });

    this.start();
  }

  /**
   * 向内存存储添加新任务，当已挂载持久化时，将新记录镜像到
   * `<sessionDir>/cron/<id>.json`。
   *
   * 存储调用是同步的（CronCreate 需要 ID 用于响应）；
   * 磁盘写入为即发即忘，慢速磁盘不会阻塞工具回复。
   * 按 ID 的队列化序列化同一 ID 上的并发写入
   * （如 add → 过期自动清除），使删除不会与重命名竞争。
   *
   * 持久化失败通过 `agent.log.warn` 记录并吞掉——
   * 不稳定的磁盘会丢失跨恢复的持久性，但不能使 Agent 循环崩溃。
   */
  addTask(init: SessionCronTaskInit): CronTask {
    const task = this.store.add(init, this.clocks.wallNow());
    this.persistEnqueue(task.id, () =>
      this.persistStore!.write(task.id, task),
    );
    return task;
  }

  /**
   * 从内存存储批量移除任务，并将每次删除镜像到磁盘
   * （当已挂载持久化时）。返回实际存在的 ID 子集，
   * 匹配 `SessionCronStore.remove` 的契约——调用方
   * （CronDelete / 调度器一次性清理 / 过期自动清除）
   * 据此决定是否发出遥测。
   *
   * 持久化失败被记录并吞掉；跨恢复的最坏情况是残留条目
   * 在下一次 `list()` 形状守卫时被丢弃。
   */
  removeTasks(ids: readonly string[]): readonly string[] {
    const removed = this.store.remove(ids);
    for (const id of removed) {
      this.persistEnqueue(id, () => this.persistStore!.remove(id));
    }
    return removed;
  }

  /**
   * 持久化调度器为循环任务记录的 `lastFiredAt` 游标，
   * 以便 `kimi resume` 不会合并重放已投递的触发。
   * 在调度器的 `onAdvanceCursor` 回调中，循环触发成功后调用。
   *
   * 当任务在触发和回调之间已被移除时无操作
   * （并发 CronDelete 是典型场景）。当持久化已脱离
   * （子 Agent / 临时会话）时，仍然更新内存记录——
   * 同会话的过期检查从内存存储读取。磁盘写入通过
   * `persistEnqueue` 即发即忘；不稳定的磁盘会丢失
   * 跨恢复的持久性，但不会阻塞调度器。
   */
  private advanceCursor(id: string, lastFiredAt: number): void {
    const updated = this.store.markFired(id, lastFiredAt);
    if (updated === undefined) return;
    if (this.persistStore === undefined) return;
    this.persistEnqueue(id, () => this.persistStore!.write(id, updated));
  }

  /**
   * 在 `kimi resume` 后从 `<sessionDir>/cron/` 重新水合内存存储。
   * 当未挂载持久化时无操作。幂等：清除内存映射并重新插入磁盘上的每条记录。
   *
   * 任务通过 {@link SessionCronStore.adopt} 插入，以保留原始 `id`
   * 和 `createdAt`——`createdAt` 是调度器的循环基准和 7 天过期判断的输入，
   * 重新生成的值会破坏两者。
   */
  async loadFromDisk(): Promise<void> {
    if (this.persistStore === undefined) return;
    const tasks = await this.persistStore.list();
    this.store.clear();
    for (const task of tasks) {
      this.store.adopt(task);
    }
  }

  /**
   * 序列化按 ID 的持久化写入。同一 ID 上的并发变更
   * （不常见但可通过 `add` 后紧跟过期自动清除触发）
   * 否则会在重命名时产生竞争——atomicWrite 是每次调用原子的，
   * 而非按 ID 有序。每个 ID 的链在解决后从 Map 中删除，
   * 使 Map 大小跟踪的是实时进行中的写入，而非生命周期变更总量。
   */
  private persistEnqueue(id: string, work: () => Promise<void>): void {
    if (this.persistStore === undefined) return;
    const prev = this.persistQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => work())
      .catch((error: unknown) => {
        this.agent.log?.warn?.('cron persist failed', error);
      })
      .finally(() => {
        if (this.persistQueues.get(id) === next) {
          this.persistQueues.delete(id);
        }
      });
    this.persistQueues.set(id, next);
  }

  /**
   * 等待通过 {@link addTask} / {@link removeTasks} 调度的
   * 所有待处理的持久化写入/删除完成。由 {@link stop} 调用
   * 用于会话优雅关闭，并公开暴露以便测试无需轮询即可
   * 同步到磁盘可见状态。
   *
   * 错误已被 `persistEnqueue` 吞掉，因此此方法永远不会拒绝。
   */
  async flushPersist(): Promise<void> {
    // 快照 Promise 链而非 Map 本身——在我们 await 期间
    // `.finally` 清理会删除条目，而活跃的 Map 迭代会观察到这些删除并丢失尾部。
    const inFlight = Array.from(this.persistQueues.values());
    await Promise.allSettled(inFlight);
  }

  /**
   * 启动调度器的自动 tick 循环并绑定 SIGUSR1 手动 tick 钩子
   * （P1.8）。幂等：第二次调用无操作，使启动序列和测试
   * 可以选择"确保已启动"而无需簿记。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduler.start();
    this.bindSigusr1();
  }

  /**
   * 停止调度器，排空待处理的持久化写入，清除进行中的簿记，
   * 并解绑 SIGUSR1 处理器。幂等且信号处理器安全——
   * 多个 vitest 文件测试管理器时不能在共享进程上留下悬挂的
   * SIGUSR1 监听器。
   *
   * 关闭时排空持久化对生产环境很重要：否则 CronCreate 之后
   * 立即 `close()` 会话会在 JSON 文件落地之前终止进程，
   * 导致任务在恢复的 `loadFromDisk()` 中丢失。
   */
  async stop(): Promise<void> {
    this.unbindSigusr1();
    await this.scheduler.stop();
    await this.flushPersist();
    this.started = false;
  }

  /** 同步驱动一次调度器 tick。用于测试 + P1.8 SIGUSR1。 */
  tick(): void {
    this.scheduler.tick();
  }

  /**
   * 所有任务中最早的理论下次触发时间（抖动后），如果无任务
   * 或无任务有未来触发则返回 null。由 `/cron` 斜杠命令和外部监控使用。
   */
  getNextFireTime(): number | null {
    return this.scheduler.getNextFireTime();
  }

  /**
   * 每个任务抖动后的下次触发时间。转发给调度器，
   * 使 CronList 渲染的时间与调度器实际触发的时间一致——
   * 即使已过去的理想时间在当前周期内仍有待处理的抖动投递。
   */
  getNextFireForTask(taskId: string): number | null {
    return this.scheduler.getNextFireForTask(taskId);
  }

  /**
   * 过期判断。
   *
   *   - `KIMI_CRON_NO_STALE=1` 短路返回 false（基准测试）。
   *   - 一次性任务（`recurring === false`）永不视为过期——
   *     它们按设计最多触发一次；标记为过期会在每次积压唤醒时
   *     产生噪点误报。
   *   - 否则：`wallNow() - createdAt >= 7 天`。
   *
   * `Number.isFinite` 防御挂钟损坏（如返回 `NaN` 的基准环境配置错误）；
   * 非有限的存活时间被视为"未知，不判定过期"。
   */
  isStale(task: CronTask): boolean {
    if (process.env['KIMI_CRON_NO_STALE'] === '1') return false;
    if (task.recurring === false) return false;
    const age = this.clocks.wallNow() - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  /**
   * 将调度器触发转换为 steer + 遥测事件。
   *
   * `agent.turn.steer` 返回新的 turnId，或当输入因轮次进行中
   * 而被缓冲时返回 `null`（参见 turn/index.ts:84）。
   * 将其作为遥测属性的 `buffered` 传播，以便仪表板能区分
   * "触发进入新轮次"与"触发进入可能要等到用户轮次结束才执行的
   * steer 缓冲区"。
   *
   * 遵循循环任务记录的 7 天自动过期契约：过期的循环任务获得
   * 恰好一次最终投递（已在上方发出），然后从存储中移除。
   * 调度器在下一次 tick 时通过 `source()` 获取删除并停止
   * 重新触发该任务。一次性任务不受影响——它们在投递后由
   * 调度器通过 `removeOneShot` 回调立即删除。
   */
  private handleFire(
    task: CronTask,
    ctx: { readonly coalescedCount: number },
  ): void {
    const stale = this.isStale(task);
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      coalescedCount: ctx.coalescedCount,
      stale,
    };
    const content: ContentPart[] = [
      {
        type: 'text',
        text: renderCronFireXml(origin, task.prompt),
      },
    ];
    this.agent.emitEvent({
      type: 'cron.fired',
      origin,
      prompt: task.prompt,
    });
    const turnId = this.agent.turn.steer(content, origin);
    this.agent.telemetry.track(CRON_FIRED, {
      recurring: task.recurring !== false,
      coalesced_count: ctx.coalescedCount,
      stale,
      buffered: turnId === null,
    });

    // 7 天自动过期——CronCreate 工具描述的循环分支向模型承诺此契约。
    // 不移除的话，长期运行的会话会持续重新注入多天前的定时提示；
    // 移除后，任务最后触发一次（上方）然后被丢弃。与手动删除
    // 对称地发出 `cron_deleted`，以便仪表板看到生命周期关闭。
    if (stale && task.recurring !== false) {
      this.removeTasks([task.id]);
      this.emitDeleted(task.id);
    }
  }

  /**
   * 预留的钩子，用于显式的"您在离线期间错过了 N 次触发"横幅。
   * 当前调度器的 `coalescedCount` 语义已在 `cron_job` 封装内
   * 传达遗漏触发（超过 7 天的循环任务以 `stale: true` 到达），
   * 因此恢复路径不会从框架调用此方法。该方法保持暴露，
   * 因为后续添加独立的面向用户横幅——例如针对所有触发时间
   * 都落在长中断期间的一次性任务——不应要求此处的 API 变更。
   *
   * `renderMissedNotification` 回调由调用方提供（而非在此导入），
   * 使本模块保持无 UI / 文案耦合；同一管理器适用于需要注入
   * 简单渲染器的测试。
   *
   * `count: 0` 为无操作——调度器端的遗漏任务检测器在调用前
   * 已过滤空值，但此处的防御使契约保持简单
   * （"传入任何值都安全，空时无操作"）。
   */
  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (
      tasks: readonly CronTask[],
    ) => readonly ContentPart[],
  ): void {
    if (tasks.length === 0) return;
    const content = renderMissedNotification(tasks);
    const origin: CronMissedOrigin = {
      kind: 'cron_missed',
      count: tasks.length,
    };
    this.agent.turn.steer(content, origin);
    this.agent.telemetry.track(CRON_MISSED, { count: tasks.length });
  }

  /**
   * 为新添加的任务发出 `cron_scheduled`。在 `store.add(...)` 成功后
   * 由 `CronCreate` 调用。保持为显式方法，使工具层永远不直接访问
   * `manager.agent.telemetry`——保持"工具看到管理器，管理器看到 Agent"
   * 的分层，与 `CronDelete` 使用的对称 `emitDeleted`（P1.6）匹配。
   */
  emitScheduled(task: CronTask): void {
    this.agent.telemetry.track(CRON_SCHEDULED, {
      recurring: task.recurring !== false,
    });
  }

  /**
   * 为已移除的任务发出 `cron_deleted`。在此接线以便 P1.6 落地时
   * 无需再次修改此文件。`task_id` 与遥测层其他地方使用的
   * 字段命名一致（snake_case）。
   */
  emitDeleted(taskId: string): void {
    this.agent.telemetry.track(CRON_DELETED, { task_id: taskId });
  }

  /**
   * 将 `SIGUSR1` 接线到手动 `tick()`，以便基准脚本能通过
   * `kill -USR1 <pid>` 推进调度器而无需自定义 RPC。
   *
   * 以 `KIMI_CRON_MANUAL_TICK=1` 为门控，原因有二：
   *
   *   1. SIGUSR1 仅在自动 tick 关闭时有意义。当 1 秒间隔运行时，
   *      调度器已在自动推进——手动信号是多余的。
   *   2. 生产环境中单个 CLI 进程可承载一个主 Agent 加多个子 Agent。
   *      每个 Agent 无条件绑定 SIGUSR1 监听器会使我们超出
   *      Node 的 10 监听器默认上限并打印 `MaxListenersExceededWarning`。
   *      将绑定耦合到禁用自动 tick 的同一环境变量，使生产路径
   *      保持零监听器，同时仍为基准测试提供便利。
   *
   * 在 Windows 上跳过，因为 Node 的信号层不传递 POSIX 信号；
   * 尝试 `process.on('SIGUSR1', ...)` 是静默无操作，但我们完全
   * 避免调用，使簿记（`sigusr1Handler !== null` 表示"已绑定"）保持准确。
   *
   * 幂等——重复调用保持同一监听器只注册一次，
   * 因此 `start() → start()` 不会堆叠处理器。
   *
   * 处理器吞掉 `tick()` 的任何抛出，因为信号驱动的基准工具
   * 绝不能使宿主进程崩溃；tick 的失败模式已通过调度器内的
   * 遥测/日志呈现。设置 `KIMI_CRON_DEBUG=1` 可将吞掉的错误
   * 输出到 stderr——镜像 `scheduler.ts` 的 debugLog 模式，
   * 以便基准调试能看到异常的 tick。
   */
  private bindSigusr1(): void {
    if (process.platform === 'win32') return;
    if (process.env['KIMI_CRON_MANUAL_TICK'] !== '1') return;
    if (this.sigusr1Handler !== null) return;
    const handler: NodeJS.SignalsListener = () => {
      try {
        this.tick();
      } catch (error) {
        if (process.env['KIMI_CRON_DEBUG'] === '1') {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `[cron/manager] SIGUSR1 tick threw: ${msg}\n`,
          );
        }
      }
    };
    this.sigusr1Handler = handler;
    process.on('SIGUSR1', handler);
  }

  /**
   * 分离由 `bindSigusr1` 注册的 SIGUSR1 监听器。当没有绑定时
   * 安全调用（无操作）。与 `stop()` 配对使用，使 vitest 文件
   * 不会在共享进程上泄漏信号处理器——`process.listenerCount('SIGUSR1')`
   * 应在 `stop()` 完成后恢复到 `start()` 之前的值。
   */
  private unbindSigusr1(): void {
    if (this.sigusr1Handler === null) return;
    process.off('SIGUSR1', this.sigusr1Handler);
    this.sigusr1Handler = null;
  }
}

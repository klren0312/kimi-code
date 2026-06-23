/**
 * `GlobalIdleValue<T>` — 将执行器的运行延迟到首次访问 `value` 时
 * （或下一个浏览器空闲回调 / `setTimeout` 回退）。用于
 * `InstantiationService._createServiceInstance` 以支持
 * `supportsDelayedInstantiation: true` 的服务：返回给调用方的 Proxy
 * 在首次非 `onDid*` 访问时触发 `idle.value`，从而执行真正的构造。
 *
 * 从 krow `packages/core/src/base/async.ts:57-97` 移植而来（即 VSCode
 * 原始版本）。兼容 Node：当 `requestIdleCallback` 不可用时回退到
 * `setTimeout`（典型的 Node 环境）。
 *
 * 仅导出 `GlobalIdleValue` — `runWhenGlobalIdle` 为本模块内部函数，
 * 因为 DI 子系统是唯一消费者；如果后续其他包需要，再提升即可。
 */

import type { IDisposable } from '../lifecycle';

interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

/**
 * 在宿主下次空闲时运行 `callback`。返回一个 disposable，如果在回调触发前
 * 释放则取消待执行的回调。可用时使用 `requestIdleCallback`；否则调度一个
 * `setTimeout` polyfill，模拟单帧截止时间（15ms）。
 */
function runWhenGlobalIdle(
  callback: (idle: IdleDeadline) => void,
  timeout?: number,
): IDisposable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeGlobal: any = globalThis;

  if (
    typeof safeGlobal.requestIdleCallback === 'function' &&
    typeof safeGlobal.cancelIdleCallback === 'function'
  ) {
    const handle: number = safeGlobal.requestIdleCallback(
      callback,
      typeof timeout === 'number' ? { timeout } : undefined,
    );
    let disposed = false;
    return {
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        safeGlobal.cancelIdleCallback(handle);
      },
    };
  } else {
    // 针对没有 requestIdleCallback 的环境（如 Node.js）的 polyfill。
    let disposed = false;
    const handle = setTimeout(() => {
      if (disposed) {
        return;
      }
      const end = Date.now() + 15; // 约 64fps 下的一帧时长
      const deadline: IdleDeadline = {
        didTimeout: true,
        timeRemaining() {
          return Math.max(0, end - Date.now());
        },
      };
      callback(Object.freeze(deadline));
    });
    return {
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        clearTimeout(handle);
      },
    };
  }
}

/**
 * 对执行器 `() => T` 的惰性包装。执行器被调度在下一个空闲 tick 时运行，
 * 但在空闲 tick 触发前读取 `.value` 会取消调度并同步执行执行器 — 然后
 * 缓存结果（或在后续每次访问时重新抛出捕获的错误）。
 *
 * `isInitialized` 让 Proxy 可以区分"真实实例已存在"和"仍在等待中"，
 * 这样 `onDid*`/`onWill*` 事件订阅可以被暂存到早期监听器列表中，
 * 并在实例化时重放。
 */
export class GlobalIdleValue<T> {
  private readonly _executor: () => void;
  private readonly _handle: IDisposable;

  private _didRun: boolean = false;
  private _value?: T;
  private _error: unknown;

  constructor(executor: () => T) {
    this._executor = () => {
      try {
        this._value = executor();
      } catch (err) {
        this._error = err;
      } finally {
        this._didRun = true;
      }
    };
    this._handle = runWhenGlobalIdle(() => this._executor());
  }

  dispose(): void {
    this._handle.dispose();
  }

  get value(): T {
    if (!this._didRun) {
      this._handle.dispose();
      this._executor();
    }
    if (this._error) {
      if (this._error instanceof Error) {
        throw this._error;
      }
      throw new Error('Lazy value initialization failed');
    }
    return this._value!;
  }

  get isInitialized(): boolean {
    return this._didRun;
  }
}

/**
 * 集中报告意外的、不可操作的错误。模式：监听器回调（通过 `Emitter.event(...)`
 * 注册）可能抛出异常；Emitter 通过 `onUnexpectedError` 路由这些异常，
 * 而不是静默吞掉它们或让它们通过 `fire()` 冒泡。
 *
 * **启动时序约束（plan §4.5）**：默认处理程序故意不在模块加载时解析
 * `ILogService`。导入时 DI 容器为空——访问 `ILogService` 会 NPE。
 * 默认保持为普通的 `console.error`，直到守护进程的 `startServer` 后续
 * 调用 `setUnexpectedErrorHandler(...)` 设置日志绑定版本（在 `ILogger`
 * 从 accessor 解析之后）。在交接之前，路由到此处的异常输出到 stderr
 * ——可见但非结构化。
 */

export type UnexpectedErrorHandler = (err: unknown) => void;

/**
 * 默认处理程序。注意：不要在此处访问 `ILogService`——此模块被急切导入，
 * DI 容器在模块加载时尚未注册日志器。回退到 `console.error` 确保启动安全。
 */
const defaultHandler: UnexpectedErrorHandler = (err) => {
  // eslint-disable-next-line no-console
  console.error('[unexpected]', err);
};

let currentHandler: UnexpectedErrorHandler = defaultHandler;

/**
 * 安装新的全局处理程序。替换之前安装的任何处理程序。
 * `startServer` 在 DI 容器完全就绪后调用此函数一次，
 * 使后续异常通过 `ILogService` 路由，而不是输出到 stderr。
 */
export function setUnexpectedErrorHandler(handler: UnexpectedErrorHandler): void {
  currentHandler = handler;
}

/**
 * 将全局处理程序重置为模块默认的 `console.error` 处理程序。
 * 主要用于测试，使某个测试安装的处理程序不会泄漏到下一个测试。
 */
export function resetUnexpectedErrorHandler(): void {
  currentHandler = defaultHandler;
}

/**
 * 通过当前安装的处理程序报告意外错误。处理程序本身绝不能抛出异常；
 * 如果抛出了，我们回退到 `console.error`，以确保单个损坏的处理程序
 * 不会静默丢失原始错误。
 */
export function onUnexpectedError(err: unknown): void {
  try {
    currentHandler(err);
  } catch (handlerErr) {
    // eslint-disable-next-line no-console
    console.error('[unexpected] handler threw', handlerErr, 'while reporting', err);
  }
}

/**
 * `Emitter.fire()` 使用的辅助函数，用于安全调用单个监听器：
 * 任何同步异常都通过 `onUnexpectedError` 路由，确保兄弟监听器仍然运行，
 * 监听器失败不会传播到 `fire()` 的调用点。
 */
export function safelyCallListener(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    onUnexpectedError(err);
  }
}

/**
 * kaos 包的基础错误类。
 *
 * 所有 kaos 相关错误的基类，用于统一捕获和处理。
 */
export class KaosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KaosError';
  }
}

/**
 * 对应 Python 的 ValueError —— 表示传入了无效参数。
 */
export class KaosValueError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosValueError';
  }
}

/**
 * 对应 Python 的 FileExistsError —— 表示文件或目录已存在。
 */
export class KaosFileExistsError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosFileExistsError';
  }
}

/**
 * 当 `detectEnvironment` 在 Windows 上找不到 Git Bash 安装时抛出。
 * 携带已探测的路径列表，调用方可在安装提示中展示这些路径。
 */
export class KaosShellNotFoundError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosShellNotFoundError';
  }
}

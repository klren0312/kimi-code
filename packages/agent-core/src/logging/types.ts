export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type LogContext = Record<string, unknown>;

/**
 * `log.error / warn / info / debug` 的第二个参数。
 *
 * 三种运行时用法：
 *   - `Error`     → 栈信息被提取到日志条目中
 *   - `LogContext`（对象）→ 合并到条目上下文中；如果包含
 *                              `{ error: Error }`，该字段会被提取出来
 *                              并提取其栈信息（bunyan 风格）
 *   - `unknown`   → 通常是 `catch` 绑定；如果是 Error 实例则按 Error 处理，
 *                   否则字符串化到 `reason` 字段中
 */
export type LogPayload = unknown;

export interface Logger {
  error(message: string, payload?: LogPayload): void;
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  /**
   * 返回一个新日志器，向其发出的每条日志添加 `ctx`。绑定上下文
   * 优先于每次调用的 payload 上下文，因此调用方无法意外覆盖
   * `sessionId` / `agentId` 等归属字段：
   *
   *   finalCtx = { ...payloadCtx, ...boundCtx }
   *
   * 子级可链式调用——`parent.createChild({a: 1}).createChild({b: 2})`
   * 同时绑定两者。
   */
  createChild(ctx: LogContext): Logger;
}

export interface LogEntry {
  readonly t: number;
  readonly level: Exclude<LogLevel, 'off'>;
  readonly msg: string;
  readonly ctx?: LogContext | undefined;
  readonly error?: { readonly message: string; readonly stack?: string } | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionLogId?: string | undefined;
}

export interface LoggingConfig {
  readonly level: LogLevel;
  readonly globalLogPath: string;
  readonly globalMaxBytes: number;
  readonly globalFiles: number;
  readonly sessionMaxBytes: number;
  readonly sessionFiles: number;
}

export interface SessionLogHandle {
  readonly logger: Logger;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionAttachInput {
  readonly sessionId: string;
  readonly sessionDir: string;
}

export interface RootLogger {
  configure(config: LoggingConfig): Promise<void>;
  attachSession(input: SessionAttachInput): SessionLogHandle;
  /** 如果任何 sink 无法刷新其待写入批次则返回 false。 */
  flush(): Promise<boolean>;
  /** 如果全局 sink 无法刷新则返回 false；没有全局 sink 时返回 true。 */
  flushGlobal(): Promise<boolean>;
  /** 如果会话 sink 无法刷新则返回 false；没有活跃 sink 时返回 true。 */
  flushSession(sessionId: string): Promise<boolean>;
  flushSync(): void;
  isConfigured(): boolean;
  getConfig(): LoggingConfig | undefined;
}

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function levelEnabled(threshold: LogLevel, level: Exclude<LogLevel, 'off'>): boolean {
  return LOG_LEVEL_RANK[threshold] >= LOG_LEVEL_RANK[level];
}

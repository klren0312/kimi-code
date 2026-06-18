import type { KimiErrorCode } from './codes';

export interface KimiErrorOptions {
  /** JSON 可序列化的结构化详情。 */
  readonly details?: Record<string, unknown>;
  /** 原始错误或值。仅本地使用；永远不会序列化到 wire。 */
  readonly cause?: unknown;
}

/**
 * Kimi 唯一的错误类。
 *
 * 始终通过 `code` 进行区分。跨进程消费者接收 `KimiErrorPayload`，
 * 必须基于 `code` 而非类标识进行分支判断。
 */
export class KimiError extends Error {
  readonly code: KimiErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: KimiErrorCode, message: string, options: KimiErrorOptions = {}) {
    super(message);
    this.name = 'KimiError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

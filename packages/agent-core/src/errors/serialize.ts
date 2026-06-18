import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '@moonshot-ai/kosong';

import { KimiError } from './classes';
import { ErrorCodes, KIMI_ERROR_INFO, type KimiErrorCode } from './codes';

/**
 * Kimi 错误的 wire 安全载荷。
 *
 * 跨进程/语言边界传递的结构（RPC、事件、遥测、SDK 包装器）。
 * 类标识不会跨越边界；下游代码必须基于 `code` 而非 `instanceof` 进行分支判断。
 *
 * `details` 是 JSON 序列化的。`cause` 故意缺失——它是仅本地的诊断状态，
 * 不应跨越边界。
 */
export interface KimiErrorPayload {
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

/** KimiError 的类型守卫。 */
export function isKimiError(error: unknown): error is KimiError {
  return error instanceof KimiError;
}

/**
 * 直接从 code + message 构建 KimiErrorPayload（不需要 Error 实例）。
 * 用于信号传递而非抛出的合成错误事件——例如 "turn busy" 或 "compaction failed"。
 * `retryable` 从 KIMI_ERROR_INFO 填充，确保调用方不会与注册表失步。
 */
export function makeErrorPayload(
  code: KimiErrorCode,
  message: string,
  options?: { readonly details?: Record<string, unknown>; readonly name?: string },
): KimiErrorPayload {
  return {
    code,
    message,
    name: options?.name,
    details: options?.details,
    retryable: KIMI_ERROR_INFO[code].retryable,
  };
}

/**
 * 将任意值规范化为 KimiErrorPayload。
 *
 * 已识别的错误类型：
 * - `KimiError`：直接透传。
 * - `APIStatusError`：429 -> rate_limit，401 -> auth_error，其他 -> api_error。
 * - `APIConnectionError` / `APITimeoutError`：connection_error。
 * - `ChatProviderError`：api_error。
 *
 * 其他任何值都归为 `internal`。我们永远不会在 wire 上回显 `cause` 或堆栈。
 */
export function toKimiErrorPayload(error: unknown): KimiErrorPayload {
  if (isKimiError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: error.details,
      retryable: KIMI_ERROR_INFO[error.code].retryable,
    };
  }

  if (error instanceof APIStatusError) {
    const code: KimiErrorCode =
      error.statusCode === 429
        ? ErrorCodes.PROVIDER_RATE_LIMIT
        : error.statusCode === 401
          ? ErrorCodes.PROVIDER_AUTH_ERROR
          : ErrorCodes.PROVIDER_API_ERROR;
    return {
      code,
      message: error.message,
      name: error.name,
      details: {
        statusCode: error.statusCode,
        requestId: error.requestId,
      },
      retryable: KIMI_ERROR_INFO[code].retryable,
    };
  }

  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return {
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
      message: error.message,
      name: error.name,
      retryable: KIMI_ERROR_INFO[ErrorCodes.PROVIDER_CONNECTION_ERROR].retryable,
    };
  }

  if (error instanceof APIEmptyResponseError) {
    return {
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: error.message,
      name: error.name,
      details: {
        finishReason: error.finishReason,
        rawFinishReason: error.rawFinishReason,
      },
      retryable: KIMI_ERROR_INFO[ErrorCodes.PROVIDER_API_ERROR].retryable,
    };
  }

  if (error instanceof ChatProviderError) {
    return {
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: error.message,
      name: error.name,
      retryable: KIMI_ERROR_INFO[ErrorCodes.PROVIDER_API_ERROR].retryable,
    };
  }

  if (error instanceof Error) {
    return {
      code: ErrorCodes.INTERNAL,
      message: error.message,
      name: error.name,
      retryable: KIMI_ERROR_INFO[ErrorCodes.INTERNAL].retryable,
    };
  }

  return {
    code: ErrorCodes.INTERNAL,
    message: String(error),
    retryable: KIMI_ERROR_INFO[ErrorCodes.INTERNAL].retryable,
  };
}

/**
 * 将 KimiErrorPayload 重新水化为 KimiError。由 SDK 边界代码使用，
 * 接收通过 RPC 传来的错误后，以真实类的形式重新暴露它们，
 * 使进程内消费者仍然可以使用 `instanceof`。
 */
export function fromKimiErrorPayload(payload: KimiErrorPayload): KimiError {
  return new KimiError(payload.code, payload.message, {
    details: payload.details,
  });
}

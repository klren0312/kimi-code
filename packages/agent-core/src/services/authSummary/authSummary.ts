/**
 * `IAuthSummaryService` — daemon 面向的就绪探针。
 *
 * 单一权威就绪信号源：
 *   - `get()` 为 `GET /v1/auth` 生成 `AuthSummary` 负载。
 *   - `ensureReady(modelOverride?)` 是由无法在没有 provider 凭据时继续执行的
 *     入口点调用的同步门控 — 当前为 `PromptService.submit`。抛出以下四个哨兵
 *     错误类之一；daemon 路由层将其映射为信封码 40110 / 40111 / 40112 / 40113。
 *
 * 为何集中管理：相同的"是否存在可用的 provider + model + token？"计算
 * 同时被读探针和每个可能产生 50001 "internal" 错误的写侧入口所需。
 * 集中管理使逻辑保持在一处 + 便于添加新的门控入口（PATCH session model 等）。
 *
 * 状态映射说明：仅返回 `'authenticated'`（token 已缓存）或
 * `'unauthenticated'`（无 token）。`'expired' / 'revoked'` 状态需要运行时
 * OAuth 内省；此门控有意不尝试区分它们。
 *
 * **实现**（`AuthSummaryService`）：通过 `ICoreProcessService.rpc.getKimiConfig({})`
 * 读取实时配置，通过缓存 token 查找读取托管 OAuth 凭据状态。两者开销都较低
 *（进程内 RPC + token 文件存在性探针），因此每次调用时执行而非缓存 —
 * 将过期窗口保持为零。
 */

import { createDecorator } from '../../di';
import type { AuthSummary } from '@moonshot-ai/protocol';

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;

  /**
   * 计算当前就绪快照。开销低（一次配置读取 + 一次缓存 token 查找）；
   * 可安全地在每次 `GET /v1/auth` 时调用。
   */
  get(): Promise<AuthSummary>;

  /**
   * 若 daemon 当前无法使用 `modelOverride`（省略时为 `config.defaultModel`）
   * 处理 prompt，则抛出哨兵认证错误。成功时返回 void。
   */
  ensureReady(modelOverride?: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAuthSummaryService = createDecorator<IAuthSummaryService>(
  'authSummaryService',
);

/**
 * `40110 auth.provisioning_required` — daemon 没有任何 provider 配置。
 */
export class AuthProvisioningRequiredError extends Error {
  constructor() {
    super('no provider configured; complete onboarding via /login or POST /v1/providers');
    this.name = 'AuthProvisioningRequiredError';
  }
}

/**
 * `40111 auth.token_missing` — provider 存在于配置中，但其凭据
 *（api_key 或缓存的 OAuth token）缺失。
 */
export class AuthTokenMissingError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`provider ${providerId} has no credential configured`);
    this.name = 'AuthTokenMissingError';
    this.providerId = providerId;
  }
}

/**
 * `40112 auth.token_unauthorized` — OAuth 刷新返回 401；用户已撤销授权。
 * 静态门控不会产生此错误（需要到 OAuth 主机的往返）；保留用于响应式刷新路径。
 */
export class AuthTokenUnauthorizedError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`provider ${providerId} oauth grant revoked; re-login required`);
    this.name = 'AuthTokenUnauthorizedError';
    this.providerId = providerId;
  }
}

/**
 * `40113 auth.model_not_resolved` —（默认或请求的）模型别名无法解析为
 * 已配置的 provider。两种子情况：
 *   - 未设置默认模型（`modelId === undefined`）
 *   - 别名缺失或指向不存在的 provider
 */
export class AuthModelNotResolvedError extends Error {
  readonly modelId: string | undefined;
  readonly providerId: string | undefined;
  constructor(modelId: string | undefined, providerId?: string) {
    super(
      modelId === undefined
        ? 'no default model configured'
        : `model ${modelId} does not resolve to a configured provider`,
    );
    this.name = 'AuthModelNotResolvedError';
    this.modelId = modelId;
    this.providerId = providerId;
  }
}

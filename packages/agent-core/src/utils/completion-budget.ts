import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';

/** 下一次 LLM 请求的补全 token 预算。 */
export interface CompletionBudgetConfig {
  /** 用户配置的显式上限。 */
  readonly hardCap?: number;
  /** 上下文窗口未知的 provider/模型的保守上限。 */
  readonly fallback?: number;
}

const MIN_FLOOR = 1;
const DEFAULT_UNKNOWN_CONTEXT_FALLBACK = 32000;

/**
 * 解析已配置的补全预算。环境变量值为显式硬上限；
 * 非正的环境变量值禁用截断。
 */
export function resolveCompletionBudget(args: {
  readonly maxOutputSize?: number;
  readonly reservedContextSize?: number;
  readonly env?: NodeJS.ProcessEnv;
}): CompletionBudgetConfig | undefined {
  const env = args.env ?? process.env;
  const fromNew = parseEnvBudget(env['KIMI_MODEL_MAX_COMPLETION_TOKENS']);
  if (fromNew !== 'absent') {
    return fromNew === 'disabled' ? undefined : { hardCap: fromNew };
  }
  const fromLegacy = parseEnvBudget(env['KIMI_MODEL_MAX_TOKENS']);
  if (fromLegacy !== 'absent') {
    return fromLegacy === 'disabled' ? undefined : { hardCap: fromLegacy };
  }
  if (args.maxOutputSize !== undefined && args.maxOutputSize > 0) {
    return { hardCap: args.maxOutputSize };
  }
  if (args.reservedContextSize !== undefined && args.reservedContextSize > 0) {
    return { fallback: args.reservedContextSize };
  }
  return { fallback: DEFAULT_UNKNOWN_CONTEXT_FALLBACK };
}

type EnvBudget = number | 'disabled' | 'absent';

function parseEnvBudget(raw: string | undefined): EnvBudget {
  if (raw === undefined || raw === '') return 'absent';
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'absent';
  if (n <= 0) return 'disabled';
  return n;
}

/**
 * 计算有效的 `max_completion_tokens` 上限。
 */
export function computeCompletionBudgetCap(args: {
  readonly budget: CompletionBudgetConfig;
  readonly capability: ModelCapability | undefined;
}): number {
  const maxCtx = args.capability?.max_context_tokens ?? 0;
  // Provider 后端根据序列化的提示词计算安全的请求特定值。
  // 本地使用最大上限可以避免在模型生成摘要之前截断思考过程。
  const cap =
    args.budget.hardCap ??
    (maxCtx > 0 ? maxCtx : args.budget.fallback ?? DEFAULT_UNKNOWN_CONTEXT_FALLBACK);
  return Math.max(MIN_FLOOR, cap);
}

/**
 * 通过 provider 可选的 `withMaxCompletionTokens` 能力应用补全预算。
 * 未配置预算或 provider 不支持时返回原始 provider。
 *
 * 返回的 provider 故意是共享原始 HTTP 客户端的浅克隆。
 * 调用方必须将其视为单步值，不要持久化回持久化 agent 状态
 * ——详见 `KimiChatProvider._clone()` 中的 F3 讨论。
 */
export function applyCompletionBudget(args: {
  readonly provider: ChatProvider;
  readonly budget: CompletionBudgetConfig | undefined;
  readonly capability: ModelCapability | undefined;
}): ChatProvider {
  if (args.budget === undefined) return args.provider;
  if (args.provider.withMaxCompletionTokens === undefined) return args.provider;
  const cap = computeCompletionBudgetCap({
    budget: args.budget,
    capability: args.capability,
  });
  return args.provider.withMaxCompletionTokens(cap);
}

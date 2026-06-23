import {
  type ChatProvider,
  type GenerationKwargs,
  KimiChatProvider,
  type ThinkingEffort,
} from '@moonshot-ai/kosong';

import { parseFloatEnv } from '#/config/resolve';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * 从环境变量应用 Kimi 采样参数（`KIMI_MODEL_TEMPERATURE`、`KIMI_MODEL_TOP_P`）
 * 到聊天 provider。在 provider 构造时应用（`ConfigState.provider`），使得从
 * `config.provider` 构建的每个请求——主循环和完整历史压缩——都携带这些参数，
 * 与 kimi-cli 中这些参数位于共享 `create_llm` provider 上的行为一致。
 * 全局应用于任何 Kimi provider（不绑定到 `KIMI_MODEL_NAME`）。
 *
 * 非 Kimi provider——以及两个变量都未设置的 Kimi provider——原样返回。
 * `max_tokens` 故意不在此处处理：`KIMI_MODEL_MAX_TOKENS` 已通过
 * completion-budget 路径（`resolveCompletionBudget`）传递。
 */
export function applyKimiEnvSamplingParams(
  provider: ChatProvider,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;

  const kwargs: GenerationKwargs = {};
  const temperature = parseFloatEnv(env['KIMI_MODEL_TEMPERATURE'], 'KIMI_MODEL_TEMPERATURE');
  if (temperature !== undefined) kwargs.temperature = temperature;
  const topP = parseFloatEnv(env['KIMI_MODEL_TOP_P'], 'KIMI_MODEL_TOP_P');
  if (topP !== undefined) kwargs.top_p = topP;

  return Object.keys(kwargs).length > 0 ? provider.withGenerationKwargs(kwargs) : provider;
}

/**
 * 将 Moonshot 保留思维透传（`KIMI_MODEL_THINKING_KEEP` -> `thinking.keep`）
 * 应用到聊天 provider。在 `ConfigState.provider` 中 `withThinking` 之后应用，
 * 且仅在 thinking 开启时生效——否则 API 会收到不带 `thinking.type` 的
 * `thinking.keep`，而 API 不会识别它。
 *（压缩使用 thinking 关闭的原始 provider，因此正确跳过此步骤。）
 *
 * 非 Kimi provider——以及未设置/空值——原样返回。
 */
export function applyKimiEnvThinkingKeep(
  provider: ChatProvider,
  thinkingLevel: ThinkingEffort,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;
  const keep = env['KIMI_MODEL_THINKING_KEEP']?.trim();
  if (keep === undefined || keep.length === 0 || thinkingLevel === 'off') return provider;
  return provider.withExtraBody({ thinking: { keep } });
}

import type {
  PermissionOption,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { QuestionAnswers, QuestionItem } from '@moonshot-ai/kimi-code-sdk';

// ── 中文概述 ──
// 本模块负责 SDK 问答（QuestionItem）与 ACP 权限选项（PermissionOption）之间的双向转换。
// 核心功能：
//   1. 将 SDK 的 QuestionItem 转换为 ACP 的 PermissionOption[]，用于向客户端展示选项。
//   2. 将 ACP 的 RequestPermissionResponse 反向映射回 SDK 的 QuestionAnswers，
//      支持用户选择、跳过（Skip）、取消等操作。
// optionId 命名空间采用 `q{i}_opt_{j}` / `q{i}_skip` 格式，预留多问题支持。

/**
 * `optionId` namespace for the AskUserQuestion bridge.
 *
 * The wire-level `PermissionOption.optionId` is opaque to the client (it
 * round-trips back via `RequestPermissionResponse.outcome.optionId`), so
 * the adapter is free to pick any stable string. We embed the
 * `questionIndex` in the prefix so multi-question support (when it
 * arrives — Phase 13.1 still degrades to single-question) does not need
 * a wire-format change: `q0_opt_*` / `q1_opt_*` are already
 * non-conflicting. The skip option follows the same scheme so a single
 * regex (`/^q(\d+)_(opt_(\d+)|skip)$/`) can parse any future surface.
 */
// 中文：生成选项的 optionId，格式为 `q{问题索引}_opt_{选项索引}`，用于在 ACP 协议中标识具体选项
function optOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex}_opt_${optionIndex}`;
}

// 中文：生成跳过（Skip）按钮的 optionId，格式为 `q{问题索引}_skip`
function skipOptionId(questionIndex: number): string {
  return `q${questionIndex}_skip`;
}

/**
 * Map a tool-side {@link QuestionItem} into ACP
 * {@link PermissionOption}[].
 *
 * Layout:
 *  - One `allow_once` option per `question.options[i]` (label preserved
 *    verbatim — it is the same string we surface back to the SDK as a
 *    `QuestionAnswers` value, so any UI normalisation belongs on the
 *    tool side, not here).
 *  - One trailing `reject_once` "Skip" option so the user can dismiss
 *    the prompt without forcing an answer. The SDK's ask-user tool
 *    already understands dismissal (`packages/agent-core/src/tools/builtin/collaboration/ask-user.ts:126`
 *    emits `question_dismissed` and resolves with a null result); the
 *    Skip surface is the user-facing path into that branch.
 *
 * `questionIndex` is currently always `0` (Phase 13.1 degrades
 * multi-question to single-question), but the namespace is wired in so
 * future multi-question support is a pure handler change with no wire
 * format break.
 *
 * Returned `readonly` because callers treat it as a constant lookup
 * table — they do not mutate it.
 */
// 中文：将 SDK 的 QuestionItem 转换为 ACP 权限选项数组，包含每个选项（allow_once）和一个跳过按钮（reject_once）
export function questionItemToPermissionOptions(
  question: QuestionItem,
  questionIndex: number,
): readonly PermissionOption[] {
  // 中文：为每个选项生成 allow_once 权限选项，label 保持原样透传
  const options: PermissionOption[] = question.options.map((opt, i) => ({
    optionId: optOptionId(questionIndex, i),
    name: opt.label,
    kind: 'allow_once' as const,
  }));
  // 中文：追加一个 reject_once 的 "Skip" 选项，允许用户跳过而不强制回答
  options.push({
    optionId: skipOptionId(questionIndex),
    name: 'Skip',
    kind: 'reject_once' as const,
  });
  return options;
}

/**
 * Reverse-map an ACP {@link RequestPermissionResponse} into a tool-side
 * {@link QuestionAnswers} payload, returning `null` when the user
 * dismissed (skip, cancel) or selected an unknown option.
 *
 * Dismissal semantics align with the existing ask-user tool path:
 * `null` causes the SDK to resolve the tool with the canonical
 * "user dismissed" branch (mirrors `rpc.ts:567` — `requestQuestion`
 * returning `null` is the dismissed signal).
 *
 * Defensive on out-of-bounds / unknown optionIds: returning `null`
 * rather than throwing keeps the bridge robust against stale or custom
 * options surfaced by the client.
 */
// 中文：将 ACP 权限响应反向转换为 SDK 的 QuestionAnswers，用户跳过/取消/未知选项时返回 null
export function outcomeToQuestionAnswer(
  question: QuestionItem,
  response: RequestPermissionResponse,
): QuestionAnswers | null {
  // 中文：用户取消请求，直接返回 null
  if (response.outcome.outcome === 'cancelled') return null;
  const optionId = response.outcome.optionId;
  // Skip — explicit dismissal path; treat the same as `cancelled`.
  // 中文：用户点击了跳过（Skip），视为与取消相同
  if (optionId === skipOptionId(0)) return null;
  // Selected option — parse the `q0_opt_<i>` shape and look up the
  // matching label. Reject anything that does not match the namespace
  // (or whose index is out of bounds) defensively rather than crashing.
  // 中文：解析 optionId 格式 `q0_opt_{i}`，提取选项索引并查找对应的 label
  const match = /^q0_opt_(\d+)$/.exec(optionId);
  if (!match) return null;
  const optionIndex = Number(match[1]);
  // 中文：防御性校验——索引必须是非负整数，且在选项范围内
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return null;
  const selected = question.options[optionIndex];
  if (!selected) return null;
  // 中文：返回 SDK 格式的问答结果，key 为问题内容，value 为选中的选项 label
  return { [question.question]: selected.label };
}

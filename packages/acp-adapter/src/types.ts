// ── 中文概述 ──
// 本模块定义了 ACP 适配器的本地类型别名。
// 将 ACP SDK 中的枚举类型（停止原因、工具调用状态、工具种类）
// 映射为项目内部类型，解耦其他模块对 SDK 原始类型名的直接依赖。

import type { PromptResponse, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

/**
 * Local alias for the ACP `stopReason` enum.
 *
 * Surfaced separately so internal helpers (e.g. `turnEndReasonToStopReason`)
 * don't have to repeat the literal union and the file is the single place
 * to look when the upstream SDK widens or renames a variant.
 */
// 中文：ACP 停止原因类型别名，对应 SDK 的 PromptResponse.stopReason 联合类型
export type AcpStopReason = PromptResponse['stopReason'];

/**
 * Local alias for the ACP `ToolCallStatus` enum.
 *
 * Same rationale as {@link AcpStopReason}: keep SDK-coupled enum
 * names confined to this file so the rest of the adapter only sees
 * project-local types.
 */
// 中文：ACP 工具调用状态类型别名，统一引用 SDK 的 ToolCallStatus 枚举
export type AcpToolCallStatus = ToolCallStatus;

/**
 * Local alias for the ACP `ToolKind` enum.
 *
 * The kind is heuristic-mapped from Kimi tool names by
 * `events-map.inferToolKind`; aliasing here keeps the consumer side
 * (UI integration / future tool registries) decoupled from the raw
 * SDK type name.
 */
// 中文：ACP 工具种类类型别名，由 inferToolKind 根据工具名启发式推断
export type AcpToolKind = ToolKind;

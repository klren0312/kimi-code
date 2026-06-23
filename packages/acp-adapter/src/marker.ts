// ── 中文概述 ──
// 本模块定义了输出隐藏标记（HideOutputMarker）。
// 工具可以在结果 output 中附加此标记，通知 ACP 适配器抑制文本输出。
// 典型场景：终端工具已通过 ACP terminal/* 通道输出内容，
// 为避免 Zed UI 重复渲染，适配器检测到标记后会短路返回空内容。

/**
 * Sentinel object that a tool can attach to its result `output` to
 * signal the ACP adapter to suppress this tool's textual output.
 *
 * Motivation: Phase 7's `AcpTerminalTool` emits its output via the
 * ACP `terminal/*` reverse-RPC channel — the adapter must NOT also
 * relay the textual stdout / stderr through `tool_call_update`
 * content or the Zed UI would render the same bytes twice (one in
 * the terminal pane, one in the tool card). The tool implementation
 * sets `output: [HideOutputMarker, ...]` (Mechanism A — array of
 * marker plus possibly textual fallback) and the adapter's
 * `toolResultToAcpContent` short-circuits to `[]` whenever the
 * marker is present.
 *
 * Detection is by reference equality OR by `__kind === 'acp-hide-output'`
 * on the value's shape — the latter is a defensive escape hatch in
 * case the marker travels through a structured clone (e.g. via the
 * worker_threads boundary), losing identity but preserving the field.
 * Both checks live in `isHideOutputMarker`.
 */
// 中文：输出隐藏标记的冻结单例对象，通过 __kind 字段标识
export const HideOutputMarker = Object.freeze({
  __kind: 'acp-hide-output' as const,
});

// 中文：输出隐藏标记的类型，从常量值推导
export type HideOutputMarker = typeof HideOutputMarker;

/**
 * Type guard: detect whether `value` is the {@link HideOutputMarker}
 * sentinel. Returns `false` for any non-object value (in particular
 * strings whose text happens to contain `'acp-hide-output'` — only
 * structural identity counts).
 */
// 中文：类型守卫，检测值是否为输出隐藏标记
// 支持两种检测方式：引用相等（快速路径）和结构匹配（跨 worker_threads 场景的兜底）
export function isHideOutputMarker(value: unknown): value is HideOutputMarker {
  if (value === HideOutputMarker) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === 'acp-hide-output'
  );
}

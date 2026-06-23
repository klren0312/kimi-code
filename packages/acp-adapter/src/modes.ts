/**
 * ACP session-mode taxonomy.
 *
 * The 4 modes (`default`, `plan`, `auto`, `yolo`) are the locked
 * decision in PLAN D9 (`PLAN.md` §D9). Every `session/new` and
 * `session/load` response advertises {@link ACP_MODES} as the
 * `availableModes` plus {@link DEFAULT_MODE_ID} as `currentModeId`,
 * so Zed (and any other ACP client) can render its mode dropdown
 * from a single canonical source.
 *
 * Phase 12.2 wires `session/set_mode` to consume the same source of
 * truth: {@link isAcpModeId} narrows the wire string, and the four
 * arms branch on {@link AcpModeId}. This module exports the
 * primitives but does **not** mutate session state — it is the
 * registry, not the dispatcher.
 */

import type { SessionMode } from '@agentclientprotocol/sdk';
import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

// ── 中文概述 ──
// 本模块定义 ACP 会话模式的分类体系（PLAN D9 决策）。
// 包含 4 种模式：default（手动审批）、plan（只读规划）、auto（自动审批安全操作）、
// yolo（自动审批全部）。本模块是注册表，负责模式定义与 SDK 切换项映射，
// 不直接修改会话状态。

/**
 * Canonical 4-mode taxonomy (PLAN D9). Order matters: the array
 * is rendered as-is by the client, so `default` must appear first
 * and `yolo` last. `as const satisfies` pins both the literal
 * shape and the SDK contract so a future SDK type change surfaces
 * here at typecheck rather than at runtime.
 */
// 中文：ACP 四种标准模式的注册表（顺序影响客户端渲染，default 在前 yolo 在后）
export const ACP_MODES = [
  {
    id: 'default',
    name: 'Default',
    description: 'Manual approvals; tools execute normally.',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only planning; no tool execution.',
  },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Auto-approve safe operations.',
  },
  {
    id: 'yolo',
    name: 'YOLO',
    description: 'Auto-approve everything.',
  },
] as const satisfies readonly SessionMode[];

/** Initial `currentModeId` for every freshly created ACP session. */
// 中文：新建 ACP 会话时的默认模式 ID
export const DEFAULT_MODE_ID = 'default' as const;

/**
 * The four wire-level mode ids understood by this adapter. Keep
 * this union in lock-step with {@link ACP_MODES} — Phase 12.2's
 * dispatch table assumes the only valid ids are these four.
 */
// 中文：ACP 模式 ID 的联合类型，与 ACP_MODES 注册表保持严格同步
export type AcpModeId = 'default' | 'plan' | 'auto' | 'yolo';

/**
 * Narrow an unknown wire string to {@link AcpModeId}. Used by Phase
 * 12.2's `setMode` handler to validate the client-supplied modeId
 * before dispatching; centralising the guard here avoids drift if
 * the taxonomy ever grows a fifth mode.
 */
// 中文：类型守卫——验证未知值是否为合法的 AcpModeId
export function isAcpModeId(value: unknown): value is AcpModeId {
  return (
    value === 'default' || value === 'plan' || value === 'auto' || value === 'yolo'
  );
}

/**
 * The two underlying SDK toggles each ACP mode maps to. `plan` is the
 * argument to `Session.setPlanMode` and `permission` is the argument to
 * `Session.setPermission`. Returned as a pure value so the dispatcher
 * in {@link AcpSession.setMode} can stay branch-free and the table is
 * co-located with the {@link ACP_MODES} registry it derives from.
 */
// 中文：ACP 模式映射到底层 SDK 的两个开关——计划模式和权限模式
export interface AcpModeToggles {
  readonly plan: boolean;
  readonly permission: PermissionMode;
}

/**
 * Resolve an {@link AcpModeId} to its underlying SDK toggles per
 * PLAN D9 (`PLAN.md:93-98`). The `switch` deliberately enumerates every
 * arm of {@link AcpModeId} so the TypeScript compiler enforces
 * exhaustiveness — adding a 5th mode without extending this table is a
 * typecheck error (the `never` fallthrough), not a silent runtime
 * no-op. Pure: no side effects, no SDK calls.
 */
// 中文：将 ACP 模式 ID 解析为底层 SDK 的计划模式和权限模式开关值（纯函数，无副作用）
export function acpModeToToggles(id: AcpModeId): AcpModeToggles {
  // 中文：穷举所有模式——新增模式未在此处处理将触发编译期类型错误
  switch (id) {
    case 'default':
      return { plan: false, permission: 'manual' };
    case 'plan':
      return { plan: true, permission: 'manual' };
    case 'auto':
      return { plan: false, permission: 'auto' };
    case 'yolo':
      return { plan: false, permission: 'yolo' };
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unhandled AcpModeId: ${String(_exhaustive)}`);
    }
  }
}

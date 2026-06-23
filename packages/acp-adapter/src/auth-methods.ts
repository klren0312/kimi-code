// Advertise the `terminal-auth` method to ACP clients. Two paths coexist:
//
//   1. First-class `type:'terminal'` per ACP 0.23 — clients re-invoke the
//      configured agent binary appending `args` (we use `['--login']` so
//      the combined command is `<binary> acp --login`, handled by the
//      `acp` subcommand's `--login` flag).
//   2. Legacy `_meta['terminal-auth']` shape — clients that don't yet
//      honor the first-class field (Zed without `AcpBetaFeatureFlag`,
//      current JetBrains plugin, etc.) read `{command,args,env,label}`
//      from `_meta` and spawn `<command> <args>` directly. Mirrors
//      kimi-cli `acp/server.py:77-96`.
//
// Most clients will hit path 1; path 2 is required for Zed today
// because the first-class handler is beta-gated.

import type { AuthMethod } from '@agentclientprotocol/sdk';

// ── 中文概述 ──
// 本模块负责构建 ACP 的 `terminal-auth` 认证方法声明。
// 支持两条路径：
//   1. ACP 0.23 标准 `type:'terminal'` — 客户端拼接 args 启动登录流程
//   2. 旧版 `_meta['terminal-auth']` — 兼容尚未支持标准字段的客户端（如旧版 Zed、JetBrains 插件）

/**
 * Build the `terminal-auth` method advertised to ACP clients.
 *
 * Optional inputs:
 *  - `env`: extra env vars forwarded to the spawned `kimi login`
 *    subprocess (e.g. `{ KIMI_CODE_HOME: '/tmp/sandbox' }` for tests).
 *  - `legacyCommand`: absolute path of the agent binary, used to
 *    populate `_meta['terminal-auth'].command` so legacy clients can
 *    spawn `<binary> login` (top-level subcommand). When omitted, the
 *    `_meta` fallback is left off entirely.
 */
// 中文：构建终端认证方法对象，支持标准 ACP 路径和旧版 _meta 回退路径
export function buildTerminalAuthMethod(
  opts: {
    env?: Readonly<Record<string, string>>;
    legacyCommand?: string;
  } = {},
): AuthMethod {
  const env = opts.env ?? {};
  // 中文：构造标准 ACP 0.23 terminal 认证方法
  const method: AuthMethod = {
    id: 'login',
    type: 'terminal',
    name: 'Login with Kimi account',
    description: 'Open the device-code login flow in a terminal.',
    // Appended to the agent's configured args by spec-compliant clients
    // (e.g. `args:['acp']` + `args:['--login']` → `acp --login`). The
    // `--login` flag on `kimi acp` pivots into the login flow before
    // touching stdio.
    args: ['--login'],
    env: { ...env },
  };
  // 中文：若提供了 legacyCommand，附加旧版 _meta 回退以兼容旧客户端
  if (opts.legacyCommand !== undefined && opts.legacyCommand.length > 0) {
    (method as AuthMethod & { _meta: { 'terminal-auth': unknown } })._meta = {
      'terminal-auth': {
        type: 'terminal',
        label: 'Login with Kimi account',
        // Legacy clients use this verbatim as the executable path, NOT
        // combined with the agent server's configured command (per Zed's
        // `meta_terminal_auth_task` in `agent_servers/src/acp.rs`).
        command: opts.legacyCommand,
        // `<command> login` runs the top-level `kimi login` subcommand,
        // skipping the `acp` subprocess entirely. Same behaviour the
        // `kimi-cli` Python reference advertises.
        args: ['login'],
        env: { ...env },
      },
    };
  }
  return method;
}

/**
 * Default `terminal-auth` advertisement with no env propagation and no
 * legacy `_meta` fallback. Kept as a named export so test files that
 * only need the default shape can import it directly without going
 * through the factory.
 */
// 中文：默认的终端认证方法实例（无环境变量、无旧版回退），供测试直接导入使用
export const TERMINAL_AUTH_METHOD: AuthMethod = buildTerminalAuthMethod();

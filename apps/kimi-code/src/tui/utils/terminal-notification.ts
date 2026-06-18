import type { Terminal } from '@earendil-works/pi-tui';

import { BEL, ESC, MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH, ST } from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';

export interface TerminalNotification {
  readonly title: string;
  readonly body?: string | undefined;
}

export interface EmitOptions {
  readonly supportsOsc9?: boolean;
  readonly insideTmux?: boolean;
}

export interface BuildOptions {
  readonly supportsOsc9: boolean;
  readonly insideTmux: boolean;
}

export function notifyTerminalOnce(
  state: TUIState,
  key: string,
  notification: TerminalNotification,
): void {
  const { enabled, condition } = state.appState.notifications;
  if (!enabled) return;
  if (state.terminalState.notificationKeys.has(key)) return;
  state.terminalState.notificationKeys.add(key);
  if (condition === 'unfocused' && state.terminalState.focused) return;
  emitTerminalNotification(state.terminal, notification, {
    supportsOsc9: state.terminalState.supportsOsc9,
    insideTmux: state.terminalState.insideTmux,
  });
}

export function emitTerminalNotification(
  terminal: Pick<Terminal, 'write'>,
  notification: TerminalNotification,
  options: EmitOptions = {},
): void {
  const sequences = buildTerminalNotificationSequences(notification, {
    supportsOsc9: options.supportsOsc9 ?? supportsOsc9Notification(),
    insideTmux: options.insideTmux ?? isInsideTmux(),
  });
  for (const sequence of sequences) {
    terminal.write(sequence);
  }
}

export function formatNotification(notification: TerminalNotification): string {
  const title = sanitizeNotificationText(notification.title);
  const body = sanitizeNotificationText(notification.body ?? '');
  const message =
    title.length > 0 && body.length > 0 ? `${title}: ${body}` : title.length > 0 ? title : body;
  return message.slice(0, MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH);
}

/**
 * 构建终端通知的 OSC/BEL 字节序列。
 *
 * - `supportsOsc9 === true`：发出单个 OSC 9 序列——iTerm2、WezTerm、
 *   Kitty、Ghostty 和 Warp 使用的现代桌面通知路径。
 * - `supportsOsc9 === false`：回退到裸 BEL，以便在不识别 OSC 9 的
 *   终端上用户仍能收到系统铃声。
 *
 * 当 `insideTmux === true` 且正在发出 OSC 9 时，将序列包装在
 * tmux DCS 直通中（`ESC P tmux ; <payload> ESC \`），
 * 并将载荷中的任何 `ESC` 字节加倍——否则 tmux 会吞掉 OSC。
 * BEL 是单字节的，可以不受影响地通过 tmux，因此回退路径不需要包装。
 */
export function buildTerminalNotificationSequences(
  notification: TerminalNotification,
  options: BuildOptions,
): string[] {
  const message = formatNotification(notification);
  if (message.length === 0) return [];
  if (!options.supportsOsc9) {
    return [BEL];
  }
  const osc9 = `${ESC}]9;${message}${BEL}`;
  if (options.insideTmux) {
    const escaped = osc9.replaceAll(ESC, `${ESC}${ESC}`);
    return [`${ESC}Ptmux;${escaped}${ESC}${ST}`];
  }
  return [osc9];
}

/**
 * 尽力检测 OSC 9 桌面通知支持，完全基于已知环境变量驱动。
 * 白名单有意简短且保守，因为 BEL 在所有地方都是安全的，
 * 而向不识别 OSC 9 的终端发送它会在屏幕上打印转义垃圾字符。
 */
export function supportsOsc9Notification(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env['TERM_PROGRAM'] ?? '';
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'ghostty' ||
    termProgram === 'WarpTerminal'
  ) {
    return true;
  }
  const term = env['TERM'] ?? '';
  if (term === 'xterm-kitty' || term === 'xterm-ghostty') return true;
  return false;
}

/**
 * 尽力检测 ConEmu 风格的 OSC 9;4 进度支持，基于已知环境变量驱动，
 * 与 `supportsOsc9Notification` 类似。
 * 两个白名单必须保持独立：iTerm2 对收到的任何 `OSC 9;<payload>`
 * 都会发布桌面通知，因此在那里发送 9;4 进度序列会在每次心跳时
 * 弹出一个 "4;3" 通知。此列表之外的终端不会获得进度报告，
 * 这始终是安全的。
 */
export function supportsTerminalProgress(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env['WT_SESSION'] ?? '').length > 0) return true;
  if (env['ConEmuANSI'] === 'ON') return true;
  const termProgram = env['TERM_PROGRAM'] ?? '';
  if (termProgram === 'ghostty' || termProgram === 'WezTerm') return true;
  const term = env['TERM'] ?? '';
  if (term === 'xterm-ghostty') return true;
  return false;
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  const tmux = env['TMUX'] ?? '';
  return tmux.length > 0;
}

function sanitizeNotificationText(value: string): string {
  return Array.from(value)
    .map((ch) => (isControlCharacter(ch) ? ' ' : ch))
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function isControlCharacter(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

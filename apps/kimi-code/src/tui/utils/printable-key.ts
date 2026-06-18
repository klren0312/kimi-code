/**
 * 将原始 stdin 字节解码为可比较的可打印字符。
 *
 * 当终端（例如 VSCode 集成终端）启用了 Kitty 键盘协议消歧标志时，
 * 普通可打印键会以 CSI-u 序列发送：按 `r` 会收到 "\x1b[114u"，
 * 按 `q` 会收到 "\x1b[113u"。因此在 Kitty 模式终端下，Container 的
 * `handleInput` 中直接使用 `data === 'q'` 比较永远不会匹配。
 *
 * 规则：
 * - 所有裸字面量可打印字符比较（字母、数字、空格、标点）必须先通过此函数处理。
 * - 功能键（方向键、Enter、Tab、Esc 等）继续使用 `matchesKey(data, Key.*)`；
 *   pi-tui 的 `matchesKey` 已经处理了 Kitty 协议。
 * - 控制字符（码位 < 32，如 ctrl-b、ctrl-f）仍可直接与原始 `data` 比较
 *   ——`decodeKittyPrintable` 会拒绝它们。
 *
 * 此模块的存在本身就是"不要忘记解码"的约束：
 * `test/tui/printable-key-guard.test.ts` 会扫描 `tui/components/**` 下的每个
 * `handleInput`，并拒绝裸字面量比较。
 */

import { decodeKittyPrintable } from '@earendil-works/pi-tui';

export function printableChar(data: string): string {
  return decodeKittyPrintable(data) ?? data;
}

/**
 * 当解码后的键是单个可打印字符、可以安全地追加到文本查询（如搜索框）时返回 true。
 * 拒绝 C0 控制字符、DEL 以及任何多码位转义序列。空格是被接受的。
 */
export function isPrintableChar(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f;
}

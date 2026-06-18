import { OSC11_RESPONSE } from "#/tui/constant/terminal";

import type { ResolvedTheme } from "./colors";

export function parseOsc11BackgroundTheme(data: string): ResolvedTheme | null {
  const match = OSC11_RESPONSE.exec(data);
  if (match === null) return null;
  const [, r, g, b] = match;
  if (r === undefined || g === undefined || b === undefined) return null;
  return themeFromHexChannels(r, g, b);
}

export function themeFromHexChannels(rHex: string, gHex: string, bHex: string): ResolvedTheme {
  const r = normalizeChannel(rHex);
  const g = normalizeChannel(gHex);
  const b = normalizeChannel(bHex);
  // 相对亮度，sRGB 线性化。阈值 0.5 能可靠地区分纯黑（#000）
  // 和纯白（#fff）等深色/浅色背景。
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.5 ? "light" : "dark";
}

function normalizeChannel(hex: string): number {
  // OSC 11 通道可以是 1-4 位十六进制数字。统一缩放到 [0,1] 范围。
  const max = (1 << (hex.length * 4)) - 1;
  const value = parseInt(hex, 16);
  return Number.isFinite(value) ? value / max : 0;
}

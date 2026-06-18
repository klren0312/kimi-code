/**
 * 终端背景检测。
 *
 * 策略，按优先级排列：
 *   1. 拒绝——非 TTY、NO_COLOR、FORCE_COLOR=0、CI → 安全返回 `'dark'`。
 *   2. OSC 11——写入 `ESC ] 11 ; ? BEL`，解析 `ESC ] 11 ; rgb:RR/GG/BB BEL`，
 *      计算相对亮度。超时上限为 `timeoutMs`，防止不支持的终端挂起。
 *   3. COLORFGBG——VT100 / xterm 回退方案，暴露 `"fg;bg"`。
 *   4. 默认——`'dark'`。
 *
 * 必须在 pi-tui 进入原始模式之前运行；一旦框架接管 stdin，
 * OSC 回复就会被输入循环吞掉。
 */

import { OSC11_QUERY, TERMINAL_THEME_DETECT_TIMEOUT_MS } from "#/tui/constant/terminal";

import type { ResolvedTheme } from "./colors";
import { parseOsc11BackgroundTheme } from "./terminal-background";

export interface DetectOptions {
  readonly timeoutMs?: number;
}

export async function detectTerminalTheme(opts: DetectOptions = {}): Promise<ResolvedTheme> {
  if (!isInteractiveTerminal()) return "dark";
  if (isColorOptOut()) return "dark";

  const fromOsc = await queryOsc11({
    timeoutMs: opts.timeoutMs ?? TERMINAL_THEME_DETECT_TIMEOUT_MS,
  });
  if (fromOsc !== null) return fromOsc;

  const fromColorFgBg = parseColorFgBg(process.env["COLORFGBG"]);
  if (fromColorFgBg !== null) return fromColorFgBg;

  return "dark";
}

function isInteractiveTerminal(): boolean {
  return (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
}

function isColorOptOut(): boolean {
  const env = process.env;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return true;
  if (env["FORCE_COLOR"] === "0") return true;
  if (env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "0") return true;
  return false;
}

interface RawModeStdin {
  isRaw?: boolean;
  setRawMode(mode: boolean): NodeJS.ReadStream;
  on(event: "data", listener: (data: Buffer) => void): NodeJS.ReadStream;
  off(event: "data", listener: (data: Buffer) => void): NodeJS.ReadStream;
}

async function queryOsc11(opts: { timeoutMs: number }): Promise<ResolvedTheme | null> {
  const stdin = process.stdin as unknown as RawModeStdin;
  if (typeof stdin.setRawMode !== "function") return null;
  // 如果已有其他程序在监听 stdin（例如另一个原始模式消费者），
  // 不要与之争夺——改用 COLORFGBG。
  if (process.stdin.listenerCount("data") > 0) return null;

  const wasRaw = stdin.isRaw === true;
  let buffer = "";
  let listener: ((data: Buffer) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    if (!wasRaw) stdin.setRawMode(true);

    const result = await new Promise<ResolvedTheme | null>((resolve) => {
      listener = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        const theme = parseOsc11BackgroundTheme(buffer);
        if (theme !== null) resolve(theme);
      };
      stdin.on("data", listener);
      timer = setTimeout(() => {
        resolve(null);
      }, opts.timeoutMs);
      try {
        process.stdout.write(OSC11_QUERY);
      } catch {
        resolve(null);
      }
    });

    return result;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (listener !== null) stdin.off("data", listener);
    if (!wasRaw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* 忽略——原始模式恢复为尽力而为 */
      }
    }
  }
}

/**
 * COLORFGBG 格式为 `"fg;bg"`（有时为 `"fg;default;bg"`）。最后一个
 * token 是背景的 ANSI 16 色索引；0-6 和 8 为暗色，其余为亮色。
 */
export function parseColorFgBg(value: string | undefined): ResolvedTheme | null {
  if (value === undefined || value === "") return null;
  const parts = value.split(";");
  const bgRaw = parts.at(-1);
  if (bgRaw === undefined) return null;
  const bg = parseInt(bgRaw, 10);
  if (!Number.isInteger(bg)) return null;
  // ANSI 0=黑色, 1=红色, 2=绿色, 3=黄色, 4=蓝色, 5=品红, 6=青色, 8=亮黑。
  const darkBgs = new Set([0, 1, 2, 3, 4, 5, 6, 8]);
  return darkBgs.has(bg) ? "dark" : "light";
}

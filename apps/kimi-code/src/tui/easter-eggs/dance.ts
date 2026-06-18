/**
 * `/dance` 彩蛋——所需的一切都在这个文件中：彩虹文字着色、
 * 动画状态机和命令处理器。移除此功能即"删除此文件及其导入位置"。
 *
 * 故意不注册到 BUILTIN_SLASH_COMMANDS，因此不出现在 `/help` 和自动补全中；
 * `executeSlashCommand` 在内置/技能解析之后作为回退调用处理器，
 * 因此真正的命令或同名技能总是优先。
 */

import chalk from 'chalk';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import type { SlashCommandHost } from '../commands/dispatch';
import type { ParsedSlashInput } from '../commands/types';
import { currentTheme } from '../theme';

/** 彩虹流动动画的帧间隔。 */
export const DANCE_FRAME_MS = 110;
/** 彩虹在定格（淡出或冻结）前流动的持续时间。 */
export const DANCE_FLOW_MS = 3000;

const DARK_RAINBOW = [
  '#4FA8FF',
  '#5BC0BE',
  '#4EC87E',
  '#E8A838',
  '#FFCB6B',
  '#C678B8',
  '#A274D9',
  '#7C8DFF',
] as const;

const LIGHT_RAINBOW = [
  '#1565C0',
  '#00838F',
  '#0E7A38',
  '#92660A',
  '#9A4A00',
  '#B91C1C',
  '#8A3A75',
  '#6B3A9A',
  '#354CB5',
] as const;

function getDanceRainbowPalette(): readonly [string, ...string[]] {
  return currentTheme.palette.text === '#1A1A1A' ? LIGHT_RAINBOW : DARK_RAINBOW;
}

/** 逐字符通过调色板着色字符串，跳过空格。 */
export function rainbowText(
  text: string,
  colors: readonly [string, ...string[]],
  offset = 0,
  bold = false,
): string {
  let colorIndex = offset;
  return Array.from(text)
    .map((char) => {
      if (char === ' ') return char;
      const color = colors[colorIndex % colors.length] ?? colors[0];
      colorIndex++;
      const style = chalk.hex(color);
      return bold ? style.bold(char) : style(char);
    })
    .join('');
}

/** 仅用于渲染的组件的舞蹈状态只读视图。 */
export interface RainbowDanceView {
  /** 消费者是否应使用彩虹色着色。 */
  readonly colored: boolean;
  /** 调色板偏移量，在彩虹流动时递增。 */
  readonly phase: number;
}

export interface RainbowDanceController extends RainbowDanceView {
  start(opts: { hold: boolean }): void;
  stop(): void;
  dispose(): void;
}

let currentDanceController: RainbowDanceController | undefined;
let currentDanceView: RainbowDanceView | undefined;

export function setRainbowDance(dance: RainbowDanceController | undefined): void {
  currentDanceController = dance;
  currentDanceView = dance;
}

export function installRainbowDance(requestRender: () => void): () => void {
  currentDanceController?.dispose();
  const dance = new RainbowDance(requestRender);
  setRainbowDance(dance);
  return () => {
    dance.dispose();
    if (currentDanceController === dance) {
      setRainbowDance(undefined);
    }
  };
}

export function getRainbowDanceView(): RainbowDanceView | undefined {
  return currentDanceView;
}

export function isRainbowDancing(): boolean {
  return currentDanceView?.colored === true;
}

export function renderDanceWelcomeHeader(
  logo: readonly [string, string],
  textWidth: number,
  rightRow1: string,
): string[] {
  const phase = currentDanceView?.phase ?? 0;
  const palette = getDanceRainbowPalette();
  const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
  const gap = '  ';
  const rightRow0 = truncateToWidth(
    rainbowText('Welcome to Kimi Code!', palette, phase + 2, true),
    textWidth,
    '…',
  );

  return [
    rainbowText(logo[0].padEnd(logoWidth), palette, phase) + gap + rightRow0,
    rainbowText(logo[1].padEnd(logoWidth), palette, phase + 3) + gap + rightRow1,
  ];
}

export function renderDanceFooterModel(modelLabel: string): string {
  return rainbowText(modelLabel, getDanceRainbowPalette(), currentDanceView?.phase ?? 0);
}

/**
 * 驱动彩虹动画：单个定时器推进共享的 `phase` 并请求 UI 重绘。
 * 独立于任何组件存在，因此欢迎横幅的滚动或重建不会干扰动画。
 * 三种状态：关闭（默认）、流动、冻结的静态彩虹。
 */
export class RainbowDance implements RainbowDanceController {
  private currentPhase = 0;
  private isColored = false;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private flowStopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly requestRender: () => void;

  constructor(requestRender: () => void) {
    this.requestRender = requestRender;
  }

  get colored(): boolean {
    return this.isColored;
  }

  get phase(): number {
    return this.currentPhase;
  }

  /**
   * 让彩虹流动 `DANCE_FLOW_MS`，然后定格：
   *  - `hold: false` → 淡出回默认（无色）横幅。
   *  - `hold: true`  → 冻结为持续显示的静态彩虹。
   */
  start(opts: { hold: boolean }): void {
    this.clearTimers();
    this.isColored = true;
    this.frameTimer = setInterval(() => {
      // Phase 只是递增；rainbowText() 会对*当前*调色板长度取模，
      // 因此动画无需知道调色板大小。
      this.currentPhase += 1;
      this.requestRender();
    }, DANCE_FRAME_MS);
    this.flowStopTimer = setTimeout(() => {
      this.settle(opts.hold);
    }, DANCE_FLOW_MS);
    this.requestRender();
  }

  /** 关闭彩虹——恢复默认颜色。 */
  stop(): void {
    this.clearTimers();
    this.isColored = false;
    this.currentPhase = 0;
    this.requestRender();
  }

  /**
   * 清除定时器但不重绘——用于关闭场景，此时 UI 即将消失，
   * 最终渲染会被浪费或写入已停止的终端。
   */
  dispose(): void {
    this.clearTimers();
  }

  /** 结束流动：冻结彩虹（hold）或淡出回默认。 */
  private settle(hold: boolean): void {
    this.clearTimers();
    if (!hold) {
      this.isColored = false;
      this.currentPhase = 0;
    }
    this.requestRender();
  }

  private clearTimers(): void {
    if (this.frameTimer !== null) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.flowStopTimer !== null) {
      clearTimeout(this.flowStopTimer);
      this.flowStopTimer = null;
    }
  }
}

/**
 * 处理 `/dance`：
 *   /dance       流动几秒后淡出回默认颜色
 *   /dance on    流动后冻结为持续显示的静态彩虹
 *   /dance off   关闭彩虹
 *
 * 当输入被消费时返回 true。
 */
export function tryHandleDanceCommand(host: SlashCommandHost, parsed: ParsedSlashInput): boolean {
  if (parsed.name !== 'dance') return false;
  if (currentDanceController === undefined) return false;

  // 状态行会将整条消息变暗，导致命令在提示中难以辨认。
  // 仅将命令用品牌色（粗体）着色使其作为命令可读；
  // chalk 嵌套会在其后恢复暗色。
  const cmd = (text: string): string => currentTheme.boldFg('primary', text);

  const sub = parsed.args.trim().toLowerCase();
  if (sub === 'off') {
    currentDanceController.stop();
  } else if (sub === 'on') {
    currentDanceController.start({ hold: true });
    host.showStatus(`Dancing — use ${cmd('/dance off')} to turn it off.`);
  } else {
    currentDanceController.start({ hold: false });
    host.showStatus(`Use ${cmd('/dance on')} to keep the rainbow on.`);
  }
  return true;
}

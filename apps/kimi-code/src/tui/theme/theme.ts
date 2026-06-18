/**
 * Theme 类 + 全局单例。
 *
 * 组件导入 `currentTheme` 并在渲染时调用如
 * `currentTheme.fg('primary', text)` 的方法。当用户切换主题时，
 * 我们调用 `currentTheme.setPalette(newPalette)`——同一个单例实例
 * 保持存活，因此每个组件（包括已渲染的对话条目）在下一个渲染帧
 * 都会看到新的颜色。
 */

import chalk from 'chalk';

import type { ColorPalette } from './colors';
import { darkColors } from './colors';

export type ColorToken = keyof ColorPalette;

export class Theme {
  private _palette: ColorPalette;

  constructor(palette: ColorPalette) {
    this._palette = palette;
  }

  get palette(): ColorPalette {
    return this._palette;
  }

  setPalette(palette: ColorPalette): void {
    this._palette = palette;
  }

  color(token: ColorToken): string {
    return this._palette[token];
  }

  /* ── 前景辅助方法 ── */

  fg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token])(text);
  }

  boldFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).bold(text);
  }

  dimFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).dim(text);
  }

  italicFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).italic(text);
  }

  underlineFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).underline(text);
  }

  strikethroughFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).strikethrough(text);
  }

  /* ── 背景辅助方法 ── */

  bg(token: ColorToken, text: string): string {
    return chalk.bgHex(this._palette[token])(text);
  }

  /* ── 独立样式辅助方法 ── */

  bold(text: string): string {
    return chalk.bold(text);
  }

  dim(text: string): string {
    return chalk.dim(text);
  }

  italic(text: string): string {
    return chalk.italic(text);
  }

  underline(text: string): string {
    return chalk.underline(text);
  }

  strikethrough(text: string): string {
    return chalk.strikethrough(text);
  }
}

/** 全局单例。使用暗色调色板初始化；通过 `setPalette` 切换。 */
export const currentTheme = new Theme(darkColors);

/**
 * 主题系统公共 API。
 */

import { getBuiltInPalette } from './colors';
import type { ColorPalette, ResolvedTheme } from './colors';
import { loadCustomThemeMerged } from './custom-theme-loader';
import { detectTerminalTheme } from './detect';

export { currentTheme, Theme } from './theme';
export type { ColorToken } from './theme';
export { darkColors, lightColors, getBuiltInPalette } from './colors';
export type { ColorPalette, ResolvedTheme } from './colors';
export { detectTerminalTheme } from './detect';
export { loadCustomTheme, loadCustomThemeMerged, listCustomThemes } from './custom-theme-loader';

/**
 * 用户可见的主题偏好设置。
 * `'auto'` 在启动时由终端背景检测决定。
 * `'dark'` / `'light'` 是显式的内置覆盖。
 * 其他字符串被视为自定义主题名称，在
 * `~/.kimi-code/themes/<name>.json` 中查找。
 */
export type BuiltInTheme = 'dark' | 'light' | 'auto';
export type ThemeName = BuiltInTheme | (string & {});

export function isBuiltInTheme(value: string): value is BuiltInTheme {
  return value === 'dark' || value === 'light' || value === 'auto';
}

export function isThemeName(_value: string): _value is ThemeName {
  return true; // 任何字符串都是有效的主题名称（自定义主题）
}

/**
 * 将用户偏好解析为具体的调色板。
 *
 * - `'auto'` 触发终端背景检测。
 * - `'dark'` / `'light'` 返回内置调色板。
 * - 其他字符串从 `~/.kimi-code/themes/` 加载自定义主题；
 *   缺失或无效的文件回退到暗色调色板。
 */
export async function getColorPalette(theme: ThemeName): Promise<ColorPalette> {
  if (theme === 'light') return getBuiltInPalette('light');
  if (theme === 'dark') return getBuiltInPalette('dark');
  if (theme === 'auto') {
    const detected = await detectTerminalTheme();
    return getBuiltInPalette(detected);
  }
  // 自定义主题
  const custom = await loadCustomThemeMerged(theme);
  return custom ?? getBuiltInPalette('dark');
}

/**
 * 同步回退方案，用于无法等待终端探测的路径。
 * `'auto'` 退化为 `'dark'`；显式选择直接传递。
 * 此处不支持自定义主题——回退到暗色。
 */
export function getColorPaletteSync(theme: ThemeName): ColorPalette {
  if (theme === 'light') return getBuiltInPalette('light');
  return getBuiltInPalette('dark');
}

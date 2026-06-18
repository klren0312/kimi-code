/**
 * 自定义主题加载器——从 `~/.kimi-code/themes/` 读取 JSON 文件。
 */

import { readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { getDataDir } from '#/utils/paths';
import type { ColorPalette, ResolvedTheme } from './colors';
import { getBuiltInPalette } from './colors';

export const CustomThemeSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  /** 未指定 token 回退使用的内置调色板。默认为 `dark`。 */
  base: z.enum(['dark', 'light']).optional(),
  colors: z.record(z.string(), z.string()).optional(),
});

export type CustomThemeDefinition = z.infer<typeof CustomThemeSchema>;

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * 内置主题的保留名称。`dark.json` / `light.json` / `auto.json` 文件
 * 会与内置值冲突，因此永远不能作为自定义主题被选择——从列表中隐藏。
 */
const RESERVED_THEME_NAMES: ReadonlySet<string> = new Set(['dark', 'light', 'auto']);

export function getCustomThemesDir(): string {
  return join(getDataDir(), 'themes');
}

interface ParsedCustomTheme {
  readonly base: ResolvedTheme;
  readonly colors: Partial<ColorPalette>;
}

async function readCustomTheme(name: string): Promise<ParsedCustomTheme | null> {
  try {
    const content = await readFile(join(getCustomThemesDir(), `${name}.json`), 'utf-8');
    const parsed = CustomThemeSchema.parse(JSON.parse(content));

    // 无效的十六进制值会被丢弃（该 token 回退到基础调色板）。
    // 我们有意不在此处打印：此加载器可能在 pi-tui 拥有终端时运行，
    // 此时原始的 stdout/stderr 写入会损坏已渲染的屏幕。
    // 编写时的验证在 JSON schema 中完成。
    const colors = Object.fromEntries(
      Object.entries(parsed.colors ?? {}).filter(([, v]) => HEX_COLOR_REGEX.test(v)),
    ) as Partial<ColorPalette>;

    return { base: parsed.base ?? 'dark', colors };
  } catch {
    return null;
  }
}

export async function loadCustomTheme(name: string): Promise<Partial<ColorPalette> | null> {
  return (await readCustomTheme(name))?.colors ?? null;
}

/** 加载自定义主题并将其合并到基础调色板上（除非 `base` 另有指定，否则为暗色）。 */
export async function loadCustomThemeMerged(name: string): Promise<ColorPalette | null> {
  const parsed = await readCustomTheme(name);
  if (parsed === null) return null;
  return { ...getBuiltInPalette(parsed.base), ...parsed.colors };
}

function toThemeNames(files: readonly string[]): string[] {
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((name) => !RESERVED_THEME_NAMES.has(name));
}

export async function listCustomThemes(): Promise<string[]> {
  try {
    const entries = await readdir(getCustomThemesDir(), { withFileTypes: true });
    return toThemeNames(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return [];
  }
}

/** 同步变体，用于无法使用 await 的 UI 路径（例如 `/theme` 选择器）。 */
export function listCustomThemesSync(): string[] {
  try {
    const entries = readdirSync(getCustomThemesDir(), { withFileTypes: true });
    return toThemeNames(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return [];
  }
}

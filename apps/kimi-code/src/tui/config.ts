/**
 * 客户端偏好设置。
 *
 * Agent/运行时设置位于 core 的 `config.toml` 中；本文件管理
 * kimi-code 客户端偏好，如终端 UI 和更新行为。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { getDataDir } from '#/utils/paths';

export const INVALID_TUI_CONFIG_MESSAGE =
  'Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.';

export const TuiThemeSchema = z.string();

export const NotificationConditionSchema = z.enum(['unfocused', 'always']);

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean(),
  condition: NotificationConditionSchema,
});

export const UpgradePreferencesSchema = z.object({
  autoInstall: z.boolean(),
});

export const TuiConfigFileSchema = z.object({
  theme: TuiThemeSchema.optional(),
  editor: z
    .object({
      command: z.string().optional(),
    })
    .optional(),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      notification_condition: NotificationConditionSchema.optional(),
    })
    .optional(),
  upgrade: z
    .object({
      auto_install: z.boolean().optional(),
    })
    .optional(),
});

export const TuiConfigSchema = z.object({
  theme: TuiThemeSchema,
  editorCommand: z.string().nullable(),
  notifications: NotificationsConfigSchema,
  upgrade: UpgradePreferencesSchema,
});

export type TuiConfigFileShape = z.infer<typeof TuiConfigFileSchema>;
export type TuiConfig = z.infer<typeof TuiConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type UpgradePreferences = z.infer<typeof UpgradePreferencesSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  condition: 'unfocused',
};

export const DEFAULT_UPGRADE_PREFERENCES: UpgradePreferences = {
  autoInstall: true,
};

export const DEFAULT_TUI_CONFIG: TuiConfig = TuiConfigSchema.parse({
  theme: 'auto',
  editorCommand: null,
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  upgrade: DEFAULT_UPGRADE_PREFERENCES,
});

/**
 * 当磁盘上的 TOML 无法解析时由 `loadTuiConfig` 抛出。
 * 携带 `fallback` 以便调用方无需重新执行 I/O 即可恢复，
 * 并将 `message`（== `INVALID_TUI_CONFIG_MESSAGE`）作为面向用户的提示。
 */
export class TuiConfigParseError extends Error {
  override readonly name = 'TuiConfigParseError';
  readonly fallback: TuiConfig;
  constructor(fallback: TuiConfig) {
    super(INVALID_TUI_CONFIG_MESSAGE);
    this.fallback = fallback;
  }
}

export function getTuiConfigPath(): string {
  return join(getDataDir(), 'tui.toml');
}

export async function loadTuiConfig(filePath: string = getTuiConfigPath()): Promise<TuiConfig> {
  if (!existsSync(filePath)) {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);
    return DEFAULT_TUI_CONFIG;
  }

  try {
    const text = await readFile(filePath, 'utf-8');
    return parseTuiConfig(text);
  } catch {
    throw new TuiConfigParseError(DEFAULT_TUI_CONFIG);
  }
}

export function parseTuiConfig(tomlText: string): TuiConfig {
  if (tomlText.trim().length === 0) {
    return DEFAULT_TUI_CONFIG;
  }
  const raw = parseToml(tomlText) as Record<string, unknown>;
  const parsed = TuiConfigFileSchema.parse(raw);
  return normalizeTuiConfig(parsed);
}

export async function saveTuiConfig(
  config: TuiConfig,
  filePath: string = getTuiConfigPath(),
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, renderTuiConfig(config), 'utf-8');
}

export function normalizeTuiConfig(config: TuiConfigFileShape): TuiConfig {
  const command = config.editor?.command?.trim();
  return TuiConfigSchema.parse({
    theme: config.theme ?? DEFAULT_TUI_CONFIG.theme,
    editorCommand: command === undefined || command.length === 0 ? null : command,
    notifications: {
      enabled: config.notifications?.enabled ?? DEFAULT_NOTIFICATIONS_CONFIG.enabled,
      condition:
        config.notifications?.notification_condition ?? DEFAULT_NOTIFICATIONS_CONFIG.condition,
    },
    upgrade: {
      autoInstall: config.upgrade?.auto_install ?? DEFAULT_UPGRADE_PREFERENCES.autoInstall,
    },
  });
}

export function renderTuiConfig(config: TuiConfig): string {
  return `# ~/.kimi-code/tui.toml
# kimi-code 客户端偏好设置。
# Agent/运行时设置位于 ~/.kimi-code/config.toml。

theme = "${escapeTomlBasicString(config.theme)}" # "auto" | "dark" | "light" | 自定义主题名称

[editor]
command = "${escapeTomlBasicString(config.editorCommand ?? '')}" # 留空则使用 $VISUAL / $EDITOR

[notifications]
enabled = ${String(config.notifications.enabled)} # true | false
notification_condition = "${config.notifications.condition}" # "unfocused" | "always"

[upgrade]
auto_install = ${String(config.upgrade.autoInstall)} # true | false
`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r');
}

// Slash-command detection for ACP `session/prompt`.
//
// Copied from the TUI's `apps/kimi-code/src/tui/commands/parse.ts` and the
// skill-resolution slice of `apps/kimi-code/src/tui/commands/resolve.ts`
// (`resolveSkillCommand`). ACP only intercepts commands the adapter can execute
// directly: skills plus the small ACP-owned built-in command set. Other slash
// inputs are reported as unknown commands instead of being silently sent to the
// model as prompt text.
//
// Sync target: if the TUI parser's accepted grammar changes (e.g. the
// "no `/` inside name" rule), update the duplicate here too.

import {
  ACP_BUILTIN_SLASH_COMMAND_NAMES,
  type AcpBuiltinSlashCommandName,
} from './builtin-commands';

// ── 中文概述 ──
// 本模块负责 ACP `session/prompt` 中斜杠命令（slash command）的检测与解析。
// 核心功能：解析用户输入的 `/xxx args` 格式，将其分类为技能命令、内置命令、
// 未知命令或直通文本（非斜杠输入），以便 ACP 适配器决定执行路径。
// 代码从 TUI 的 `parse.ts` 和 `resolve.ts` 同步而来，需保持语法一致性。

// 中文：斜杠命令解析后的结构，包含命令名和参数
export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

// 中文：斜杠命令意图的联合类型——技能命令、内置命令、未知命令或直通文本
export type SlashIntent =
  | { readonly kind: 'skill'; readonly skillName: string; readonly args: string }
  | { readonly kind: 'builtin'; readonly name: AcpBuiltinSlashCommandName; readonly args: string }
  | { readonly kind: 'unknown'; readonly name: string; readonly args: string }
  | { readonly kind: 'passthrough' };

// 中文：解析斜杠命令输入，提取命令名和参数；非斜杠开头或名称含 `/` 则返回 null
export function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  // 中文：以首个空格分割命令名和参数
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  // 中文：命令名中不允许包含 `/`，防止嵌套路径注入
  if (name.includes('/')) return null;
  return { name, args };
}

// 中文：从技能命令映射表中查找命令对应技能名，支持带/不带 `skill:` 前缀两种格式
export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

// 中文：检测输入文本的斜杠命令意图，按优先级依次判断为技能命令、内置命令、未知命令或直通文本
export function detectSlashIntent(
  text: string,
  skillCommandMap: ReadonlyMap<string, string>,
  builtinCommandNames: ReadonlySet<string> = ACP_BUILTIN_SLASH_COMMAND_NAMES,
): SlashIntent {
  // 中文：先尝试解析斜杠命令格式
  const parsed = parseSlashInput(text);
  if (parsed === null) return { kind: 'passthrough' };
  // 中文：优先匹配技能命令
  const skillName = resolveSkillCommand(skillCommandMap, parsed.name);
  if (skillName !== undefined) {
    return { kind: 'skill', skillName, args: parsed.args };
  }
  // 中文：其次匹配内置命令
  if (builtinCommandNames.has(parsed.name)) {
    return { kind: 'builtin', name: parsed.name as AcpBuiltinSlashCommandName, args: parsed.args };
  }
  // 中文：均未匹配则标记为未知命令
  return { kind: 'unknown', name: parsed.name, args: parsed.args };
}

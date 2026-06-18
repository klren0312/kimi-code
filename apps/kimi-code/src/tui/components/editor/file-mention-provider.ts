import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  CombinedAutocompleteProvider,
  fuzzyMatch,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui';

const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);
const MAX_FALLBACK_SCAN = 2000;
const MAX_FALLBACK_SUGGESTIONS = 50;

export interface SlashAutocompleteCommand extends SlashCommand {
  readonly aliases?: readonly string[];
}

interface FsMentionCandidate {
  readonly path: string;
  readonly isDirectory: boolean;
}

/**
 * Kimi 对 pi-tui 组合自动补全提供器的包装。
 *
 * 文件/文件夹提及功能在 fd 可用时使用 pi-tui 的 fd 后端提供器。
 * 在托管 fd 下载期间（或不可用时），一个小型文件系统回退
 * 保持基本的 `@` 文件和文件夹补全可用。
 * 普通路径补全仍由 pi-tui 的 readdir 后端路径补全器处理。
 * 此包装器还保留了 Kimi 特有的斜杠命令守卫。
 */
export class FileMentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider;

  constructor(
    private readonly slashCommands: SlashAutocompleteCommand[],
    private readonly workDir: string,
    private readonly fdPath: string | null,
  ) {
    // 构建一个包含别名条目的扩展列表，
    // 使内部的参数补全也能通过别名找到命令。
    const expanded: SlashAutocompleteCommand[] = [];
    for (const cmd of slashCommands) {
      expanded.push(cmd);
      for (const alias of cmd.aliases ?? []) {
        expanded.push({ ...cmd, name: alias });
      }
    }
    this.inner = new CombinedAutocompleteProvider(expanded, workDir, fdPath);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? '';
    const textBeforeCursor = currentLine.slice(0, cursorCol);

    if (shouldSuppressLeadingWhitespaceSlashPath(textBeforeCursor, options.force)) {
      return null;
    }

    if (
      shouldSuppressSlashArgumentCompletion(
        textBeforeCursor,
        currentLine.slice(cursorCol),
        options.force,
      )
    ) {
      return null;
    }

    const atPrefix = extractAtPrefix(textBeforeCursor);
    if (atPrefix !== null) {
      if (this.fdPath === null) {
        return getFsMentionSuggestions(this.workDir, atPrefix, options.signal);
      }
      try {
        return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
      } catch {
        // 如果 fd 意外启动失败，保持 @ 补全可用。
        return getFsMentionSuggestions(this.workDir, atPrefix, options.signal);
      }
    }

    // 自行处理斜杠命令名称补全，使别名可搜索且在标签中可见。
    if (!options.force && textBeforeCursor.startsWith('/')) {
      const spaceIndex = textBeforeCursor.indexOf(' ');
      if (spaceIndex === -1) {
        const tokens = textBeforeCursor
          .slice(1)
          .trim()
          .split(/\s+/)
          .filter((t) => t.length > 0);

        type SlashMatch = {
          cmd: SlashAutocompleteCommand;
          score: number;
          viaAlias: boolean;
          label: string;
        };
        const matches: SlashMatch[] = [];

        for (const cmd of this.slashCommands) {
          const nameScore = scoreTokens(tokens, cmd.name);
          if (nameScore !== null) {
            matches.push({ cmd, score: nameScore, viaAlias: false, label: cmd.name });
            continue;
          }
          // 别名仅在主名称未匹配时才计入；标签会列出它们，
          // 以便用户了解命令匹配的原因。
          const aliases = cmd.aliases ?? [];
          let bestAliasScore: number | null = null;
          for (const alias of aliases) {
            const aliasScore = scoreTokens(tokens, alias);
            if (aliasScore !== null && (bestAliasScore === null || aliasScore < bestAliasScore)) {
              bestAliasScore = aliasScore;
            }
          }
          if (bestAliasScore !== null) {
            matches.push({
              cmd,
              score: bestAliasScore,
              viaAlias: true,
              label: `${cmd.name} (${aliases.join(', ')})`,
            });
          }
        }

        // 主名称匹配在分数相同时优先于别名匹配。
        matches.sort((a, b) => a.score - b.score || Number(a.viaAlias) - Number(b.viaAlias));

        if (matches.length === 0) return null;
        return {
          items: matches.map((m) => ({
            value: m.cmd.name,
            label: m.label,
            description: formatSlashCommandDescription(m.cmd),
          })),
          prefix: textBeforeCursor,
        };
      }
    }

    try {
      return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    } catch {
      return null;
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

function extractAtPrefix(text: string): string | null {
  let tokenStart = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? '')) {
      tokenStart = i + 1;
      break;
    }
  }
  if (text[tokenStart] !== '@') return null;
  return text.slice(tokenStart);
}

function getFsMentionSuggestions(
  workDir: string,
  atPrefix: string,
  signal: AbortSignal,
): AutocompleteSuggestions | null {
  if (signal.aborted) return null;

  const query = atPrefix.slice(1);
  const candidates = collectFsMentionCandidates(workDir, signal);
  if (candidates.length === 0 || signal.aborted) return null;

  const ranked = rankFsMentionCandidates(candidates, query).slice(0, MAX_FALLBACK_SUGGESTIONS);
  if (ranked.length === 0) return null;

  return {
    prefix: atPrefix,
    items: ranked.map(toMentionItem),
  };
}

function collectFsMentionCandidates(workDir: string, signal: AbortSignal): FsMentionCandidate[] {
  const result: FsMentionCandidate[] = [];
  const stack = [''];

  while (stack.length > 0 && result.length < MAX_FALLBACK_SCAN) {
    if (signal.aborted) break;
    const relativeDir = stack.pop() ?? '';
    const absoluteDir = relativeDir.length === 0 ? workDir : join(workDir, relativeDir);
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (signal.aborted || result.length >= MAX_FALLBACK_SCAN) break;
      if (entry.name === '.git') continue;

      const relativePath = normalizePath(relativeDir.length === 0 ? entry.name : join(relativeDir, entry.name));
      const isSymlink = entry.isSymbolicLink();
      let isDirectory = entry.isDirectory();
      if (!isDirectory && isSymlink) {
        try {
          isDirectory = statSync(join(workDir, relativePath)).isDirectory();
        } catch {
          // 损坏的符号链接或权限错误——保持为文件候选。
        }
      }

      result.push({ path: relativePath, isDirectory });
      if (isDirectory && !isSymlink) {
        stack.push(relativePath);
      }
    }
  }

  return result;
}

function rankFsMentionCandidates(
  candidates: readonly FsMentionCandidate[],
  query: string,
): FsMentionCandidate[] {
  const lowerQuery = query.toLowerCase();
  const scored: Array<{ candidate: FsMentionCandidate; score: number }> = [];

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, lowerQuery);
    if (score > 0) scored.push({ candidate, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.candidate.isDirectory !== b.candidate.isDirectory) {
      return a.candidate.isDirectory ? -1 : 1;
    }
    return a.candidate.path.localeCompare(b.candidate.path);
  });

  return scored.map((entry) => entry.candidate);
}

function scoreCandidate(candidate: FsMentionCandidate, lowerQuery: string): number {
  if (lowerQuery.length === 0) {
    const depthPenalty = candidate.path.split('/').length - 1;
    return (candidate.isDirectory ? 120 : 100) - depthPenalty;
  }

  const lowerPath = candidate.path.toLowerCase();
  const lowerBase = basename(candidate.path).toLowerCase();
  let score = 0;
  if (lowerBase === lowerQuery) score = 100;
  else if (lowerBase.startsWith(lowerQuery)) score = 80;
  else if (lowerBase.includes(lowerQuery)) score = 50;
  else if (lowerPath.includes(lowerQuery)) score = 30;
  if (candidate.isDirectory && score > 0) score += 10;
  return score;
}

function toMentionItem(candidate: FsMentionCandidate): AutocompleteItem {
  const valuePath = candidate.isDirectory ? `${candidate.path}/` : candidate.path;
  const value = valuePath.includes(' ') ? `@"${valuePath}"` : `@${valuePath}`;
  const label = `${basename(candidate.path)}${candidate.isDirectory ? '/' : ''}`;
  return {
    value,
    label,
    description: valuePath,
  };
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function shouldSuppressLeadingWhitespaceSlashPath(
  textBeforeCursor: string,
  force: boolean | undefined,
): boolean {
  if (force === true) return false;
  if (textBeforeCursor.startsWith('/')) return false;
  return textBeforeCursor.trimStart().startsWith('/');
}

function shouldSuppressSlashArgumentCompletion(
  textBeforeCursor: string,
  textAfterCursor: string,
  force: boolean | undefined,
): boolean {
  if (force === true) return false;
  if (!textBeforeCursor.startsWith('/')) return false;
  if (!textBeforeCursor.includes(' ')) return false;
  return textAfterCursor.trimStart().length > 0;
}

/**
 * 所有 token 必须与 `text` 模糊匹配；返回总分数，任一 token 未命中时返回 null。
 * 空 token 列表以分数 0 匹配一切。
 * 镜像 pi-tui fuzzyFilter 的 token 语义——如果其变更需保持同步。
 */
function scoreTokens(tokens: readonly string[], text: string): number | null {
  let score = 0;
  for (const token of tokens) {
    const m = fuzzyMatch(token, text);
    if (!m.matches) return null;
    score += m.score;
  }
  return score;
}

/**
 * 镜像 CombinedAutocompleteProvider 的描述渲染，
 * 使拦截的名称补全仍显示参数提示。
 */
function formatSlashCommandDescription(cmd: SlashAutocompleteCommand): string | undefined {
  const desc = cmd.description ?? '';
  const full = cmd.argumentHint
    ? desc
      ? `${cmd.argumentHint} — ${desc}`
      : cmd.argumentHint
    : desc;
  return full || undefined;
}

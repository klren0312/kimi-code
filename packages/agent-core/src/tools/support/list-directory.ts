/**
 * list-directory ——面向 LLM 上下文的紧凑 2 级目录树。
 *
 * 当 GlobTool 拒绝以 `**` 开头的模式时使用：追加工作区根目录的
 * 快照有助于 LLM 重新调整模式范围，无需额外一轮交互。
 *
 * 宽度上限控制系统提示词的 token 预算：
 *   - 深度 0（根）：最多 LIST_DIR_ROOT_WIDTH 个条目
 *   - 深度 1（根目录的子项）：最多 LIST_DIR_CHILD_WIDTH 个条目
 *   - 被截断的层级显示 "... and N more"，使 LLM 知道还有更多内容。
 */

import { basename, join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

export const LIST_DIR_ROOT_WIDTH = 30;
export const LIST_DIR_CHILD_WIDTH = 10;

export interface ListDirectoryOptions {
  readonly collapseHiddenDirs?: boolean;
}

interface Entry {
  readonly name: string;
  readonly isDir: boolean;
}

async function collectEntries(
  kaos: Kaos,
  dirPath: string,
  maxWidth: number,
): Promise<{ entries: Entry[]; total: number; readable: boolean }> {
  const all: Entry[] = [];
  try {
    for await (const fullPath of kaos.iterdir(dirPath)) {
      const name = basename(fullPath);
      let isDir = false;
      try {
        const st = await kaos.stat(fullPath);
        // StatResult 镜像 POSIX stat；从 mode 位派生文件类型
        // （S_IFMT 掩码 → S_IFDIR == 0o040000）。
        isDir = (st.stMode & 0o170000) === 0o040000;
      } catch {
        // 不可读条目保持 isDir=false；仍列出名称。
      }
      all.push({ name, isDir });
    }
  } catch {
    return { entries: [], total: 0, readable: false };
  }
  all.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: all.slice(0, maxWidth), total: all.length, readable: true };
}

function shouldCollapseDirectory(entry: Entry, options: ListDirectoryOptions): boolean {
  return options.collapseHiddenDirs === true && entry.isDir && entry.name.startsWith('.');
}

/**
 * 返回适合包含在工具错误消息中的 `workDir` 2 级树形列表。
 * 目录为空时返回 `"(empty directory)"`，目录本身不可读时返回错误标记行。
 */
export async function listDirectory(
  kaos: Kaos,
  workDir: string = kaos.getcwd(),
  options: ListDirectoryOptions = {},
): Promise<string> {
  const lines: string[] = [];
  const { entries, total, readable } = await collectEntries(
    kaos,
    workDir,
    LIST_DIR_ROOT_WIDTH,
  );
  if (!readable) return '[not readable]';
  const remaining = total - entries.length;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const { name, isDir } = entry;
    const isLast = i === entries.length - 1 && remaining === 0;
    const connector = isLast ? '└── ' : '├── ';

    if (isDir) {
      lines.push(`${connector}${name}/`);
      if (shouldCollapseDirectory(entry, options)) continue;
      const childPrefix = isLast ? '    ' : '│   ';
      const childDir = join(workDir, name);
      const child = await collectEntries(kaos, childDir, LIST_DIR_CHILD_WIDTH);
      if (!child.readable) {
        lines.push(`${childPrefix}└── [not readable]`);
        continue;
      }
      const childRemaining = child.total - child.entries.length;
      for (let j = 0; j < child.entries.length; j++) {
        const ce = child.entries[j];
        if (ce === undefined) continue;
        const cIsLast = j === child.entries.length - 1 && childRemaining === 0;
        const cConnector = cIsLast ? '└── ' : '├── ';
        const suffix = ce.isDir ? '/' : '';
        lines.push(`${childPrefix}${cConnector}${ce.name}${suffix}`);
      }
      if (childRemaining > 0) {
        lines.push(`${childPrefix}└── ... and ${String(childRemaining)} more`);
      }
    } else {
      lines.push(`${connector}${name}`);
    }
  }

  if (remaining > 0) {
    lines.push(`└── ... and ${String(remaining)} more entries`);
  }

  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}



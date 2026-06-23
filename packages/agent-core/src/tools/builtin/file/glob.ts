/**
 * GlobTool — 文件模式匹配。
 *
 * 查找匹配 glob 模式的文件，按修改时间排序返回（最新的在前）。
 * 使用 `kaos.glob`。
 *
 * 输出约定：显示给 LLM 的 `content` 仅在搜索基础路径位于主工作区内时
 * 才会相对于基础路径进行相对化。外部根路径保持绝对路径，以便下游
 * Read/Edit 操作指向相同的文件。
 *
 * 行为：
 *   - 花括号展开（`*.{ts,tsx}`, `{src,test}/**`）在此层展开为子模式列表，
 *     然后逐个交给 `kaos.glob`。kaos 遍历器将 `{` / `}` 视为字面量，
 *     因此扇出必须在此处发生才能返回结果。支持笛卡尔积和一层嵌套；
 *     不平衡或无逗号的花括号作为字面量透传。
 *   - `path` 通过 `resolvePathAccess` 以 `absolute-outside-allowed` 模式验证。
 *     允许工作区外的显式绝对路径；逃逸工作区的相对路径仍然被拒绝。
 *   - 匹配数量上限为 `MAX_MATCHES`（唯一路径）。原始 yield 流上的
 *     `YIELD_SAFETY_CAP` 是二级安全带，即使 kaos 层自身的符号链接循环
 *     检测缺失或被绕过也能终止流。主要循环防御位于
 *     `packages/kaos/src/local.ts:_globWalk` 中的路径级已访问 inode 集合。
 *     花括号展开时，合法的 yield 量随子模式数量缩放，因此安全上限也随之缩放。
 *   - 对纯通配符 / `**` 开头模式的预拒绝已被移除；100 匹配上限是
 *     唯一的防失控枚举安全措施。当 100 个结果不够时，调用方应添加锚点
 *    （扩展名、子目录）。
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { normalize } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { isWithinDirectory, resolvePathAccessPath } from '../../policies/path-access';
import type { PathClass } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import GLOB_DESCRIPTION from './glob.md?raw';

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files/directories.'),
  path: z
    .string()
    .optional()
    .describe(
      'Absolute path to the directory to search in. Defaults to the current working directory.',
    ),
  include_dirs: z
    .boolean()
    .default(true)
    .optional()
    .describe(
      'Whether to include directories in results. Defaults to true. Set false to return only files.',
    ),
});

export type GlobInput = z.Infer<typeof GlobInputSchema>;

export const MAX_MATCHES = 100;

/**
 * 单个花括号展开允许生成的子模式数量硬上限。足够宽松以适应常见的
 * LLM 模式（`*.{ts,tsx,js,jsx,mjs,cjs}` 等），同时仍能防止
 * 病态笛卡尔积输入如 `{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}`（= 64）
 * 无限扇出。超出此限制时，原始模式保持未展开状态透传 — kaos 会将
 * 花括号视为字面量并匹配零个结果，对于模型可能本意并非如此的模式，
 * 这是正确的"明显失败"信号。
 */
const MAX_BRACE_EXPANSIONS = 64;

/**
 * 仅在 Windows（`win32` 路径类）后端上附加到工具描述的路径形状提示。
 * `path` 参数接受原生 Windows 路径和 POSIX 风格路径，但匹配路径以
 * Windows 反斜杠形式返回 — 通过 Bash 运行的命令必须先将它们转换为
 * 正斜杠。条件注入，因此非 Windows 会话不会看到不适用的提示。
 */
export const WINDOWS_PATH_HINT =
  '\n\nWindows note: the `path` argument accepts both Windows paths ' +
  '(e.g. `C:\\Users\\foo`) and POSIX-style paths (e.g. `/c/Users/foo`). Matched paths are ' +
  'returned in Windows backslash form; convert them to forward slashes before ' +
  'using them in a Bash command.';

// POSIX 模式位 — 与 KaosPath.isDir 使用的常量相同（packages/kaos/src/path.ts:199）。
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/**
 * 在工具声明时显示给 LLM 的工具级描述。在任何往返之前告知模型
 * 接受哪些模式、花括号展开如何处理、以及哪些目录过大不应递归。
 * 在 Windows 后端上，描述还携带 `WINDOWS_PATH_HINT`（路径形状指导）。
 */
export class GlobTool implements BuiltinTool<GlobInput> {
  readonly name = 'Glob' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GlobInputSchema);
  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {
    this.description =
      this.kaos.pathClass() === 'win32'
        ? GLOB_DESCRIPTION + WINDOWS_PATH_HINT
        : GLOB_DESCRIPTION;
  }

  resolveExecution(args: GlobInput): ToolExecution {
    let path: string | undefined;
    if (args.path !== undefined) {
      path = resolvePathAccessPath(args.path, {
        kaos: this.kaos,
        workspace: this.workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const searchRoots = [path ?? this.workspace.workspaceDir];

    const detailParts: string[] = [];
    detailParts.push(`pattern: ${args.pattern}`);
    if (args.path !== undefined) {
      detailParts.push(`path: ${args.path}`);
    }
    if (args.include_dirs === false) {
      detailParts.push('include_dirs: false');
    }

    return {
      accesses: ToolAccesses.searchTree(searchRoots[0]!),
      description: `Searching ${args.pattern}`,
      display: {
        kind: 'file_io',
        operation: 'glob',
        path: searchRoots[0]!,
        detail: detailParts.join(', '),
      },
      approvalRule: literalRulePattern(this.name, args.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: () => this.execution(args, searchRoots),
    };
  }

  private async execution(args: GlobInput, searchRoots: string[]): Promise<ExecutableToolResult> {
    const subPatterns = expandBraces(args.pattern).map((p) =>
      hasGlobEscape(p) ? p : normalize(p),
    );

    // 默认为 true。当为 false 时，kaos 产出的目录被过滤掉，
    // 使用与 mtime 排序相同的 stat（每个路径无额外 stat 调用）。
    const includeDirs = args.include_dirs ?? true;

    // kaos.glob 对不存在或非目录的根路径静默返回空值
    // （其 _globWalk 捕获 readdir 失败并退出而不 yield）。
    // 没有此预检查，对不存在路径的 Glob 会报告"未找到匹配"而非
    // "不存在"，模型不会意识到搜索根本身是错误的。iterdir 是正确的
    // 信号：拉取一个条目会触发 kaos.glob 会做的相同 readdir，
    // 因此 ENOENT/ENOTDIR 在实际后端上调用遍历器之前就会在此处出现。
    // 任何其他失败（如未模拟的测试后端抛出"未实现"）静默透传，
    // 以便现有的 kaos.glob 路径仍能运行。
    for (const root of searchRoots) {
      try {
        const iter = this.kaos.iterdir(root);
        await iter.next();
        if (typeof iter.return === 'function') {
          await iter.return(undefined);
        }
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error) {
          const code = (error as { code?: string }).code;
          if (code === 'ENOENT') {
            return { isError: true, output: `${root} does not exist` };
          }
          if (code === 'ENOTDIR') {
            return { isError: true, output: `${root} is not a directory` };
          }
        }
      // 未知失败（包括未模拟的测试后端）：透传让 kaos.glob 运行；
      // 它要么产出结果，要么其自身的捕获路径会暴露错误。
      }
    }

    try {
      // 两个计数器，两个职责：
      //   - `entries.length` 限制返回的*唯一*路径，因此截断警告
      //     仅在 MAX_MATCHES 次实际命中后触发。
      //   - `yielded` 计算 kaos 流发出的每条路径（包括重复项）。
      //     二级安全带：kaos `_globWalk` 自身检测符号链接循环，
      //     因此正常的 kaos 层不会重新 yield 相同的真实文件。
      //     `yielded` 仍能在该主防御缺失或被绕过时终止流（如
      //     未来无 inode 跟踪的 kaos 后端），使工具层不依赖 kaos
      //     实现来保证循环安全。花括号展开时，合法 yield 量随
      //     子模式数量缩放，因此上限也随之缩放。
      const seen = new Set<string>();
      const entries: Array<{ path: string; mtime: number }> = [];
      const YIELD_SAFETY_CAP = MAX_MATCHES * 2 * subPatterns.length;
      let yielded = 0;
      let truncated = false;

      outer: for (const root of searchRoots) {
        for (const subPattern of subPatterns) {
          for await (const filePath of this.kaos.glob(root, subPattern)) {
            yielded++;
            if (yielded >= YIELD_SAFETY_CAP) {
              truncated = true;
              break outer;
            }
            if (seen.has(filePath)) continue;
            if (entries.length >= MAX_MATCHES) {
              truncated = true;
              break outer;
            }
            seen.add(filePath);
            let mtime = 0;
            let isDir = false;
            try {
              const st = await this.kaos.stat(filePath);
              mtime = st.stMtime ?? 0;
              isDir = (st.stMode & S_IFMT) === S_IFDIR;
            } catch {
            // stat 失败 — 使用 0 mtime / 假设为文件以便仍能显示
            }
            // 在标记 seen 之后应用 include_dirs，这样被过滤的目录
            // 不会通过后续重复 yield 重新进入；在推入 entries 之前应用，
            // 以便 MAX_MATCHES 继续限制输出（而非预过滤）大小。
            if (!includeDirs && isDir) continue;
            entries.push({ path: filePath, mtime });
          }
        }
      }

      entries.sort((a, b) => b.mtime - a.mtime);

      const paths = entries.map((e) => e.path);
      // 显示给 LLM 的内容使用相对于搜索基础的路径以节省 token，
      // 但仅限主工作区。相对路径后续会相对于 workspaceDir 解析，
      // 因此 additionalDir 的匹配必须保持绝对路径以确保后续
      // Read/Edit 调用指向同一文件。
      const pathClass = this.kaos.pathClass();
      const relBase = searchRoots[0] ?? this.workspace.workspaceDir;
      const shouldRelativize = isWithinDirectory(relBase, this.workspace.workspaceDir, pathClass);
      const displayLines = paths.map((p) =>
        shouldRelativize ? relativizeIfUnder(p, relBase, pathClass) : p,
      );

      if (entries.length === 0 && !truncated) {
        return { output: 'No matches found' };
      }
      const lines: string[] = [];
      if (truncated) {
        lines.push(`[Truncated at ${String(MAX_MATCHES)} matches — ${String(seen.size)} matched so far, use a more specific pattern]`);
        lines.push(`Only the first ${String(MAX_MATCHES)} matches are returned.`);
      }
      lines.push(...displayLines);
      if (!truncated && entries.length === MAX_MATCHES) {
        lines.push(`Found ${String(entries.length)} matches`);
      }
      return { output: lines.join('\n') };
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error) {
        const code = (error as { code?: string }).code;
        const path = searchRoots[0] ?? this.workspace.workspaceDir;
        if (code === 'ENOENT') {
          return { isError: true, output: `${path} does not exist` };
        }
        if (code === 'ENOTDIR') {
          return { isError: true, output: `${path} is not a directory` };
        }
      }
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }
  }

}

/**
 * 如果 `candidate` 在 `base` 下面，返回 `base/` 之后的部分。
 * 否则原样返回 `candidate`（绝对路径）。两个参数都应该是
 * 规范化的绝对路径。
 */
function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const normCandidate = normalize(candidate);
  const normBase = normalize(base);
  const comparableCandidate = pathClass === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  const comparableBase = pathClass === 'win32' ? normBase.toLowerCase() : normBase;
  if (comparableCandidate === comparableBase) return '.';
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  if (comparableCandidate.startsWith(prefix)) {
    return normCandidate.slice(prefix.length);
  }
  return normCandidate;
}

/**
 * 将花括号交替项（`{a,b,c}`, `{src,test}/**`）展开为子模式的扁平列表。
 * 递归处理 — 支持笛卡尔积（`{a,b}/{c,d}.ts` → 4 个模式）和一层或多层嵌套
 *（`{a,{b,c}}.ts`）。
 *
 * 在以下情况下以单元素列表形式透传原始模式：
 *   - 模式完全不包含 `{...}` 组；
 *   - 模式包含 `{...}` 组但没有顶层逗号（如 `{abc}` — bash 将其视为字面量）；
 *   - 花括号不平衡（孤立的 `{` 没有匹配的 `}` 等）；
 *   - 展开将产生超过 `MAX_BRACE_EXPANSIONS` 个模式 — 病态笛卡尔积输入
 *    （`{a,b}{c,d}{e,f}{g,h}{i,j}{k,l,m}` ≥ 192）会中止而非无限扇出。
 *
 * 反斜杠转义的花括号（`\{`, `\}`）被视为字面量并跳过结构识别，
 * 以便用户可以主动退出展开。
 */
export function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  if (!expandInto(pattern, out, MAX_BRACE_EXPANSIONS)) {
    // 某处递归超出上限 — 丢弃部分扇出，返回原始模式。
    // 让一半的交替项通过会是一个静默的陷阱。
    return [pattern];
  }
  return out;
}

function hasGlobEscape(pattern: string): boolean {
  return /\\[{}[\]*?,]/.test(pattern);
}

function expandInto(pattern: string, out: string[], cap: number): boolean {
  // 查找第一个包含顶层逗号的平衡 `{...}` 组。
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      i++;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) {
        // 孤立的 `}` — 将整个模式视为字面量。
        return pushLiteral(pattern, out, cap);
      }
      depth--;
      if (depth === 0 && start !== -1) {
        const inner = pattern.slice(start + 1, i);
        const parts = splitTopLevelCommas(inner);
        if (parts.length < 2) {
          // 顶层无逗号 → 字面量组；跳过它并继续向右扫描真正的交替项。
          start = -1;
          continue;
        }
        const prefix = pattern.slice(0, start);
        const suffix = pattern.slice(i + 1);
        for (const part of parts) {
          if (out.length >= cap) return false;
          if (!expandInto(prefix + part + suffix, out, cap)) return false;
        }
        return true;
      }
    }
  }

  if (depth !== 0) {
    // 不平衡的 `{` — 将整个模式视为字面量。
    return pushLiteral(pattern, out, cap);
  }

  return pushLiteral(pattern, out, cap);
}

function pushLiteral(pattern: string, out: string[], cap: number): boolean {
  if (out.length >= cap) return false;
  out.push(pattern);
  return true;
}

/**
 * 在花括号深度为零处的逗号上分割。被 `expandBraces` 用于将
 * `{a,{b,c},d}` 组切分为 `["a", "{b,c}", "d"]` 而非
 * `["a", "{b", "c}", "d"]`。
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

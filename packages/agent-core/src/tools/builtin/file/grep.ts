/**
 * GrepTool ——通过 ripgrep 进行内容搜索。
 *
 * 通过 Kaos 调用 `rg`。支持 glob/type 过滤、上下文行、输出模式、
 * 分页、多行和大小写不敏感搜索。
 *
 * 路径安全在任何 Kaos I/O 之前强制执行。显式的工作区外绝对路径
 * 允许访问；逃逸工作区的相对路径被拒绝。
 *
 * 输出在到达模型前经过有界和后处理：
 *   - 超时和环境中止都会终止 rg 子进程；
 *   - stdout/stderr 在流继续排空时被限制大小；
 *   - 隐藏文件会被搜索，但 VCS 元数据和常见敏感 glob 模式
 *     会尽可能预过滤；
 *   - rg 返回后使用活跃的后端路径类再次过滤已解析的路径记录。
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { normalize } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { isAbortError } from '../../../loop/errors';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import type { PathClass } from '../../policies/path-access';
import { isSensitiveFile, SENSITIVE_DOT_VARIANT_SUFFIXES } from '../../policies/sensitive';
import { toInputJsonSchema } from '../../support/input-schema';
import { ensureRgPath, rgUnavailableMessage } from '../../support/rg-locator';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import { isPrematureCloseError } from '../../support/stream';
import type { WorkspaceConfig } from '../../support/workspace';
import GREP_DESCRIPTION from './grep.md?raw';

export const GrepInputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.',
    ),
  glob: z.string().optional().describe('Optional glob filter passed to ripgrep.'),
  type: z
    .string()
    .optional()
    .describe(
      'Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count_matches'])
    .optional()
    .describe(
      'Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match (honors `head_limit`); `count_matches` shows the total number of matches. Defaults to `files_with_matches`.',
    ),
  '-i': z.boolean().optional().describe('Perform a case-insensitive search. Defaults to false.'),
  '-n': z
    .boolean()
    .optional()
    .describe(
      'Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true.',
    ),
  '-A': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show after each match. Applies only when `output_mode` is `content`.',
    ),
  '-B': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before each match. Applies only when `output_mode` is `content`.',
    ),
  '-C': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.',
    ),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.',
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.',
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      'Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. Defaults to false.',
    ),
});

export const GrepOutputSchema = z.object({
  mode: z.enum(['content', 'files_with_matches', 'count_matches']),
  numFiles: z.number().int().nonnegative(),
  filenames: z.array(z.string()),
  content: z.string().optional(),
  numLines: z.number().int().nonnegative().optional(),
  numMatches: z.number().int().nonnegative().optional(),
  appliedLimit: z.number().int().nonnegative().optional(),
});

export type GrepInput = z.Infer<typeof GrepInputSchema>;
export type GrepOutput = z.Infer<typeof GrepOutputSchema>;

const DEFAULT_TIMEOUT_MS = 20_000;
const SIGTERM_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

async function disposeProcess(proc: KaosProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
    /* 尽力清理 */
  }
}
// 列宽限制仅应用于非内容输出模式；`content` 模式返回完整匹配行，
// 因此在此处有意跳过限制。
const RG_MAX_COLUMNS = 500;
const DEFAULT_HEAD_LIMIT = 250;
const MTIME_STAT_CONCURRENCY = 32;
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;
// 这是保守的预过滤。权威的敏感文件检查仍在执行后对已解析的 rg 记录进行。
const SENSITIVE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa'] as const;
const SENSITIVE_KEY_GLOBS_TO_EXCLUDE = SENSITIVE_KEY_BASENAMES.flatMap((name) => [
  `**/${name}`,
  `**/${name}[-_]*`,
  ...SENSITIVE_DOT_VARIANT_SUFFIXES.map((suffix) => `**/${name}${suffix}`),
]);
const SENSITIVE_GLOBS_TO_EXCLUDE = [
  '**/.env',
  ...SENSITIVE_KEY_GLOBS_TO_EXCLUDE,
  '**/.aws/credentials',
  '**/.aws/credentials/**',
  '**/.gcp/credentials',
  '**/.gcp/credentials/**',
] as const;

// ripgrep 产生的行格式：
//   含 --null 的内容匹配：  "file.py<NUL>10:matched text"
//   含 --null 的上下文行：  "file.py<NUL>9-context text"
//   含 --null 的计数匹配：  "file.py<NUL>2"
//   无 NUL 的内容回退：     "file.py:10:matched text"
//   上下文分隔符：          "--"
// 运行时 rg 输出使用 NUL 作为路径边界；正则表达式处理
// 无 NUL 分隔符的面向行的输出。
const CONTENT_LINE_RE = /^(.*?)([:-])(\d+)\2/;

export class GrepTool implements BuiltinTool<GrepInput> {
  readonly name = 'Grep' as const;
  readonly description = GREP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GrepInputSchema);
  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: GrepInput): ToolExecution {
    let path: string | undefined;
    if (args.path !== undefined) {
      path = resolvePathAccessPath(args.path, {
        kaos: this.kaos,
        workspace: this.workspace,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const searchPaths = [path ?? this.workspace.workspaceDir];
    const searchPath = args.path ?? this.workspace.workspaceDir;
    return {
      accesses: ToolAccesses.searchTree(searchPaths[0]!),
      description: `Searching for '${args.pattern}' in ${searchPath}`,
      display: { kind: 'file_io', operation: 'grep', path: searchPaths[0]! },
      approvalRule: literalRulePattern(this.name, args.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: ({ signal }) => this.execution(args, signal, searchPaths),
    };
  }

  private async execution(
    args: GrepInput,
    signal: AbortSignal,
    searchPaths: string[],
  ): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before search started' };
    }

    const pathClass = this.kaos.pathClass();
    let rgPath: string;
    try {
      const resolution = await ensureRgPath({ signal });
      rgPath = resolution.path;
    } catch (error) {
      if (isAbortError(error)) {
        return { isError: true, output: 'Grep aborted' };
      }
      return { isError: true, output: rgUnavailableMessage(error) };
    }

    let runResult = await runRipgrepOnce(this.kaos, buildRgArgs(rgPath, args, searchPaths), signal);
    if (runResult.kind === 'tool-error') return runResult.result;
    if (shouldRetryRipgrepEagain(runResult)) {
      runResult = await runRipgrepOnce(
        this.kaos,
        buildRgArgs(rgPath, args, searchPaths, true),
        signal,
      );
      if (runResult.kind === 'tool-error') return runResult.result;
    }

    const { exitCode, stderrText, bufferTruncated, stderrTruncated, timedOut } = runResult;
    let { stdoutText } = runResult;

    // rg 退出码：0 = 有匹配，1 = 无匹配，2 = 错误。超时终止
    // 通常表现为信号退出码；保留所有完整的部分记录。
    if (exitCode !== 0 && exitCode !== 1 && !timedOut) {
      return {
        isError: true,
        output: formatRipgrepError(exitCode, stderrText, stderrTruncated),
      };
    }

    const mode = args.output_mode ?? 'files_with_matches';
    if (bufferTruncated || timedOut) {
      stdoutText = omitIncompleteTrailingRecord(stdoutText, mode);
    }
    if (timedOut && stdoutText.trim() === '') {
      return {
        isError: true,
        output: `Grep timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s. Try a more specific path or pattern.`,
      };
    }
    if (signal.aborted) {
      return { isError: true, output: 'Grep aborted' };
    }

    const rawLines = parseRipgrepOutput(stdoutText, mode);

    const filteredSensitive = new Set<string>();
    const keptLines = filterSensitiveLines(rawLines, mode, filteredSensitive, pathClass);
    let orderedLines: ParsedGrepLine[];
    try {
      orderedLines =
        mode === 'files_with_matches' && !timedOut
          ? await sortFilesWithMatchesByMtime(keptLines, this.kaos, signal)
          : keptLines;
    } catch (error) {
      if (error instanceof GrepAbortedError) {
        return { isError: true, output: 'Grep aborted' };
      }
      throw error;
    }

    const offset = args.offset ?? 0;
    const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
    const afterOffset = offset > 0 ? orderedLines.slice(offset) : orderedLines;
    const limitActive = headLimit > 0;
    const limited = limitActive ? afterOffset.slice(0, headLimit) : afterOffset;
    const paginationTruncated = limitActive && afterOffset.length > headLimit;

    // 人类可读的注释附加在可见匹配之后。
    // 在计数模式下，数据流必须保持纯净的 `path:count` 行
    // ——计数摘要和分页通知移到侧通道
    // （通过 `result.message` 返回）以免污染数据流。
    // 其他模式将这些通知内联在 `output` 中。
    const messages: string[] = [];
    const sideChannelMessages: string[] = [];
    if (filteredSensitive.size > 0) {
      const displayedFilteredPaths = [...filteredSensitive].map((path) =>
        relativizeIfUnder(path, this.workspace.workspaceDir, pathClass),
      );
      messages.push(
        `Filtered ${String(filteredSensitive.size)} sensitive file(s): ${displayedFilteredPaths.join(', ')}`,
      );
    }
    if (mode === 'count_matches' && orderedLines.length > 0) {
      sideChannelMessages.push(formatCountSummary(orderedLines, filteredSensitive.size > 0));
    }
    if (paginationTruncated) {
      const total = afterOffset.length + offset;
      const nextOffset = offset + headLimit;
      const paginationNotice = `Results truncated to ${String(headLimit)} lines (total: ${String(total)}). Use offset=${String(nextOffset)} to see more.`;
      if (mode === 'count_matches') {
        sideChannelMessages.push(paginationNotice);
      } else {
        messages.push(paginationNotice);
      }
    }
    if (bufferTruncated) {
      messages.push(
        `[stdout truncated at ${String(MAX_OUTPUT_BYTES)} bytes; incomplete trailing line omitted]`,
      );
    }
    if (timedOut) {
      messages.push(
        `Grep timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s; partial results returned`,
      );
    }

    const contentIncludesLineNumbers = mode === 'content' && args['-n'] !== false;
    const displayedLines = limited.map((line) =>
      formatDisplayLine(
        line,
        mode,
        this.workspace.workspaceDir,
        pathClass,
        contentIncludesLineNumbers,
      ),
    );
    const contentBody = displayedLines.join('\n');
    const visibleBody =
      orderedLines.length === 0 && filteredSensitive.size > 0
        ? 'No non-sensitive matches found'
        : contentBody;
    const emptyResultMessage =
      SENSITIVE_GLOBS_TO_EXCLUDE.length > 0 ? 'No non-sensitive matches found' : 'No matches found';
    const combined =
      visibleBody === '' && messages.length === 0
        ? emptyResultMessage
        : messages.length > 0
          ? visibleBody === ''
            ? messages.join('\n')
            : `${visibleBody}\n${messages.join('\n')}`
          : visibleBody;

    const builder = new ToolResultBuilder();
    builder.write(combined);
    return builder.ok(sideChannelMessages.join('\n'));
  }

}

interface RipgrepRunResult {
  readonly kind: 'result';
  readonly exitCode: number;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly bufferTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

type RipgrepRunOutcome =
  | RipgrepRunResult
  | { readonly kind: 'tool-error'; readonly result: ExecutableToolResult };

type GrepMode = 'content' | 'files_with_matches' | 'count_matches';

type ParsedGrepLine =
  | {
      readonly kind: 'record';
      readonly filePath: string;
      readonly payload: string;
    }
  | {
      readonly kind: 'separator';
    }
  | {
      readonly kind: 'legacy';
      readonly text: string;
    };

class GrepAbortedError extends Error {
  constructor() {
    super('Grep aborted');
    this.name = 'GrepAbortedError';
  }
}

async function runRipgrepOnce(
  kaos: Kaos,
  rgArgs: readonly string[],
  signal: AbortSignal,
): Promise<RipgrepRunOutcome> {
  if (signal.aborted) {
    return { kind: 'tool-error', result: { isError: true, output: 'Grep aborted' } };
  }

  let proc: KaosProcess;
  try {
    proc = await kaos.exec(...rgArgs);
  } catch (error) {
    // 路径解析后启动仍可能失败，例如权限问题或损坏的二进制文件。
    // ENOENT 与定位器失败获得相同可操作的提示。
    const isEnoent =
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      kind: 'tool-error',
      result: {
        isError: true,
        output: isEnoent
          ? rgUnavailableMessage(error)
          : error instanceof Error
            ? error.message
            : String(error),
      },
    };
  }

  try {
    proc.stdin.end();
  } catch {
    /* 已关闭 */
  }

  let timedOut = false;
  let aborted = false;
  let killed = false;

  const killProc = async (): Promise<void> => {
    if (killed) return;
    killed = true;
    try {
      await proc.kill('SIGTERM');
    } catch {
      /* 进程已退出 */
    }
    const exited = proc
      .wait()
      .then(() => true)
      .catch(() => true);
    const raced = await Promise.race([
      exited,
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
      }),
    ]);
    if (!raced && proc.exitCode === null) {
      try {
        await proc.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
    await disposeProcess(proc);
  };

  const onAbort = (): void => {
    aborted = true;
    void killProc();
  };
  signal.addEventListener('abort', onAbort);
  // AbortSignal 不会重放已过的中止事件；注册监听器后立即检查一次，
  // 使已中止的调用仍能运行清理路径。
  if (signal.aborted) onAbort();

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    void killProc();
  }, DEFAULT_TIMEOUT_MS);

  let exitCode = 0;
  let stdoutText = '';
  let stderrText = '';
  let bufferTruncated = false;
  let stderrTruncated = false;

  try {
    const isTerminating = (): boolean => timedOut || aborted || killed;
    const [stdoutResult, stderrResult, code] = await Promise.all([
      readStreamWithCap(proc.stdout, MAX_OUTPUT_BYTES, isTerminating),
      readStreamWithCap(proc.stderr, MAX_OUTPUT_BYTES, isTerminating),
      proc.wait(),
    ]);
    stdoutText = stdoutResult.text;
    stderrText = stderrResult.text;
    bufferTruncated = stdoutResult.truncated;
    stderrTruncated = stderrResult.truncated;
    exitCode = code;
  } catch (error) {
    if (isPrematureCloseError(error) && (timedOut || aborted || killed)) {
      // 析构器有意在终止信号后关闭流。
    } else {
      return {
        kind: 'tool-error',
        result: {
          isError: true,
          output: error instanceof Error ? error.message : String(error),
        },
      };
    }
  } finally {
    clearTimeout(timeoutHandle);
    signal.removeEventListener('abort', onAbort);
    await disposeProcess(proc);
  }

  if (aborted) {
    return {
      kind: 'tool-error',
      result: { isError: true, output: 'Grep aborted' },
    };
  }

  return {
    kind: 'result',
    exitCode,
    stdoutText,
    stderrText,
    bufferTruncated,
    stderrTruncated,
    timedOut,
  };
}

function shouldRetryRipgrepEagain(result: RipgrepRunResult): boolean {
  return (
    result.exitCode !== 0 &&
    result.exitCode !== 1 &&
    !result.timedOut &&
    isEagainRipgrepError(result.stderrText)
  );
}

function isEagainRipgrepError(stderr: string): boolean {
  return stderr.includes('os error 11') || stderr.includes('Resource temporarily unavailable');
}

async function sortFilesWithMatchesByMtime(
  lines: readonly ParsedGrepLine[],
  kaos: Kaos,
  signal: AbortSignal,
): Promise<ParsedGrepLine[]> {
  const entries = await mapWithConcurrency(
    lines,
    MTIME_STAT_CONCURRENCY,
    signal,
    async (line, index) => {
      const path =
        line.kind === 'record' ? line.filePath : line.kind === 'legacy' ? line.text : undefined;
      let mtime = 0;
      if (path !== undefined) {
        try {
          mtime = (await kaos.stat(path)).stMtime ?? 0;
        } catch {
          // 保持 stat 失败可见；使用 mtime=0 使它们排在已知文件之后。
        }
      }
      return { line, mtime, index };
    },
  );
  entries.sort((a, b) => b.mtime - a.mtime || a.index - b.index);
  return entries.map((entry) => entry.line);
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (signal.aborted) throw new GrepAbortedError();
  if (items.length === 0) return [];

  const results: U[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (signal.aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );
  if (signal.aborted) throw new GrepAbortedError();
  return results;
}

function buildRgArgs(
  rgPath: string,
  args: GrepInput,
  searchPaths: readonly string[],
  singleThreaded = false,
): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push('-j', '1');
  cmd.push('--hidden');
  const mode = args.output_mode ?? 'files_with_matches';
  // `content` 模式原样返回匹配行。在此处限制列宽会使 rg 将任何
  // 超过限制的行替换为占位符，静默丢弃实际匹配文本。
  // 列宽限制仅在 `content` 模式外有用，因为那里行文本不会展示。
  if (mode !== 'content') {
    cmd.push('--max-columns', String(RG_MAX_COLUMNS));
  }
  cmd.push('--null');
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    cmd.push('--glob', `!${dir}`);
  }

  if (mode === 'files_with_matches') cmd.push('-l');
  else if (mode === 'count_matches') {
    // rg 在仅搜索单个文件时省略文件名，因此强制开启。
    // 否则每文件行会坍缩为裸计数，摘要解析器与显示的数字不一致。
    cmd.push('--count-matches', '--with-filename');
  }

  if (args['-i']) cmd.push('-i');
  if (mode === 'content') {
    cmd.push('--with-filename');
    if (args['-n'] !== false) {
      cmd.push('-n');
    } else {
      cmd.push('--field-context-separator', ':');
    }
    if (args['-C'] !== undefined) {
      cmd.push('-C', String(args['-C']));
    } else {
      if (args['-A'] !== undefined) cmd.push('-A', String(args['-A']));
      if (args['-B'] !== undefined) cmd.push('-B', String(args['-B']));
    }
  }
  if (args.glob !== undefined) cmd.push('--glob', args.glob);
  if (args.type !== undefined) cmd.push('--type', args.type);
  if (args.multiline) cmd.push('-U', '--multiline-dotall');
  if (args.include_ignored) cmd.push('--no-ignore');
  for (const glob of SENSITIVE_GLOBS_TO_EXCLUDE) {
    // 附加在用户 glob 之后，使宽泛的包含如 `**/.env` 无法
    // 撤消此首遍排除。显式文件路径仍受后处理过滤保护，
    // 因为 rg 会有意搜索它们。
    cmd.push('--glob', `!${glob}`);
  }
  // 不将 `head_limit` 转发给 `rg --max-count`：省略表示"使用工具默认值"，
  // head_limit=0 表示"无限制"，而 `rg --max-count 0` 表示
  // "每个文件零匹配"。分页在后处理中完成。

  cmd.push('--', args.pattern, ...searchPaths);
  return cmd;
}

function splitRgLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // 移除末尾换行留下的尾部空行。
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  return lines.map((line) => stripTrailingCarriageReturn(line));
}

function parseRipgrepOutput(text: string, mode: GrepMode): ParsedGrepLine[] {
  if (text === '') return [];
  if (!text.includes('\0')) {
    return splitRgLines(text).map((line) =>
      mode === 'content' && line === '--' ? { kind: 'separator' } : { kind: 'legacy', text: line },
    );
  }

  if (mode === 'files_with_matches') {
    return text
      .split('\0')
      .map((filePath) => stripTrailingCarriageReturn(filePath))
      .filter((filePath) => filePath !== '')
      .map((filePath) => ({ kind: 'record', filePath, payload: '' }));
  }

  const records: ParsedGrepLine[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === '\n') {
      cursor += 1;
      continue;
    }
    if (text.startsWith('--\r\n', cursor)) {
      records.push({ kind: 'separator' });
      cursor += 4;
      continue;
    }
    if (text.startsWith('--\n', cursor)) {
      records.push({ kind: 'separator' });
      cursor += 3;
      continue;
    }

    const nulIndex = text.indexOf('\0', cursor);
    if (nulIndex < 0) {
      const tail = stripTrailingCarriageReturn(text.slice(cursor));
      if (tail !== '') records.push({ kind: 'legacy', text: tail });
      break;
    }

    const lineEnd = text.indexOf('\n', nulIndex + 1);
    const payloadEnd = lineEnd >= 0 ? lineEnd : text.length;
    const filePath = text.slice(cursor, nulIndex);
    const payload = stripTrailingCarriageReturn(text.slice(nulIndex + 1, payloadEnd));
    records.push({ kind: 'record', filePath, payload });
    cursor = lineEnd >= 0 ? lineEnd + 1 : text.length;
  }
  return records;
}

function formatDisplayLine(
  line: ParsedGrepLine,
  mode: GrepMode,
  workspaceDir: string,
  pathClass: PathClass,
  contentIncludesLineNumbers: boolean,
): string {
  if (line.kind === 'separator') return '--';
  if (line.kind === 'record') {
    const displayPath = relativizeIfUnder(line.filePath, workspaceDir, pathClass);
    if (mode === 'files_with_matches') return displayPath;
    if (mode === 'count_matches') return `${displayPath}:${line.payload}`;
    const separator = contentIncludesLineNumbers ? contentPayloadPathSeparator(line.payload) : ':';
    return `${displayPath}${separator}${line.payload}`;
  }

  const text = line.text;
  if (mode === 'files_with_matches') {
    return relativizeIfUnder(text, workspaceDir, pathClass);
  }
  if (mode === 'count_matches') {
    const idx = text.lastIndexOf(':');
    if (idx <= 0) return text;
    return relativizeIfUnder(text.slice(0, idx), workspaceDir, pathClass) + text.slice(idx);
  }

  const filePath = extractContentFilePath(text, pathClass);
  if (filePath !== undefined) {
    return relativizeIfUnder(filePath, workspaceDir, pathClass) + text.slice(filePath.length);
  }
  return text;
}

/**
 * 如果 `candidate` 在 `base` 下面，返回 `base/` 之后的部分。
 * 否则原样返回 `candidate`。两个参数都应是活跃后端路径类中
 * 的规范绝对路径。
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

function omitIncompleteTrailingRecord(text: string, mode: GrepMode): string {
  if (!text.includes('\0')) return omitIncompleteTrailingLine(text);
  if (mode === 'files_with_matches') {
    const lastNul = text.lastIndexOf('\0');
    return lastNul >= 0 ? text.slice(0, lastNul + 1) : '';
  }

  let cursor = 0;
  let lastCompleteEnd = 0;
  while (cursor < text.length) {
    if (text[cursor] === '\n') {
      cursor += 1;
      lastCompleteEnd = cursor;
      continue;
    }
    if (text.startsWith('--\r\n', cursor)) {
      cursor += 4;
      lastCompleteEnd = cursor;
      continue;
    }
    if (text.startsWith('--\n', cursor)) {
      cursor += 3;
      lastCompleteEnd = cursor;
      continue;
    }

    const nulIndex = text.indexOf('\0', cursor);
    if (nulIndex < 0) break;
    const lineEnd = text.indexOf('\n', nulIndex + 1);
    if (lineEnd < 0) break;
    cursor = lineEnd + 1;
    lastCompleteEnd = cursor;
  }
  return text.slice(0, lastCompleteEnd);
}

function omitIncompleteTrailingLine(text: string): string {
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline >= 0 ? text.slice(0, lastNewline) : '';
}

function formatRipgrepError(
  exitCode: number,
  stderrText: string,
  stderrTruncated: boolean,
): string {
  const stderr = stderrText.trim();
  if (stderr.length === 0) {
    return `Failed to grep: ripgrep exited with code ${String(exitCode)}`;
  }

  const summary = summarizeRipgrepStderr(stderr);
  const lines = [`Failed to grep: ${summary}`, '', 'ripgrep stderr:', stderr];
  if (stderrTruncated) {
    lines.push(`[stderr truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`);
  }
  return lines.join('\n');
}

function summarizeRipgrepStderr(stderr: string): string {
  const lines = splitRgLines(stderr)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = lines.findLast((line) => line.toLowerCase().startsWith('error:'));
  return errorLine ?? lines.at(-1) ?? 'ripgrep error';
}

function filterSensitiveLines(
  lines: readonly ParsedGrepLine[],
  mode: GrepMode,
  filteredPaths: Set<string>,
  pathClass: PathClass,
): ParsedGrepLine[] {
  const kept: ParsedGrepLine[] = [];
  for (const line of lines) {
    if (line.kind === 'separator') {
      kept.push(line);
      continue;
    }
    const filePath = parsedFilePath(line, mode, pathClass);
    if (filePath !== undefined && isSensitiveFile(filePath)) {
      filteredPaths.add(filePath);
      continue;
    }
    kept.push(line);
  }
  return mode === 'content' ? normalizeContextSeparators(kept) : kept;
}

function normalizeContextSeparators(lines: readonly ParsedGrepLine[]): ParsedGrepLine[] {
  const normalized: ParsedGrepLine[] = [];
  for (const line of lines) {
    if (
      line.kind === 'separator' &&
      (normalized.length === 0 || normalized.at(-1)?.kind === 'separator')
    ) {
      continue;
    }
    normalized.push(line);
  }
  while (normalized.length > 0 && normalized.at(-1)?.kind === 'separator') {
    normalized.pop();
  }
  return normalized;
}

function parsedFilePath(
  line: ParsedGrepLine,
  mode: GrepMode,
  pathClass: PathClass,
): string | undefined {
  if (line.kind === 'record') return normalize(line.filePath);
  if (line.kind === 'separator') return undefined;
  const text = line.text;
  if (mode === 'files_with_matches') return normalize(text);
  if (mode === 'count_matches') {
    const idx = text.lastIndexOf(':');
    return idx > 0 ? normalize(text.slice(0, idx)) : normalize(text);
  }
  return extractContentFilePath(text, pathClass);
}

function extractContentFilePath(line: string, pathClass: PathClass): string | undefined {
  const m = CONTENT_LINE_RE.exec(line);
  if (m?.[1] !== undefined) return normalize(m[1]);

  const separatorIndex = noLineNumberContentSeparatorIndex(line, pathClass);
  return separatorIndex > 0 ? normalize(line.slice(0, separatorIndex)) : undefined;
}

function noLineNumberContentSeparatorIndex(line: string, pathClass: PathClass): number {
  const searchFrom = pathClass === 'win32' && /^[A-Za-z]:/.test(line) ? 2 : 0;
  return line.indexOf(':', searchFrom);
}

function contentPayloadPathSeparator(payload: string): ':' | '-' {
  const m = /^(\d+)([:-])/.exec(payload);
  return m?.[2] === '-' ? '-' : ':';
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function formatCountSummary(lines: readonly ParsedGrepLine[], redactedSensitive: boolean): string {
  let totalMatches = 0;
  let totalFiles = 0;
  for (const line of lines) {
    const rawCount =
      line.kind === 'record'
        ? line.payload
        : line.kind === 'legacy'
          ? countPayloadFromLegacyLine(line.text)
          : undefined;
    if (rawCount === undefined) continue;
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 0) continue;
    totalMatches += count;
    totalFiles++;
  }

  const occurrenceWord = totalMatches === 1 ? 'occurrence' : 'occurrences';
  const fileWord = totalFiles === 1 ? 'file' : 'files';
  const scope = redactedSensitive ? 'total non-sensitive' : 'total';
  return `Found ${String(totalMatches)} ${scope} ${occurrenceWord} across ${String(totalFiles)} ${fileWord}.`;
}

function countPayloadFromLegacyLine(line: string): string | undefined {
  const idx = line.lastIndexOf(':');
  return idx > 0 ? line.slice(idx + 1) : undefined;
}

interface CappedStreamResult {
  readonly text: string;
  readonly truncated: boolean;
}

async function readStreamWithCap(
  stream: Readable,
  maxBytes: number,
  suppressPrematureClose?: () => boolean,
): Promise<CappedStreamResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf: Buffer =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
      if (truncated) continue;
      if (total + buf.length > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        continue;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } catch (error) {
    if (!isPrematureCloseError(error) || suppressPrematureClose?.() !== true) {
      throw error;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

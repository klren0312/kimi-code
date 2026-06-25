/**
 * explore 子代理的 Git 仓库上下文。
 *
 * `collectGitContext` produces a `<git-context>` block that is prepended to a
 * fresh explore subagent's prompt so it can orient itself in the repository
 * before searching. Every git probe is best-effort: probes fail in perfectly
 * normal states (no `origin` remote, no commits yet, detached HEAD, older
 * Git), so a failed probe is logged and its section omitted rather than
 * dropping the whole block. The block is omitted entirely only when nothing
 * useful was collected. The one explicit state surfaced to the subagent is
 * `reason="not-a-repo"`, so it doesn't waste turns probing git history in a
 * non-repo directory. Remote URLs are sanitized so internal infrastructure
 * is not surfaced to the model.
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';

import { log } from '../logging/logger';

const GIT_TIMEOUT_MS = 5_000;
const MAX_DIRTY_FILES = 20;
const MAX_COMMIT_LINE_LENGTH = 200;

// 已知的公共托管平台，其远程 URL 可以安全展示。自托管或未识别的
// 主机将被排除，以避免泄露内部基础设施信息。
const ALLOWED_HOSTS = [
  'github.com',
  'gitlab.com',
  'gitee.com',
  'bitbucket.org',
  'codeberg.org',
  'git.sr.ht',
] as const;

async function disposeProcess(proc: KaosProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
    /* 尽力清理 */
  }
}

/**
 * 收集 explore 代理的 git 上下文。
 *
 * 返回格式化的 `<git-context>` 块，如果不是 git 仓库或未收集到有用信息则返回空字符串。
 */
export async function collectGitContext(kaos: Kaos, cwd: string): Promise<string> {
  // Step 1: is this a git repo? `rev-parse` is the authoritative probe — it
  // handles `.git` files (worktrees/submodules), subdirectories, bare repos,
  // and `$GIT_DIR` redirection, none of which a plain FS check covers.
  const revParseArgs = ['rev-parse', '--is-inside-work-tree'] as const;
  const revParse = await runGit(kaos, cwd, revParseArgs);
  if (!revParse.ok) {
    if (revParse.kind === 'command-failed' && isNotARepo(revParse.stderr)) {
      // Definitive "not a repo" — tell the subagent so it doesn't waste turns
      // probing git history. All other failures are logged but surface as an
      // empty block (the subagent works without git context, same as before):
      // a transient `git status` hang shouldn't read as "git is broken".
      return `<git-context status="unavailable" reason="not-a-repo"/>`;
    }
    logGitFailure(cwd, revParseArgs, revParse);
    return '';
  }

  // Step 2: collect context in parallel. Every probe is optional — git
  // probes fail in perfectly normal states (no `origin` remote, no commits
  // yet, detached HEAD, older Git), so a failed probe never aborts the
  // collection. Each failure is logged and its section is simply omitted; if
  // nothing useful is collected, the block is dropped entirely below.
  //
  // Branch is read via `symbolic-ref --short HEAD`, which works in unborn
  // repositories and on older Git; it fails in detached-HEAD state, in which
  // case the Branch section is just omitted.
  const commandArgs = [
    ['remote', 'get-url', 'origin'],
    ['symbolic-ref', '--short', 'HEAD'],
    ['status', '--porcelain'],
    ['log', '-3', '--format=%h %s'],
  ] as const;
  const [remote, branch, status, gitLog] = (await Promise.all(
    commandArgs.map(async (args) => ({ args, result: await runGit(kaos, cwd, args) })),
  )) as unknown as [TaggedGitResult, TaggedGitResult, TaggedGitResult, TaggedGitResult];

  for (const { args, result } of [remote, branch, status, gitLog]) {
    if (!result.ok) logGitFailure(cwd, args, result);
  }

  const remoteUrl = stdoutOf(remote.result);
  const branchName = stdoutOf(branch.result);
  const dirtyRaw = stdoutOf(status.result);
  const logRaw = stdoutOf(gitLog.result);

  const sections: string[] = [`Working directory: ${cwd}`];

  if (remoteUrl) {
    const safeUrl = sanitizeRemoteUrl(remoteUrl);
    if (safeUrl) {
      sections.push(`Remote: ${safeUrl}`);
      // 仅从已允许的远程地址派生项目标识——从未批准的主机派生会将
      // 内部 owner/repo 泄露到提示词中。
      const project = parseProjectName(safeUrl);
      if (project) sections.push(`Project: ${project}`);
    }
  }

  if (branchName) sections.push(`Branch: ${branchName}`);

  const dirtyLines = dirtyRaw.split('\n').filter((line) => line.trim().length > 0);
  if (dirtyLines.length > 0) {
    const total = dirtyLines.length;
    const shown = dirtyLines.slice(0, MAX_DIRTY_FILES);
    let body = shown.map((line) => `  ${line}`).join('\n');
    if (total > MAX_DIRTY_FILES) {
      body += `\n  ... and ${String(total - MAX_DIRTY_FILES)} more`;
    }
    sections.push(`Dirty files (${String(total)}):\n${body}`);
  }

  if (logRaw) {
    const logLines = logRaw.split('\n').filter((line) => line.trim().length > 0);
    if (logLines.length > 0) {
      const body = logLines.map((line) => `  ${line.slice(0, MAX_COMMIT_LINE_LENGTH)}`).join('\n');
      sections.push(`Recent commits:\n${body}`);
    }
  }

  if (sections.length <= 1) {
    // 只有工作目录行——未收集到有用信息。
    return '';
  }

  return `<git-context>\n${sections.join('\n')}\n</git-context>`;
}

/**
 * 如果远程 URL 指向已知的公共托管平台，则返回该 URL（去除 HTTPS URL 中的凭据）。
 * 对于未识别的主机返回 `null`。
 */
export function sanitizeRemoteUrl(remoteUrl: string): string | null {
  // SSH 格式：git@host:owner/repo.git——不可能包含凭据。
  for (const host of ALLOWED_HOSTS) {
    if (remoteUrl.startsWith(`git@${host}:`)) return remoteUrl;
  }

  // HTTPS 格式：精确解析主机名并丢弃任何用户信息。
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if ((ALLOWED_HOSTS as readonly string[]).includes(parsed.hostname)) {
    const port = parsed.port ? `:${parsed.port}` : '';
    return `https://${parsed.hostname}${port}${parsed.pathname}`;
  }

  return null;
}

/**
 * 从 git 远程 URL 中提取项目路径——`owner/repo`，对于嵌套命名空间
 * （如 GitLab 子组）则是完整的 `group/subgroup/repo`。
 * 支持类 scp 的 SSH 格式（`git@host:path`）和 URL 格式（`https://`、`ssh://`）。
 */
export function parseProjectName(remoteUrl: string): string | null {
  // 类 scp 的 SSH 格式（`git@host:owner/.../repo.git`）不是有效的 URL——直接匹配；
  // 其他格式通过 URL 解析处理。保留完整路径以支持嵌套命名空间。
  const scp = /^[^/]+@[^/:]+:(.+)$/.exec(remoteUrl);
  const rawPath = scp?.[1] ?? tryUrlPath(remoteUrl);
  if (rawPath === null) return null;
  const project = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return project.length > 0 ? project : null;
}

function tryUrlPath(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).pathname;
  } catch {
    return null;
  }
}

/**
 * Outcome of a single `git` invocation.
 *
 * - `ok: true` — exited 0; `stdout` is trimmed.
 * - `timeout` — exceeded `GIT_TIMEOUT_MS`; process was SIGKILLed.
 * - `spawn-error` — `kaos.exec` itself rejected (git missing / backend error).
 * - `command-failed` — git ran but exited non-zero, or its streams errored.
 *   `exitCode`/`stderr` are populated for the non-zero-exit case.
 */
type GitFailure =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn-error' }
  | { readonly kind: 'command-failed'; readonly exitCode?: number; readonly stderr?: string };

type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | ({ readonly ok: false } & GitFailure);

type TaggedGitResult = { readonly args: readonly string[]; readonly result: GitResult };

function stdoutOf(result: GitResult): string {
  return result.ok ? result.stdout : '';
}

function isNotARepo(stderr: string | undefined): boolean {
  return stderr !== undefined && stderr.includes('not a git repository');
}

function logGitFailure(cwd: string, args: readonly string[], failure: GitFailure): void {
  const command = `git ${args.join(' ')}`;
  if (failure.kind === 'timeout') {
    log.debug('git context command timed out', { cwd, command });
  } else if (failure.kind === 'spawn-error') {
    log.warn('git context command failed to spawn', { cwd, command });
  } else {
    log.debug('git context command failed', {
      cwd,
      command,
      exitCode: failure.exitCode,
      stderr: failure.stderr,
    });
  }
}

/**
 * Run a single `git -C <cwd> <args>` command and return a structured result.
 * The `git -C` form runs in the target directory regardless of the Kaos
 * backend. Both stdout and stderr are captured so callers can tell "not a
 * git repository" (exit 128 + telltale stderr) apart from other failures.
 */
async function runGit(kaos: Kaos, cwd: string, args: readonly string[]): Promise<GitResult> {
  let proc: KaosProcess | undefined;
  try {
    proc = await kaos.exec('git', '-C', cwd, ...args);
  } catch {
    return { ok: false, kind: 'spawn-error' };
  }

  try {
    proc.stdin.end();
  } catch {
    /* stdin 已关闭 */
  }

  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  // Attach a rejection handler up front: if `work` rejects during the
  // timeout-handling window (before the catch block re-awaits it), Node must
  // not flag it as an unhandled rejection.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`git ${args.join(' ')} timed out`));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    if (exitCode !== 0) {
      return { ok: false, kind: 'command-failed', exitCode, stderr: stderr.trim() };
    }
    return { ok: true, stdout: stdout.trim() };
  } catch {
    try {
      await proc.kill('SIGKILL');
    } catch {
      /* 进程已不存在 */
    }
    // Let the streams drain so process resources are released, even though
    // the timed-out/errored output is discarded.
    await work.catch(() => {});
    if (timedOut) return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'command-failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (proc !== undefined) await disposeProcess(proc);
  }
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

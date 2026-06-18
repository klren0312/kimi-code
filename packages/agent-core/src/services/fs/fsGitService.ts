

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type {
  FsDiffRequest,
  FsDiffResponse,
  FsGitStatusRequest,
  FsGitStatusResponse,
  FsPullRequest,
} from '@moonshot-ai/protocol';
import { ISessionService } from '../session/session';

import { FsPathNotFoundError } from './fs';
import { IFsGitService, FsGitUnavailableError, parsePorcelain, parseNumstat } from './fsGit';
import { resolveSafePath } from './fsPathSafety';

/** 限制单个文件的 unified diff 大小（避免生成的超大文件撑爆响应）；响应附带 `truncated` 标志以便 UI 提示。 */
const DIFF_MAX_BYTES = 1_048_576;

const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

export class FsGitService extends Disposable implements IFsGitService {
  readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();

  constructor(@ISessionService protected readonly sessions: ISessionService) {
    super();
  }

  async status(
    sessionId: string,
    req: FsGitStatusRequest,
  ): Promise<FsGitStatusResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const realCwd = await fs.realpath(cwd);

    let filterSet: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filterSet = new Set();
      for (const p of req.paths) {
        const safe = await resolveSafePath(realCwd, p);
        filterSet.add(safe.relative);
      }
    }

    const insideRes = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], realCwd);
    if (insideRes.exitCode !== 0 || insideRes.stdout.trim() !== 'true') {
      throw new FsGitUnavailableError(
        realCwd,
        insideRes.stderr.trim() || `git rev-parse exit ${insideRes.exitCode}`,
      );
    }

    const porcRes = await runCommand(
      'git',
      ['status', '--porcelain=v1', '--branch'],
      realCwd,
    );
    if (porcRes.exitCode !== 0) {

      throw new FsGitUnavailableError(
        realCwd,
        porcRes.stderr.trim() || `git status exit ${porcRes.exitCode}`,
      );
    }

    const result = parsePorcelain(porcRes.stdout, filterSet);

    // 对 HEAD 汇总行级统计。仅在工作树有变更且存在 HEAD 可对比时才值得发起第二次 spawn
    //（无提交的仓库没有可对比的两端）；否则统计值为 0。脏状态从未过滤的 porcelain
    // 读取，numstat 未按 `req.paths` 限定范围 — 头部计数器反映整个工作树，
    // 与 kimi-cli 的 git status 行一致。
    const dirty = porcRes.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('## '));
    if (dirty) {
      const headRes = await runCommand(
        'git',
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        realCwd,
      );
      if (headRes.exitCode === 0) {
        const numstatRes = await runCommand(
          'git',
          ['diff', '--no-color', '--numstat', 'HEAD', '--'],
          realCwd,
        );
        if (numstatRes.exitCode === 0) {
          const stats = parseNumstat(numstatRes.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(realCwd);

    return result;
  }

  private async readPullRequest(cwd: string): Promise<FsPullRequest | null> {
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const res = await runCommand(
      'gh',
      ['pr', 'view', '--json', 'number,url,state'],
      cwd,
      {
        timeoutMs: PR_SPAWN_TIMEOUT_MS,
        env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
      },
    );
    const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
    this.pullRequestCache.set(cwd, { value, fetchedAt: now });
    return value;
  }

  async diff(sessionId: string, req: FsDiffRequest): Promise<FsDiffResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const realCwd = await fs.realpath(cwd);
    const safe = await resolveSafePath(realCwd, req.path);
    const rel = safe.relative;

    const insideRes = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], realCwd);
    if (insideRes.exitCode !== 0 || insideRes.stdout.trim() !== 'true') {
      throw new FsGitUnavailableError(
        realCwd,
        insideRes.stderr.trim() || `git rev-parse exit ${insideRes.exitCode}`,
      );
    }

    const statusRes = await runCommand(
      'git',
      ['status', '--porcelain=v1', '--', rel],
      realCwd,
    );
    if (statusRes.exitCode !== 0) {
      throw new FsGitUnavailableError(
        realCwd,
        statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`,
      );
    }
    const untracked = statusRes.stdout.startsWith('??');

    // 尚无提交的仓库没有 HEAD 可对比 — 所有变更文件均为全新内容，
    // 与未跟踪文件情况相同。
    const headRes = await runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], realCwd);
    const hasHead = headRes.exitCode === 0;

    // 未跟踪文件没有 HEAD 侧内容；与 /dev/null 做 diff 使 UI 获得
    // 全新增的 hunk。`git diff --no-index` 在文件不同时退出码为 1。
    let diffRes: RunResult;
    if (untracked || !hasHead) {
      diffRes = await runCommand(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', rel],
        realCwd,
      );
      if (diffRes.exitCode !== 0 && diffRes.exitCode !== 1) {
        throw new FsGitUnavailableError(
          realCwd,
          diffRes.stderr.trim() || `git diff exit ${diffRes.exitCode}`,
        );
      }
    } else {
      diffRes = await runCommand(
        'git',
        ['diff', '--no-color', 'HEAD', '--', rel],
        realCwd,
      );
      if (diffRes.exitCode !== 0) {
        throw new FsGitUnavailableError(
          realCwd,
          diffRes.stderr.trim() || `git diff exit ${diffRes.exitCode}`,
        );
      }
      if (diffRes.stdout.length === 0 && statusRes.stdout.length === 0) {
        // 无任何变更 — 区分"干净文件"（空 diff 是正常的）和不存在的路径。
        const exists = await fs
          .stat(safe.absolute)
          .then(() => true)
          .catch(() => false);
        if (!exists) throw new FsPathNotFoundError(req.path);
      }
    }

    const full = diffRes.stdout;
    const truncated = full.length > DIFF_MAX_BYTES;
    return {
      path: rel,
      diff: truncated ? full.slice(0, DIFF_MAX_BYTES) : full,
      truncated,
    };
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill();
        finish({ exitCode: -1, stdout, stderr });
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.once('error', () => {
      finish({ exitCode: -1, stdout, stderr });
    });
    child.once('close', (code) => {
      finish({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function parsePullRequest(stdout: string): FsPullRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const number = record['number'];
  const url = record['url'];
  const state = record['state'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
  if (typeof state !== 'string') return null;
  const normalized = state.toLowerCase();
  if (normalized !== 'open' && normalized !== 'merged' && normalized !== 'closed') return null;
  return { number, state: normalized, url };
}

function isSafeHttpUrl(value: string): boolean {
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

registerSingleton(IFsGitService, FsGitService, InstantiationType.Delayed);

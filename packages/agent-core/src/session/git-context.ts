/**
 * explore 子代理的 Git 仓库上下文。
 *
 * `collectGitContext` 生成一个 `<git-context>` 块，该块会被添加到新创建的
 * explore 子代理的提示词前面，使其在搜索前能够了解仓库概况。每条 git 命令
 * 都有独立的保护——单条命令失败不会中止整个收集过程——同时远程 URL 会被
 * 清理，以避免向模型暴露内部基础设施信息。
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';

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
  // 快速检查：是否为 git 仓库？
  if ((await runGit(kaos, cwd, ['rev-parse', '--is-inside-work-tree'])) === null) {
    return '';
  }

  const [remoteUrl, branch, dirtyRaw, logRaw] = await Promise.all([
    runGit(kaos, cwd, ['remote', 'get-url', 'origin']),
    runGit(kaos, cwd, ['branch', '--show-current']),
    runGit(kaos, cwd, ['status', '--porcelain']),
    runGit(kaos, cwd, ['log', '-3', '--format=%h %s']),
  ]);

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

  if (branch) sections.push(`Branch: ${branch}`);

  if (dirtyRaw !== null) {
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
  const project = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
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
 * 执行单个 `git -C <cwd> <args>` 命令并返回其去除空白的 stdout，
 * 任何失败（启动错误、非零退出码或超时）返回 `null`。`git -C` 形式
 * 无论 Kaos 后端如何都会在目标目录中运行。
 */
async function runGit(kaos: Kaos, cwd: string, args: readonly string[]): Promise<string | null> {
  let proc: KaosProcess | undefined;
  try {
    proc = await kaos.exec('git', '-C', cwd, ...args);
  } catch {
    return null;
  }

  try {
    proc.stdin.end();
  } catch {
    /* stdin 已关闭 */
  }

  const work = Promise.all([collectStream(proc.stdout), proc.wait()]);
  // 提前附加拒绝处理器：如果 `work` 在超时处理窗口期间（catch 块重新 await 之前）
  // 被拒绝，Node 不应将其标记为未处理的拒绝。
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`git ${args.join(' ')} timed out`));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, exitCode] = await Promise.race([work, timeout]);
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    try {
      await proc.kill('SIGKILL');
    } catch {
      /* 进程已不存在 */
    }
    // 让 stdout 排尽以释放进程资源，即使超时输出已被丢弃。
    await work.catch(() => {});
    return null;
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

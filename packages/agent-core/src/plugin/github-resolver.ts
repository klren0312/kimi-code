import type { GithubRef } from './source';
import type { PluginGithubRef } from './types';

export interface GithubSourceInput {
  readonly kind: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly ref?: GithubRef;
}

export interface GithubSourceResolution {
  readonly tarballUrl: string;
  readonly displayVersion: string;
  readonly ref: PluginGithubRef;
}

/**
 * 将 `github` 源描述符解析为可下载的 zip URL。
 *
 * 热路径是裸 URL 场景（无显式 ref）。我们刻意避免使用
 * `api.github.com`，因为其匿名配额（每出口 IP 60 次/小时）与用户的
 * 浏览器、gh CLI、IDE 集成等共享，首次安装因其他工具耗尽配额而失败
 * 对我们的用户体验来说是不可接受的。
 *
 * 策略：
 *   1. 显式 ref → 直接使用 codeload，无需预先发起网络请求。
 *   2. 裸 URL：
 *      a. GET `github.com/{owner}/{repo}/releases/latest`，手动处理重定向。
 *         302 → 从 `Location` 头部提取 tag。这是一个被 Homebrew、gh 等
 *         使用的 GitHub UI 路由行为。它*不*计入 API 配额。
 *      b. 404 或 302 到 `/releases`（fork 没有自己的 release）→ 回退到
 *         `codeload.github.com/{o}/{r}/zip/HEAD`，它会流式传输默认分支
 *         的最新提交，无需知道分支名称。
 *      c. codeload 对 HEAD 返回 404 → 仓库本身不存在。
 */
export async function resolveGithubSource(
  input: GithubSourceInput,
): Promise<GithubSourceResolution> {
  const { owner, repo } = input;

  if (input.ref !== undefined) {
    return {
      tarballUrl: codeloadUrl(owner, repo, input.ref),
      displayVersion: input.ref.value,
      ref: { kind: input.ref.kind, value: input.ref.value },
    };
  }

  const latestTag = await tryResolveLatestReleaseTag(owner, repo);
  if (latestTag !== undefined) {
    return {
      tarballUrl: codeloadUrl(owner, repo, { kind: 'tag', value: latestTag }),
      displayVersion: latestTag,
      ref: { kind: 'tag', value: latestTag },
    };
  }

  // 无法解析到 release，回退到通过 codeload 获取默认分支。
  const headProbe = await fetch(
    `https://codeload.github.com/${owner}/${repo}/zip/HEAD`,
    { method: 'HEAD' },
  );
  if (headProbe.status === 404) {
    throw new Error(`Repository \`${owner}/${repo}\` not found or not accessible.`);
  }
  if (!headProbe.ok) {
    throw new Error(
      `Could not access \`${owner}/${repo}\`: HTTP ${headProbe.status} ${headProbe.statusText}.`,
    );
  }
  return {
    tarballUrl: `https://codeload.github.com/${owner}/${repo}/zip/HEAD`,
    displayVersion: 'HEAD',
    ref: { kind: 'branch', value: 'HEAD' },
  };
}

/**
 * 返回值：
 *   - tag 字符串 → 成功解析到最新的 release
 *   - undefined   → 仓库确实没有自己的最新 release；
 *                   调用方应回退到默认分支
 *
 * 遇到任何意外 HTTP 状态码（5xx、403、429 等）时抛出异常。我们刻意
 * *不*将这些情况归为"无 release" —— 在 GitHub 暂时出错时静默安装
 * 默认分支比大声报错更糟糕：用户会得到与预期不同的内容，而我们不会
 * 告知他们。
 */
async function tryResolveLatestReleaseTag(
  owner: string,
  repo: string,
): Promise<string | undefined> {
  const url = `https://github.com/${owner}/${repo}/releases/latest`;
  const resp = await fetch(url, { redirect: 'manual' });

  // 确定性的"没有自己的最新 release"。与暂时性错误不同。
  if (resp.status === 404) return undefined;

  if (resp.status !== 301 && resp.status !== 302) {
    throw new Error(
      `Could not look up latest release of \`${owner}/${repo}\`: ` +
        `HTTP ${resp.status} ${resp.statusText} (${url}). ` +
        `Pin a specific ref with \`/tree/<branch|tag|sha>\` to bypass release lookup.`,
    );
  }

  const location = resp.headers.get('location');
  if (location === null) return undefined;

  // 没有自己 release 的 fork 会重定向到 `/releases`（列出从上游继承的 tag
  // 的页面），而不是特定的 tag URL。将其视为"没有自己的最新 release"，
  // 并回退到默认分支。
  const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

function codeloadUrl(owner: string, repo: string, ref: GithubRef): string {
  const base = `https://codeload.github.com/${owner}/${repo}/zip`;
  const encoded = encodeCodeloadRefPath(ref.value);
  if (ref.kind === 'sha') return `${base}/${encoded}`;
  // 对于确认是 tag 的 ref（来自 /releases/tag/...），使用显式的 refs/tags/ 路径，
  // 以确保下载路径明确，即使仓库中存在同名分支也是如此。
  if (ref.kind === 'tag') return `${base}/refs/tags/${encoded}`;
  // 对于 `branch` 类型的 ref，我们无法判断用户输入的值是分支名还是 tag 名
  // （例如 `/tree/v5.1.0`）。使用 codeload 的短路径形式，让 GitHub 后端
  // 以与 `github.com/.../tree/<x>` 相同的方式解析。
  return `${base}/${encoded}`;
}

/**
 * 对 ref 名称进行百分号编码，以便安全地插入到 codeload URL 路径中。
 *
 * Git 允许 ref 名称中包含在 URL 中具有特殊含义的字符。审查中关注的
 * 案例是 `#`：它是有效的 Git tag 字符（例如名为 `release#1` 的 release），
 * 但同时也是 URL 片段分隔符。直接粘贴到 `…/refs/tags/release#1` 中，
 * `#1` 会被解析为片段，HTTP 请求到达服务器时变成 `…/refs/tags/release` ——
 * 会返回 404，或者更糟，返回不同的 ref。
 *
 * Ref 中也可能合法包含 `/`（名为 `feat/foo` 的分支，或名为 `series/v1` 的 tag）。
 * 我们必须将它们保留为真实的路径分隔符。
 * 因此：按 `/` 分割，对每个段进行百分号编码，然后重新连接。
 */
function encodeCodeloadRefPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

import path from 'node:path';

export interface GithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export type ResolvedSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'zip-url'; path: string }
  | { kind: 'github'; owner: string; repo: string; ref?: GithubRef };

// 作为向后兼容的别名保留，供导入旧名称的下游代码使用。
export type InstallSource = ResolvedSource;

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function resolveInstallSource(source: string): ResolvedSource {
  const trimmed = source.trim();

  const github = parseGithubUrl(trimmed);
  if (github !== undefined) return github;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { kind: 'zip-url', path: trimmed };
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Plugin root must be an absolute path (got "${source}")`);
  }
  return { kind: 'local-path', path: trimmed };
}

function parseGithubUrl(raw: string): ResolvedSource | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const owner = segments[0];
  const repoRaw = segments[1];
  if (owner === undefined || repoRaw === undefined) return undefined;

  const repo = repoRaw.endsWith('.git') ? repoRaw.slice(0, -4) : repoRaw;
  const rest = segments.slice(2);

  if (rest.length === 0) {
    return { kind: 'github', owner, repo };
  }

  const head = rest[0];
  const second = rest[1];

  if (head === 'tree' && rest.length >= 2) {
    // `url.pathname` 保留了百分号编码（例如 `release%231`）。对每个段进行解码，
    // 使存储的 ref 值是人类可读的 Git ref 名称。
    // 解析器在构建 codeload URL 时会重新编码。
    const refValue = decodeRefSegments(rest.slice(1));
    // 在解析时无法区分分支和 tag。对于 SHA 形状的值使用 kind: 'sha'；
    // 否则标记为 'branch'。解析器通过为 'branch' 类型使用 codeload 的短路径 URL
    // 来补偿，让 codeload 自己选择分支或 tag —— 匹配 GitHub UI 中 `/tree/<x>` 的解析方式。
    const kind: GithubRef['kind'] = SHA_RE.test(refValue) ? 'sha' : 'branch';
    return { kind: 'github', owner, repo, ref: { kind, value: refValue } };
  }

  if (head === 'releases' && second === 'tag' && rest.length >= 3) {
    // 识别标准的"这是一个特定 release" URL 形式。早期版本拒绝了它并引导用户
    // 使用 /tree/<tag>，但 /tree/<tag> 无法被解析为 tag（只能是分支），
    // 当 codeload 请求 refs/heads/<tag-name> 时会产生 404。
    const tag = decodeRefSegments(rest.slice(2));
    return { kind: 'github', owner, repo, ref: { kind: 'tag', value: tag } };
  }

  if (head === 'commit' && rest.length >= 2) {
    // 与 /releases/tag/ 的改动对称：commit URL 精确指向一个 SHA，
    // 因此直接接受，而不是将用户重定向到 /tree/<sha>。
    const sha = decodeRefSegments(rest.slice(1));
    return { kind: 'github', owner, repo, ref: { kind: 'sha', value: sha } };
  }

  // /archive/refs/{heads,tags}/X.zip 及其他路径 —— 回退到 zip-url。
  return undefined;
}

/**
 * 连接路径段并对其进行百分号解码，合并为单个 ref 名称。
 *
 * `URL.pathname` 保留 `%xx` 序列（例如 `release%231`），但下游代码将 ref 值
 * 视为原始 Git ref。在此处解码可以保持唯一的规范表示：存储和显示时为人类可读的，
 * 由解析器在构建 codeload URL 时重新编码。
 *
 * 畸形的百分号编码（`%ZZ`）会被容忍：我们保留原始段，使用户在下游看到有意义的
 * 错误，而不是解析崩溃。
 */
function decodeRefSegments(segments: readonly string[]): string {
  return segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

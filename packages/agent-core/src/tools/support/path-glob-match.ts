import { isAbsolute, join, parse } from 'pathe';

import picomatch from 'picomatch';

import { canonicalizePath, type PathClass } from '../policies/path-access';

export interface PermissionPathMatchOptions {
  readonly cwd?: string;
  readonly pathClass?: PathClass;
  readonly homeDir?: string;
  readonly caseInsensitivePaths?: boolean;
}

interface PathMatchSemantics {
  readonly pathClass: PathClass;
}

/**
 * 匹配普通字符串字段，如命令文本或搜索模式。
 * `*` 和 `**` 作为通配符使用，但值不被视为文件路径。
 */
export function globMatch(value: string, pattern: string, options?: { nocase?: boolean }): boolean {
  if (picomatch.isMatch(value, pattern, options)) return true;

  const normalizedValue = stripLeadingDotSlash(value);
  const normalizedPattern = stripLeadingDotSlash(pattern);
  if (normalizedValue === value && normalizedPattern === pattern) return false;
  return picomatch.isMatch(normalizedValue, normalizedPattern, options);
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

/**
 * 匹配文件路径字段，如 Read/Write/Edit 的 `path`。
 * 同时比较规范化形式，使 `./a`、`dir/../a` 以及 Windows 分隔符
 * 或大小写变体也能匹配同一规则。
 */
export function pathGlobMatch(
  value: string,
  pattern: string,
  pathOptions?: PermissionPathMatchOptions,
): boolean {
  const semantics = pathMatchSemantics(value, pattern, pathOptions);
  const nocase = pathOptions?.caseInsensitivePaths ?? true;

  if (globMatch(value, pattern, { nocase })) return true;

  for (const valueVariant of pathVariants(value, semantics, pathOptions)) {
    for (const patternVariant of pathVariants(pattern, semantics, pathOptions)) {
      if (globMatch(valueVariant, patternVariant, { nocase })) return true;
    }
  }
  return false;
}

/**
 * 在 glob 匹配前为一个路径字符串构建等价拼写：
 * 原始文本、去除前导 `./` 或 `.\` 的形式、
 * 可能的规范化绝对路径，以及斜杠形式的 Windows 路径。
 *
 * 示例：cwd 为 `/repo` 时，`./src/../secret.txt` 同时添加
 * `src/../secret.txt` 和 `/repo/secret.txt`。在 Windows 上，
 * `C:\repo\secret.txt` 还会添加 `C:/repo/secret.txt`。
 */
function pathVariants(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string[] {
  const variants = new Set<string>();
  addPathVariant(variants, value, semantics.pathClass);
  addPathVariant(variants, stripLeadingDotPath(value, semantics.pathClass), semantics.pathClass);

  const canonical = canonicalizePathPattern(value, semantics, pathOptions);
  if (canonical !== undefined) addPathVariant(variants, canonical, semantics.pathClass);
  return Array.from(variants);
}

function canonicalizePathPattern(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string | undefined {
  const expanded = expandUserPath(value, semantics.pathClass, pathOptions?.homeDir);
  const cwd = pathOptions?.cwd ?? defaultCwdForPath(expanded);
  if (cwd === undefined) return undefined;
  try {
    return canonicalizePath(expanded, cwd, semantics.pathClass);
  } catch {
    return undefined;
  }
}

function expandUserPath(
  value: string,
  pathClass: PathClass,
  homeDir: string | undefined,
): string {
  if (homeDir === undefined) return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || (pathClass === 'win32' && value.startsWith('~\\'))) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

function defaultCwdForPath(value: string): string | undefined {
  if (!isAbsolute(value)) return undefined;
  return parse(value).root;
}

function pathMatchSemantics(
  value: string,
  pattern: string,
  pathOptions: PermissionPathMatchOptions | undefined,
): PathMatchSemantics {
  // 生产调用方传入当前活跃的 Kaos 路径类。回退逻辑使纯匹配器
  // 对测试和直接辅助函数调用仍然可用。
  const pathClass =
    pathOptions?.pathClass ??
    ([value, pattern].some((candidate) => {
      return (
        /^[A-Za-z]:(?:[\\/]|$)/.test(candidate) ||
        candidate.startsWith('\\\\') ||
        candidate.includes('\\')
      );
    })
      ? 'win32'
      : 'posix');
  return { pathClass };
}

function addPathVariant(variants: Set<string>, value: string, pathClass: PathClass): void {
  variants.add(value);
  // Picomatch 在某些情况下将反斜杠视为转义语法；添加斜杠分隔的
  // Win32 变体使 nocase 和 glob 行为可预测。
  if (pathClass === 'win32') variants.add(value.replaceAll('\\', '/'));
}

function stripLeadingDotPath(value: string, pathClass: PathClass): string {
  if (value.startsWith('./')) return value.slice(2);
  if (pathClass === 'win32' && value.startsWith('.\\')) return value.slice(2);
  return value;
}

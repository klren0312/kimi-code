/**
 * 拦截文件访问工具调用以保护敏感路径的策略。
 *
 * 导出两个策略：
 * - {@link SensitiveFileAccessAskPermissionPolicy}：当工具访问已知敏感文件
 *   （`.env`、SSH 密钥、凭据）时提示用户。
 * - {@link GitControlPathAccessAskPermissionPolicy}：当工具访问 `.git` 内部
 *   或 git 工作树控制目录时提示，这些操作可能损坏版本控制状态。
 *
 * 两者都基于工具声明的 `accesses` 元数据而非解析参数来操作，
 * 因此可在 Write、Edit、Read 和任何未来的文件访问工具之间统一工作。
 */

import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { Agent } from '../..';
import type { ToolFileAccess } from '../../../loop/tool-access';
import { isWithinDirectory, type PathClass } from '../../../tools/policies/path-access';
import { isSensitiveFile } from '../../../tools/policies/sensitive';
import {
  findGitWorkTreeMarker,
  type GitWorkTreeMarker,
} from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * 当工具访问敏感文件（如 `.env`、SSH 密钥或凭据存储）时请求用户批准。
 * 这些文件通常包含不应在未经明确同意的情况下读取或修改的机密信息。
 */
export class SensitiveFileAccessAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const access = fileAccesses(context).find((fileAccess) =>
      isSensitiveFile(fileAccess.path),
    );
    if (access === undefined) return;
    return {
      kind: 'ask',
      reason: fileAccessReason(access, { sensitive_path: true }),
    };
  }
}

/**
 * 当工具访问 git 控制路径（`.git` 目录或工作树控制目录）时请求用户批准。
 * 直接修改 git 内部文件可能损坏仓库状态，因此需要用户确认。
 */
export class GitControlPathAccessAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'git-control-path-access-ask';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return;
    const pathClass = this.agent.kaos.pathClass();
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return;

    const directGitAccess = accesses.find((fileAccess) => {
      return hasGitPathComponent(fileAccess.path, cwd, pathClass);
    });
    if (directGitAccess !== undefined) {
      return {
        kind: 'ask',
        reason: fileAccessReason(directGitAccess, { git_control_path: true }),
      };
    }

    const marker = await findGitWorkTreeMarker(this.agent.kaos, cwd);
    if (marker === null) return;
    const access = accesses.find((fileAccess) => {
      return isGitControlPath(fileAccess.path, marker, pathClass);
    });
    if (access === undefined) return;
    return {
      kind: 'ask',
      reason: fileAccessReason(access, { git_control_path: true }),
    };
  }
}

/** 从工具执行上下文中提取所有文件类型的访问。 */
function fileAccesses(context: PermissionPolicyContext): ToolFileAccess[] {
  return (
    context.execution.accesses?.filter((access): access is ToolFileAccess => access.kind === 'file') ??
    []
  );
}

/**
 * 仅提取具有写入能力的文件访问（write 或 readwrite 操作）。
 * 供其他策略（计划模式守卫、git-cwd-write）用于判断工具调用是否会修改文件。
 */
export function writeFileAccesses(context: PermissionPolicyContext): ToolFileAccess[] {
  return fileAccesses(context).filter(
    (access) => access.operation === 'write' || access.operation === 'readwrite',
  );
}

/** 从文件访问事件构建结构化遥测元数据。 */
function fileAccessReason(access: ToolFileAccess, extra: Record<string, boolean>) {
  return {
    file_access_operation: access.operation,
    recursive: access.recursive === true,
    ...extra,
  };
}

/** 检查从 cwd 到目标的相对路径中是否出现 `.git` 路径组件。 */
function hasGitPathComponent(
  targetPath: string,
  cwd: string,
  pathClass: PathClass,
): boolean {
  return relativePathParts(targetPath, cwd, pathClass).some((part) => part.toLowerCase() === '.git');
}

/** 检查目标路径是否在 git 工作树的 `.git` 或控制目录内。 */
function isGitControlPath(
  targetPath: string,
  marker: GitWorkTreeMarker,
  pathClass: PathClass,
): boolean {
  return (
    isWithinDirectory(targetPath, marker.dotGitPath, pathClass) ||
    isWithinDirectory(targetPath, marker.controlDirPath, pathClass)
  );
}

/** 将从 cwd 到目标的相对路径拆分为非空路径段。 */
function relativePathParts(targetPath: string, cwd: string, pathClass: PathClass): string[] {
  return pathMod(pathClass)
    .relative(cwd, targetPath)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
}

/** 返回给定路径类别对应的适当路径模块（posix 或 win32）。 */
function pathMod(pathClass: PathClass): typeof posixPath {
  return pathClass === 'win32' ? win32Path : posixPath;
}

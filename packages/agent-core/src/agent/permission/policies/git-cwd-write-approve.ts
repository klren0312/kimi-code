/**
 * 批准指向 git 工作树内路径的 Write/Edit 调用的策略。
 *
 * 这是针对常见情况的便捷批准：用户在 git 仓库中工作，agent 需要在该仓库内写入文件。
 * 此策略自动批准满足以下条件的写入，而非每次都提示：
 * 1. 仅限 POSIX 路径（为安全起见跳过 Windows 路径）。
 * 2. 在 agent 的当前工作目录下。
 * 3. 在检测到的 git 工作树内（有 `.git` 目录或文件）。
 *
 * 此策略在链中较晚运行，在所有拒绝和询问策略之后，
 * 因此敏感文件和 git 控制路径检查仍然优先。
 */

import type { Agent } from '../..';
import { isWithinWorkspace } from '../../../tools/policies/path-access';
import { findGitWorkTreeMarker } from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { writeFileAccesses } from './file-access-ask';

/**
 * 当所有文件访问都在 agent 的 cwd 内且该 cwd 在 git 工作树内时，
 * 批准 Write/Edit 工具调用。
 */
export class GitCwdWriteApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;
    if (this.agent.kaos.pathClass() !== 'posix') return;

    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: this.agent.getAdditionalDirs() },
          'posix',
        ),
      )
    ) {
      return;
    }

    const marker = await findGitWorkTreeMarker(this.agent.kaos, cwd);
    if (marker === null) return;

    return {
      kind: 'approve',
    };
  }
}

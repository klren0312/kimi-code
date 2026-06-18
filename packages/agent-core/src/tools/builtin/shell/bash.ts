/**
 * BashTool — 执行 shell 命令。
 *
 * 根据注入的 `Environment` 调用 bash（POSIX）。Windows 上 shell 为
 * Git Bash；路径由 `detectEnvironment` 解析。
 *
 * 通过构造函数注入的依赖：
 *   - `Kaos`        — shell 执行抽象层（exec / execWithEnv）
 *   - `cwd`         — 命令的默认工作目录
 *   - `Environment` — 跨平台探测（shellName / shellPath）
 *   - `BackgroundManager?` — 可选：仅当 run_in_background=true 时必需
 *
 * 执行通过 Kaos 进行，不直接使用 node:child_process。
 *
 * 安全加固：
 *   - `args.timeout`（秒）和环境 `signal` 共同驱动 `Promise.race`；
 *     任一条件触发即发送 kill。
 *   - stdin 立即关闭，使交互式命令（`cat`、`read`、`python -c 'input()'`）
 *     收到 EOF 而非挂起。
 *   - 两阶段 kill：SIGTERM → 5 秒宽限 → SIGKILL（Kaos 跨平台遵守此约定）。
 *   - stdout/stderr 流入 ToolResultBuilder；超出部分替换为截断标记，
 *     防止失控命令导致主机 OOM。
 */

import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { z } from 'zod';

import { ProcessBackgroundTask, type BackgroundManager } from '../../../agent/background';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution, ToolUpdate } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import { isPrematureCloseError } from '../../support/stream';
import bashDescriptionTemplate from './bash.md?raw';

const MS_PER_SECOND = 1000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 5 * 60;
const DEFAULT_BACKGROUND_TIMEOUT_S = 10 * 60;
const MAX_BACKGROUND_TIMEOUT_S = 24 * 60 * 60;
const SIGTERM_GRACE_MS = 5_000;

export const BashInputSchema = z
  .object({
    command: z.string().min(1, 'Command cannot be empty.').describe('The command to execute.'),
    cwd: z
      .string()
      .optional()
      .describe(
        "The working directory in which to run the command. When omitted, the command runs in the session's working directory.",
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TIMEOUT_S)
      .describe(
        `Optional timeout in seconds for the command to execute. Foreground default ${String(DEFAULT_TIMEOUT_S)}s, max ${String(MAX_TIMEOUT_S)}s. Background default ${String(DEFAULT_BACKGROUND_TIMEOUT_S)}s, max ${String(MAX_BACKGROUND_TIMEOUT_S)}s. Ignored for background commands when disable_timeout=true.`,
      )
      .optional(),
    description: z
      .string()
      .optional()
      .describe(
        'A short description for the background task. Required when run_in_background is true.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Whether to run the command as a background task.'),
    disable_timeout: z
      .boolean()
      .optional()
      .describe(
        'If true, do not apply a timeout to the command. Only applies when run_in_background is true.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.timeout === undefined) return;
    const isBackground = val.run_in_background === true;
    if (!isValidTimeoutValue(val.timeout, isBackground)) {
      const cap = isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeout'],
        message: `timeout must be ≤ ${String(cap)}s (${isBackground ? 'background' : 'foreground'})`,
      });
    }
  });

export const BashOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type BashInput = z.Infer<typeof BashInputSchema>;
export type BashOutput = z.Infer<typeof BashOutputSchema>;

const SHELL_TIMEOUT_VARS = {
  DEFAULT_TIMEOUT_S,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
};

function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

function isValidTimeoutValue(timeout: number, isBackground: boolean): boolean {
  return timeout <= timeoutCapS(isBackground);
}

function normalizeTimeoutMs(timeout: number | undefined, isBackground: boolean): number {
  const defaultSeconds = isBackground ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  const value = timeout ?? defaultSeconds;
  return Math.min(value, timeoutCapS(isBackground)) * MS_PER_SECOND;
}

async function disposeProcess(proc: KaosProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
    /* 尽力清理 */
  }
}

function renderBashDescription(shellName: string): string {
  return renderPrompt(bashDescriptionTemplate, { ...SHELL_TIMEOUT_VARS, SHELL_NAME: shellName });
}

function withoutBackgroundDescription(description: string): string {
  return description
    .replace(
      /\n\nIf `run_in_background=true`,[\s\S]*?point them to the `\/tasks` command, which opens an interactive panel; it has no subcommands\./,
      '\n\nBackground execution is disabled for this agent. Do not set `run_in_background=true`.',
    )
    .replace(
      ` For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to ${String(DEFAULT_TIMEOUT_S)}s and allow up to ${String(MAX_TIMEOUT_S)}s.`,
      ` For possibly long-running commands, set the \`timeout\` argument in seconds. The default is ${String(DEFAULT_TIMEOUT_S)}s; foreground commands allow up to ${String(MAX_TIMEOUT_S)}s.`,
    )
    .replace(
      /\n- Prefer `run_in_background=true`[\s\S]*?conversation to continue before the command finishes\./,
      '\n- Do not set `run_in_background=true`; background task management tools are not available.',
    );
}

export class BashTool implements BuiltinTool<BashInput> {
  readonly name = 'Bash' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BashInputSchema);

  private readonly isWindowsBash: boolean;

  private readonly allowBackground: boolean;

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
    private readonly backgroundManager?: BackgroundManager,
    options?: {
      allowBackground?: boolean | undefined;
    },
  ) {
    this.isWindowsBash = this.kaos.osEnv.osKind === 'Windows';
    this.allowBackground = options?.allowBackground ?? this.backgroundManager !== undefined;
    const rendered = renderBashDescription(this.kaos.osEnv.shellName);
    this.description = this.allowBackground ? rendered : withoutBackgroundDescription(rendered);
  }

  resolveExecution(args: BashInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: args.cwd ?? this.cwd,
        description: args.description,
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: ({ signal, onUpdate }) => this.execution(args, signal, onUpdate),
    };
  }

  private spawn(effectiveCwd: string, command: string): Promise<KaosProcess> {
    const shellCwd = this.isWindowsBash ? windowsPathToPosixPath(effectiveCwd) : effectiveCwd;
    const shellArgs = [
      this.kaos.osEnv.shellPath,
      '-c',
      `cd ${shellQuote(shellCwd)} && ${command}`,
    ];

    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      // 默认 '0' 以便在意外继承 TTY 时 git 对私有远程仓库快速失败；
      // 当用户显式设置了环境变量时遵循该值。
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: this.kaos.osEnv.shellPath,
    };

    // 合并环境变量与非交互模式开关，使 git / node 等工具不打开分页器，
    // 并且输出不带颜色。
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...noninteractiveEnv,
    };
    return this.kaos.execWithEnv(shellArgs, mergedEnv);
  }

  private async execution(
    args: BashInput,
    signal: AbortSignal,
    onUpdate?: ((update: ToolUpdate) => void) | undefined,
  ): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before command started' };
    }
    if (args.command.length === 0) {
      return { isError: true, output: 'Command cannot be empty.' };
    }

    if (args.run_in_background) {
      if (!this.allowBackground) {
        return {
          isError: true,
          output:
            'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
        };
      }
      return this.executeInBackground(args);
    }

    const timeoutMs = normalizeTimeoutMs(args.timeout, false);

    let proc: KaosProcess;
    const command = this.isWindowsBash ? rewriteWindowsNullRedirect(args.command) : args.command;
    try {
      const effectiveCwd = args.cwd ?? this.cwd;
      proc = await this.spawn(effectiveCwd, command);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      // 对已退出的进程关闭 stdin 在某些平台上是空操作，在其他平台上会抛异常
      // — 两种情况均可安全忽略。
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

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killProc();
    }, timeoutMs);

    try {
      const builder = new ToolResultBuilder();
      const isTerminating = (): boolean => timedOut || aborted || killed;
      const [, exitCode] = await Promise.all([
        Promise.all([
          readStreamIntoBuilder(proc.stdout, builder, 'stdout', onUpdate, isTerminating),
          readStreamIntoBuilder(proc.stderr, builder, 'stderr', onUpdate, isTerminating),
        ]),
        proc.wait(),
      ]);

      if (timedOut) {
        const timeoutLabel =
          timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
        return builder.error(`Command killed by timeout (${timeoutLabel})`, {
          brief: `Killed by timeout (${timeoutLabel})`,
        });
      }
      if (aborted) {
        return builder.error('Interrupted by user', { brief: 'Interrupted by user' });
      }

      const isError = exitCode !== 0;
      if (isError && builder.nChars === 0) {
        builder.write(`Process exited with code ${String(exitCode)}`);
      }

      if (!isError) {
        return builder.ok('Command executed successfully.');
      }
      return builder.error(`Command failed with exit code: ${String(exitCode)}.`, {
        brief: `Failed with exit code: ${String(exitCode)}`,
      });
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
      await disposeProcess(proc);
    }
  }

  private async executeInBackground(args: BashInput): Promise<ExecutableToolResult> {
    if (!this.backgroundManager) {
      return {
        isError: true,
        output: 'Background execution is not available (no BackgroundManager configured).',
      };
    }
    const backgroundManager = this.backgroundManager;

    if (!args.description?.trim()) {
      return {
        isError: true,
        output: 'description is required when run_in_background is true.',
      };
    }

    const timeoutMs = args.disable_timeout ? undefined : normalizeTimeoutMs(args.timeout, true);

    let proc: KaosProcess;
    const command = this.isWindowsBash ? rewriteWindowsNullRedirect(args.command) : args.command;
    try {
      const effectiveCwd = args.cwd ?? this.cwd;
      proc = await this.spawn(effectiveCwd, command);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      /* 进程已退出 */
    }

    let taskId: string;
    try {
      taskId = backgroundManager.registerTask(
        new ProcessBackgroundTask(proc, command, args.description.trim()),
      );
    } catch (error) {
      try {
        await proc.kill('SIGTERM');
      } catch {
        /* 进程已退出 */
      }
      await disposeProcess(proc);
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    if (timeoutMs !== undefined) {
      const timeoutHandle = setTimeout(() => {
        void (async (): Promise<void> => {
          if (proc.exitCode !== null) return;
          const info = backgroundManager.getTask(taskId);
          if (info && info.status === 'running') {
            void backgroundManager.stop(taskId, 'Timed out');
          }
        })();
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    // registerTask() 将 taskId 同步插入管理器的 Map，因此同一 tick 内
    // 此查找不可能返回 undefined。
    const status = backgroundManager.getTask(taskId)!.status;
    const builder = new ToolResultBuilder();
    builder.write(
      `task_id: ${taskId}\n` +
        `pid: ${String(proc.pid)}\n` +
        `description: ${args.description.trim()}\n` +
        `status: ${status}\n` +
        `automatic_notification: true\n` +
        'next_step: You will be automatically notified when it completes.\n' +
        'next_step: Use TaskOutput with this task_id for a non-blocking status/output snapshot.\n' +
        'next_step: Use TaskStop only if the task must be cancelled.\n' +
        'human_shell_hint: Tell the human to run /tasks to open the interactive background-task panel.',
    );
    return builder.ok('Background task started', { brief: `Started ${taskId}` });
  }
}

async function readStreamIntoBuilder(
  stream: Readable,
  builder: ToolResultBuilder,
  kind: 'stdout' | 'stderr',
  onUpdate?: ((update: ToolUpdate) => void) | undefined,
  suppressPrematureClose?: () => boolean,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of stream) {
      const buf: Buffer =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
      const text = decoder.write(buf);
      if (text.length > 0) onUpdate?.({ kind, text });
      builder.write(text);
    }
  } catch (error) {
    if (!isPrematureCloseError(error) || suppressPrematureClose?.() !== true) {
      throw error;
    }
  }
  const trailing = decoder.end();
  if (trailing.length > 0) onUpdate?.({ kind, text: trailing });
  builder.write(trailing);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) {
    return path.replaceAll('\\', '/');
  }

  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll('\\', '/');
    return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
  }

  return path.replaceAll('\\', '/');
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}

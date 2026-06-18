/**
 * 合成的 `mcp__<server>__authenticate` 工具。
 *
 * 当远程 MCP 服务器进入 `needs-auth` 状态时——即其初始连接因 401 /
 * `UnauthorizedError` 失败且未配置静态 bearer token——{@link ToolManager}
 * 会将真实的 MCP 工具列表替换为这个单独的工具。调用它时：
 *
 *  1. 请求 {@link McpOAuthService} 执行 RFC 9728 / RFC 8414 / RFC 7591
 *     发现并生成授权 URL。
 *  2. 通过 `onUpdate({kind:'status'})` 将该 URL 流式传回模型，并在
 *     工具输出中返回，以便模型将其传递给用户。
 *  3. 在 OAuth 服务持有的一次性本地回调解监听器上阻塞
 *    （最多 {@link DEFAULT_AUTH_TIMEOUT_MS}）。
 *  4. token 持久化后驱动管理器级别的 `reconnect(name)`，将条目切换为
 *     `connected` 并让 `ToolManager` 将合成工具替换为真实的 MCP 工具。
 *
 * 阻塞模式（计划中的选项 1）使实现保持简单，代价是在用户完成浏览器流程
 * 期间保持一个工具调用处于打开状态。如果模型在流程中途再次调用该工具，
 * 则启动新的流程；新的回调解监听器会取代旧的。
 */

import { z } from 'zod';

import {
  type ExecutableTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
} from '../loop';
import { toInputJsonSchema } from '../tools/support/input-schema';
import {
  MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
  type McpOAuthAuthorizationUrlUpdateData,
} from '../rpc/events';
import { AlreadyAuthorizedError, type McpOAuthService } from './oauth';
import { qualifyMcpToolName } from './tool-naming';

const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const AUTH_TOOL_TOOL_NAME = 'authenticate';

const DESCRIPTION_TEMPLATE = (serverName: string): string =>
  `Authenticate with MCP server "${serverName}" via OAuth.

This server requires an OAuth login that has not yet been completed. ` +
  `Calling this tool starts the authorization flow:

  1. The tool prints an authorization URL.
  2. **You must show that URL to the user verbatim** and ask them to open it
     in a browser, sign in, and approve the kimi-code client.
  3. The tool blocks (up to 15 minutes) until the browser redirects back to
     the local callback listener.
  4. On success, kimi-code reconnects the MCP server and the real tools
     replace this synthetic tool.

Take no arguments. Treat the URL as sensitive — do not modify it or strip
query parameters.`;

export interface CreateMcpAuthToolOptions {
  /** 在 `mcp.json` 中配置的友好 MCP 服务器名称。 */
  readonly serverName: string;
  /** MCP 服务器的基础 URL（用于 OAuth 资源元数据发现）。 */
  readonly serverUrl: string;
  /** OAuth 编排器，通常为 `Session` 作用域。 */
  readonly oauthService: McpOAuthService;
  /**
   * token 持久化到磁盘后触发管理器级别的重连。由
   * {@link McpConnectionManager} 实现，并在 {@link ToolManager}
   * 的 `needs-auth` 分支中绑定。
   */
  readonly reconnect: (signal?: AbortSignal) => Promise<void>;
  /**
   * 覆盖每次调用的 OAuth 等待超时时间。测试中设为较小的值；
   * 生产环境调用方应使用默认值。
   */
  readonly timeoutMs?: number;
}

export function createMcpAuthTool(options: CreateMcpAuthToolOptions): ExecutableTool {
  const { serverName, serverUrl, oauthService, reconnect, timeoutMs } = options;
  const name = qualifyMcpToolName(serverName, AUTH_TOOL_TOOL_NAME);
  const description = DESCRIPTION_TEMPLATE(serverName);
  // 无参数；空对象 schema 可以兼容各 SDK 提供方。
  const parameters = toInputJsonSchema(z.object({}));
  const execute = async (ctx: ExecutableToolContext): Promise<ExecutableToolResult> => {
    const { signal, onUpdate } = ctx;
    signal.throwIfAborted();

    onUpdate?.({ kind: 'status', text: `Discovering OAuth metadata for ${serverName}…` });

    let flow: Awaited<ReturnType<McpOAuthService['beginAuthorization']>>;
    try {
      flow = await oauthService.beginAuthorization(serverName, serverUrl);
    } catch (error) {
      if (error instanceof AlreadyAuthorizedError) {
        onUpdate?.({ kind: 'status', text: `Already authorized; reconnecting ${serverName}…` });
        try {
          await reconnect(signal);
        } catch (reconnectError) {
          return errorResult(serverName, reconnectError);
        }
        return {
          output:
            `MCP server "${serverName}" already had valid OAuth credentials. ` +
            `Reconnected; real tools are available now.`,
        };
      }
      return errorResult(serverName, error);
    }

    const urlText = flow.authorizationUrl.toString();
    const customData: McpOAuthAuthorizationUrlUpdateData = {
      serverName,
      authorizationUrl: urlText,
    };
    onUpdate?.({
      kind: 'custom',
      customKind: MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
      customData,
    });
    onUpdate?.({
      kind: 'status',
      text:
        `Open this URL in your browser to authorize "${serverName}":\n` +
        `\n${urlText}\n\n` +
        `Waiting for the OAuth callback (timeout 15 min). ` +
        `If you cancel, call this tool again to restart the flow.`,
    });

    try {
      await flow.complete({ signal, timeoutMs: timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS });
    } catch (error) {
      return errorResult(serverName, error, urlText);
    }

    onUpdate?.({ kind: 'status', text: `Authorized — reconnecting ${serverName}…` });
    try {
      await reconnect(signal);
    } catch (error) {
      return errorResult(serverName, error);
    }

    return {
      output:
        `MCP server "${serverName}" authenticated successfully. ` +
        `The real MCP tools have replaced this synthetic authenticate tool.`,
    };
  };

  return {
    name,
    description,
    parameters,
    resolveExecution: () => {
      return {
        description: `Authenticating ${serverName}`,
        approvalRule: name,
        execute,
      };
    },
  };
}

function errorResult(
  serverName: string,
  error: unknown,
  authorizationUrl?: string,
): ExecutableToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const suffix =
    authorizationUrl !== undefined
      ? `\n\nAuthorization URL (still valid if the listener has not timed out): ${authorizationUrl}`
      : '';
  return {
    isError: true,
    output: `OAuth flow for MCP server "${serverName}" did not complete: ${message}${suffix}`,
  };
}

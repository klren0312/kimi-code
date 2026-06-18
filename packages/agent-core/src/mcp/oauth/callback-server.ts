/**
 * 一次性本地主机 OAuth 回调监听器。
 *
 * `startCallbackServer()` 绑定 127.0.0.1 上的随机空闲端口并返回一个句柄，
 * 暴露结果的 `redirect_uri` 和可等待的 `waitForCode()`，该方法使用第一个
 * `/callback` 请求中的 `{ code, state }` 解析。后续请求收到通用的 404，
 * 非回调路径被忽略。代码交付后（或显式调用 `close()` 后）服务器自动关闭。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CallbackResult {
  readonly code: string;
  readonly state: string | undefined;
}

export interface CallbackServer {
  readonly redirectUri: string;
  /**
   * 使用 OAuth 回调载荷解析，或在以下情况拒绝：
   *  - `signal` 中止 → AbortError
   *  - `timeoutMs` 超时 → Error('OAuth callback timed out')
   *  - 用户的授权服务器返回错误 → Error('OAuth error: <code>')
   */
  waitForCode(opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallbackResult>;
  close(): Promise<void>;
}

const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Authorized</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in complete</h1>' +
  '<p>You can close this tab and return to kimi-code.</p>' +
  '</body></html>';

const ERROR_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in failed</h1>' +
  '<p>The authorization server reported an error. Return to kimi-code for details.</p>' +
  '</body></html>';

export async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode: ((value: CallbackResult) => void) | undefined;
  let rejectCode: ((reason: Error) => void) | undefined;
  let settled = false;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res);
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' || req.url === undefined) {
      res.writeHead(404).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(404).end();
      return;
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const errorParam = url.searchParams.get('error');
    if (errorParam !== null) {
      const description = url.searchParams.get('error_description') ?? '';
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
      settle(() => {
        rejectCode?.(
          new Error(`OAuth error: ${errorParam}${description ? ` — ${description}` : ''}`),
        );
      });
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code.length === 0) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(ERROR_HTML);
      settle(() => {
        rejectCode?.(new Error('OAuth callback missing authorization code'));
      });
      return;
    }
    const state = url.searchParams.get('state') ?? undefined;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);
    settle(() => {
      resolveCode?.({ code, state });
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  const waitForCode: CallbackServer['waitForCode'] = ({ signal, timeoutMs } = {}) => {
    return new Promise<CallbackResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        settle(() =>
          rejectCode?.(
            signal?.reason instanceof Error ? signal.reason : new Error('OAuth flow aborted'),
          ),
        );
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      resolveCode = (value) => {
        cleanup();
        void close();
        resolve(value);
      };
      rejectCode = (reason) => {
        cleanup();
        void close();
        reject(reason);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(() => rejectCode?.(new Error('OAuth callback timed out')));
        }, timeoutMs);
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  return { redirectUri, waitForCode, close };
}

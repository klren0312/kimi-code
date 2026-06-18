/**
 * LLM 通信日志记录器 & Web 查看器
 *
 * 此模块提供 AI 通信（LLM 请求/响应）的实时日志记录，
 * 包括基于文件的日志记录和通过 Server-Sent Events (SSE) 的内置 Web 查看器。
 *
 * 功能：
 * - 记录所有 LLM 请求（系统提示词、工具、消息）和响应（内容、工具调用、用量）
 * - 实时 Web 查看器：http://127.0.0.1:9877
 * - OAuth 设备码流程集成（在 Web 查看器中显示授权提示）
 * - 自动轮转日志文件（10MB 限制）
 * - 支持局域网访问（通过 KIMI_CODE_LOG_LLM_HOST=0.0.0.0）
 *
 * 用法：
 *   设置 KIMI_CODE_LOG_LLM=1 环境变量以启用
 *   启动时终端会显示 Web 查看器 URL
 *
 * 环境变量：
 *   KIMI_CODE_LOG_LLM=1          启用日志
 *   KIMI_CODE_LOG_LLM_HOST       监听地址（默认 127.0.0.1，设为 0.0.0.0 支持局域网）
 *   KIMI_CODE_LOG_LLM_PORT       监听端口（默认 9877）
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathe';

import { grandTotal, inputTotal, type TokenUsage } from '@moonshot-ai/kosong';
import type { ContentPart, Message, Tool } from '@moonshot-ai/kosong';

// ============================================================================
// 常量 & 配置
// ============================================================================

/** 日志文件目录：~/.kimi-code/logs/ */
const LOG_DIR = join(homedir(), '.kimi-code', 'logs');

/** 主日志文件路径 */
const LOG_FILE = join(LOG_DIR, 'llm-communication.log');

/** 日志文件轮转前的最大大小（10MB） */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** 轮转后的日志文件路径（当当前文件超过 MAX_FILE_SIZE 时） */
const ROTATED_FILE = `${LOG_FILE}.1`;

/** Web 查看器 HTTP 服务器的默认端口 */
const DEFAULT_PORT = 9877;

/** Web 查看器 HTTP 服务器的默认主机 */
const DEFAULT_HOST = '127.0.0.1';

// ============================================================================
// 模块状态
// ============================================================================

/** 是否启用日志记录（由 KIMI_CODE_LOG_LLM 环境变量控制） */
let enabled = false;

/** 已连接的 SSE（Server-Sent Events）客户端，用于实时 Web 查看器 */
let sseClients: Set<ServerResponse> = new Set();

/** Web 查看器的 HTTP 服务器实例 */
let httpServer: ReturnType<typeof createServer> | null = null;

/** OAuth 设备码事件的回调（可选） */
let deviceCodeCallback: ((info: DeviceCodeInfo) => void) | null = null;

/** 来自 Web 查看器的审批响应回调 */
let approvalResponseCallback: ((requestId: string, approved: boolean, scope?: string) => void) | null = null;

// ============================================================================
// 类型
// ============================================================================

/**
 * OAuth 设备码授权信息（RFC 8628）。
 * 需要登录时在 Web 查看器中显示。
 */
export interface DeviceCodeInfo {
  /** 用户需要在验证 URI 中输入的代码 */
  userCode: string;
  /** 基础验证 URI（用户手动输入代码） */
  verificationUri: string;
  /** 预填代码的完整验证 URI（可点击链接） */
  verificationUriComplete: string;
  /** 设备码过期的剩余秒数（未知时为 null） */
  expiresIn: number | null;
  /** 轮询间隔（秒） */
  interval: number;
}

/**
 * 待记录的 LLM 请求数据。
 * 包含发送给 AI 模型的所有信息。
 */
export interface LlmCommunicationRequest {
  /** Provider 名称（如 'kimi'、'openai'、'anthropic'） */
  provider: string;
  /** 模型名称（如 'kimi-k2'、'gpt-4'） */
  model: string;
  /** 发送给模型的系统提示词 */
  systemPrompt: string;
  /** 模型可调用的可用工具 */
  tools: readonly Tool[];
  /** 对话历史（发送给模型的消息） */
  history: readonly Message[];
}

/**
 * 待记录的 LLM 响应数据。
 * 包含模型的输出和用量统计。
 */
export interface LlmCommunicationResponse {
  /** 响应的文本内容 */
  content: string;
  /** 模型请求的工具调用 */
  toolCalls: Array<{ name: string; arguments: string }>;
  /** Token 用量统计（provider 未报告时为 null） */
  usage: TokenUsage | null;
  /** 模型停止生成的原因（如 'completed'、'tool_calls'、'truncated'） */
  finishReason: string | null;
  /** 总请求耗时（毫秒） */
  durationMs: number;
}

/**
 * 通过 SSE 发送到 Web 查看器的所有日志条目的联合类型。
 * 每个条目都有一个 `type` 字段用于区分不同的事件类型。
 */
type LlmLogEntry =
  | {
      type: 'request';
      timestamp: string;
      request: {
        provider: string;
        model: string;
        systemPrompt: string;
        tools: unknown[];
        messages: unknown[];
      };
    }
  | {
      type: 'response';
      timestamp: string;
      response: {
        content: string;
        toolCalls: Array<{ name: string; arguments: string }>;
        usage: { input: number; output: number; total: number } | null;
        finishReason: string | null;
        durationMs: number;
      };
    }
  | {
      type: 'auth';
      timestamp: string;
      auth: {
        userCode: string;
        verificationUri: string;
        verificationUriComplete: string;
        expiresIn: number | null;
        interval: number;
      };
    }
  | {
      type: 'auth_complete';
      timestamp: string;
      authComplete: { success: boolean; message?: string };
    }
  | {
      type: 'approval';
      timestamp: string;
      approval: {
        toolName: string;
        toolInput: string;
        requestId: string;
      };
    }
  | {
      type: 'approval_result';
      timestamp: string;
      approvalResult: {
        requestId: string;
        approved: boolean;
        scope?: string;
      };
    };

// ============================================================================
// 控制函数
// ============================================================================

/**
 * 检查 LLM 通信日志是否启用。
 * @returns 如果设置了 KIMI_CODE_LOG_LLM=1 则返回 true
 */
export function isLlmCommunicationLogEnabled(): boolean {
  return enabled;
}

/**
 * 启用 LLM 通信日志并创建日志目录。
 * 启动时设置 KIMI_CODE_LOG_LLM=1 后调用。
 */
export function enableLlmCommunicationLog(): void {
  enabled = true;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // 目录可能已存在，忽略
  }
}

/**
 * 设置 OAuth 设备码事件的回调。
 * 用于在收到设备码信息时通知认证流程。
 */
export function setDeviceCodeCallback(callback: (info: DeviceCodeInfo) => void): void {
  deviceCodeCallback = callback;
}

/**
 * 设置来自 Web 查看器的审批响应回调。
 * 当用户在浏览器中点击批准/拒绝时调用。
 *
 * @param callback - 处理审批响应的函数 (requestId, approved, scope)
 */
export function setApprovalResponseCallback(
  callback: (requestId: string, approved: boolean, scope?: string) => void,
): void {
  approvalResponseCallback = callback;
}

/**
 * 触发认证事件并广播给 Web 查看器。
 * 当 CLI 从 OAuth 服务器收到设备码授权信息时调用。
 *
 * @param info - 设备码信息，包含用户代码和验证 URI
 */
export function triggerDeviceCodeAuth(info: DeviceCodeInfo): void {
  broadcastToClients({
    type: 'auth',
    timestamp: new Date().toISOString(),
    auth: {
      userCode: info.userCode,
      verificationUri: info.verificationUri,
      verificationUriComplete: info.verificationUriComplete,
      expiresIn: info.expiresIn,
      interval: info.interval,
    },
  });

  // 如果设置了回调也调用
  if (deviceCodeCallback) {
    deviceCodeCallback(info);
  }
}

/**
 * 触发认证完成事件并广播给 Web 查看器。
 * 登录成功或失败时调用。
 *
 * @param success - 登录是否成功
 * @param message - 可选消息，显示在 Web 查看器中
 */
export function triggerAuthComplete(success: boolean, message?: string): void {
  broadcastToClients({
    type: 'auth_complete',
    timestamp: new Date().toISOString(),
    authComplete: { success, message },
  });
}

/**
 * 触发审批请求事件并广播给 Web 查看器。
 * 当工具（MCP、bash、文件编辑等）需要用户批准时调用。
 *
 * @param toolName - 请求批准的工具名称（如 'bash'、'write'、'mcp__server__tool'）
 * @param toolInput - 工具的输入/参数
 * @param requestId - 此审批请求的唯一标识符
 */
export function triggerApprovalRequest(
  toolName: string,
  toolInput: string,
  requestId: string,
): void {
  broadcastToClients({
    type: 'approval',
    timestamp: new Date().toISOString(),
    approval: {
      toolName,
      toolInput,
      requestId,
    },
  });
}

/**
 * 触发审批结果事件并广播给 Web 查看器。
 * 当用户批准或拒绝工具请求时调用。
 *
 * @param requestId - 审批请求 ID
 * @param approved - 请求是否被批准
 * @param scope - 'once' 表示单次使用，'session' 表示整个会话
 */
export function triggerApprovalResult(
  requestId: string,
  approved: boolean,
  scope?: string,
): void {
  broadcastToClients({
    type: 'approval_result',
    timestamp: new Date().toISOString(),
    approvalResult: {
      requestId,
      approved,
      scope,
    },
  });
}

// ============================================================================
// 格式化辅助函数
// ============================================================================

/**
 * 将字符串截断到最大长度，截断时添加提示。
 * 用于防止日志中的内容过长。
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated, total ${str.length} chars]`;
}

/**
 * 将对象安全序列化为 JSON 字符串，带截断。
 * JSON.stringify 失败时回退到 String()。
 */
function safeStringify(obj: unknown, maxLen: number): string {
  try {
    return truncate(JSON.stringify(obj, null, 2), maxLen);
  } catch {
    return truncate(String(obj), maxLen);
  }
}

/**
 * 格式化内容部分用于日志记录。
 * 将 provider 特定内容转换为简化表示。
 * - 文本：保持原样
 * - 思考：截断到 2000 字符
 * - 图片/音频/视频：替换为占位符
 */
function formatContentPart(p: ContentPart): unknown {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.type === 'think') return { type: 'think', think: truncate(p.think, 2000) };
  if (p.type === 'image_url') return { type: 'image_url', url: '[image]' };
  if (p.type === 'audio_url') return { type: 'audio_url', url: '[audio]' };
  if (p.type === 'video_url') return { type: 'video_url', url: '[video]' };
  return p;
}

/**
 * 格式化消息数组用于日志记录。
 * 每条消息包含角色、内容和可选的工具调用。
 */
function formatMessages(messages: readonly Message[]): unknown[] {
  if (messages.length === 0) return [];
  return messages.map((m) => {
    const summary: Record<string, unknown> = { role: m.role };

    // 处理内容（字符串或内容部分数组）
    if (typeof m.content === 'string') {
      summary['content'] = m.content;
    } else if (Array.isArray(m.content)) {
      summary['content'] = m.content.map(formatContentPart);
    }

    // 包含工具调用（如果有）
    if (m.toolCalls && m.toolCalls.length > 0) {
      summary['toolCalls'] = m.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: truncate(tc.arguments ?? '', 2000),
      }));
    }

    // 工具结果消息包含 toolCallId
    if (m.toolCallId !== undefined) {
      summary['toolCallId'] = m.toolCallId;
    }

    return summary;
  });
}

/**
 * 格式化工具列表用于日志记录。
 * 仅包含名称和描述（不含参数 schema），保持日志可读。
 */
function formatTools(tools: readonly Tool[]): unknown[] {
  if (tools.length === 0) return [];
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

// ============================================================================
// SSE 广播
// ============================================================================

/**
 * 向所有已连接的 SSE 客户端（Web 查看器）广播日志条目。
 * 断开的连接会自动清理。
 *
 * @param entry - 要广播的日志条目
 */
function broadcastToClients(entry: LlmLogEntry): void {
  if (sseClients.size === 0) return;

  // 格式化为 SSE 消息 (data: <json>\n\n)
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  const dead: ServerResponse[] = [];

  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      // 客户端断开连接，标记待移除
      dead.push(client);
    }
  }

  // 清理断开的连接
  for (const client of dead) {
    sseClients.delete(client);
  }
}

// ============================================================================
// 文件日志
// ============================================================================

/**
 * 将一行写入日志文件，带自动轮转。
 * 文件超过 MAX_FILE_SIZE 时轮转到 <file>.1
 */
function writeLine(line: string): void {
  if (!enabled) return;

  try {
    // 检查是否需要轮转
    const stat = statSync(LOG_FILE, { throwIfNoEntry: false });
    if (stat && stat.size > MAX_FILE_SIZE) {
      try {
        renameSync(LOG_FILE, ROTATED_FILE);
      } catch {
        // 轮转失败，继续写入当前文件
      }
    }

    // 追加到日志文件
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // 文件尚不存在，创建目录后重试
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(LOG_FILE, line, 'utf-8');
    } catch {
      // 最后手段：静默失败
    }
  }
}

// ============================================================================
// 公共日志函数
// ============================================================================

/**
 * 将 LLM 请求记录到文件并广播给 Web 查看器。
 * 每次 LLM API 调用前调用。
 *
 * @param req - 请求数据，包含 provider、模型、提示词、工具和历史
 */
export function logLlmRequest(req: LlmCommunicationRequest): void {
  const timestamp = new Date().toISOString();
  const separator = '='.repeat(80);

  // 构建日志文件条目
  let text = `\n${separator}\n`;
  text += `[${timestamp}] LLM REQUEST\n`;
  text += `Provider: ${req.provider}\n`;
  text += `Model: ${req.model}\n`;
  text += `${separator}\n`;

  text += `\n--- System Prompt ---\n`;
  text += `${truncate(req.systemPrompt, 10000)}\n`;

  text += `\n--- Tools (${req.tools.length}) ---\n`;
  text += `${safeStringify(formatTools(req.tools), 10000)}\n`;

  text += `\n--- Messages (${req.history.length}) ---\n`;
  text += `${safeStringify(formatMessages(req.history), 50000)}\n`;

  text += '\n';

  // 写入文件
  writeLine(text);

  // 广播给 Web 查看器
  broadcastToClients({
    type: 'request',
    timestamp,
    request: {
      provider: req.provider,
      model: req.model,
      systemPrompt: req.systemPrompt,
      tools: formatTools(req.tools),
      messages: formatMessages(req.history),
    },
  });
}

/**
 * 将 LLM 响应记录到文件并广播给 Web 查看器。
 * 每次 LLM API 调用完成后调用。
 *
 * @param res - 响应数据，包含内容、工具调用、用量和耗时
 */
export function logLlmResponse(res: LlmCommunicationResponse): void {
  const timestamp = new Date().toISOString();
  const separator = '-'.repeat(80);

  // 构建日志文件条目
  let text = `\n--- Response [${timestamp}] (${res.durationMs}ms) ---\n`;
  text += `Finish reason: ${res.finishReason ?? 'unknown'}\n`;

  if (res.usage) {
    text += `Tokens: input=${inputTotal(res.usage)} output=${res.usage.output} total=${grandTotal(res.usage)}\n`;
  }

  text += `\n--- Content ---\n`;
  text += `${truncate(res.content, 50000)}\n`;

  if (res.toolCalls.length > 0) {
    text += `\n--- Tool Calls (${res.toolCalls.length}) ---\n`;
    for (const tc of res.toolCalls) {
      text += `  ${tc.name}(${truncate(tc.arguments, 2000)})\n`;
    }
  }

  text += '\n';

  // 写入文件
  writeLine(text);

  // 广播给 Web 查看器（将用量标准化为简单总数）
  broadcastToClients({
    type: 'response',
    timestamp,
    response: {
      content: res.content,
      toolCalls: res.toolCalls,
      usage: res.usage
        ? {
            input: inputTotal(res.usage),
            output: res.usage.output,
            total: grandTotal(res.usage),
          }
        : null,
      finishReason: res.finishReason,
      durationMs: res.durationMs,
    },
  });
}

// ============================================================================
// Web 查看器 (HTML/CSS/JS)
// ============================================================================

/**
 * 使用原始文本加载器导入 Web 查看器的 HTML 页面。
 * 确保 HTML 内容在构建时嵌入到 bundle 中。
 */
import HTML_PAGE from './llm-viewer.html?raw';

// ============================================================================
// HTTP 服务器
// ============================================================================
// HTTP 服务器
// ============================================================================

/**
 * 处理 Web 查看器的 HTTP 请求。
 * 路由：
 *   GET /events              - SSE 端点，用于实时日志流
 *   GET /api/logs            - 原始日志文件内容
 *   POST /api/approval/:id   - 从 Web 查看器提交审批响应
 *   GET /                    - Web 查看器的 HTML 页面
 */
function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // SSE 端点：客户端连接此端点获取实时更新
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n'); // SSE 注释，保持连接活跃
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
    return;
  }

  // 审批响应回调端点：Web 查看器提交审批决定
  const approvalMatch = url.pathname.match(/^\/api\/approval\/(.+)$/);
  if (approvalMatch && req.method === 'POST' && approvalMatch[1] !== undefined) {
    const requestId = approvalMatch[1];
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // 无论 enabled 状态如何，设置了回调就调用
        if (approvalResponseCallback) {
          approvalResponseCallback(requestId, data.approved === true, data.scope);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid request body' }));
      }
    });
    return;
  }

  // POST 请求的 CORS 预检
  if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 原始日志文件端点
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    try {
      const content = readFileSync(LOG_FILE, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('(no logs yet)');
    }
    return;
  }

  // Web 查看器的 HTML 页面
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  // 未知路由返回 404
  res.writeHead(404);
  res.end('Not found');
}

// ============================================================================
// 服务器生命周期
// ============================================================================

/**
 * 启动 Web 查看器 HTTP 服务器。
 * 启动时设置 KIMI_CODE_LOG_LLM=1 后调用。
 * 在终端中显示 URL 以便访问。
 *
 * @param port - 监听端口（默认：9877）
 * @param host - 监听地址（默认：127.0.0.1，设置为 '0.0.0.0' 可支持局域网访问）
 */
export function startLlmLogServer(port = DEFAULT_PORT, host = DEFAULT_HOST): void {
  if (httpServer !== null) return;

  httpServer = createServer(handleHttpRequest);
  httpServer.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? '0.0.0.0' : host;
    const url = `http://${displayHost}:${port}`;
    process.stdout.write(`\n`);
    process.stdout.write(`┌─────────────────────────────────────────────────────────┐\n`);
    process.stdout.write(`│  📊 LLM Communication Log                               │\n`);
    process.stdout.write(`│  ${url.padEnd(55)}│\n`);
    if (host === '0.0.0.0') {
      process.stdout.write(`│  ⚠️  局域网可访问，请注意安全                              │\n`);
    }
    process.stdout.write(`└─────────────────────────────────────────────────────────┘\n`);
    process.stdout.write(`\n`);
  });
}

/**
 * 停止 Web 查看器 HTTP 服务器并关闭所有 SSE 连接。
 * 进程退出或禁用日志时调用。
 */
export function stopLlmLogServer(): void {
  if (httpServer === null) return;

  // 关闭所有 SSE 连接
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();

  // 关闭 HTTP 服务器
  httpServer.close();
  httpServer = null;
}

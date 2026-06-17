/**
 * LLM Communication Logger & Web Viewer
 *
 * This module provides real-time logging of AI communication (LLM requests/responses)
 * with both file-based logging and a built-in web viewer via Server-Sent Events (SSE).
 *
 * Features:
 * - Logs all LLM requests (system prompt, tools, messages) and responses (content, tool calls, usage)
 * - Real-time web viewer at http://127.0.0.1:9877
 * - OAuth device code flow integration (shows auth prompts in web viewer)
 * - Auto-rotating log files (10MB limit)
 *
 * Usage:
 *   Set KIMI_CODE_LOG_LLM=1 environment variable to enable
 *   The web viewer URL will be displayed in the terminal on startup
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathe';

import { grandTotal, inputTotal, type TokenUsage } from '@moonshot-ai/kosong';
import type { ContentPart, Message, Tool } from '@moonshot-ai/kosong';

// ============================================================================
// Constants & Configuration
// ============================================================================

/** Directory for log files: ~/.kimi-code/logs/ */
const LOG_DIR = join(homedir(), '.kimi-code', 'logs');

/** Main log file path */
const LOG_FILE = join(LOG_DIR, 'llm-communication.log');

/** Maximum log file size before rotation (10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Rotated log file path (when current file exceeds MAX_FILE_SIZE) */
const ROTATED_FILE = `${LOG_FILE}.1`;

/** Default port for the web viewer HTTP server */
const DEFAULT_PORT = 9877;

// ============================================================================
// Module State
// ============================================================================

/** Whether logging is enabled (controlled by KIMI_CODE_LOG_LLM env var) */
let enabled = false;

/** Connected SSE (Server-Sent Events) clients for real-time web viewer */
let sseClients: Set<ServerResponse> = new Set();

/** HTTP server instance for the web viewer */
let httpServer: ReturnType<typeof createServer> | null = null;

/** Callback for OAuth device code events (optional) */
let deviceCodeCallback: ((info: DeviceCodeInfo) => void) | null = null;

/** Callback for approval responses from web viewer */
let approvalResponseCallback: ((requestId: string, approved: boolean, scope?: string) => void) | null = null;

// ============================================================================
// Types
// ============================================================================

/**
 * OAuth device code authorization information (RFC 8628).
 * Displayed in the web viewer when login is required.
 */
export interface DeviceCodeInfo {
  /** The code the user must enter at the verification URI */
  userCode: string;
  /** Base verification URI (user types code manually) */
  verificationUri: string;
  /** Complete verification URI with code pre-filled (clickable link) */
  verificationUriComplete: string;
  /** Seconds until the device code expires (null if unknown) */
  expiresIn: number | null;
  /** Polling interval in seconds */
  interval: number;
}

/**
 * LLM request data to be logged.
 * Contains all information sent to the AI model.
 */
export interface LlmCommunicationRequest {
  /** Provider name (e.g., 'kimi', 'openai', 'anthropic') */
  provider: string;
  /** Model name (e.g., 'kimi-k2', 'gpt-4') */
  model: string;
  /** System prompt sent to the model */
  systemPrompt: string;
  /** Available tools the model can call */
  tools: readonly Tool[];
  /** Conversation history (messages sent to the model) */
  history: readonly Message[];
}

/**
 * LLM response data to be logged.
 * Contains the model's output and usage statistics.
 */
export interface LlmCommunicationResponse {
  /** Text content of the response */
  content: string;
  /** Tool calls requested by the model */
  toolCalls: Array<{ name: string; arguments: string }>;
  /** Token usage statistics (null if not reported by provider) */
  usage: TokenUsage | null;
  /** Why the model stopped generating (e.g., 'completed', 'tool_calls', 'truncated') */
  finishReason: string | null;
  /** Total request duration in milliseconds */
  durationMs: number;
}

/**
 * Union type for all log entries sent via SSE to the web viewer.
 * Each entry has a `type` field to distinguish between different event types.
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
// Control Functions
// ============================================================================

/**
 * Check if LLM communication logging is enabled.
 * @returns true if KIMI_CODE_LOG_LLM=1 was set
 */
export function isLlmCommunicationLogEnabled(): boolean {
  return enabled;
}

/**
 * Enable LLM communication logging and create the log directory.
 * Called once at startup when KIMI_CODE_LOG_LLM=1 is set.
 */
export function enableLlmCommunicationLog(): void {
  enabled = true;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Directory may already exist, ignore
  }
}

/**
 * Set a callback for OAuth device code events.
 * Used by the auth flow to notify when device code info is received.
 */
export function setDeviceCodeCallback(callback: (info: DeviceCodeInfo) => void): void {
  deviceCodeCallback = callback;
}

/**
 * Set a callback for approval responses from the web viewer.
 * Called when user clicks Approve/Reject in the browser.
 *
 * @param callback - Function to handle approval response (requestId, approved, scope)
 */
export function setApprovalResponseCallback(
  callback: (requestId: string, approved: boolean, scope?: string) => void,
): void {
  approvalResponseCallback = callback;
}

/**
 * Trigger an auth event to be broadcast to web viewers.
 * Called when the CLI receives device code authorization info from the OAuth server.
 *
 * @param info - Device code information containing user code and verification URIs
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

  // Also call the optional callback if set
  if (deviceCodeCallback) {
    deviceCodeCallback(info);
  }
}

/**
 * Trigger an auth completion event to be broadcast to web viewers.
 * Called when login succeeds or fails.
 *
 * @param success - Whether the login was successful
 * @param message - Optional message to display in the web viewer
 */
export function triggerAuthComplete(success: boolean, message?: string): void {
  broadcastToClients({
    type: 'auth_complete',
    timestamp: new Date().toISOString(),
    authComplete: { success, message },
  });
}

/**
 * Trigger an approval request event to be broadcast to web viewers.
 * Called when a tool (MCP, bash, file edit, etc.) requires user approval.
 *
 * @param toolName - Name of the tool requesting approval (e.g., 'bash', 'write', 'mcp__server__tool')
 * @param toolInput - The input/arguments for the tool
 * @param requestId - Unique identifier for this approval request
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
 * Trigger an approval result event to be broadcast to web viewers.
 * Called when the user approves or rejects a tool request.
 *
 * @param requestId - The approval request ID
 * @param approved - Whether the request was approved
 * @param scope - 'once' for single use, 'session' for entire session
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
// Formatting Helpers
// ============================================================================

/**
 * Truncate a string to a maximum length, adding a notice if truncated.
 * Used to prevent excessively long content in logs.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated, total ${str.length} chars]`;
}

/**
 * Safely serialize an object to JSON string with truncation.
 * Falls back to String() if JSON.stringify fails.
 */
function safeStringify(obj: unknown, maxLen: number): string {
  try {
    return truncate(JSON.stringify(obj, null, 2), maxLen);
  } catch {
    return truncate(String(obj), maxLen);
  }
}

/**
 * Format a content part for logging.
 * Converts provider-specific content to a simplified representation.
 * - Text: kept as-is
 * - Thinking: truncated to 2000 chars
 * - Images/audio/video: replaced with placeholder
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
 * Format an array of messages for logging.
 * Each message includes role, content, and optional tool calls.
 */
function formatMessages(messages: readonly Message[]): unknown[] {
  if (messages.length === 0) return [];
  return messages.map((m) => {
    const summary: Record<string, unknown> = { role: m.role };

    // Handle content (string or array of content parts)
    if (typeof m.content === 'string') {
      summary['content'] = m.content;
    } else if (Array.isArray(m.content)) {
      summary['content'] = m.content.map(formatContentPart);
    }

    // Include tool calls if present
    if (m.toolCalls && m.toolCalls.length > 0) {
      summary['toolCalls'] = m.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: truncate(tc.arguments ?? '', 2000),
      }));
    }

    // Include toolCallId for tool result messages
    if (m.toolCallId !== undefined) {
      summary['toolCallId'] = m.toolCallId;
    }

    return summary;
  });
}

/**
 * Format tools for logging.
 * Only includes name and description (not parameter schemas) to keep logs readable.
 */
function formatTools(tools: readonly Tool[]): unknown[] {
  if (tools.length === 0) return [];
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

// ============================================================================
// SSE Broadcasting
// ============================================================================

/**
 * Broadcast a log entry to all connected SSE clients (web viewers).
 * Dead connections are automatically cleaned up.
 *
 * @param entry - The log entry to broadcast
 */
function broadcastToClients(entry: LlmLogEntry): void {
  if (sseClients.size === 0) return;

  // Format as SSE message (data: <json>\n\n)
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  const dead: ServerResponse[] = [];

  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      // Client disconnected, mark for removal
      dead.push(client);
    }
  }

  // Clean up dead connections
  for (const client of dead) {
    sseClients.delete(client);
  }
}

// ============================================================================
// File Logging
// ============================================================================

/**
 * Write a line to the log file with auto-rotation.
 * If the file exceeds MAX_FILE_SIZE, it's rotated to <file>.1
 */
function writeLine(line: string): void {
  if (!enabled) return;

  try {
    // Check if rotation is needed
    const stat = statSync(LOG_FILE, { throwIfNoEntry: false });
    if (stat && stat.size > MAX_FILE_SIZE) {
      try {
        renameSync(LOG_FILE, ROTATED_FILE);
      } catch {
        // Rotation failed, continue writing to current file
      }
    }

    // Append to log file
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // File doesn't exist yet, create directory and try again
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(LOG_FILE, line, 'utf-8');
    } catch {
      // Last resort: silently fail
    }
  }
}

// ============================================================================
// Public Logging Functions
// ============================================================================

/**
 * Log an LLM request to file and broadcast to web viewers.
 * Called before each LLM API call.
 *
 * @param req - Request data including provider, model, prompt, tools, and history
 */
export function logLlmRequest(req: LlmCommunicationRequest): void {
  const timestamp = new Date().toISOString();
  const separator = '='.repeat(80);

  // Build log file entry
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

  // Write to file
  writeLine(text);

  // Broadcast to web viewers
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
 * Log an LLM response to file and broadcast to web viewers.
 * Called after each LLM API call completes.
 *
 * @param res - Response data including content, tool calls, usage, and timing
 */
export function logLlmResponse(res: LlmCommunicationResponse): void {
  const timestamp = new Date().toISOString();
  const separator = '-'.repeat(80);

  // Build log file entry
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

  // Write to file
  writeLine(text);

  // Broadcast to web viewers (normalize usage to simple totals)
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
// Web Viewer (HTML/CSS/JS)
// ============================================================================

/**
 * Load the HTML page for the web viewer from the external file.
 * The HTML file is located in the same directory as this TypeScript file.
 */
function loadHtmlPage(): string {
  const htmlPath = join(import.meta.dirname, 'llm-viewer.html');
  try {
    return readFileSync(htmlPath, 'utf-8');
  } catch {
    // Fallback: minimal HTML if file not found
    return '<html><body><h1>Error: llm-viewer.html not found</h1></body></html>';
  }
}

/** Cached HTML page content */
let htmlPageCache: string | null = null;

function getHtmlPage(): string {
  if (htmlPageCache === null) {
    htmlPageCache = loadHtmlPage();
  }
  return htmlPageCache;
}

// ============================================================================
// HTTP Server
// ============================================================================
// HTTP Server
// ============================================================================

/**
 * Handle incoming HTTP requests for the web viewer.
 * Routes:
 *   GET /events              - SSE endpoint for real-time log streaming
 *   GET /api/logs            - Raw log file content
 *   POST /api/approval/:id   - Submit approval response from web viewer
 *   GET /                    - HTML page for the web viewer
 */
function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // SSE endpoint: clients connect here for real-time updates
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n'); // SSE comment to keep connection alive
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
    return;
  }

  // Approval response endpoint: web viewer submits approval decision
  const approvalMatch = url.pathname.match(/^\/api\/approval\/(.+)$/);
  if (approvalMatch && req.method === 'POST' && approvalMatch[1] !== undefined) {
    const requestId = approvalMatch[1];
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // Always call callback if set, regardless of enabled state
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

  // CORS preflight for POST requests
  if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Raw log file endpoint
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

  // HTML page for the web viewer
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtmlPage());
    return;
  }

  // 404 for unknown routes
  res.writeHead(404);
  res.end('Not found');
}

// ============================================================================
// Server Lifecycle
// ============================================================================

/**
 * Start the web viewer HTTP server.
 * Called once at startup when KIMI_CODE_LOG_LLM=1 is set.
 * Displays the URL in the terminal for easy access.
 *
 * @param port - Port to listen on (default: 9877)
 */
export function startLlmLogServer(port = DEFAULT_PORT): void {
  if (httpServer !== null) return;

  httpServer = createServer(handleHttpRequest);
  httpServer.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    process.stdout.write(`\n`);
    process.stdout.write(`┌─────────────────────────────────────────────────────────┐\n`);
    process.stdout.write(`│  📊 LLM Communication Log                               │\n`);
    process.stdout.write(`│  ${url.padEnd(55)}│\n`);
    process.stdout.write(`└─────────────────────────────────────────────────────────┘\n`);
    process.stdout.write(`\n`);
  });
}

/**
 * Stop the web viewer HTTP server and close all SSE connections.
 * Called on process exit or when logging is disabled.
 */
export function stopLlmLogServer(): void {
  if (httpServer === null) return;

  // Close all SSE connections
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  sseClients.clear();

  // Close HTTP server
  httpServer.close();
  httpServer = null;
}

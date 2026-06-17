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
 * Embedded HTML page for the web viewer.
 * Includes:
 * - Real-time SSE connection for live log updates
 * - Dark theme UI with GitHub-style colors
 * - Collapsible log entries for request/response details
 * - OAuth device code prompt display
 * - Auto-scroll toggle
 */
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kimi Code - LLM Communication Log</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; background: #0d1117; color: #c9d1d9; font-size: 13px; }
  #header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 20px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
  #header h1 { font-size: 14px; font-weight: 600; color: #58a6ff; }
  #status { font-size: 12px; color: #8b949e; }
  #status.connected { color: #3fb950; }
  #status.disconnected { color: #f85149; }
  #controls { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  #controls label { font-size: 12px; color: #8b949e; }
  #controls button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  #controls button:hover { background: #30363d; }
  #controls button.primary { background: #238636; border-color: #2ea043; color: #fff; }
  #controls button.primary:hover { background: #2ea043; }
  #container { padding: 16px 20px; }
  .log-entry { border: 1px solid #30363d; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .log-entry.request { border-left: 3px solid #58a6ff; }
  .log-entry.response { border-left: 3px solid #3fb950; }
  .log-entry.auth { border-left: 3px solid #d2a8ff; }
  .log-entry.auth_complete { border-left: 3px solid #3fb950; }
  .log-entry.approval { border-left: 3px solid #ffa657; }
  .log-entry.approval_result { border-left: 3px solid #3fb950; }
  .log-header { background: #161b22; padding: 10px 16px; cursor: pointer; display: flex; align-items: center; gap: 12px; user-select: none; }
  .log-header:hover { background: #1c2128; }
  .log-header .arrow { color: #8b949e; transition: transform 0.2s; }
  .log-header .arrow.open { transform: rotate(90deg); }
  .log-header .tag { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .log-header .tag.request { background: #1f3a5f; color: #58a6ff; }
  .log-header .tag.response { background: #1a3a2a; color: #3fb950; }
  .log-header .tag.auth { background: #2d1b4e; color: #d2a8ff; }
  .log-header .tag.auth_complete { background: #1a3a2a; color: #3fb950; }
  .log-header .tag.approval { background: #3d2e00; color: #ffa657; }
  .log-header .tag.approval_result { background: #1a3a2a; color: #3fb950; }
  .log-header .meta { color: #8b949e; font-size: 12px; }
  .log-header .meta .model { color: #d2a8ff; }
  .log-header .meta .duration { color: #79c0ff; }
  .log-header .meta .tokens { color: #56d364; }
  .log-body { display: none; padding: 16px; background: #0d1117; }
  .log-body.open { display: block; }
  .section { margin-bottom: 12px; }
  .section-title { color: #8b949e; font-size: 11px; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.5px; }
  pre { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; font-size: 12px; line-height: 1.5; }
  .role-user { color: #79c0ff; }
  .role-assistant { color: #7ee787; }
  .role-system { color: #d2a8ff; }
  .role-tool { color: #ffa657; }
  .tool-call { color: #ffa657; }
  .auth-box { background: #161b22; border: 1px solid #d2a8ff; border-radius: 8px; padding: 20px; text-align: center; }
  .auth-box h3 { color: #d2a8ff; margin-bottom: 16px; font-size: 14px; }
  .auth-code { font-size: 28px; font-weight: bold; color: #f0f6fc; background: #21262d; padding: 12px 24px; border-radius: 8px; display: inline-block; margin: 8px 0; letter-spacing: 4px; font-family: monospace; }
  .auth-link { display: block; margin: 12px 0; }
  .auth-link a { color: #58a6ff; text-decoration: none; font-size: 14px; }
  .auth-link a:hover { text-decoration: underline; }
  .auth-timer { color: #8b949e; font-size: 12px; margin-top: 8px; }
  .auth-success { color: #3fb950; font-weight: bold; }
  .auth-failed { color: #f85149; font-weight: bold; }
  .approval-box { background: #161b22; border: 1px solid #ffa657; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .approval-box h3 { color: #ffa657; margin-bottom: 12px; font-size: 14px; }
  .approval-box .tool-name { color: #f0f6fc; font-weight: bold; font-size: 16px; margin: 8px 0; }
  .approval-box .tool-input { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 12px; margin: 12px 0; font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
  .approval-box .status { color: #8b949e; font-size: 12px; margin-top: 8px; }
  .approval-box .status.pending { color: #ffa657; }
  .approval-box .status.approved { color: #3fb950; }
  .approval-box .status.rejected { color: #f85149; }
  .approval-box .btn-group { display: flex; gap: 8px; margin-top: 12px; justify-content: center; }
  .approval-box .btn { padding: 8px 20px; border-radius: 6px; border: 1px solid #30363d; cursor: pointer; font-size: 13px; font-weight: 500; }
  .approval-box .btn-approve { background: #238636; border-color: #2ea043; color: #fff; }
  .approval-box .btn-approve:hover { background: #2ea043; }
  .approval-box .btn-approve-session { background: #1f6feb; border-color: #388bfd; color: #fff; }
  .approval-box .btn-approve-session:hover { background: #388bfd; }
  .approval-box .btn-reject { background: #da3633; border-color: #f85149; color: #fff; }
  .approval-box .btn-reject:hover { background: #f85149; }
  .approval-box .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #empty { text-align: center; padding: 60px 20px; color: #484f58; }
  #empty h2 { font-size: 16px; margin-bottom: 8px; color: #8b949e; }
</style>
</head>
<body>
<div id="header">
  <h1>Kimi Code LLM Logs</h1>
  <span id="status" class="disconnected">Connecting...</span>
  <div id="controls">
    <label><input type="checkbox" id="autoScroll" checked> Auto-scroll</label>
    <button onclick="clearLogs()">Clear</button>
  </div>
</div>
<div id="container">
  <div id="empty">
    <h2>Waiting for LLM communication...</h2>
    <p>Logs will appear here in real-time</p>
  </div>
</div>
<script>
const container = document.getElementById('container');
const status = document.getElementById('status');
const empty = document.getElementById('empty');
const autoScroll = document.getElementById('autoScroll');
let entryCount = 0;
let authPollTimer = null;

/**
 * Connect to the SSE endpoint for real-time log updates.
 * Reconnects automatically on error.
 */
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { status.textContent = 'Connected'; status.className = 'connected'; };
  es.onerror = () => { status.textContent = 'Reconnecting...'; status.className = 'disconnected'; };
  es.onmessage = (e) => {
    const entry = JSON.parse(e.data);
    handleEntry(entry);
  };
}

/**
 * Route incoming entries to the appropriate renderer.
 */
function handleEntry(entry) {
  if (entry.type === 'auth') {
    renderAuthPrompt(entry);
  } else if (entry.type === 'auth_complete') {
    renderAuthComplete(entry);
  } else if (entry.type === 'approval') {
    renderApprovalRequest(entry);
  } else if (entry.type === 'approval_result') {
    renderApprovalResult(entry);
  } else {
    renderLogEntry(entry);
  }
}

/**
 * Render the OAuth device code authorization prompt.
 * Shows the user code and a clickable link to the verification URI.
 */
function renderAuthPrompt(entry) {
  // Remove any existing auth prompt
  const existing = document.getElementById('auth-pending');
  if (existing) existing.remove();

  if (empty && !empty.parentNode) container.appendChild(empty);
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.id = 'auth-pending';
  div.className = 'auth-box';
  div.innerHTML = '<h3>🔐 Login Authorization Required</h3>'
    + '<div class="auth-code">' + esc(entry.auth.userCode) + '</div>'
    + '<div class="auth-link"><a href="' + esc(entry.auth.verificationUriComplete) + '" target="_blank">'
    + esc(entry.auth.verificationUri) + '</a></div>'
    + '<p style="color:#8b949e;font-size:12px;margin:8px 0">Click the link above, then enter the code</p>'
    + '<div class="auth-timer" id="auth-timer">Waiting for authorization...</div>';
  container.insertBefore(div, container.firstChild);
  if (autoScroll.checked) div.scrollIntoView({ behavior: 'smooth' });

  // Start countdown timer if expiration is known
  if (entry.auth.expiresIn) {
    let remaining = entry.auth.expiresIn;
    const timer = document.getElementById('auth-timer');
    if (authPollTimer) clearInterval(authPollTimer);
    authPollTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0 || !document.getElementById('auth-pending')) {
        clearInterval(authPollTimer);
        authPollTimer = null;
        if (timer) timer.textContent = 'Code expired';
        return;
      }
      if (timer) timer.textContent = 'Expires in ' + remaining + 's';
    }, 1000);
  }
}

/**
 * Render the auth completion result (success or failure).
 */
function renderAuthComplete(entry) {
  if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
  const pending = document.getElementById('auth-pending');
  if (pending) {
    if (entry.authComplete.success) {
      pending.innerHTML = '<h3 class="auth-success">✅ Authorization Successful</h3>'
        + '<p style="color:#3fb950;margin-top:8px">' + esc(entry.authComplete.message || 'Login complete. You can use Kimi Code now.') + '</p>';
      setTimeout(() => pending.remove(), 3000);
    } else {
      pending.innerHTML = '<h3 class="auth-failed">❌ Authorization Failed</h3>'
        + '<p style="color:#f85149;margin-top:8px">' + esc(entry.authComplete.message || 'Login failed. Please try again.') + '</p>';
      setTimeout(() => pending.remove(), 5000);
    }
  }
}

/**
 * Render an approval request (tool execution requires user permission).
 * Shows the tool name, input, and approval buttons.
 */
function renderApprovalRequest(entry) {
  if (empty && !empty.parentNode) container.appendChild(empty);
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.id = 'approval-' + entry.approval.requestId;
  div.className = 'approval-box';
  div.dataset.requestId = entry.approval.requestId;

  const h3 = document.createElement('h3');
  h3.textContent = '\u26a0\ufe0f Approval Required';

  const toolName = document.createElement('div');
  toolName.className = 'tool-name';
  toolName.textContent = entry.approval.toolName;

  const toolInput = document.createElement('div');
  toolInput.className = 'tool-input';
  toolInput.textContent = entry.approval.toolInput;

  const status = document.createElement('div');
  status.className = 'status pending';
  status.id = 'approval-status-' + entry.approval.requestId;
  status.textContent = 'Select an option:';

  const btnGroup = document.createElement('div');
  btnGroup.className = 'btn-group';
  btnGroup.id = 'approval-btns-' + entry.approval.requestId;

  const btnApprove = document.createElement('button');
  btnApprove.className = 'btn btn-approve';
  btnApprove.textContent = '\u2713 Approve';
  btnApprove.onclick = () => submitApproval(entry.approval.requestId, true);

  const btnSession = document.createElement('button');
  btnSession.className = 'btn btn-approve-session';
  btnSession.textContent = '\u2713 Approve for session';
  btnSession.onclick = () => submitApproval(entry.approval.requestId, true, 'session');

  const btnReject = document.createElement('button');
  btnReject.className = 'btn btn-reject';
  btnReject.textContent = '\u2717 Reject';
  btnReject.onclick = () => submitApproval(entry.approval.requestId, false);

  btnGroup.appendChild(btnApprove);
  btnGroup.appendChild(btnSession);
  btnGroup.appendChild(btnReject);

  div.appendChild(h3);
  div.appendChild(toolName);
  div.appendChild(toolInput);
  div.appendChild(status);
  div.appendChild(btnGroup);

  container.insertBefore(div, container.firstChild);
  if (autoScroll.checked) div.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Submit an approval response to the CLI via HTTP POST.
 */
async function submitApproval(requestId, approved, scope) {
  const btns = document.getElementById('approval-btns-' + requestId);
  const status = document.getElementById('approval-status-' + requestId);
  if (btns) btns.style.display = 'none';
  if (status) {
    status.className = 'status ' + (approved ? 'approved' : 'rejected');
    status.textContent = approved ? '⏳ Sending...' : '⏳ Rejecting...';
  }
  try {
    await fetch('/api/approval/' + requestId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, scope })
    });
    if (status) {
      status.className = 'status ' + (approved ? 'approved' : 'rejected');
      status.textContent = approved ? '✅ Approved' : '❌ Rejected';
    }
    setTimeout(() => {
      const box = document.getElementById('approval-' + requestId);
      if (box) box.remove();
    }, 2000);
  } catch (err) {
    if (status) {
      status.className = 'status rejected';
      status.textContent = '❌ Failed to submit. Try in terminal.';
    }
    if (btns) btns.style.display = 'flex';
  }
}

/**
 * Render the approval result (approved or rejected).
 * Updates the existing approval request with the result.
 */
function renderApprovalResult(entry) {
  const pending = document.getElementById('approval-' + entry.approvalResult.requestId);
  const status = document.getElementById('approval-status-' + entry.approvalResult.requestId);
  if (status) {
    if (entry.approvalResult.approved) {
      status.className = 'status approved';
      status.textContent = '✅ Approved' + (entry.approvalResult.scope ? ' (' + entry.approvalResult.scope + ')' : '');
    } else {
      status.className = 'status rejected';
      status.textContent = '❌ Rejected';
    }
  }
  if (pending) {
    setTimeout(() => pending.remove(), 3000);
  }
}

/**
 * Render a log entry (request or response) as a collapsible card.
 */
function renderLogEntry(entry) {
  if (empty && empty.parentNode) empty.remove();
  entryCount++;

  const div = document.createElement('div');
  div.className = 'log-entry ' + entry.type;

  // Build header with metadata
  const header = document.createElement('div');
  header.className = 'log-header';
  let metaHtml = '';
  if (entry.type === 'request' && entry.request) {
    metaHtml = '<span class="model">' + esc(entry.request.provider + '/' + entry.request.model) + '</span>'
      + ' | Tools: ' + entry.request.tools.length
      + ' | Messages: ' + entry.request.messages.length;
  } else if (entry.type === 'response' && entry.response) {
    const r = entry.response;
    metaHtml = '<span class="duration">' + r.durationMs + 'ms</span>'
      + ' | <span class="tokens">Tokens: ' + (r.usage ? r.usage.total : '?') + '</span>'
      + ' | ' + (r.finishReason || 'unknown');
  }
  header.innerHTML = '<span class="arrow">&#9654;</span>'
    + '<span class="tag ' + entry.type + '">' + entry.type + '</span>'
    + '<span class="meta">' + esc(entry.timestamp) + ' | ' + metaHtml + '</span>';

  // Build body with details
  const body = document.createElement('div');
  body.className = 'log-body';
  header.onclick = () => { body.classList.toggle('open'); header.querySelector('.arrow').classList.toggle('open'); };

  if (entry.type === 'request' && entry.request) {
    body.innerHTML = renderRequest(entry.request);
  } else if (entry.type === 'response' && entry.response) {
    body.innerHTML = renderResponse(entry.response);
  }

  div.appendChild(header);
  div.appendChild(body);
  container.appendChild(div);
  if (autoScroll.checked) div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/**
 * Render request details (system prompt, tools, messages).
 */
function renderRequest(req) {
  let h = '<div class="section"><div class="section-title">System Prompt</div><pre>' + esc(req.systemPrompt) + '</pre></div>';
  if (req.tools.length > 0) h += '<div class="section"><div class="section-title">Tools (' + req.tools.length + ')</div><pre>' + esc(JSON.stringify(req.tools, null, 2)) + '</pre></div>';
  h += '<div class="section"><div class="section-title">Messages (' + req.messages.length + ')</div><pre>' + renderMessages(req.messages) + '</pre></div>';
  return h;
}

/**
 * Render messages with role-based coloring.
 */
function renderMessages(msgs) {
  return msgs.map(m => {
    const roleClass = 'role-' + m.role;
    let content = '';
    if (typeof m.content === 'string') content = esc(m.content);
    else if (Array.isArray(m.content)) content = m.content.map(p => {
      if (p.type === 'text') return esc(p.text);
      if (p.type === 'think') return '<span style="color:#8b949e">[thinking] ' + esc(p.think) + '</span>';
      return '<span style="color:#8b949e">[' + p.type + ']</span>';
    }).join('\\n');
    let tc = '';
    if (m.toolCalls && m.toolCalls.length > 0) {
      tc = '\\n' + m.toolCalls.map(t => '<span class="tool-call">  tool_call: ' + esc(t.name) + '(' + esc(t.arguments) + ')</span>').join('\\n');
    }
    return '<span class="' + roleClass + '">[' + m.role + ']</span> ' + content + tc;
  }).join('\\n\\n');
}

/**
 * Render response details (finish reason, content, tool calls).
 */
function renderResponse(res) {
  let h = '';
  h += '<div class="section"><div class="section-title">Finish: ' + esc(res.finishReason || 'unknown') + ' | Duration: ' + res.durationMs + 'ms' + (res.usage ? ' | Tokens: input=' + res.usage.input + ' output=' + res.usage.output + ' total=' + res.usage.total : '') + '</div></div>';
  h += '<div class="section"><div class="section-title">Content</div><pre>' + esc(res.content) + '</pre></div>';
  if (res.toolCalls.length > 0) h += '<div class="section"><div class="section-title">Tool Calls (' + res.toolCalls.length + ')</div><pre>' + res.toolCalls.map(t => '<span class="tool-call">' + esc(t.name) + '(' + esc(t.arguments) + ')</span>').join('\\n') + '</pre></div>';
  return h;
}

/** HTML-escape a string to prevent XSS */
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/** Clear all log entries from the page */
function clearLogs() { container.innerHTML = ''; entryCount = 0; }

// Initialize SSE connection on page load
connect();
</script>
</body>
</html>`;

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
    res.end(HTML_PAGE);
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

// ── 中文概述 ──
// 本模块是 acp-adapter 包的入口文件，统一对外导出所有公共 API。
// 包括：类型别名、内置斜杠命令、版本协商、认证方法、服务器、会话、
// 内容转换、事件映射、输出标记、日志重定向等子模块的导出。

export type { AvailableCommand, Implementation } from '@agentclientprotocol/sdk';
export {
  ACP_BUILTIN_SLASH_COMMAND_NAMES,
  ACP_BUILTIN_SLASH_COMMANDS,
  isAcpBuiltinSlashCommand,
} from './builtin-commands';
export type { AcpBuiltinSlashCommandName } from './builtin-commands';
export { CURRENT_VERSION, MIN_PROTOCOL_VERSION, negotiateVersion } from './version';
export type { AcpVersionSpec } from './version';
export { TERMINAL_AUTH_METHOD, buildTerminalAuthMethod } from './auth-methods';
export { AcpServer, runAcpServer, runAcpServerWithStream } from './server';
export type { SlashCommandsSnapshot } from './server';
export { AcpSession } from './session';
export {
  acpBlocksToPromptParts,
  displayBlockToAcpContent,
  toolResultToAcpContent,
} from './convert';
export {
  acpToolCallId,
  assistantDeltaToSessionUpdate,
  inferToolKind,
  stringifyArgs,
  thinkingDeltaToSessionUpdate,
  toolCallDeltaToSessionUpdate,
  toolCallLazyCreateToSessionUpdate,
  toolCallStartedUpgradeToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolProgressToSessionUpdate,
  toolResultToSessionUpdate,
  turnEndReasonToStopReason,
} from './events-map';
export type { AcpStopReason, AcpToolCallStatus, AcpToolKind } from './types';
export { HideOutputMarker, isHideOutputMarker } from './marker';
export { redirectConsoleToStderr } from './log-guard';

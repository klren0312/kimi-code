/**
 * /feedback 命令的常量——端点、遥测事件键，以及反馈提交流程中显示的状态消息。
 *
 * 对话框内部文案（弹窗标题、副标题、底部提示）放在对话框组件旁边，
 * 因为它是该组件视觉契约的一部分。
 */

import { FEEDBACK_VERSION_PREFIX } from '#/constant/app';

export {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_TELEMETRY_EVENT,
  FEEDBACK_VERSION_PREFIX,
} from '#/constant/app';

export const FEEDBACK_STATUS_SUBMITTING = 'Submitting feedback…';
export const FEEDBACK_STATUS_SUCCESS = 'Feedback submitted, thank you!';
export const FEEDBACK_STATUS_CANCELLED = 'Feedback cancelled.';
export const FEEDBACK_STATUS_NETWORK_ERROR = 'Network error, failed to submit feedback.';
export const FEEDBACK_STATUS_FALLBACK = 'Opening GitHub Issues as fallback…';
export const FEEDBACK_STATUS_NOT_SIGNED_IN =
  "You're not signed in. Opening GitHub Issues for feedback…";

export function feedbackHttpErrorMessage(status: number): string {
  return `Failed to submit feedback (HTTP ${String(status)}).`;
}

export function feedbackSessionLine(sessionId: string): string {
  return `Session: ${sessionId}`;
}

// 在 TUI 中会话级错误消息下方显示的提示，引导用户使用
// `/export-debug-zip` 工作流来与我们共享诊断信息。
export function errorReportHintLine(): string {
  return "If this persists, run `/export-debug-zip` and share the file with us for diagnosis. Please don't share it publicly.";
}

export function withFeedbackVersionPrefix(version: string): string {
  return `${FEEDBACK_VERSION_PREFIX}${version}`;
}

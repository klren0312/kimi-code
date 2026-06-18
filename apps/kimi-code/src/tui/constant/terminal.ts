import { BEL, ESC, ST } from "#/constant/terminal";

export { BEL, ESC, ST } from "#/constant/terminal";

// 终端主题上报使用私有 CSI 序列：启用上报、查询一次，
// 然后从输入流中解析 dark/light 报告。
export const QUERY_TERMINAL_THEME = `${ESC}[?996n`;
export const TERMINAL_THEME_DARK = `${ESC}[?997;1n`;
export const TERMINAL_THEME_LIGHT = `${ESC}[?997;2n`;
export const ENABLE_TERMINAL_THEME_REPORTING = `${ESC}[?2031h`;
export const DISABLE_TERMINAL_THEME_REPORTING = `${ESC}[?2031l`;

// Xterm 风格的焦点上报。输入监听器会消费这些字节，
// 防止它们泄漏到编辑器中。
export const TERMINAL_FOCUS_IN = `${ESC}[I`;
export const TERMINAL_FOCUS_OUT = `${ESC}[O`;
export const ENABLE_TERMINAL_FOCUS_REPORTING = `${ESC}[?1004h`;
export const DISABLE_TERMINAL_FOCUS_REPORTING = `${ESC}[?1004l`;

// 标准 OSC 11 背景色查询。响应正则表达式有意允许缺少前导 ESC，
// 因为终端可能会将回复与其他原始输入一起回显，但它要求使用
// OSC 终止符，以避免将分片的颜色通道解析为完整回复。
export const OSC11_QUERY = `${ESC}]11;?${BEL}`;
const OSC11_RESPONSE_TERMINATOR_PATTERN = `(?:${BEL}|${ESC}\\\\)`;
export const OSC11_RESPONSE = new RegExp(
  String.raw`${ESC}?\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})${OSC11_RESPONSE_TERMINATOR_PATTERN}`,
  "i",
);
export const OSC11_RESPONSE_PREFIX = `${ESC}]11;rgb:`;
export const OSC11_RESPONSE_PREFIX_NO_ESC = "]11;rgb:";

// 限制通知/标题内容长度，保持终端标签页和桌面通知可读。
export const MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH = 240;
export const MAX_TERMINAL_TITLE_LENGTH = 32;

// OSC 11 探测超时要短，因为不支持的终端不会回复。
export const TERMINAL_THEME_DETECT_TIMEOUT_MS = 250;
export const TERMINAL_THEME_INPUT_BUFFER_MAX_LENGTH = 512;

// 使用 U+25CF 代替 U+23FA，以避免终端中的 emoji/回退渲染问题。
export const STATUS_BULLET = '● ';

// 共用的转录标记。保持宽度稳定，因为消息换行假设标记占据前导单元格。
export const USER_MESSAGE_BULLET = '✨ ';
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';

// 共用的选择器标记——保持所有列表选择器视觉一致。
// SELECT_POINTER 标记高亮行；CURRENT_MARK 附加到当前激活值所在行。
// 参见 .agents/skills/write-tui/DESIGN.md。
export const SELECT_POINTER = '❯';
export const CURRENT_MARK = '← current';

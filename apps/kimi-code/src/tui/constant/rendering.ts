// 使用双格前导标记的转录行的续行缩进。
export const MESSAGE_INDENT = '  ';

// 应用于转录区、面板和状态行的外部左右内边距，使得界面边框的左边缘
// 与输入框内部（`>` 提示符）对齐。编辑器本身保持在第 0 列——
// 它的垂直边框是所有其他元素对齐的视觉锚点。
export const CHROME_GUTTER = 1;

// 思考过程、工具结果和 shell 代码片段共用的预览行数上限。
export const RESULT_PREVIEW_LINES = 3;
export const THINKING_PREVIEW_LINES = 2;
export const COMMAND_PREVIEW_LINES = 10;

// 登录/更新加载动画和实时思考过程共用的动画帧。
export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const BRAILLE_SPINNER_INTERVAL_MS = 80;

export const MOON_SPINNER_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
export const MOON_SPINNER_INTERVAL_MS = 120;

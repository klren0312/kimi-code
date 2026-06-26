/**
 * 暗色和亮色主题的调色板定义。
 *
 * `darkColors` / `lightColors` 是每个 UI 组件通过全局 Theme 单例
 * 消费的语义化 `ColorPalette`。每个 token 直接保存其十六进制值——
 * 详见 `ColorPalette` 上每个 token 的文档，了解其控制的用途。
 *
 * 亮色调色板的文本 token 针对 #FFFFFF 背景进行了 ≥ 4.5:1 对比度调优，
 * chrome 元素（边框/大文本）≥ 3:1，符合 WCAG AA 标准。
 */

// 下面每个 token 都记录了其实际消费位置，以便主题作者了解
// 修改它会影响什么。"广泛使用"表示该 token 在大多数对话框/消息中
// 都被读取，而非仅在某个特定位置。
export interface ColorPalette {
  // ── 品牌色 ──
  /** 主要交互/品牌色：链接和行内代码、几乎所有对话框中选中的项目、
   *  编辑器聚焦边框、计划/"运行中"徽标、加载动画。使用最广泛的 token。 */
  primary: string;
  /** 次要高亮色：审批 "▶" 前缀、设备码框、图片占位符、
   *  BTW / 队列面板、自定义注册表导入。 */
  accent: string;

  // ── 文本色 ──
  /** 默认正文文本：对话框正文、待办标题、页脚模型标签、
   *  markdown 标题、工具/读取输出，以及助手侧消息要点
   *  （助手/工具/代理/读取）加 markdown 列表要点。 */
  text: string;
  /** 强调/加粗文本：输入对话框、状态消息。 */
  textStrong: string;
  /** 次要、暗淡文本（使用最广泛的暗淡色调）：思考块、
   *  提示、描述、已完成待办、markdown 引用，以及页脚
   *  状态栏（cwd 路径、git 徽标）。 */
  textDim: string;
  /** 最淡文本：计数器、滚动信息、描述、markdown 链接 URL、
   *  代码块边框。 */
  textMuted: string;

  // ── 表面色 ──
  /** 边框：面板和编辑器边框、markdown 水平分隔线。 */
  border: string;
  /** 聚焦/注意边框——目前仅用于审批面板。 */
  borderFocus: string;

  // ── 状态色 ──
  /** 成功：✓ 标记、"已启用"、已完成状态。 */
  success: string;
  /** 警告：auto/yolo 徽标、过时标记、计划模式提示。 */
  warning: string;
  /** 错误：错误消息、失败的工具输出。 */
  error: string;

  // ── Diff（全部由 components/media/diff-preview.ts 消费）──
  /** 新增行。 */
  diffAdded: string;
  /** 删除行。 */
  diffRemoved: string;
  /** 新增行——行内变更词（加粗）。 */
  diffAddedStrong: string;
  /** 删除行——行内变更词（加粗）。 */
  diffRemovedStrong: string;
  /** 行号装订线（也用于审批面板/预览）。 */
  diffGutter: string;
  /** 元信息 / hunk 头。 */
  diffMeta: string;

  // ── 角色色 ──
  /** 用户消息：要点和文本、技能激活名称。唯一拥有独立色相的
   *  角色色——助手/思考/状态要点复用 text/textDim。 */
  roleUser: string;

  // ── Shell mode ──
  /** Shell mode (`!`): the `!` prompt symbol, bash-mode editor border, and the
   *  echoed `$ command` line. Its own hue (violet), distinct from
   *  plan-mode (primary) and the user role (roleUser). */
  shellMode: string;
}

export const darkColors: ColorPalette = {
  primary: '#4FA8FF',
  accent: '#5BC0BE',

  text: '#E0E0E0',
  textStrong: '#F5F5F5',
  textDim: '#888888',
  textMuted: '#6B6B6B',

  border: '#5A5A5A',
  borderFocus: '#E8A838',

  success: '#4EC87E',
  warning: '#E8A838',
  error: '#E85454',

  diffAdded: '#4EC87E',
  diffRemoved: '#E85454',
  diffAddedStrong: '#7AD99B',
  diffRemovedStrong: '#F08585',
  diffGutter: '#6B6B6B',
  diffMeta: '#888888',

  roleUser: '#FFCB6B',
  shellMode: '#BD93F9',
};

export const lightColors: ColorPalette = {
  primary: '#1565C0',
  accent: '#00838F',

  text: '#1A1A1A',
  textStrong: '#1A1A1A',
  textDim: '#454545',
  textMuted: '#5F5F5F',

  border: '#737373',
  borderFocus: '#92660A',

  success: '#0E7A38',
  warning: '#92660A',
  error: '#B91C1C',

  diffAdded: '#0E7A38',
  diffRemoved: '#B91C1C',
  diffAddedStrong: '#0E7A38',
  diffRemovedStrong: '#B91C1C',
  diffGutter: '#737373',
  diffMeta: '#5F5F5F',

  roleUser: '#9A4A00',
  shellMode: '#7C3AED',
};

export type ResolvedTheme = 'dark' | 'light';

/** 仅用于内置主题的同步调色板查找。 */
export function getBuiltInPalette(resolved: ResolvedTheme): ColorPalette {
  return resolved === 'dark' ? darkColors : lightColors;
}

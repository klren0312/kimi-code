/**
 * Pi-tui 主题适配器——由全局 `currentTheme` 单例支持的 MarkdownTheme
 * 和 EditorTheme。
 *
 * 所有颜色查找都通过 `currentTheme.color(token)` 路由，以便
 * 切换主题时即时生效：旧组件持有旧的 MarkdownTheme/EditorTheme 实例，
 * 但这些实例上的每次方法调用都通过单例读取*当前*调色板。
 */

import type { MarkdownTheme, EditorTheme } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';

import { currentTheme } from './theme';

// pi-tui 的渲染器对 h3-h6 标题发出字面的 "### " / "#### " / ... 标记
// （h1/h2 渲染时不带 `#` 前缀）。前缀到达此处时已被粗体 SGR 代码包裹，
// 因此我们在重新设置样式之前将其剥离——剥离的是 ANSI 序列之后的前导部分。
// 不这样做的话，h3+ 会渲染为原始的 "### Title"，看起来像未解析的 markdown。
// eslint-disable-next-line no-control-regex -- 故意匹配开启 ANSI SGR 序列的 ESC 字节。
const HEADING_HASH_PREFIX = /^((?:\u001B\[[0-9;]*m)*)#{1,6}[ \t]+/;

export function createMarkdownTheme(): MarkdownTheme {
  const stripHash = (text: string): string => text.replace(HEADING_HASH_PREFIX, '$1');

  return {
    heading: (text) => chalk.bold.hex(currentTheme.color('text'))(stripHash(text)),
    link: (text) => chalk.hex(currentTheme.color('primary'))(text),
    linkUrl: (text) => chalk.hex(currentTheme.color('textMuted'))(text),
    code: (text) => chalk.hex(currentTheme.color('primary'))(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => chalk.hex(currentTheme.color('textMuted'))(text),
    quote: (text) => chalk.hex(currentTheme.color('textDim'))(text),
    quoteBorder: (text) => chalk.hex(currentTheme.color('textDim'))(text),
    hr: (text) => chalk.hex(currentTheme.color('border'))(text),
    // 与助手消息要点匹配，使列表标记读起来像回复前缀。
    // 有序列表到达时为 "1. " / "2. "，不会被前导短横线锚点修改。
    listBullet: (text) => chalk.hex(currentTheme.color('text'))(text.replace(/^-/, '•')),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code: string, lang?: string) => {
      const normalizedLang = lang?.trim().toLowerCase();
      const language =
        normalizedLang !== undefined && supportsLanguage(normalizedLang) ? normalizedLang : 'text';
      try {
        const highlighted = highlight(code, { language, ignoreIllegals: true });
        return highlighted.split('\n');
      } catch {
        return code.split('\n');
      }
    },
  };
}

export function createEditorTheme(): EditorTheme {
  return {
    borderColor: (s) => chalk.hex(currentTheme.color('border'))(s),
    selectList: {
      selectedPrefix: (s) => chalk.hex(currentTheme.color('primary'))(s),
      selectedText: (s) => chalk.hex(currentTheme.color('primary'))(s),
      description: (s) => chalk.hex(currentTheme.color('textMuted'))(s),
      scrollInfo: (s) => chalk.hex(currentTheme.color('textMuted'))(s),
      noMatch: (s) => chalk.hex(currentTheme.color('textMuted'))(s),
    },
  };
}

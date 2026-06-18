/**
 * 扩展 pi-tui Editor 的自定义编辑器，添加应用级快捷键绑定。
 */

import {
  Editor,
  isKeyRelease,
  matchesKey,
  Key,
  SelectList,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';

import { WrappingSelectList } from './wrapping-select-list';

// oxlint-disable-next-line no-control-regex -- 需要 ESC (\x1b) 来匹配 ANSI SGR 转义序列
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

const PASTE_MARKER_RE = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const BRACKET_PASTE_START = '\u001B[200~';
const BRACKET_PASTE_END = '\u001B[201~';

// Kitty 键盘协议 CSI-u 序列：ESC [ keycode ; modifier[:eventType] u。
// 只匹配简单的两字段形式——足以将 caps_lock 下的
// `ctrl+<LETTER>` 重写为无 caps_lock 的 `ctrl+<letter>`。
// oxlint-disable-next-line no-control-regex -- 需要 ESC (\x1b) 来匹配 CSI
const KITTY_CSI_U = /^\u001B\[(\d+);(\d+)((?::\d+)*)u$/;
// Kitty 修饰键位布局：shift=1, alt=2, ctrl=4, super=8, hyper=16,
// meta=32, caps_lock=64, num_lock=128。报告值为 `mask + 1`。
const CAPS_LOCK_BIT = 64;
const CTRL_BIT = 4;
const SHIFT_BIT = 1;

interface AutocompleteInternals {
  cancelAutocomplete(): void;
  readonly autocompleteAbort?: AbortController;
  readonly autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
}

interface AutocompleteListFactoryInternals {
  createAutocompleteList?: (prefix: string, items: SelectItem[]) => SelectList;
}

// 镜像 pi-tui 私有的 SLASH_COMMAND_SELECT_LIST_LAYOUT
// (dist/components/editor.js)；升级 pi-tui 时需保持同步。
const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
} as const;

/**
 * 解决 pi-tui 在 Kitty 键盘协议激活且 caps_lock 开启时出现的 bug。
 * 在该状态下，终端会发出例如 `ESC[68;69u` 表示 ctrl+d
 * （码点=68=`D`，修饰键=ctrl|caps_lock）。
 * pi-tui 的 `matchesKittySequence` 从*修饰键*中移除了 caps_lock，
 * 但保留了*码点*的大写形式，因此 `matchesKey(data, "ctrl+d")`
 * （期望码点=100=`d`）会失败，所有 ctrl 快捷键都被静默丢弃。
 *
 * 在分派之前，将序列重写回未锁定形式，
 * 但仅在按住 ctrl 且未按住 shift 时——即恰好是
 * `ctrl+<字母>` 的情况。纯大写（仅 caps_lock，无 ctrl）和
 * 显式的 ctrl+shift+<字母> 不做处理。
 */
export function normalizeCapsLockedCtrl(data: string): string {
  const m = data.match(KITTY_CSI_U);
  if (m === null) return data;
  const codepoint = Number(m[1]);
  const modifierPlus1 = Number(m[2]);
  const tail = m[3] ?? '';
  if (!Number.isFinite(codepoint) || !Number.isFinite(modifierPlus1)) return data;
  const modifier = modifierPlus1 - 1;
  if ((modifier & CAPS_LOCK_BIT) === 0) return data;
  if ((modifier & CTRL_BIT) === 0) return data;
  if ((modifier & SHIFT_BIT) !== 0) return data;
  if (codepoint < 65 || codepoint > 90) return data;
  const loweredCodepoint = codepoint + 32;
  const strippedModifier = (modifier & ~CAPS_LOCK_BIT) + 1;
  return `\u001B[${String(loweredCodepoint)};${String(strippedModifier)}${tail}u`;
}

/** 将可见字符索引（去除 ANSI 后）转换回含 ANSI 转义的原始字符串的索引。 */
function mapVisibleIdxToRaw(line: string, visibleIdx: number): number {
  let visibleCount = 0;
  let i = 0;
  const re = new RegExp(ANSI_SGR.source, 'y');
  while (i < line.length && visibleCount < visibleIdx) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m !== null && m.index === i) {
      i += m[0].length;
    } else {
      visibleCount++;
      i++;
    }
  }
  return i;
}

function stripSgr(s: string): string {
  return s.replace(ANSI_SGR, '');
}

function getNewlineInput(data: string): string | undefined {
  if (data === '\n' || data === '\u001B\r' || data === '\u001B[13;2~') return data;
  if (matchesKey(data, Key.ctrl('j'))) return '\n';
  return undefined;
}

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  public onUndo?: () => void;
  public onInsertNewline?: () => void;
  public onTextPaste?: () => void;
  /**
   * 在空编辑器中按下 ↑ 时调用。返回 `true` 消费该按键
   * （例如召回了队列消息）；返回 `false` 让事件穿透，
   * 以触发 pi-tui 内置的历史导航。
   */
  public onUpArrowEmpty?: () => boolean;
  public onDownArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;
  public connectedAbove = false;
  public borderHighlighted = false;
  /**
   * 用户触发"粘贴图片"时调用（Unix 上为 Ctrl-V，
   * Windows 上为 Alt-V——因为 Ctrl-V 被终端保留）。返回
   * `true` 消费该按键（图片已读取并处理）；返回
   * `false` 让按键穿透到普通粘贴路径。
   * 回调可以是异步的；pi-tui 会等待它完成后才分派下一个按键。
   */
  public onPasteImage?: () => Promise<boolean>;

  private consumingPaste = false;
  private consumeBuffer = '';

  constructor(tui: TUI) {
    // paddingX: 4 将第 0 列预留给左边框（│），
    // 第 1 列作为边框与提示符之间的空格，第 2 列放置 `>` 提示符，
    // 第 3 列作为提示符与内容之间的空格。
    // 右侧对称配置 3 列内边距，最后一列为右边框。
    const theme = createEditorTheme();
    super(tui, theme, { paddingX: 4 });

    // pi-tui 将 `createAutocompleteList` 设为私有；用实例属性遮蔽它，
    // 使斜杠命令菜单的描述文本最多换行显示两行。
    // 非斜杠补全（路径、@ 提及）仍使用 pi-tui 的单行列表。
    (this as unknown as AutocompleteListFactoryInternals).createAutocompleteList = (
      prefix,
      items,
    ) => {
      if (prefix.startsWith('/')) {
        return new WrappingSelectList(
          items,
          this.getAutocompleteMaxVisible(),
          theme.selectList,
          SLASH_COMMAND_SELECT_LIST_LAYOUT,
        );
      }
      return new SelectList(items, this.getAutocompleteMaxVisible(), theme.selectList);
    };
  }

  private expandPasteMarkerAtCursor(): boolean {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const currentLine = lines[line] ?? '';

    for (const match of currentLine.matchAll(PASTE_MARKER_RE)) {
      const start = match.index;
      const end = start + match[0].length;
      if (col < start || col > end) continue;

      const pasteId = Number(match[1]);
      const pastes = (this as unknown as { pastes: Map<number, string> }).pastes;
      const content = pastes.get(pasteId);
      if (content === undefined) return false;

      const text = this.getText();
      const offset = lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + start;
      const newText = text.slice(0, offset) + content + text.slice(offset + match[0].length);
      this.setText(newText);
      return true;
    }
    return false;
  }

  private hasAutocompleteActivity(): boolean {
    const autocomplete = this as unknown as AutocompleteInternals;
    return (
      this.isShowingAutocomplete() ||
      autocomplete.autocompleteAbort !== undefined ||
      autocomplete.autocompleteDebounceTimer !== undefined
    );
  }

  private cancelAutocompleteActivity(): void {
    // pi-tui 暴露了 `isShowingAutocomplete()` 但将取消操作设为私有。
    // Kimi 需要 Esc 在斜杠菜单请求活跃时优先于应用级取消。
    (this as unknown as AutocompleteInternals).cancelAutocomplete();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 3) return lines;
    const firstContentIdx = 1;
    const text = this.getText().trimStart();
    if (text.startsWith('/')) {
      // 只渲染第一行编辑器内容；实际上不存在多行斜杠命令。
      const original = lines[firstContentIdx];
      if (original !== undefined) {
        const highlighted = highlightFirstSlashToken(original, 'primary');
        if (highlighted !== undefined) {
          lines[firstContentIdx] = highlighted;
        }
      }
    }
    const firstContent = lines[firstContentIdx];
    if (firstContent !== undefined) {
      const withPrompt = injectPromptSymbol(firstContent);
      if (withPrompt !== undefined) {
        lines[firstContentIdx] = withPrompt;
      }
    }
    // `this.borderColor` 是 pi-tui 的每次渲染着色函数。宿主可以覆盖它
    // （例如通过 `editor.borderColor = chalk.hex(primary)` 实现计划模式/
    // 斜杠上下文高亮），因此将圆角和侧边框也通过同一钩子着色以保持同步。
    return wrapWithSideBorders(lines, (s) => this.borderColor(s), {
      connectedAbove: this.connectedAbove && !this.borderHighlighted,
    });
  }

  override handleInput(data: string): void {
    const normalized = normalizeCapsLockedCtrl(data);
    if (isKeyRelease(normalized)) {
      return;
    }

    // 当刚展开粘贴标记时，丢弃终端在 Ctrl-V 按键时
    // 发送的后续方括号粘贴数据。
    if (this.consumingPaste) {
      this.consumeBuffer += normalized;
      if (this.consumeBuffer.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = false;
        this.consumeBuffer = '';
      }
      return;
    }

    // 如果方括号粘贴到达时光标位于已有的粘贴标记上，
    // 则展开该标记而不是粘贴新内容。
    if (normalized.includes(BRACKET_PASTE_START) && this.expandPasteMarkerAtCursor()) {
      if (!normalized.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = true;
      }
      return;
    }

    // 粘贴图片绑定——平台感知：
    //   Windows 终端将 Ctrl-V 保留用于自身的粘贴处理
    //   （例如 Windows Terminal 的 Ctrl+V 快捷键），因此在此监听
    //   Alt-V。其他平台使用 Ctrl-V 粘贴。当宿主报告没有可用图片时，
    //   事件穿透到 pi-tui 的普通粘贴路径，使剪贴板文本仍可正常使用。
    const pasteKey = process.platform === 'win32' ? 'alt+v' : Key.ctrl('v');
    if (matchesKey(normalized, pasteKey)) {
      if (this.expandPasteMarkerAtCursor()) {
        return;
      }
      if (this.onPasteImage !== undefined) {
        const handler = this.onPasteImage;
        void handler().then((handled) => {
          if (!handled) {
            this.onTextPaste?.();
            super.handleInput.call(this, normalized);
          }
        });
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl('d'))) {
      if (this.getText().length === 0) {
        this.onCtrlD?.();
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('g'))) {
      this.onOpenExternalEditor?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('o'))) {
      this.onToggleToolExpand?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('s'))) {
      this.onCtrlS?.();
      return;
    }

    if (matchesKey(normalized, 'shift+tab')) {
      this.onShiftTab?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('-'))) {
      this.onUndo?.();
    }

    const newlineInput = getNewlineInput(normalized);
    if (newlineInput !== undefined) {
      this.onInsertNewline?.();
      super.handleInput(newlineInput);
      return;
    }

    if (matchesKey(normalized, Key.up)) {
      if (this.getText().length === 0 && this.onUpArrowEmpty) {
        if (this.onUpArrowEmpty()) return;
        // 穿透到 super，让 Editor 的内置历史导航运行
      }
    }

    if (matchesKey(normalized, Key.down)) {
      if (this.getText().length === 0 && this.onDownArrowEmpty) {
        if (this.onDownArrowEmpty()) return;
      }
    }

    if (matchesKey(normalized, Key.escape)) {
      if (this.hasAutocompleteActivity()) {
        this.cancelAutocompleteActivity();
        return;
      }
      this.onEscape?.();
      return;
    }

    super.handleInput(normalized);
  }
}

/**
 * 返回 `line` 的副本，其中第一个 `/token` 使用 `hex` 着色。
 * 对于 `/goal next manage`，还会对命令路径 token 着色。
 * `line` 可能已包含 SGR 转义（光标反转等）；通过可见索引计算
 * 定位 `/`，确保 ANSI 透传不受影响。
 * 未找到 token 时返回 `undefined`。
 */
export function highlightFirstSlashToken(line: string, token: 'primary'): string | undefined {
  const visible = stripSgr(line);
  const slashIdx = visible.indexOf('/');
  if (slashIdx < 0) return undefined;
  // 保护：仅当 `/` 是行首第一个非空白字符时才着色
  // （避免对句中斜杠进行着色）。
  for (let i = 0; i < slashIdx; i++) {
    if (visible[i] !== ' ' && visible[i] !== '\t') return undefined;
  }
  // Token 在下一个空白处（或可见末尾）结束。
  let endVisible = slashIdx + 1;
  while (endVisible < visible.length) {
    const ch = visible[endVisible];
    if (ch === ' ' || ch === '\t') break;
    endVisible++;
  }
  const visibleToken = visible.slice(slashIdx, endVisible);
  if (visibleToken.slice(1).includes('/')) return undefined;
  const ranges = [{ start: slashIdx, end: endVisible }];
  if (visibleToken === '/goal') {
    ranges.push(...goalCommandPathRanges(visible, endVisible));
  }
  return highlightVisibleRanges(line, ranges, token);
}

function goalCommandPathRanges(
  visible: string,
  commandEnd: number,
): Array<{ start: number; end: number }> {
  const nextRange = readTokenRange(visible, commandEnd);
  if (nextRange === null || visible.slice(nextRange.start, nextRange.end) !== 'next') {
    return [];
  }
  const ranges = [nextRange];
  const manageRange = readTokenRange(visible, nextRange.end);
  if (manageRange !== null && visible.slice(manageRange.start, manageRange.end) === 'manage') {
    ranges.push(manageRange);
  }
  return ranges;
}

function readTokenRange(
  visible: string,
  start: number,
): { start: number; end: number } | null {
  let tokenStart = start;
  while (tokenStart < visible.length && isTokenSpace(visible[tokenStart])) tokenStart++;
  if (tokenStart >= visible.length) return null;
  let tokenEnd = tokenStart;
  while (tokenEnd < visible.length && !isTokenSpace(visible[tokenEnd])) tokenEnd++;
  return { start: tokenStart, end: tokenEnd };
}

function isTokenSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function highlightVisibleRanges(
  line: string,
  ranges: Array<{ start: number; end: number }>,
  token: 'primary',
): string {
  let out = '';
  let rawCursor = 0;
  for (const range of ranges) {
    const rawStart = mapVisibleIdxToRaw(line, range.start);
    const rawEnd = mapVisibleIdxToRaw(line, range.end);
    out += line.slice(rawCursor, rawStart);
    out += currentTheme.boldFg(token, line.slice(rawStart, rawEnd));
    rawCursor = rawEnd;
  }
  return out + line.slice(rawCursor);
}

/**
 * 在第一行内容上叠加终端风格的 `> ` 提示符。
 * 第 0 列预留给左边框（后续由 wrapWithSideBorders 叠加）；
 * 第 1 列为单空格间隔，`>` 符号位于第 2 列，第 3 列将其与内容分隔。
 * 依赖编辑器配置 `paddingX >= 4`，使行首至少有四个字面空格。
 * 不发出 SGR，因此使用终端默认前景色渲染该符号。
 * 行过短或不以预期的内边距开头时返回 `undefined`。
 */
export function injectPromptSymbol(line: string): string | undefined {
  if (line.length < 4) return undefined;
  for (let i = 0; i < 4; i++) {
    if (line[i] !== ' ') return undefined;
  }
  return '  > ' + line.slice(4);
}

/**
 * 后处理 pi-tui 的编辑器输出，为其绘制完整的边框。
 *
 * pi-tui 只渲染上下水平边框；用 `╭╮╰╯` 圆角包裹，
 * 并在每行外侧列添加竖线 `│`。
 * 水平边框行（首个可见字符为 `─` 的行，包括
 * 滚动指示符如 `── ↑ N more ──`）会去除现有 SGR，
 * 重新绘制为单一的制表线跨度。内容行保留其内部 SGR 不变；
 * 仅在第 0 列和最后一列且为字面空格时才叠加——
 * 这保护了光标溢出的情况，即最右列是带 SGR 标记的反转光标。
 */
export function wrapWithSideBorders(
  lines: string[],
  paint: (s: string) => string,
  options: { readonly connectedAbove?: boolean } = {},
): string[] {
  let seenTop = false;
  return lines.map((line) => {
    const plain = stripSgr(line);
    if (plain.length > 0 && plain[0] === '─') {
      const leftCorner = seenTop ? '╰' : options.connectedAbove === true ? '├' : '╭';
      const rightCorner = seenTop ? '╯' : options.connectedAbove === true ? '┤' : '╮';
      seenTop = true;
      if (plain.length === 1) return paint(leftCorner);
      const middle = plain.slice(1, -1);
      return paint(leftCorner + middle + rightCorner);
    }
    if (line.length === 0) return line;
    const firstCh = line[0];
    const lastCh = line.at(-1);
    const head = firstCh === ' ' ? paint('│') : (firstCh ?? '');
    const tail =
      line.length > 1 && lastCh === ' ' ? paint('│') : (lastCh ?? '');
    if (line.length === 1) return head;
    return head + line.slice(1, -1) + tail;
  });
}

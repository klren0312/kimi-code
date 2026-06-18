/**
 * CustomRegistryImportDialog —— 蓝色圆角对话框，用于收集自定义注册表 URL
 * 和 Bearer token，然后导入注册表的提供商条目。
 *
 * 几何布局镜像 `ApiKeyInputDialogComponent`，以保持与 API 密钥登录流程的
 * 一致性。两个字段通过 Tab / Shift-Tab / Up / Down 切换；Enter 跳转到
 * 下一个字段（在最后一个字段时提交），Esc 取消。两个字段均为必填。
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface CustomRegistryImportValue {
  readonly url: string;
  readonly apiKey: string;
}

export type CustomRegistryImportResult =
  | { readonly kind: 'ok'; readonly value: CustomRegistryImportValue }
  | { readonly kind: 'cancel' };

const TITLE = 'Import custom provider registry';
const SUBTITLE_DEFAULT = 'Paste an api.json URL and its Bearer token.';
const SUBTITLE_URL_EMPTY = 'Registry URL cannot be empty.';
const SUBTITLE_TOKEN_EMPTY = 'Bearer token cannot be empty.';
const FOOTER_NOT_LAST = 'Tab / ↑↓ to switch  ·  Enter for next field  ·  Esc to cancel';
const FOOTER_LAST = 'Tab / ↑↓ to switch  ·  Enter to submit  ·  Esc to cancel';

type FieldId = 'url' | 'token';

/** 对输入行中的可见字符进行遮罩处理（用于密码/token 输入），保留 ANSI 转义序列。 */
function maskInputLine(raw: string): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  // 去除尾部填充空格，使其保持为空格。
  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  // 保护 ANSI 转义序列（反显光标、IME 标记等），
  // 同时遮罩其他所有可见字符。
  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // ANSI 转义序列
      return part.replaceAll(/[^ ]/g, '•');
    })
    .join('');

  return prefix + maskedContent + padding;
}

export class CustomRegistryImportDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly urlInput = new Input();
  private readonly tokenInput = new Input();
  private readonly onDone: (result: CustomRegistryImportResult) => void;
  private activeField: FieldId = 'url';
  private done = false;
  private hint: 'none' | 'url-empty' | 'token-empty' = 'none';

  constructor(
    onDone: (result: CustomRegistryImportResult) => void,
    defaultUrl: string = '',
  ) {
    super();
    this.onDone = onDone;
    if (defaultUrl.length > 0) this.urlInput.setValue(defaultUrl);
    // URL 字段按 Enter 跳转到 token 字段；token 字段（最后一个）按 Enter 提交。
    this.urlInput.onSubmit = () => {
      this.focusField('token');
    };
    this.tokenInput.onSubmit = () => {
      this.handleSubmit();
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.toggleField();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.focusField('token');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.focusField('url');
      return;
    }

    if (this.hint !== 'none') {
      this.hint = 'none';
    }

    if (this.activeField === 'url') {
      this.urlInput.handleInput(data);
    } else {
      this.tokenInput.handleInput(data);
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.urlInput.invalidate();
    this.tokenInput.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && !this.done;
    this.urlInput.focused = dialogActive && this.activeField === 'url';
    this.tokenInput.focused = dialogActive && this.activeField === 'token';

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', TITLE);
    const subtitleText =
      this.hint === 'url-empty'
        ? SUBTITLE_URL_EMPTY
        : this.hint === 'token-empty'
          ? SUBTITLE_TOKEN_EMPTY
          : SUBTITLE_DEFAULT;
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const footerStyled = currentTheme.fg(
      'textDim',
      this.activeField === 'url' ? FOOTER_NOT_LAST : FOOTER_LAST,
    );

    const urlLabelText = 'Registry URL';
    const tokenLabelText = 'Bearer token';
    const urlLabelStyled =
      this.activeField === 'url'
        ? currentTheme.boldFg('accent', urlLabelText)
        : currentTheme.fg('textDim', urlLabelText);
    const tokenLabelStyled =
      this.activeField === 'token'
        ? currentTheme.boldFg('accent', tokenLabelText)
        : currentTheme.fg('textDim', tokenLabelText);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const urlLabelLine = truncateToWidth(urlLabelStyled, innerWidth, '…');
    const tokenLabelLine = truncateToWidth(tokenLabelStyled, innerWidth, '…');
    const urlInputLine = this.urlInput.render(innerWidth)[0] ?? '> ';
    const rawTokenInputLine = this.tokenInput.render(innerWidth)[0] ?? '> ';
    const tokenInputLine = maskInputLine(rawTokenInputLine);

    const contentLines: string[] = [
      titleLine,
      '',
      subtitleLine,
      '',
      urlLabelLine,
      urlInputLine,
      '',
      tokenLabelLine,
      tokenInputLine,
      '',
      footerLine,
    ];

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  /** 切换当前活动字段（url <-> token）。 */
  private toggleField(): void {
    this.focusField(this.activeField === 'url' ? 'token' : 'url');
  }

  /** 将焦点设置到指定字段。 */
  private focusField(field: FieldId): void {
    this.hint = 'none';
    this.activeField = field;
  }

  /** 处理表单提交：校验必填字段并回调。 */
  private handleSubmit(): void {
    if (this.done) return;

    const urlValue = this.urlInput.getValue().trim();
    const tokenValue = this.tokenInput.getValue().trim();

    if (urlValue.length === 0) {
      this.hint = 'url-empty';
      this.activeField = 'url';
      return;
    }
    if (tokenValue.length === 0) {
      this.hint = 'token-empty';
      this.activeField = 'token';
      return;
    }

    this.done = true;
    this.onDone({ kind: 'ok', value: { url: urlValue, apiKey: tokenValue } });
  }

  /** 取消对话框。 */
  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}

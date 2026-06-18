/**
 * 技能激活卡片。
 *
 * 当用户运行 `/skill:foo bar` 时，TUI 渲染一张紧凑卡片，而非将
 * SKILL.md 正文展开到用户气泡中：
 *
 *   ▶ Activated skill: foo
 *     bar
 *
 * 参数行是可选的。核心层将技能正文展开到 LLM 上下文中；
 * TUI 仅消费 `skill.activated` 事件和 user_message 来源元数据。
 */

import { Container, Text, Spacer } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { SkillActivationTrigger } from '#/tui/types';

const ARGS_PREVIEW_MAX = 200;

export class SkillActivationComponent extends Container {
  private headText: Text;
  private previewText?: Text;
  private name: string;
  private args?: string;

  constructor(
    name: string,
    args: string | undefined,
    readonly trigger?: SkillActivationTrigger,
  ) {
    super();
    this.name = name;
    this.args = args;
    this.addChild(new Spacer(1));
    const head =
      currentTheme.boldFg('primary', '▶ Activated skill: ') +
      currentTheme.boldFg('roleUser', name);
    this.headText = new Text(head, 0, 0);
    this.addChild(this.headText);
    const trimmed = args?.trim() ?? '';
    if (trimmed.length > 0) {
      const preview =
        trimmed.length > ARGS_PREVIEW_MAX ? trimmed.slice(0, ARGS_PREVIEW_MAX) + '…' : trimmed;
      this.previewText = new Text('  ' + currentTheme.fg('textDim', preview), 0, 0);
      this.addChild(this.previewText);
    }
  }

  override invalidate(): void {
    const head =
      currentTheme.boldFg('primary', '▶ Activated skill: ') +
      currentTheme.boldFg('roleUser', this.name);
    this.headText.setText(head);
    if (this.previewText !== undefined && this.args !== undefined) {
      const trimmed = this.args.trim();
      const preview =
        trimmed.length > ARGS_PREVIEW_MAX ? trimmed.slice(0, ARGS_PREVIEW_MAX) + '…' : trimmed;
      this.previewText.setText('  ' + currentTheme.fg('textDim', preview));
    }
    super.invalidate();
  }
}

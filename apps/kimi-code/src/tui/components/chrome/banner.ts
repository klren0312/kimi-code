import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { BannerState } from '#/tui/types';

const PREFIX_STAR = '✦';
const PADDING = ' ';

export class BannerComponent implements Component {
  constructor(private readonly state: BannerState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const main = (s: string): string => currentTheme.boldFg('textStrong', s);
    const dim = (s: string): string => currentTheme.fg('textDim', s);

    // 如果终端宽度不足以显示一个可见列，则只渲染末尾的空行。
    if (width < 1) {
      return [''];
    }

    const tagText = this.state.tag ?? '';
    // 不要在此处添加冒号/标签后缀；调用方提供的标签已包含自身的标点/分隔符。
    const tagLabel = tagText.length > 0 ? `${PREFIX_STAR} ${tagText}` : '';
    const tagStyled = tagLabel.length > 0 ? currentTheme.boldFg('primary', tagLabel) : '';
    const tagDisplay = tagStyled.length > 0 ? tagStyled + PADDING : '';
    const tagWidth = visibleWidth(tagDisplay);
    const showTag = tagWidth > 0 && tagWidth < width;
    // 正文续行缩进以对齐首行主文本列，即紧跟标签显示之后的位置。
    const bodyIndent = showTag ? ' '.repeat(tagWidth) : '';
    // 描述性副文本行（设计中的第二行）从引导星号+空格之后的列开始，
    // 与标签文本本身对齐。
    const descIndent = showTag ? ' '.repeat(visibleWidth(PREFIX_STAR + PADDING)) : '';
    const bodyContentWidth = width - (showTag ? tagWidth : 0);
    const descContentWidth = width - (showTag ? visibleWidth(PREFIX_STAR + PADDING) : 0);

    if (bodyContentWidth <= 0) {
      return [''];
    }

    const mainSegments = this.state.mainText.split('\n');
    const subSegments = this.state.subText ? this.state.subText.split('\n') : [];

    const result: string[] = [];
    for (let i = 0; i < mainSegments.length; i++) {
      const wrapped = wrapTextWithAnsi(mainSegments[i]!, bodyContentWidth);
      for (let j = 0; j < wrapped.length; j++) {
        const boldLine = main(wrapped[j]!);
        if (i === 0 && j === 0 && showTag) {
          result.push(tagDisplay + boldLine);
        } else {
          result.push(bodyIndent + boldLine);
        }
      }
    }

    for (const sub of subSegments) {
      const available = descContentWidth <= 0 ? bodyContentWidth : descContentWidth;
      const wrapped = wrapTextWithAnsi(sub, available);
      for (const line of wrapped) {
        result.push(descIndent + dim(line));
      }
    }

    // 在横幅下方添加空行，使后续转录内容（如输入提示/状态消息）在视觉上分隔开来。
    result.push('');

    return result;
  }
}

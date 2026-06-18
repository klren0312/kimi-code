/**
 * 容器，在子元素左右两侧预留边距列，使界面元素（状态栏、转录区、面板）
 * 与输入框的内部内容区对齐，而不是紧贴终端边缘。
 *
 * 子元素以 `width - left - right` 的宽度渲染，每行输出前缀 `left` 个
 * 普通空格。右侧填充仅为逻辑上的 —— 我们不会实际输出尾部空格，
 * 因为终端本就会将背景色绘制到边缘，添加尾部空格只会增加差异渲染器的开销。
 */

import { Container } from '@earendil-works/pi-tui';

export class GutterContainer extends Container {
  constructor(
    private readonly leftPad: number,
    private readonly rightPad: number,
  ) {
    super();
  }

  override render(width: number): string[] {
    const inner = Math.max(1, width - this.leftPad - this.rightPad);
    const lead = ' '.repeat(this.leftPad);
    const out: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(inner)) {
        out.push(lead + line);
      }
    }
    return out;
  }
}

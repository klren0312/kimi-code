/** 转义 XML 内容——同时转义标签和属性边界字符（& < > "） */
export function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 转义 XML 属性值——仅转义属性边界字符（& "），不转义标签字符 */
export function escapeXmlAttr(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/** 仅转义标签分隔符——防止 XML 标签注入而不破坏 Markdown（& " 保持原样） */
export function escapeXmlTags(input: string): string {
  return input.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

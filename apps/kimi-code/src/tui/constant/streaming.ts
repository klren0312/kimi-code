// 从部分流式传输的 JSON 工具参数中提取有用的字符串字段。
// 这是有意设计的预览解析器，而非完整的 JSON 解析器。
export const STREAMING_ARGS_FIELD_RE =
  /"(path|file_path|command|pattern|query|url|description|title|name)"\s*:\s*"((?:\\.|[^"\\])*)"/g;

// 限制实时工具参数预览的大小；最终的 tool.call 载荷保持完整。
export const STREAMING_ARGS_PREVIEW_MAX_CHARS = 64 * 1024;

// 在重建 TUI 组件前合并高频的模型/工具增量更新。
export const STREAMING_UI_FLUSH_MS = 50;

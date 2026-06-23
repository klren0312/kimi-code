/**
 * MCP 协议类型和 `ToolManager` 消费的最小客户端契约。
 *
 * 独立于 `toolset.ts`（而非放在其中），因为代理侧的工具运行时层是
 * `ExecutableTool`，而非旧版的 `Toolset` 接口。此处保留的是线级接口：
 * `tools/list` 返回的工具定义、`tools/call` 结果形状，以及允许测试
 * 注入伪传输而不引入 MCP SDK 类型图的小接口。
 */

/**
 * 嵌套在 EmbeddedResource 块下的内联资源内容。
 * 根据 MCP schema 的 `TextResourceContents | BlobResourceContents` 联合体，
 * `text` 或 `blob` 恰好有一个被填充。
 */
export interface MCPEmbeddedResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

/**
 * MCP 工具调用（`tools/call`）返回的内容块。
 *
 * 这是 MCP 协议 `ContentBlock` 联合体的结构子集，
 * 覆盖 {@link convertMCPContentBlock} 知道如何转换为
 * kosong `ContentPart` 的形状。额外字段被忽略。
 */
export interface MCPContentBlock {
  // 已知值：'text' | 'image' | 'audio' | 'resource' | 'resource_link'。
  // 声明为 `string` 以接受未来的 MCP 内容类型而无需类型断言。
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  // EmbeddedResource 将其载荷嵌套在 `resource` 下（根据 MCP 规范），
  // 而非作为顶层 `data`/`mimeType`。
  resource?: MCPEmbeddedResourceContents;
  [key: string]: unknown;
}

/**
 * 单次 MCP 工具调用的结果。
 *
 * 匹配 MCP 协议 `tools/call` 方法返回的形状。
 */
export interface MCPToolResult {
  content: MCPContentBlock[];
  isError: boolean;
}

/**
 * MCP 服务器 `tools/list` 方法返回的 MCP 工具定义。
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * {@link McpConnectionManager} 和 {@link ToolManager} 消费的最小 MCP 客户端接口。
 *
 * 这是一个传输无关的接缝：实现可以封装 `@modelcontextprotocol/sdk`、
 * 定制的 stdio 客户端、HTTP SSE 客户端或用于测试的 mock。
 * 保持接口小巧使测试可以注入伪实现而无需引入完整的 SDK 类型图。
 */
export interface MCPClient {
  /** 列出 MCP 服务器公告的工具。 */
  listTools(): Promise<MCPToolDefinition[]>;
  /**
   * 按名称使用给定的 JSON 参数调用工具。
   *
   * `signal`（如果提供）被转发到底层传输，以便循环中的中止
   * （如用户取消）一直传播到服务器，而非让请求在后台继续运行。
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
}

/**
 * 验证 MCP 工具定义的 `inputSchema` 字段。MCP 将输入 schema 公告为
 * JSON Schema 对象；拒绝任何非普通对象的内容，以免下游的验证编译器
 * 看到 `null` 或原始值。
 */
export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`);
}

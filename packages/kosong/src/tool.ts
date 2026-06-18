/**
 * 模型在生成过程中可能调用的工具。
 *
 * 定义是与提供者无关的；每个提供者实现将其转换为适当的线路格式
 * （例如 OpenAI function-calling、Anthropic tool-use、Google function declarations）。
 */
export interface Tool {
  /** 用于匹配调用的唯一工具名称。 */
  name: string;
  /** 展示给模型的人类可读描述。 */
  description: string;
  /** 描述工具参数的 JSON Schema。 */
  parameters: Record<string, unknown>;
}

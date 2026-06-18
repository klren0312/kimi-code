/**
 * 单次 LLM 生成的 token 用量明细。
 *
 * 提供者将其原生的用量计数器映射到此通用形状，以便调用方
 * 可以聚合成本而无需关心后端细节。
 */
export interface TokenUsage {
  /** 既非缓存读取也非缓存创建的输入 token。 */
  inputOther: number;
  /** 模型生成的输出（补全）token。 */
  output: number;
  /** 从提供者提示缓存中提供的输入 token。 */
  inputCacheRead: number;
  /** 写入提供者提示缓存的输入 token。 */
  inputCacheCreation: number;
}

/**
 * 计算总输入 token（其他 + 缓存读取 + 缓存创建）。
 */
export function inputTotal(usage: TokenUsage): number {
  return usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
}

/**
 * 计算总 token 数（总输入 + 输出）。
 */
export function grandTotal(usage: TokenUsage): number {
  return inputTotal(usage) + usage.output;
}

/**
 * 创建一个全零的 TokenUsage。
 */
export function emptyUsage(): TokenUsage {
  return {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
}

/**
 * 将两个 TokenUsage 值相加。
 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputOther: a.inputOther + b.inputOther,
    output: a.output + b.output,
    inputCacheRead: a.inputCacheRead + b.inputCacheRead,
    inputCacheCreation: a.inputCacheCreation + b.inputCacheCreation,
  };
}

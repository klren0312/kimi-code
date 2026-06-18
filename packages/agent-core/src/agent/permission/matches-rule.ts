/**
 * 权限系统的规则模式匹配引擎。
 *
 * 提供 DSL 解析器和匹配器，用于判断 {@link PermissionRule} 是否适用于给定的工具调用。
 * DSL 支持工具名 glob（通过 picomatch）和可选的参数模式，工具可通过其 `matchesRule` 回调解释。
 *
 * 本模块是模式语法的唯一真实来源——权限系统中所有规则匹配都通过 {@link matchPermissionRule}。
 */

import picomatch from 'picomatch';

import type { RunnableToolExecution } from '../../loop/types';
import type { PermissionRule } from './types';

/**
 * PermissionRule `pattern` 字符串的 DSL 解析器。
 *
 * 语法：
 *   pattern    := toolName ( "(" argPattern ")" )?
 *   toolName   := 标识符字符（如 `Bash`、`mcp__github__*`）
 *   argPattern := 仅由工具提供的匹配器解释的任意字符串
 *
 * 示例：
 *   "Write"            -> { toolName: "Write" }
 *   "Read(/etc/**)"    -> { toolName: "Read", argPattern: "/etc/**" }
 *   "Bash(!rm *)"      -> { toolName: "Bash", argPattern: "!rm *" }
 *   "mcp__github__*"   -> { toolName: "mcp__github__*" }
 */
export interface ParsedPattern {
  readonly toolName: string;
  readonly argPattern?: string;
}

/**
 * 参数级规则匹配所需的执行接口。
 * 委托给工具自身的 `matchesRule` 回调，使每个工具能按自己的方式解释参数模式（如 glob 路径）。
 */
export interface PermissionRuleMatchExecution {
  readonly matchesRule?: RunnableToolExecution['matchesRule'];
}

/**
 * 规则匹配方式：`tool_name_only` 表示规则没有参数模式（或工具不支持参数匹配）；
 * `matches_rule` 表示工具名和参数模式都匹配成功。
 */
export type PermissionRuleMatchStrategy = 'tool_name_only' | 'matches_rule';

/** 成功规则匹配的结果，包含用于遥测的匹配元数据。 */
export interface PermissionRuleMatch {
  readonly rule: PermissionRule;
  readonly strategy: PermissionRuleMatchStrategy;
  readonly hasRuleArgs: boolean;
}

/** {@link matchPermissionRule} 的输入：待测试的规则、工具名和执行上下文。 */
export interface PermissionRuleMatchInput {
  readonly rule: PermissionRule;
  readonly toolName: string;
  readonly execution: PermissionRuleMatchExecution;
}

/**
 * 解析 DSL 模式。输入格式错误时抛出异常（缺少右括号、空工具名）。
 * 解析器是 DSL 语法的唯一真实来源。
 *
 * 注意：`Tool()`（空括号）解析为仅工具名，以便没有 `matchesRule` 匹配器的工具
 * （用户/MCP/自定义）仍然可以匹配它。
 */
export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('permission pattern: empty string');
  }

  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) {
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(`permission pattern: missing closing paren in "${pattern}"`);
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) {
    throw new Error(`permission pattern: empty tool name in "${pattern}"`);
  }
  // `Tool()` 解析为无参数模式，因此保持仅工具名——没有 `matchesRule` 匹配器的工具
  // （用户/MCP/自定义）否则将无法匹配它。
  if (argPattern.length === 0) {
    return { toolName };
  }
  return { toolName, argPattern };
}

/**
 * 测试权限规则是否匹配特定的工具调用。
 *
 * 匹配分两阶段：
 * 1. **工具名**：精确匹配或通过 picomatch 进行 glob 匹配（如 `mcp__github__*`）。
 * 2. **参数模式**（如果存在）：委托给工具的 `matchesRule` 回调，
 *    由该回调根据工具的实际参数解释模式。
 *
 * @returns 如果规则匹配则返回带有元数据的 {@link PermissionRuleMatch}，
 *   否则返回 `undefined`。格式错误的模式返回 `undefined` 而非抛出异常，
 *   以防止错误的用户规则导致系统崩溃。
 */
export function matchPermissionRule({
  rule,
  toolName,
  execution,
}: PermissionRuleMatchInput): PermissionRuleMatch | undefined {
  let parsed;
  try {
    parsed = parsePattern(rule.pattern);
  } catch {
    return undefined;
  }

  if (parsed.toolName !== '*' && !picomatch.isMatch(toolName, parsed.toolName)) {
    return undefined;
  }

  if (parsed.argPattern === undefined) {
    return { rule, strategy: 'tool_name_only', hasRuleArgs: false };
  }

  return execution.matchesRule?.(parsed.argPattern) === true
    ? { rule, strategy: 'matches_rule', hasRuleArgs: true }
    : undefined;
}

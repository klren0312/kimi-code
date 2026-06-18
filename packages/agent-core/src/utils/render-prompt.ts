import nunjucks from 'nunjucks';

/**
 * 共享的提示词模板渲染器。
 *
 * 所有提示词模板（系统提示词、工具描述、压缩指令……）使用 nunjucks
 * `{{ var }}` / `{% if %}` 语法，通过此函数统一渲染。
 *
 * - `autoescape: false`——提示词文本不是 HTML；`<`、`>`、`&` 必须原样传递。
 * - `throwOnUndefined: true`——缺失变量是明确的错误，绝不会在发送给模型的
 *   文本中静默泄漏 `{{ placeholder }}`。
 */
const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });

export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return env.renderString(template, vars);
}

/**
 * 通知 XML 渲染 — 生成活跃 ContextMemory 和投影器之间
 * 共享的聊天历史注入文本。
 *
 * 输出格式：
 *   <notification id="..." category="..." type="..." source_kind="..." source_id="..." [agent_id="..."]>
 *   Title: ...
 *   Severity: ...
 *   <body>
 *   <children...>
 *   </notification>
 *
 * The opening tag name (`<notification `) is load-bearing for notification
 * consumers that detect chat-history injections.
 *
 * `agent_id` 仅对来源任务为 Agent 子代理的后台任务通知输出 —
 * 将其以结构化方式呈现，使 LLM 无需解析正文或原始 spawn-success
 * ToolResult 即可识别传递给 `Agent(resume=...)` 的正确 id。
 * 它故意与 `source_id` 是独立的属性：两者看起来相似（`agent-...`）
 * 但处于不同的命名空间。
 */

import { escapeXmlAttr } from '#/utils/xml-escape';

/**
 * 将通知数据对象渲染为注入到聊天历史中的 XML 结构化文本格式。
 *
 * 输出格式具有关键作用：开标签 `<notification` 和
 * `<task-notification>` 被投影器的合并逻辑检测到以识别通知消息。
 * 重命名这些标签需要同步更新投影器的检测器。
 *
 * 对于后台任务通知，会追加一个 `<task-notification>` 块，
 * 包含任务输出的截断尾部，为模型提供后台任务产出的预览。
 *
 * `agent_id` 属性仅对来源任务为 Agent 子代理的后台任务通知输出，
 * 使模型无需解析正文文本即可识别用于 `Agent(resume=...)` 的正确 ID。
 *
 * @param data - 原始通知数据（通常来自通知系统）。
 * @returns 格式化好的 XML 字符串，可直接注入上下文。
 */
export function renderNotificationXml(data: Record<string, unknown>): string {
  const id = stringAttr(data['id'], 'unknown');
  const category = stringAttr(data['category'], 'unknown');
  const type = stringAttr(data['type'], 'unknown');
  const sourceKind = stringAttr(data['source_kind'], 'unknown');
  const sourceId = stringAttr(data['source_id'], 'unknown');
  const agentId = optionalStringAttr(data['agent_id']);
  const title = typeof data['title'] === 'string' ? data['title'] : '';
  const severity = typeof data['severity'] === 'string' ? data['severity'] : '';
  const body = typeof data['body'] === 'string' ? data['body'] : '';
  const children = childBlocks(data['children'] ?? data['extraBlocks']);

  const agentIdAttr = agentId === undefined ? '' : ` agent_id="${agentId}"`;
  const lines: string[] = [
    `<notification id="${id}" category="${category}" type="${type}" source_kind="${sourceKind}" source_id="${sourceId}"${agentIdAttr}>`,
  ];
  if (title.length > 0) lines.push(`Title: ${title}`);
  if (severity.length > 0) lines.push(`Severity: ${severity}`);
  if (body.length > 0) lines.push(body);
  lines.push(...children);

  lines.push('</notification>');
  return lines.join('\n');
}

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return escapeXmlAttr(value);
}

/** 与 `stringAttr` 类似，但返回 `undefined` 而非 fallback，
 *  以便调用者在源值不存在时可完全省略该属性。 */
function optionalStringAttr(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function childBlocks(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

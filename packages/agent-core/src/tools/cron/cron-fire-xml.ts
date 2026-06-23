/**
 * Cron 触发 XML 渲染 — 生成当 CronTask 触发时调度器注入到模型的
 * 聊天历史文本。
 *
 * 输出形状：
 *   <cron-fire jobId="..." cron="..." recurring="true|false" coalescedCount="N" stale="true|false">
 *   <prompt>
 *   原始用户 prompt
 *   </prompt>
 *   </cron-fire>
 *
 * 镜像 `agent/context/notification-xml.ts`：属性值通过 `stringAttr`
 * 转义安全，但 `<prompt>` 内的主体保持原样。注入目标是 LLM 可见的
 * 转录记录，双重转义会比字面标点更干扰阅读。
 */
import type { CronJobOrigin } from '../../agent/context/types';

export function renderCronFireXml(
  origin: CronJobOrigin,
  prompt: string,
): string {
  const jobId = stringAttr(origin.jobId, 'unknown');
  const cron = stringAttr(origin.cron, 'unknown');
  const recurring = origin.recurring ? 'true' : 'false';
  const coalescedCount = String(origin.coalescedCount);
  const stale = origin.stale ? 'true' : 'false';

  return [
    `<cron-fire jobId="${jobId}" cron="${cron}" recurring="${recurring}" coalescedCount="${coalescedCount}" stale="${stale}">`,
    '<prompt>',
    prompt,
    '</prompt>',
    '</cron-fire>',
  ].join('\n');
}

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  // 属性边界安全：转义 `&` 和 `"`。主体文本中的 `<` / `>` 保持不变
  // — 注入目标是 LLM 可见的转录记录，双重转义会比字面标点更干扰阅读。
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

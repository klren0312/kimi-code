/**
 * 以本地墙钟时间和显式数字偏移渲染面向 cron 的时间戳。Cron 表达式
 * 在本地时间中求值，因此工具输出应保留该心智模型，同时保持
 * 无歧义并可作为 ISO 8601 解析。
 */
export function formatLocalIsoWithOffset(ms: number): string {
  const date = new Date(ms);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(
    3,
    '0',
  )}${offset}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

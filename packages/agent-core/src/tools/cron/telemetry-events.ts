/** cron 子系统发出的遥测事件名称。集中管理以避免拼写错误漂移指标。 */
export const CRON_SCHEDULED = 'cron_scheduled' as const;
export const CRON_FIRED = 'cron_fired' as const;
export const CRON_MISSED = 'cron_missed' as const;
export const CRON_DELETED = 'cron_deleted' as const;

export type CronTelemetryEvent =
  | typeof CRON_SCHEDULED
  | typeof CRON_FIRED
  | typeof CRON_MISSED
  | typeof CRON_DELETED;

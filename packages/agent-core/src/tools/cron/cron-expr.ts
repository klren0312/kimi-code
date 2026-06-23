/**
 * 5 字段 cron 表达式解析和"下次触发时间"计算，使用本地时间。
 * 自包含 — 不使用外部 cron 库，因为上游 `claude-code` 镜像了
 * 相同语义，我们需要与其实现精确同步行为。
 *
 * 我们关注两种正确性：
 *
 *   1. **语义。** 标准 5 字段（分钟 小时 日 月份 星期几）。
 *      日和星期几在两者都受限时使用 cron 的 OR 规则
 *     （POSIX/Vixie 传统）。dow 接受 0..7，7 折叠为 0（星期日）。
 *
 *   2. **终止性。** 对合法但永不触发的表达式如 `0 0 31 2 *` 计算
 *      `next` 不能自旋。我们将搜索限制在固定窗口（默认 5 年），
 *      超出返回 `null` — `CronCreate` 的验证器复用此信号。
 */

/** 已解析的 cron 表达式。对调用者不透明 — 传回 {@link computeNextCronRun}。 */
export interface ParsedCronExpression {
  readonly raw: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** 当源字段为 `*` 时为 true — 使 cron 的 dom/dow OR 规则仅在两者都受限时生效。 */
  readonly daysOfMonthWildcard: boolean;
  readonly daysOfWeekWildcard: boolean;
}

const MINUTE_RANGE = { min: 0, max: 59 } as const;
const HOUR_RANGE = { min: 0, max: 23 } as const;
const DOM_RANGE = { min: 1, max: 31 } as const;
const MONTH_RANGE = { min: 1, max: 12 } as const;
const DOW_RANGE = { min: 0, max: 7 } as const; // 解析后 7 → 0 折叠

const MS_PER_MINUTE = 60_000;

/**
 * 解析 5 字段 cron 表达式。任何语法错误时抛出命名问题字段的消息。
 * 以空白分隔；恰好 5 个字段。每个字段支持的标记：`*`、整数、
 * 范围（`a-b`）、列表（`a,b,c`）和步长（如 *-slash-n 或 `a-b/n`）。
 */
export function parseCronExpression(expr: string): ParsedCronExpression {
  if (typeof expr !== 'string') {
    throw new TypeError('cron expression must be a string');
  }
  const trimmed = expr.trim();
  if (trimmed === '') {
    throw new Error('cron expression is empty');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}`,
    );
  }
  const [minField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = parseField(minField, MINUTE_RANGE.min, MINUTE_RANGE.max, 'minute');
  const hours = parseField(hourField, HOUR_RANGE.min, HOUR_RANGE.max, 'hour');
  const daysOfMonth = parseField(domField, DOM_RANGE.min, DOM_RANGE.max, 'day-of-month');
  const months = parseField(monthField, MONTH_RANGE.min, MONTH_RANGE.max, 'month');
  const dowRaw = parseField(dowField, DOW_RANGE.min, DOW_RANGE.max, 'day-of-week');
  const daysOfWeek = new Set<number>();
  for (const v of dowRaw) daysOfWeek.add(v === 7 ? 0 : v);

  return {
    raw: trimmed,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    daysOfMonthWildcard: isWildcard(domField),
    daysOfWeekWildcard: isWildcard(dowField),
  };
}

function isWildcard(field: string): boolean {
  // `*` 和 `*/n` 在"每个值"意义上都使字段不受约束 — 但只有裸 `*`
  // 才应抑制 dom/dow OR 规则。cron 传统将 `*/n` 视为一种限制。
  return field === '*';
}

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  if (field === '') {
    throw new Error(`cron ${name} field is empty`);
  }
  const out = new Set<number>();
  const terms = field.split(',');
  for (const term of terms) {
    if (term === '') {
      throw new Error(`cron ${name} field has empty term in list`);
    }
    addTerm(out, term, min, max, name);
  }
  if (out.size === 0) {
    throw new Error(`cron ${name} field matches no values`);
  }
  return out;
}

// Cron 数字字段仅限数字。`Number(...)` 否则会接受 `''`（→ 0）、
// `'1e1'`、`'0x10'`、`'+5'`、`'  3  '` 等 — 这些都不是合法 cron 语法。
// 此正则门控在转换前运行，将拼写错误作为解析错误暴露，
// 而非静默地重新调度任务。
const DIGIT_ONLY = /^\d+$/;

function parseCronInt(raw: string, name: string, role: string): number {
  if (!DIGIT_ONLY.test(raw)) {
    throw new Error(
      `cron ${name} ${role} must be a non-negative integer with digits only (got ${JSON.stringify(raw)})`,
    );
  }
  return Number.parseInt(raw, 10);
}

function addTerm(out: Set<number>, term: string, min: number, max: number, name: string): void {
  let rangePart = term;
  let step = 1;
  const slash = term.indexOf('/');
  if (slash !== -1) {
    rangePart = term.slice(0, slash);
    const stepStr = term.slice(slash + 1);
    if (stepStr === '') {
      throw new Error(`cron ${name} step is empty in "${term}"`);
    }
    const parsedStep = parseCronInt(stepStr, name, 'step');
    if (parsedStep <= 0) {
      throw new Error(`cron ${name} step must be a positive integer (got "${stepStr}")`);
    }
    step = parsedStep;
    if (rangePart === '') {
      throw new Error(`cron ${name} step needs a range or "*" before "/" in "${term}"`);
    }
  }

  let lo: number;
  let hi: number;
  if (rangePart === '*') {
    lo = min;
    hi = max;
  } else {
    const dash = rangePart.indexOf('-');
    if (dash === -1) {
      const single = parseCronInt(rangePart, name, 'value');
      if (single < min || single > max) {
        throw new Error(`cron ${name} value ${single} out of range ${min}..${max}`);
      }
      // 带步长的裸单个值（`5/10`）不常见；视为"从值到最大值步进 N"，
      // 这是大多数 cron 方言的做法。
      if (slash !== -1) {
        lo = single;
        hi = max;
      } else {
        out.add(single);
        return;
      }
    } else {
      const loStr = rangePart.slice(0, dash);
      const hiStr = rangePart.slice(dash + 1);
      lo = parseCronInt(loStr, name, 'range lower bound');
      hi = parseCronInt(hiStr, name, 'range upper bound');
      if (lo < min || hi > max || lo > hi) {
        throw new Error(
          `cron ${name} range ${lo}-${hi} out of bounds (must be ${min}..${max}, ascending)`,
        );
      }
    }
  }

  for (let v = lo; v <= hi; v += step) {
    out.add(v);
  }
}

/**
 * 查找严格大于 `fromMs` 且满足 `expr` 的下一个墙钟 epoch 毫秒，
 * 使用本地时间语义。如果在默认 5 年搜索窗口内无匹配则返回 `null`
 * — 防御合法但永不触发的表达式如 `0 0 31 2 *`。
 *
 * 使用 O(transitions) 逐字段跳过算法而非逐分钟扫描 — 月份不匹配
 * 按月前进，日期不匹配按天前进等，因此 `0 12 1 1 *` 的最坏情况
 * 是几次迭代，而非 43200 次。
 *
 * 终止由候选日期的墙钟截止时间限制 — 而非迭代次数 — 因此每个
 * 迭代都在 `advanceMonth` 上的病态表达式仍在文档窗口内退出。
 * 次级 `HARD_ITERATION_CAP` 防止未来重构未能推进日期。
 */
export function computeNextCronRun(expr: ParsedCronExpression, fromMs: number): number | null {
  return nextRunWithinMinutes(expr, fromMs, 5 * 366 * 24 * 60);
}

/**
 * 当且仅当在 `fromMs` 的 `years` 年内至少存在一次触发时返回 true。
 * 用于 CronCreate 验证以提前拒绝 `0 0 31 2 *` 等表达式，
 * 使用与 {@link computeNextCronRun} 相同的墙钟截止时间
 * （因此验证器永远不会对调度器稍后拒绝计算的内容说"是"）。
 */
export function hasFireWithinYears(
  expr: ParsedCronExpression,
  years: number,
  fromMs: number,
): boolean {
  const cap = Math.max(1, Math.floor(years * 366 * 24 * 60));
  return nextRunWithinMinutes(expr, fromMs, cap) !== null;
}

function nextRunWithinMinutes(
  expr: ParsedCronExpression,
  fromMs: number,
  capMinutes: number,
): number | null {
  // 严格进入下一分钟：丢弃秒/毫秒并加一分钟。这保证永远不返回 `fromMs` 本身。
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  const date = new Date(start.getTime() + MS_PER_MINUTE);

  // 墙钟截止时间。每个循环体只向前推进 `date`（月/日/时/分），
  // 因此对 `date.getTime()` 的单次截止检查限制了总工作量，
  // 无论哪种粒度占主导 — 包括 `advanceMonth` 为主要操作的
  // 病态情况（如 `0 0 30 2 *` 永远不匹配二月）。
  const deadlineMs = fromMs + capMinutes * MS_PER_MINUTE;

  // 次级安全网：如果未来重构意外未能推进 `date`，这将防止无限循环。
  // 足够慷慨以覆盖合理窗口内的任何逐分钟遍历，且比之前的迭代界限
  // 低多个数量级。
  let iterations = 0;
  const HARD_ITERATION_CAP = 10_000_000;

  while (date.getTime() <= deadlineMs && iterations++ < HARD_ITERATION_CAP) {
    // 月 — 最粗粒度。如果不对，跳到下一个允许月份的 1 日并重启日检查。
    if (!expr.months.has(date.getMonth() + 1)) {
      advanceMonth(date);
      continue;
    }

    // 日。Cron 风格 OR：当 dom 和 dow 都受限时，匹配任一；
    // 当一个是 `*` 时，只有另一个施加约束。
    if (!dayMatches(expr, date)) {
      advanceDay(date);
      continue;
    }

    if (!expr.hours.has(date.getHours())) {
      advanceHour(date);
      continue;
    }

    if (!expr.minutes.has(date.getMinutes())) {
      advanceMinute(date);
      continue;
    }

    return date.getTime();
  }

  return null;
}

function dayMatches(expr: ParsedCronExpression, date: Date): boolean {
  const dom = date.getDate();
  const dow = date.getDay();
  const domOk = expr.daysOfMonth.has(dom);
  const dowOk = expr.daysOfWeek.has(dow);

  if (expr.daysOfMonthWildcard && expr.daysOfWeekWildcard) return true;
  if (expr.daysOfMonthWildcard) return dowOk;
  if (expr.daysOfWeekWildcard) return domOk;
  // 两者都受限：cron 风格 OR。
  return domOk || dowOk;
}

function advanceMonth(date: Date): void {
  // 跳到下个月的 1 日 00:00。Date 的自动进位处理年份翻转。
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  date.setMonth(date.getMonth() + 1);
}

function advanceDay(date: Date): void {
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);
}

function advanceHour(date: Date): void {
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
}

function advanceMinute(date: Date): void {
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * 表达式的简单人类可读摘要。当形状不是我们识别的模式之一时回退到
 * 原始字符串 — 调用方（CronList）纯用于展示，因此冗长的回退
 * 是可以的，我们不试图穷举。
 */
export function cronToHuman(expr: ParsedCronExpression): string {
  const allMin = isFullRange(expr.minutes, 0, 59);
  const allHour = isFullRange(expr.hours, 0, 23);
  const allDom = expr.daysOfMonthWildcard;
  const allMonth = isFullRange(expr.months, 1, 12);
  const allDow = expr.daysOfWeekWildcard;

  // 每 N 分钟 — 常见 LLM 模式（`*/5 * * * *`）。
  if (allHour && allDom && allMonth && allDow) {
    const step = detectStep(expr.minutes, 0, 59);
    if (step !== null && step > 1) return `every ${step} minutes`;
    if (allMin) return 'every minute';
    if (expr.minutes.size === 1) {
      const m = [...expr.minutes][0]!;
      return `at minute ${m} of every hour`;
    }
  }

  // 每 N 小时。
  if (expr.minutes.size === 1 && allDom && allMonth && allDow) {
    const m = [...expr.minutes][0]!;
    const step = detectStep(expr.hours, 0, 23);
    if (step !== null && step > 1) {
      return `every ${step} hours at minute ${pad(m)}`;
    }
  }

  // 每天 HH:MM，可选 dow 限制。
  if (
    expr.minutes.size === 1 &&
    expr.hours.size === 1 &&
    allDom &&
    allMonth
  ) {
    const h = [...expr.hours][0]!;
    const m = [...expr.minutes][0]!;
    if (allDow) return `at ${pad(h)}:${pad(m)} every day`;
    const dowStr = formatDows(expr.daysOfWeek);
    if (dowStr !== null) return `at ${pad(h)}:${pad(m)} on ${dowStr}`;
  }

  // 在 <月份> 第 N 天的 HH:MM。
  if (
    expr.minutes.size === 1 &&
    expr.hours.size === 1 &&
    expr.daysOfMonth.size === 1 &&
    !expr.daysOfMonthWildcard &&
    expr.months.size === 1 &&
    allDow
  ) {
    const h = [...expr.hours][0]!;
    const m = [...expr.minutes][0]!;
    const d = [...expr.daysOfMonth][0]!;
    const mo = [...expr.months][0]!;
    return `at ${pad(h)}:${pad(m)} on day ${d} of ${MONTH_NAMES[mo - 1]}`;
  }

  return expr.raw;
}

function isFullRange(set: ReadonlySet<number>, min: number, max: number): boolean {
  if (set.size !== max - min + 1) return false;
  for (let v = min; v <= max; v++) if (!set.has(v)) return false;
  return true;
}

/**
 * 如果集合形如 `{min, min+step, ..., <=max}` 且步长恒定，返回 `step`。
 * 否则返回 null。用于美化打印 star-slash-N。
 */
function detectStep(set: ReadonlySet<number>, min: number, max: number): number | null {
  const values = [...set].toSorted((a, b) => a - b);
  if (values.length < 2) return null;
  if (values[0] !== min) return null;
  const step = values[1]! - values[0]!;
  if (step <= 0) return null;
  let expected = min;
  for (const v of values) {
    if (v !== expected) return null;
    expected += step;
  }
  // 最后一个期望值应超出 `max` 不到 `step`。
  if (expected - step > max) return null;
  return step;
}

function formatDows(set: ReadonlySet<number>): string | null {
  const values = [...set].toSorted((a, b) => a - b);
  if (values.length === 0) return null;
  // 周一到周五快捷方式。
  if (values.length === 5 && values.every((v, i) => v === i + 1)) {
    return 'weekdays';
  }
  if (values.length === 2 && values[0] === 0 && values[1] === 6) {
    return 'weekends';
  }
  return values.map((v) => DAY_NAMES[v]!).join(', ');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

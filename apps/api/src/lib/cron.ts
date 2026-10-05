/**
 * Standard 5-field cron schedules ("minute hour day-of-month month day-of-week"),
 * evaluated in UTC. Supports *, numbers, ranges (1-5), steps (*\/15, 1-10/2),
 * lists (1,15,30), month and weekday names (JAN, MON), 7 = Sunday, and the
 * macros @hourly, @daily (@midnight), @weekly, @monthly, @yearly (@annually).
 * Like Vixie cron: when both day-of-month and day-of-week are restricted, a
 * day matches if EITHER does.
 */

export interface CronSchedule {
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

export class CronSyntaxError extends Error {}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Index of the first name (JAN = 1, SUN = 0). */
  nameOffset?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES, nameOffset: 0 },
];

export function parseCron(input: string): CronSchedule {
  const expression = input.trim().replace(/\s+/g, " ");
  const expanded = MACROS[expression.toLowerCase()] ?? expression;
  const parts = expanded.split(" ");
  if (parts.length !== 5) {
    throw new CronSyntaxError(`"${expression}" needs 5 fields (minute hour day-of-month month day-of-week), or a macro like @daily`);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeekRaw] = parts.map((part, index) => parseField(part, FIELDS[index]!));
  // 7 is Sunday too.
  const daysOfWeek = new Set([...daysOfWeekRaw!].map((day) => (day === 7 ? 0 : day)));
  return {
    expression,
    minutes: minutes!,
    hours: hours!,
    daysOfMonth: daysOfMonth!,
    months: months!,
    daysOfWeek,
    dayOfMonthRestricted: parts[2] !== "*",
    dayOfWeekRestricted: parts[4] !== "*",
  };
}

function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new CronSyntaxError(`invalid ${spec.name} "${item}"`);
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > spec.max) throw new CronSyntaxError(`invalid step in ${spec.name} "${item}"`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = spec.min;
      to = spec.name === "day of week" ? 6 : spec.max;
    } else {
      const [start, end] = range!.split("-");
      from = value(start!, spec);
      to = end === undefined ? (stepText === undefined ? from : spec.max) : value(end, spec);
      if (from > to) throw new CronSyntaxError(`range ${range} in ${spec.name} goes backwards`);
    }
    for (let current = from; current <= to; current += step) values.add(current);
  }
  return values;
}

function value(text: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  const number = named >= 0 ? named + (spec.nameOffset ?? 0) : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
    throw new CronSyntaxError(`${spec.name} "${text}" is not between ${spec.min} and ${spec.max}`);
  }
  return number;
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const dom = schedule.daysOfMonth.has(date.getUTCDate());
  const dow = schedule.daysOfWeek.has(date.getUTCDay());
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dom || dow;
  return dom && dow;
}

/**
 * The first time strictly after `after` (to the minute) the schedule fires,
 * or null if it never does within 5 years (e.g. "0 0 31 2 *").
 */
export function nextRun(schedule: CronSchedule, after: Date): Date | null {
  const date = new Date(after.getTime());
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(date.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (date.getTime() <= limit) {
    if (!schedule.months.has(date.getUTCMonth() + 1)) {
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      date.setUTCHours(0, 0);
      continue;
    }
    if (!dayMatches(schedule, date)) {
      date.setUTCDate(date.getUTCDate() + 1);
      date.setUTCHours(0, 0);
      continue;
    }
    if (!schedule.hours.has(date.getUTCHours())) {
      date.setUTCHours(date.getUTCHours() + 1, 0);
      continue;
    }
    if (!schedule.minutes.has(date.getUTCMinutes())) {
      date.setUTCMinutes(date.getUTCMinutes() + 1);
      continue;
    }
    return date;
  }
  return null;
}

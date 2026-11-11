/**
 * Calendar-date helpers for the plain `YYYY-MM-DD` strings used throughout the records
 * (tasks carry no timezone, so a date is a calendar day, not an instant).
 * Day arithmetic runs in UTC so DST transitions never produce 23- or 25-hour "days".
 */

/** A calendar date as `YYYY-MM-DD`. Validate with `isDateOnly` or the `dateOnly` schema. */
export type DateOnly = string;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export class InvalidDateError extends Error {
  readonly input: unknown;

  constructor(input: unknown) {
    super(`Expected a calendar date as YYYY-MM-DD, got ${JSON.stringify(input)}`);
    this.name = 'InvalidDateError';
    this.input = input;
  }
}

function parts(text: string): { year: number; month: number; day: number } | null {
  const match = DATE_ONLY_RE.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Date.UTC normalizes out-of-range fields (Feb 30 -> Mar 2); a real date round-trips.
  const probe = new Date(Date.UTC(year, month - 1, day));
  const valid =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return valid ? { year, month, day } : null;
}

/** Strict check: exactly `YYYY-MM-DD` and a real calendar day (leap years included). */
export function isDateOnly(text: unknown): text is DateOnly {
  return typeof text === 'string' && parts(text) !== null;
}

export function assertDateOnly(text: unknown): asserts text is DateOnly {
  if (!isDateOnly(text)) {
    throw new InvalidDateError(text);
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Formats the local calendar date of a Date (Bryntum dates are local-time instants). */
export function toDateOnly(date: Date): DateOnly {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new InvalidDateError(date);
  }
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** Local midnight of the calendar day, which is how Bryntum interprets a plain date string. */
export function parseDateOnly(text: DateOnly): Date {
  assertDateOnly(text);
  const { year, month, day } = parts(text)!;
  return new Date(year, month - 1, day);
}

function utcMidnight(text: DateOnly): number {
  assertDateOnly(text);
  const { year, month, day } = parts(text)!;
  return Date.UTC(year, month - 1, day);
}

/**
 * Whole days from `start` to `end` (negative when `end` is earlier). With an exclusive end
 * this is the number of calendar days in the interval, e.g. a booking's billable days.
 */
export function daysBetween(start: DateOnly, end: DateOnly): number {
  return (utcMidnight(end) - utcMidnight(start)) / MS_PER_DAY;
}

export function addDays(date: DateOnly, days: number): DateOnly {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError(`days must be an integer, got ${String(days)}`);
  }
  const shifted = new Date(utcMidnight(date) + days * MS_PER_DAY);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
}

/** Lexicographic order equals chronological order for zero-padded `YYYY-MM-DD`. */
export function compareDateOnly(a: DateOnly, b: DateOnly): -1 | 0 | 1 {
  assertDateOnly(a);
  assertDateOnly(b);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

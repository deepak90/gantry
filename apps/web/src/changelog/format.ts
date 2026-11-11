/**
 * Plain-language formatting for the changelog: calendar days, inclusive finish days, counts and
 * relative times. Dates in revisions travel without a timezone (`YYYY-MM-DDTHH:mm:ss`), so they are
 * read as calendar values and never shifted through the browser's offset.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 86_400_000;

interface CalendarValue {
  year: number;
  month: number;
  day: number;
  /** Time of day in minutes; 0 at midnight. */
  minutes: number;
}

/** Reads `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss]` or a Date (local fields) as a calendar value. */
export function readCalendarValue(value: unknown): CalendarValue | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate(), minutes: value.getHours() * 60 + value.getMinutes() };
  }
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    minutes: match[4] ? Number(match[4]) * 60 + Number(match[5]) : 0,
  };
}

function dayNumber(value: CalendarValue): number {
  return Date.UTC(value.year, value.month - 1, value.day) / DAY_MS;
}

/** `2026-11-13T00:00:00` → `Fri, Nov 13`. */
export function formatDay(value: unknown): string {
  const date = readCalendarValue(value);
  if (!date) {
    return '—';
  }
  const weekday = new Date(dayNumber(date) * DAY_MS).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${MONTHS[date.month - 1]} ${date.day}`;
}

/**
 * The last day a task is worked: Bryntum end dates are exclusive (midnight after the last day), so a
 * task ending at `2026-11-14T00:00` finishes on Fri, Nov 13. A milestone (no length) finishes on its end.
 */
export function formatFinish(end: unknown, start?: unknown): string {
  const finish = readCalendarValue(end);
  if (!finish) {
    return '—';
  }
  const begin = readCalendarValue(start);
  const zeroLength = begin !== null && dayNumber(begin) * 1440 + begin.minutes >= dayNumber(finish) * 1440 + finish.minutes;
  if (finish.minutes === 0 && !zeroLength) {
    const previous = new Date((dayNumber(finish) - 1) * DAY_MS);
    return formatDay(`${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}-${String(previous.getUTCDate()).padStart(2, '0')}`);
  }
  return formatDay(end);
}

/** Calendar days from `before` to `after` (positive when later); null when either is not a date. */
export function dayShift(before: unknown, after: unknown): number | null {
  const from = readCalendarValue(before);
  const to = readCalendarValue(after);
  return from && to ? Math.round(dayNumber(to) - dayNumber(from)) : null;
}

export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/** `2 days later`, `1 day earlier`. */
export function shiftPhrase(days: number): string {
  return `${plural(Math.abs(days), 'day')} ${days > 0 ? 'later' : 'earlier'}`;
}

/** A Bryntum duration in its unit: `5 days`, `1 day`, `3 hours`. */
export function formatDuration(value: unknown, unit: unknown = 'day'): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  const rounded = Math.round(value * 100) / 100;
  const noun = typeof unit === 'string' && unit ? unit.replace(/s$/, '') : 'day';
  return plural(rounded, noun);
}

export function formatPercent(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

/** Relative time for recent events, the day otherwise. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 6 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (now.toDateString() === at.toDateString()) return `today ${time}`;
  return `${at.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** The full local date and time, for tooltips. */
export function fullTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Note fields may hold the task editor's rich text; the changelog shows a short plain excerpt. */
export function plainExcerpt(value: unknown, max = 80): string {
  if (typeof value !== 'string') {
    return value == null ? '—' : String(value);
  }
  const text = value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '—';
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

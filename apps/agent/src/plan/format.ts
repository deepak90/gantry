/** Plain-words formatting shared by tools, the mock model and the CLI. */
import { addDays, format, money, type CurrencyCode } from '@collab/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-12-11` -> `Fri, Dec 11`. */
export function day(date: string): string {
  const [year, month, dayOfMonth] = date.split('-').map(Number);
  if (!year || !month || !dayOfMonth) return date;
  const weekday = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${MONTHS[month - 1]} ${dayOfMonth}`;
}

/** The last day of an exclusive end date. */
export function lastDay(endExclusive: string): string {
  return addDays(endExclusive, -1);
}

export function usd(minor: number, currency: CurrencyCode = 'USD'): string {
  return format(money(minor, currency));
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

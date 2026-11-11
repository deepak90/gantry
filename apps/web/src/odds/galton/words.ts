/** What the board says, in plain US English: the result's words, its percent, its dates. Pure, so it can be tested. */

const DAY_MS = 86_400_000;

/** The local midnight of a day number (days since 1970-01-01, by the local date). */
export function dateOfDay(day: number): Date {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });
export const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "1,000" */
export const count = (value: number): string => value.toLocaleString('en-US');

/** "Fri, Jun 11" */
export const dayWords = (day: number): string => LONG_DAY.format(dateOfDay(day));

/** The share on time as a whole percent, rounded as the odds panel rounds it (515 of 1,000 is 52). */
export const percentOf = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** "515 of 1,000 finish by Fri, Jun 11": the film's plain words, no "runs". */
export const resultWords = (onTime: number, total: number, contractDay: number): string => `${count(onTime)} of ${count(total)} finish by ${dayWords(contractDay)}`;

/** "Deadline · Fri, Jun 11" */
export const deadlineWords = (contractDay: number): string => `Deadline · ${dayWords(contractDay)}`;

/** "412 of 1,000" */
export const counterWords = (landed: number, total: number): string => `${count(landed)} of ${count(total)}`;

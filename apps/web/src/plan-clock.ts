/**
 * The plan's clock: what "today" and "now" are for the plan's dates. Everything that reads the plan against today
 * asks here: the odds, the Friday pay run in the late-payment forecast, the chart's today line, the 3D view's day,
 * the watch rules, what is due now in the costs, and the fallbacks for a task without dates.
 *
 * The hosted site runs on the film's day, Tue, Nov 10, 2026, so the forecast and the odds there match the film. A
 * local build follows the real clock, unless VITE_PLAN_DATE (YYYY-MM-DD) pins it to a day; VITE_PLAN_DATE also
 * overrides the hosted site's day. The header says when the date is pinned (app/PlanDate.tsx).
 *
 * Pinned, the day is held and the time of day is real: "now" is the pinned day at the hour and minute it is where
 * the person is, so a today line still moves through the day, and at midnight it starts the same day over.
 *
 * Timestamps never come from here: messages, calls and captions, presence, the session's lease, PayPal's records and
 * payment times, the change history, analytics and sign-in all keep the real clock.
 */
import { HOSTED } from './hosted';

/** The day the film was recorded: the hosted site's plan date. */
export const FILM_DAY = '2026-11-10';

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `value` when it is a real calendar day written YYYY-MM-DD, else null. */
export function parsePlanDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = ISO_DAY.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? text : null;
}

/** The day the plan is pinned to: VITE_PLAN_DATE when it is a day, else the film's day on the hosted site; null: the real clock. */
export function pinnedPlanDay(asked: unknown, hosted: boolean): string | null {
  const day = parsePlanDay(asked);
  if (!day && typeof asked === 'string' && asked.trim() !== '') console.warn(`VITE_PLAN_DATE is not a day written YYYY-MM-DD ("${asked}"), so it is left out.`);
  return day ?? (hosted ? FILM_DAY : null);
}

export interface PlanClock {
  /** The pinned day (YYYY-MM-DD), or null when the plan follows the real clock. */
  readonly pinned: string | null;
  /** Now, for the plan: the pinned day at the real time of day, or the real now. */
  now(): Date;
  /** The start of the plan's today (local midnight). */
  today(): Date;
}

/** A clock for the plan: pinned to `pinned` (YYYY-MM-DD) with `realNow`'s time of day, or `realNow` itself. */
export function planClockFor(pinned: string | null, realNow: () => number = () => Date.now()): PlanClock {
  const day = parsePlanDay(pinned);
  if (!day) {
    return {
      pinned: null,
      now: () => new Date(realNow()),
      today: () => {
        const real = new Date(realNow());
        return new Date(real.getFullYear(), real.getMonth(), real.getDate());
      },
    };
  }
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return {
    pinned: day,
    now: () => {
      const real = new Date(realNow());
      return new Date(year, month - 1, date, real.getHours(), real.getMinutes(), real.getSeconds(), real.getMilliseconds());
    },
    today: () => new Date(year, month - 1, date),
  };
}

/**
 * This build's plan clock: `planClock.now()` and `planClock.today()` for the plan's dates, and `planClock.pinned`,
 * the day it is pinned to (null when it follows the real clock). Its functions can be passed around as they are.
 */
export const planClock: PlanClock = planClockFor(pinnedPlanDay(import.meta.env.VITE_PLAN_DATE, HOSTED));

const LABELS = {
  long: new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
  short: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }),
};

/** A day as people read it: "Tue, Nov 10, 2026", or "Nov 10" short. */
export function planDayLabel(day: string, length: keyof typeof LABELS = 'long'): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return LABELS[length].format(new Date(year, month - 1, date));
}

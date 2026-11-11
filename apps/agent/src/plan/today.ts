/**
 * The plan's today on the server. GANTRY_PLAN_DATE pins it, as VITE_PLAN_DATE (and the hosted build) pins it in the
 * browser: the hosted site runs on the film's day, Tue, Nov 10, 2026, so the watch rules and the fact tools count
 * from that day, the app events the model reads carry it, and the system prompt names it (agent/prompts.ts). Pinned,
 * the day is held and the time of day is real. Unpinned, it is the server's own day.
 *
 * Only the plan's sense of today comes from here: when a daily rule runs, how recent a call is, and every time stored
 * or shown (messages, payments, the change history) stay on the real clock.
 */
import { isoDay } from './watch';

/** The plan's today, YYYY-MM-DD: the pinned day, or the day it is now. */
export function planDay(pinned: string | null | undefined, now: Date = new Date()): string {
  return pinned ?? isoDay(now);
}

/** When something happened, as an app event tells the model: the plan's day at the real time (UTC), or the real time. */
export function planStamp(pinned: string | null | undefined, now: Date = new Date()): string {
  const real = now.toISOString();
  return pinned ? `${pinned}${real.slice(10)}` : real;
}

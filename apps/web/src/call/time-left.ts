/**
 * How long the call has left, as the call bar shows it ("4:12 left"). The moment it ends comes from Remy's worker
 * (her `remy.ends_at` attribute, protocol.ts), so every tab counts down to the same moment, whoever joined when. It is
 * read on this tab's clock, corrected by the call server's own when the two are seconds apart (clockOffsetOf).
 */

/** The last stretch, shown in amber: Remy says she has to drop off when it starts. */
export const ENDING_MS = 30_000;
/** Clocks closer than this are taken as agreeing: the gap is the time the join took, not a wrong clock. */
export const CLOCK_TOLERANCE_MS = 2_000;

/** What is left of the call at `now`, never below zero. */
export function msLeft(endsAt: number, now: number): number {
  return Math.max(0, endsAt - now);
}

/** Whole seconds left, rounded up: "5:00 left" at the start, "0:01 left" in the last second. */
const secondsLeft = (ms: number): number => Math.ceil(Math.max(0, ms) / 1000);

/** "4:12 left", "0:09 left", "1:02:03 left". */
export function formatTimeLeft(ms: number): string {
  const total = secondsLeft(ms);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds} left` : `${minutes}:${seconds} left`;
}

/** The same, for a screen reader: "4 minutes 12 seconds left on the call". */
export function spokenTimeLeft(ms: number): string {
  const total = secondsLeft(ms);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts = [minutes > 0 ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : null, seconds > 0 || minutes === 0 ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : null];
  return `${parts.filter(Boolean).join(' ')} left on the call`;
}

/** In the last 30 seconds. */
export const isEnding = (ms: number): boolean => ms <= ENDING_MS;

/**
 * How far the call server's clock is ahead of this tab's, from when the server says this tab joined (`serverMs`) and
 * this tab's own time on hearing it (`localMs`). Within a couple of seconds, 0: that much is the join's own delay, and
 * the clocks are taken as agreeing. A tab whose clock is minutes off still counts down to the worker's moment.
 */
export function clockOffsetOf(serverMs: number, localMs: number, toleranceMs: number = CLOCK_TOLERANCE_MS): number {
  if (!Number.isFinite(serverMs) || serverMs <= 0 || !Number.isFinite(localMs)) return 0;
  const offset = serverMs - localMs;
  return Math.abs(offset) <= toleranceMs ? 0 : offset;
}

/** When the call ends on this tab's clock: the worker's moment less how far the server's clock is ahead. */
export function localEndsAt(serverEndsAt: number | null, offset: number): number | null {
  return serverEndsAt === null ? null : serverEndsAt - offset;
}

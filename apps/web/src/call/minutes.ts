/**
 * Remy's minutes for the session, as the page shows them: one pool a visit, five minutes on the hosted site, shared by
 * everyone on the session and run down only while Remy is on a call. The site keeps them (the database's remy_minutes,
 * through the room route, call-hosted.ts); the page counts them down between its looks, from when it heard them, so a
 * tab whose clock is off still shows the same as everyone else's.
 */
import { ASSISTANT_NAME } from '../assistant/identity';

/** The minutes as the room route answers them. */
export interface RoomMinutes {
  totalMs: number;
  /** Left when the route answered: the rest of the minutes, or, while a call is going, of its share. */
  leftMs: number;
  /** A call with Remy is going: what's left runs down. */
  going: boolean;
}

/** The minutes, and when this tab heard them (its own clock, ms). */
export interface HeardMinutes extends RoomMinutes {
  at: number;
}

/** A call needs this much left to start (the site's MIN_CALL_MS): any less, and the minutes are used up. */
export const MIN_CALL_MS = 15_000;
/** The last stretch, in amber, as on the call bar's clock. */
export const MINUTES_ENDING_MS = 30_000;

/** The room route's `minutes`, when it sent them whole; null otherwise. */
export function roomMinutesOf(value: unknown): RoomMinutes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { totalMs, leftMs, going } = value as Record<string, unknown>;
  const ms = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!ms(totalMs) || !ms(leftMs) || typeof going !== 'boolean' || totalMs <= 0) return null;
  return { totalMs, leftMs: Math.min(leftMs, totalMs), going };
}

/** What's left at `now`: running down from when it was heard while a call is going, still otherwise. */
export function minutesLeftAt(minutes: HeardMinutes, now: number): number {
  return minutes.going ? Math.max(0, minutes.leftMs - Math.max(0, now - minutes.at)) : minutes.leftMs;
}

/** Used up: too little left for a call, and none going. */
export function minutesSpent(minutes: HeardMinutes | null): boolean {
  return minutes !== null && !minutes.going && minutes.leftMs < MIN_CALL_MS;
}

/** How full the orb is: 0 to 1. */
export function fullnessOf(leftMs: number, totalMs: number): number {
  if (!(totalMs > 0)) return 0;
  return Math.min(1, Math.max(0, leftMs / totalMs));
}

/** Whole seconds, rounded up while any time is left: "4:12", "0:09", "0:00". */
export function formatMinutes(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "4 minutes 12 seconds", "1 minute", "9 seconds". */
export function spokenDuration(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts = [minutes > 0 ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : null, seconds > 0 || minutes === 0 ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : null];
  return parts.filter(Boolean).join(' ');
}

/** What the orb's title says: what's left, of how much, who shares it, and when it runs. */
export function minutesTitle(leftMs: number, totalMs: number, going: boolean): string {
  const of = `${ASSISTANT_NAME} minutes for this session: ${formatMinutes(leftMs)} of ${formatMinutes(totalMs)} left.`;
  const how = going ? `They're running down while ${ASSISTANT_NAME} is on the call.` : `They run down only while ${ASSISTANT_NAME} is on a call.`;
  return `${of} Everyone on this session shares them. ${how}`;
}

/** What the header says once they're used up, and its title. */
export const SPENT_TEXT = `No ${ASSISTANT_NAME} minutes left`;
export function spentTitle(totalMs: number): string {
  return `This session's ${spokenDuration(totalMs)} with ${ASSISTANT_NAME} on calls are used up. She's still in the chat, and the rest of the plan works as usual.`;
}

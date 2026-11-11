/**
 * When Remy can't be called now, the call button says why and is greyed, so nobody presses it only to be refused. The
 * room route says so before anyone presses (its `blocked`: blockHold), and the token route's refusal says the same if
 * the two cross (holdOf). How long it holds depends on why:
 *
 * - `calls_paused`: the site's daily limit is reached (its calls, joins, Remy's turns or its spend), until it resets:
 *   midnight UTC, or 00:05 UTC when the spend breaker turned calls off ("Calls paused until 4:00 PM").
 * - `remy_busy` (409): she is on as many calls as she takes; a few minutes ("Remy is on other calls").
 * - `allowance_spent`: this session's calls with her are used up; for the rest of the visit ("No more calls this session").
 * - `minutes_spent`: this session's minutes with her are used up (minutes.ts); for the rest of the visit, and the
 *   header puts the call button away.
 * - `calls_off`: calls are switched off on the site; a few minutes, then a press asks again ("Calls are off right now").
 *
 * Any other refusal (not on the project, a tab that lost its sign-in) is not a hold: the call bar shows it as before.
 * The hold never suggests a way around it (a new session, say): the limits are what keeps the site open for everyone.
 */
import { ASSISTANT_NAME } from '../assistant/identity';
import { SPENT_TEXT, spentTitle } from './minutes';

export type RefusalCode = 'remy_busy' | 'allowance_spent' | 'minutes_spent' | 'calls_off' | 'calls_paused';

export interface Refusal {
  status: number;
  /** The server's reason, when it gave one. */
  code: string | null;
  /** The server's own words. */
  message: string;
  /** When it was refused (ms). */
  at: number;
  /** When a pause lifts (ms), when the server said. */
  until?: number | null;
}

export interface CallHold {
  code: RefusalCode;
  /** What the button says. */
  text: string;
  /** Why, in plain words, and what still works. */
  title: string;
  /** Until when (ms); Infinity for the rest of the visit on this page. */
  until: number;
}

/** Why a call can't be had now, as the room route says it before anyone presses (call-hosted.ts: CallBlock). */
export interface RoomBlock {
  why: 'paused' | 'session' | 'busy' | 'off';
  /** Which limit: calls, joins, turns, starts, spend or remy. */
  what: string;
  /** When a pause lifts (ms); null when nobody can say. */
  until: number | null;
}

/** What Remy's seat says while held, on the call bar, where there is room for no more. */
export const UNAVAILABLE = `${ASSISTANT_NAME} is unavailable`;

const MINUTE = 60_000;
/** How long each kind of refusal holds the button, when the server didn't say. */
export const HOLD_MS: Readonly<Record<RefusalCode, number>> = {
  remy_busy: 3 * MINUTE,
  allowance_spent: Infinity,
  minutes_spent: Infinity,
  calls_off: 5 * MINUTE,
  calls_paused: 30 * MINUTE,
};

const STILL = `She's still in the chat, and the rest of the plan works as usual.`;
const WHY: Readonly<Record<RefusalCode, string>> = {
  remy_busy: `${ASSISTANT_NAME} is on as many calls as she can take. Try again in a few minutes. ${STILL}`,
  allowance_spent: `This session's calls with ${ASSISTANT_NAME} are used up. ${STILL}`,
  minutes_spent: `This session's minutes with ${ASSISTANT_NAME} on calls are used up. ${STILL}`,
  calls_off: `Calls are switched off on the site for now. ${STILL}`,
  calls_paused: `Calls with ${ASSISTANT_NAME} are paused on the site until its daily limit resets. ${STILL}`,
};

/** What the button says for each (the header is narrow). */
const TEXT: Readonly<Record<'remy_busy' | 'allowance_spent' | 'calls_off', string>> = {
  remy_busy: `${ASSISTANT_NAME} is on other calls`,
  allowance_spent: 'No more calls this session',
  calls_off: 'Calls are off right now',
};

/** Why she can't come, in plain words, with what still works (the call bar's notice says it under its title). */
export const holdReason = (code: RefusalCode): string => WHY[code];

/** "4:00 PM", where the person is, and "4:00 PM tomorrow" when it isn't today there. */
export function untilWords(until: number, now: number): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date(now).toDateString() ? time : `${time} tomorrow`;
}

/** The site's day is used up: "Calls paused until 4:00 PM". */
function pausedHold(until: number | null, now: number): CallHold {
  if (until === null) return { code: 'calls_paused', text: 'Calls paused for today', title: WHY.calls_paused, until: now + HOLD_MS.calls_paused };
  const when = untilWords(until, now);
  return { code: 'calls_paused', text: `Calls paused until ${when}`, title: `Calls with ${ASSISTANT_NAME} are paused on the site until ${when}, when its daily limit resets. ${STILL}`, until };
}

/** The reason a refusal gives; a 409 without one is Remy being busy (an older server's answer). */
export function refusalCode(refusal: Pick<Refusal, 'status' | 'code'>): RefusalCode | null {
  const { code } = refusal;
  if (code === 'remy_busy' || code === 'allowance_spent' || code === 'minutes_spent' || code === 'calls_off' || code === 'calls_paused') return code;
  return refusal.status === 409 ? 'remy_busy' : null;
}

/** The hold a refusal puts on the call button at `now`, or null when there is none (or it is over). */
export function holdOf(refusal: Refusal | null, now: number): CallHold | null {
  if (!refusal) return null;
  const code = refusalCode(refusal);
  if (!code) return null;
  if (code === 'calls_paused') {
    const until = typeof refusal.until === 'number' && Number.isFinite(refusal.until) ? refusal.until : refusal.at + HOLD_MS.calls_paused;
    return now >= until ? null : pausedHold(until, now);
  }
  const until = refusal.at + HOLD_MS[code];
  if (now >= until) return null;
  if (code === 'minutes_spent') return { code, text: SPENT_TEXT, title: WHY[code], until };
  return { code, text: TEXT[code], title: WHY[code], until };
}

/** The hold the room route's word puts on the button before anyone presses: as long as it says so. */
export function blockHold(block: RoomBlock, now: number): CallHold {
  switch (block.why) {
    case 'paused':
      return pausedHold(block.until, now);
    case 'session':
      return {
        code: 'allowance_spent',
        text: TEXT.allowance_spent,
        title: block.what === 'turns' ? `${ASSISTANT_NAME} has answered as much as one session gets. ${STILL}` : WHY.allowance_spent,
        until: Infinity,
      };
    case 'busy':
      return { code: 'remy_busy', text: TEXT.remy_busy, title: WHY.remy_busy, until: Infinity };
    case 'off':
      return { code: 'calls_off', text: TEXT.calls_off, title: WHY.calls_off, until: Infinity };
  }
}

/** The room route's `blocked`, when it sent one whole; null otherwise. */
export function roomBlockOf(value: unknown): RoomBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { why, what, until } = value as Record<string, unknown>;
  if (why !== 'paused' && why !== 'session' && why !== 'busy' && why !== 'off') return null;
  return { why, what: typeof what === 'string' ? what : '', until: typeof until === 'number' && Number.isFinite(until) ? until : null };
}

/** The hold the session's used-up minutes put on the button, as the room route reports them (minutes.ts). */
export function minutesHold(totalMs: number): CallHold {
  return { code: 'minutes_spent', text: SPENT_TEXT, title: spentTitle(totalMs), until: Infinity };
}

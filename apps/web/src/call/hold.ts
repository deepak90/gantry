/**
 * After the server refuses to bring Remy into a call, the call button says so and stays put for a while, so nobody
 * presses it again and again: "Remy is unavailable right now", with why in plain words. How long depends on why:
 *
 * - `remy_busy` (409): she is on as many calls as she takes; a few minutes.
 * - `allowance_spent`: this session's calls with her are used up; for the rest of the visit on this page.
 * - `minutes_spent`: this session's minutes with her are used up (minutes.ts); for the rest of the visit, and the
 *   header puts the call button away.
 * - `calls_off`: calls are switched off on the site; a few minutes, then a press asks again.
 *
 * Any other refusal (not on the project, a tab that lost its sign-in) is not a hold: the call bar shows it as before.
 * The hold never suggests a way around it (a new session, say): the limits are what keeps the site open for everyone.
 */
import { ASSISTANT_NAME } from '../assistant/identity';
import { SPENT_TEXT, spentTitle } from './minutes';

export type RefusalCode = 'remy_busy' | 'allowance_spent' | 'minutes_spent' | 'calls_off';

export interface Refusal {
  status: number;
  /** The server's reason, when it gave one. */
  code: string | null;
  /** The server's own words. */
  message: string;
  /** When it was refused (ms). */
  at: number;
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

/** What the button says while held (the header is narrow); its title starts with the whole sentence. */
export const UNAVAILABLE = `${ASSISTANT_NAME} is unavailable`;

const MINUTE = 60_000;
/** How long each kind of refusal holds the button. */
export const HOLD_MS: Readonly<Record<RefusalCode, number>> = { remy_busy: 3 * MINUTE, allowance_spent: Infinity, minutes_spent: Infinity, calls_off: 5 * MINUTE };

const STILL = `She's still in the chat, and the rest of the plan works as usual.`;
const WHY: Readonly<Record<RefusalCode, string>> = {
  remy_busy: `${ASSISTANT_NAME} is on as many calls as she can take. Try again in a few minutes. ${STILL}`,
  allowance_spent: `This session's calls with ${ASSISTANT_NAME} are used up. ${STILL}`,
  minutes_spent: `This session's minutes with ${ASSISTANT_NAME} on calls are used up. ${STILL}`,
  calls_off: `Calls are switched off on the site for now. ${STILL}`,
};

/** Why she can't come, in plain words, with what still works (the call bar's notice says it under its title). */
export const holdReason = (code: RefusalCode): string => WHY[code];

/** The reason a refusal gives; a 409 without one is Remy being busy (an older server's answer). */
export function refusalCode(refusal: Pick<Refusal, 'status' | 'code'>): RefusalCode | null {
  if (refusal.code === 'remy_busy' || refusal.code === 'allowance_spent' || refusal.code === 'minutes_spent' || refusal.code === 'calls_off') return refusal.code;
  return refusal.status === 409 ? 'remy_busy' : null;
}

/** The hold a refusal puts on the call button at `now`, or null when there is none (or it is over). */
export function holdOf(refusal: Refusal | null, now: number): CallHold | null {
  if (!refusal) return null;
  const code = refusalCode(refusal);
  if (!code) return null;
  const until = refusal.at + HOLD_MS[code];
  if (now >= until) return null;
  if (code === 'minutes_spent') return { code, text: SPENT_TEXT, title: WHY[code], until };
  return { code, text: UNAVAILABLE, title: `${UNAVAILABLE} right now. ${WHY[code]}`, until };
}

/** The hold the session's used-up minutes put on the button, as the room route reports them (minutes.ts). */
export function minutesHold(totalMs: number): CallHold {
  return { code: 'minutes_spent', text: SPENT_TEXT, title: spentTitle(totalMs), until: Infinity };
}

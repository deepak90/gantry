/**
 * On the hosted site a call is for the tab in front. A tab left in the background for ten seconds leaves its call, and
 * so does one sent there a third time on the same call: a call nobody is watching shouldn't run down the session's
 * minutes with Remy. Coming back within the ten seconds keeps the call. Another of the session's tabs in front in the
 * same browser (a teammate's, opened from Invite, as Remy suggests for a second approval) counts as someone there: no
 * strike, no countdown, until it isn't (tabs.ts). CallLayer watches while the tab is on a call.
 */

/** In the background this long, the tab leaves the call. */
export const AWAY_LEAVE_MS = 10_000;
/** The time the tab goes to the background on one call that leaves it at once. */
export const AWAY_STRIKES = 3;
/** How long after going to the background the tab looks whether another of the session's tabs came to the front. */
export const AWAY_SETTLE_MS = 600;
/** How often it looks again while another of them is in front. */
export const AWAY_RECHECK_MS = 1_000;

/** Why the tab left: in the background too long, or sent there too often. */
export type AwayReason = 'background' | 'often';

/** The part of `document` this reads. */
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Watches the tab while it's on a call, and calls `leave` once, with why, when it must go. A tab already in the
 * background when the watch starts counts as sent there. Returns the stop.
 */
export function watchAway(
  page: Visibility,
  leave: (why: AwayReason) => void,
  {
    leaveMs = AWAY_LEAVE_MS,
    strikes = AWAY_STRIKES,
    settleMs = AWAY_SETTLE_MS,
    recheckMs = AWAY_RECHECK_MS,
    watchedElsewhere = () => false,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }: {
    leaveMs?: number;
    strikes?: number;
    settleMs?: number;
    recheckMs?: number;
    /** Another of the session's tabs is in front, in this browser (tabs.ts). */
    watchedElsewhere?: () => boolean;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  } = {},
): () => void {
  let times = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let checking: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const go = (why: AwayReason) => {
    if (done) return;
    done = true;
    stop();
    leave(why);
  };
  // Nobody is watching: a strike, and the countdown.
  const away = () => {
    times += 1;
    if (times >= strikes) {
      go('often');
      return;
    }
    if (timer === null) timer = setTimer(() => go('background'), leaveMs);
  };
  const check = () => {
    checking = null;
    if (done || !page.hidden) return;
    if (watchedElsewhere()) checking = setTimer(check, recheckMs);
    else away();
  };
  const look = () => {
    if (done) return;
    if (checking !== null) clearTimer(checking);
    checking = null;
    if (!page.hidden) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      return;
    }
    // A moment for the tab that came to the front to say so.
    checking = setTimer(check, settleMs);
  };
  const stop = () => {
    page.removeEventListener('visibilitychange', look);
    for (const pending of [timer, checking]) if (pending !== null) clearTimer(pending);
    timer = checking = null;
  };
  page.addEventListener('visibilitychange', look);
  if (page.hidden) look();
  return () => {
    done = true;
    stop();
  };
}

/** What the header says after the tab left its call, and its title. */
export function awayNote(why: AwayReason): { text: string; title: string } {
  return {
    text: 'You left the call',
    title:
      why === 'often'
        ? 'You left the call: this tab went to the background three times. On this site a call is for the tab in front, so the session’s minutes with Remy only run while someone is there.'
        : 'You left the call: this tab was in the background for 10 seconds. On this site a call is for the tab in front, so the session’s minutes with Remy only run while someone is there.',
  };
}

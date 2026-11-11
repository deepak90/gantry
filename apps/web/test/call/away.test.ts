// @vitest-environment node
/**
 * A call is for the tab in front (call/away.ts): ten seconds in the background, or the third time it goes there on one
 * call, and the tab leaves the call; coming back in time keeps it. Another of the session's tabs in front in the same
 * browser (a teammate's, opened from Invite) counts as someone there (call/tabs.ts). Nothing fires after the watch stops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_LEAVE_MS, AWAY_RECHECK_MS, AWAY_SETTLE_MS, awayNote, watchAway, type Visibility } from '../../src/call/away';
import { TAB_FRESH_MS, TAB_HEARTBEAT_MS, watchTabs, type TabChannel, type TabWord } from '../../src/call/tabs';

function page(hidden = false) {
  const listeners = new Set<() => void>();
  const state = { hidden };
  const target: Visibility = {
    get hidden() {
      return state.hidden;
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const set = (value: boolean) => {
    state.hidden = value;
    for (const listener of [...listeners]) listener();
  };
  return { target, hide: () => set(true), show: () => set(false), listeners };
}

/** Sent to the background, and counted once the moment for another tab to speak up has passed. */
const awayFor = (tab: ReturnType<typeof page>) => {
  tab.hide();
  vi.advanceTimersByTime(AWAY_SETTLE_MS);
};

describe('a call is for the tab in front', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves the call after ten seconds in the background', () => {
    const tab = page();
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    awayFor(tab);
    vi.advanceTimersByTime(AWAY_LEAVE_MS - 1);
    expect(left).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(left).toEqual(['background']);
    // Once, and the watch is done.
    tab.show();
    awayFor(tab);
    vi.advanceTimersByTime(60_000);
    expect(left).toEqual(['background']);
    expect(tab.listeners.size).toBe(0);
  });

  it('keeps the call when the tab comes back in time', () => {
    const tab = page();
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    awayFor(tab);
    vi.advanceTimersByTime(9_000);
    tab.show();
    vi.advanceTimersByTime(60_000);
    expect(left).toEqual([]);
  });

  it('leaves at once the third time the tab goes to the background on the call', () => {
    const tab = page();
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    awayFor(tab);
    tab.show();
    awayFor(tab);
    tab.show();
    expect(left).toEqual([]);
    awayFor(tab);
    expect(left).toEqual(['often']);
  });

  it('counts a tab already in the background when the watch starts', () => {
    const tab = page(true);
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    vi.advanceTimersByTime(AWAY_SETTLE_MS + AWAY_LEAVE_MS);
    expect(left).toEqual(['background']);
  });

  it('keeps the call while a teammate’s tab is in front, with no strikes, until nobody is', () => {
    const tab = page();
    const left: string[] = [];
    let teammate = true;
    watchAway(tab.target, (why) => left.push(why), { watchedElsewhere: () => teammate });
    // Back and forth between the two people for a payment's approvals: never away.
    for (let round = 0; round < 5; round++) {
      awayFor(tab);
      vi.advanceTimersByTime(30_000);
      tab.show();
    }
    expect(left).toEqual([]);
    // The teammate's tab closes while this one is behind: from then on, the usual ten seconds.
    awayFor(tab);
    teammate = false;
    vi.advanceTimersByTime(AWAY_RECHECK_MS + AWAY_LEAVE_MS - 1);
    expect(left).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(left).toEqual(['background']);
  });

  it('does nothing once stopped', () => {
    const tab = page();
    const left: string[] = [];
    const stop = watchAway(tab.target, (why) => left.push(why));
    tab.hide();
    stop();
    vi.advanceTimersByTime(60_000);
    tab.show();
    tab.hide();
    tab.show();
    tab.hide();
    vi.advanceTimersByTime(60_000);
    expect(left).toEqual([]);
    expect(tab.listeners.size).toBe(0);
  });

  it('says why the tab left', () => {
    expect(awayNote('background')).toMatchObject({ text: 'You left the call', title: expect.stringMatching(/background for 10 seconds/) });
    expect(awayNote('often').title).toMatch(/three times/);
  });
});

describe('the session’s other tabs in this browser', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Channels that hear each other, as BroadcastChannel does across tabs (never their own words). */
  function channels() {
    const all: { listeners: ((event: { data: unknown }) => void)[]; closed: boolean }[] = [];
    const make = (): TabChannel => {
      const me = { listeners: [] as ((event: { data: unknown }) => void)[], closed: false };
      all.push(me);
      return {
        postMessage: (word: TabWord) => {
          for (const other of all) if (other !== me && !other.closed) other.listeners.forEach((listener) => listener({ data: word }));
        },
        addEventListener: (_type, listener) => me.listeners.push(listener),
        close: () => {
          me.closed = true;
        },
      };
    };
    return { make };
  }

  it('hears a tab in front, and stops counting it once it goes behind, goes quiet, or closes', () => {
    const net = channels();
    const caller = page();
    const teammate = page(true);
    const mine = watchTabs('p', { page: caller.target, channel: net.make(), tab: 'caller' });
    const theirs = watchTabs('p', { page: teammate.target, channel: net.make(), tab: 'teammate' });
    expect(mine.othersInFront()).toBe(false);
    teammate.show();
    caller.hide();
    expect(mine.othersInFront()).toBe(true);
    // It says so every two seconds while in front.
    vi.advanceTimersByTime(TAB_FRESH_MS + TAB_HEARTBEAT_MS);
    expect(mine.othersInFront()).toBe(true);
    teammate.hide();
    expect(mine.othersInFront()).toBe(false);
    teammate.show();
    expect(mine.othersInFront()).toBe(true);
    theirs.stop();
    expect(mine.othersInFront()).toBe(false);
    mine.stop();
  });

  it('hears nobody without a channel', () => {
    expect(watchTabs('p', { page: page().target, channel: null }).othersInFront()).toBe(false);
  });
});

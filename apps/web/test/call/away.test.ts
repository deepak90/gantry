// @vitest-environment node
/**
 * A call is for the tab in front (call/away.ts): ten seconds in the background, or the third time it goes there on one
 * call, and the tab leaves the call; coming back in time keeps it. Nothing fires after the watch stops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAY_LEAVE_MS, awayNote, watchAway, type Visibility } from '../../src/call/away';

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

describe('a call is for the tab in front', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves the call after ten seconds in the background', () => {
    const tab = page();
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    tab.hide();
    vi.advanceTimersByTime(AWAY_LEAVE_MS - 1);
    expect(left).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(left).toEqual(['background']);
    // Once, and the watch is done.
    tab.show();
    tab.hide();
    vi.advanceTimersByTime(60_000);
    expect(left).toEqual(['background']);
    expect(tab.listeners.size).toBe(0);
  });

  it('keeps the call when the tab comes back in time', () => {
    const tab = page();
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    tab.hide();
    vi.advanceTimersByTime(9_000);
    tab.show();
    vi.advanceTimersByTime(60_000);
    expect(left).toEqual([]);
  });

  it('leaves at once the third time the tab goes to the background on the call', () => {
    const tab = page();
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    tab.hide();
    tab.show();
    tab.hide();
    tab.show();
    expect(left).toEqual([]);
    tab.hide();
    expect(left).toEqual(['often']);
  });

  it('counts a tab already in the background when the watch starts', () => {
    const tab = page(true);
    const left: string[] = [];
    watchAway(tab.target, (why) => left.push(why));
    vi.advanceTimersByTime(AWAY_LEAVE_MS);
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
    expect(left).toEqual([]);
    expect(tab.listeners.size).toBe(0);
  });

  it('says why the tab left', () => {
    expect(awayNote('background')).toMatchObject({ text: 'You left the call', title: expect.stringMatching(/background for 10 seconds/) });
    expect(awayNote('often').title).toMatch(/three times/);
  });
});

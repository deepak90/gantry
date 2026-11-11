// @vitest-environment node
/**
 * Remy's minutes as the page shows them (call/minutes.ts): read from the room route, run down from when they were heard
 * while a call is going, used up under fifteen seconds with no call going, and said in minutes and seconds.
 */
import { describe, expect, it } from 'vitest';
import { formatMinutes, fullnessOf, minutesLeftAt, minutesSpent, minutesTitle, MIN_CALL_MS, roomMinutesOf, spentTitle, spokenDuration, type HeardMinutes } from '../../src/call/minutes';

const heard = (leftMs: number, going: boolean, at = 1_000_000, totalMs = 300_000): HeardMinutes => ({ totalMs, leftMs, going, at });

describe('the room route’s minutes', () => {
  it('are read when whole, and nothing otherwise', () => {
    expect(roomMinutesOf({ totalMs: 300_000, leftMs: 120_000, going: true })).toEqual({ totalMs: 300_000, leftMs: 120_000, going: true });
    expect(roomMinutesOf({ totalMs: 300_000, leftMs: 400_000, going: false })).toEqual({ totalMs: 300_000, leftMs: 300_000, going: false });
    for (const odd of [null, undefined, [], 'five', { totalMs: 300_000, leftMs: 1 }, { totalMs: 0, leftMs: 0, going: false }, { totalMs: 300_000, leftMs: -1, going: false }, { totalMs: '300000', leftMs: 1, going: false }]) {
      expect(roomMinutesOf(odd)).toBeNull();
    }
  });
});

describe('what is left', () => {
  it('runs down from when it was heard while a call is going, and stays put otherwise', () => {
    expect(minutesLeftAt(heard(120_000, true), 1_000_000 + 30_000)).toBe(90_000);
    expect(minutesLeftAt(heard(120_000, true), 1_000_000 + 500_000)).toBe(0);
    expect(minutesLeftAt(heard(120_000, false), 1_000_000 + 30_000)).toBe(120_000);
    // A clock that went back never adds time.
    expect(minutesLeftAt(heard(120_000, true), 900_000)).toBe(120_000);
  });

  it('is used up under fifteen seconds with no call going, and never while one is', () => {
    expect(minutesSpent(heard(MIN_CALL_MS - 1, false))).toBe(true);
    expect(minutesSpent(heard(0, false))).toBe(true);
    expect(minutesSpent(heard(MIN_CALL_MS, false))).toBe(false);
    expect(minutesSpent(heard(0, true))).toBe(false);
    expect(minutesSpent(null)).toBe(false);
  });

  it('fills the orb by what is left of the whole', () => {
    expect(fullnessOf(150_000, 300_000)).toBe(0.5);
    expect(fullnessOf(400_000, 300_000)).toBe(1);
    expect(fullnessOf(-1, 300_000)).toBe(0);
    expect(fullnessOf(10, 0)).toBe(0);
  });
});

describe('the words', () => {
  it('shows minutes and seconds, rounded up while any time is left', () => {
    expect(formatMinutes(300_000)).toBe('5:00');
    expect(formatMinutes(252_400)).toBe('4:13');
    expect(formatMinutes(9_000)).toBe('0:09');
    expect(formatMinutes(1)).toBe('0:01');
    expect(formatMinutes(0)).toBe('0:00');
    expect(formatMinutes(-5)).toBe('0:00');
  });

  it('says them in words', () => {
    expect(spokenDuration(300_000)).toBe('5 minutes');
    expect(spokenDuration(61_000)).toBe('1 minute 1 second');
    expect(spokenDuration(9_000)).toBe('9 seconds');
    expect(spokenDuration(0)).toBe('0 seconds');
  });

  it('says what is left, who shares it and when it runs', () => {
    expect(minutesTitle(252_000, 300_000, false)).toBe('Remy minutes for this session: 4:12 of 5:00 left. Everyone on this session shares them. They run down only while Remy is on a call.');
    expect(minutesTitle(252_000, 300_000, true)).toMatch(/running down while Remy is on the call\.$/);
    expect(spentTitle(300_000)).toBe("This session's 5 minutes with Remy on calls are used up. She's still in the chat, and the rest of the plan works as usual.");
  });
});

/**
 * The plan's clock (src/plan-clock.ts): the hosted site pins the plan to the film's day, Tue, Nov 10, 2026, a local
 * build follows the real clock unless VITE_PLAN_DATE names a day, and a pinned clock keeps the real time of day.
 */
import { describe, expect, it, vi } from 'vitest';
import { FILM_DAY, parsePlanDay, pinnedPlanDay, planClockFor, planDayLabel } from '../src/plan-clock';

/** Wed, Dec 9, 2026, 3:42:10.500 PM where the test runs: a visit a month after the film. */
const DECEMBER = new Date(2026, 11, 9, 15, 42, 10, 500).getTime();

describe('the plan date a build is pinned to', () => {
  it('is the film’s day on the hosted site, and the real clock on a local build', () => {
    expect(FILM_DAY).toBe('2026-11-10');
    expect(pinnedPlanDay(undefined, true)).toBe('2026-11-10');
    expect(pinnedPlanDay('', true)).toBe('2026-11-10');
    expect(pinnedPlanDay(undefined, false)).toBeNull();
    expect(pinnedPlanDay('  ', false)).toBeNull();
  });

  it('is VITE_PLAN_DATE when it names a day, on a local build or the hosted one', () => {
    expect(pinnedPlanDay('2026-11-10', false)).toBe('2026-11-10');
    expect(pinnedPlanDay(' 2026-11-03 ', false)).toBe('2026-11-03');
    expect(pinnedPlanDay('2026-12-01', true)).toBe('2026-12-01');
  });

  it('leaves out a VITE_PLAN_DATE that is not a day, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(pinnedPlanDay('Nov 10', false)).toBeNull();
    expect(pinnedPlanDay('2026-02-30', true)).toBe('2026-11-10');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('VITE_PLAN_DATE');
    warn.mockRestore();
  });

  it('reads only real days written YYYY-MM-DD', () => {
    expect(parsePlanDay('2026-11-10')).toBe('2026-11-10');
    expect(parsePlanDay('2028-02-29')).toBe('2028-02-29');
    for (const value of ['2026-02-29', '2026-13-01', '2026-1-5', '20261110', 'today', '', null, undefined, 20261110]) expect(parsePlanDay(value)).toBeNull();
  });
});

describe('a pinned plan clock', () => {
  const clock = planClockFor('2026-11-10', () => DECEMBER);

  it('holds the day and keeps the real time of day, so a today line still moves through it', () => {
    expect(clock.pinned).toBe('2026-11-10');
    expect(clock.now()).toEqual(new Date(2026, 10, 10, 15, 42, 10, 500));
    expect(clock.today()).toEqual(new Date(2026, 10, 10));
  });

  it('starts the same day over at midnight', () => {
    let real = new Date(2026, 11, 9, 23, 59, 30).getTime();
    const moving = planClockFor('2026-11-10', () => real);
    expect(moving.now()).toEqual(new Date(2026, 10, 10, 23, 59, 30));
    real = new Date(2026, 11, 10, 0, 0, 30).getTime();
    expect(moving.now()).toEqual(new Date(2026, 10, 10, 0, 0, 30));
    expect(moving.today()).toEqual(new Date(2026, 10, 10));
  });

  it('follows the real clock when nothing is pinned', () => {
    const real = planClockFor(null, () => DECEMBER);
    expect(real.pinned).toBeNull();
    expect(real.now().getTime()).toBe(DECEMBER);
    expect(real.today()).toEqual(new Date(2026, 11, 9));
  });

  it('reads the real clock each time it is asked', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: DECEMBER });
    try {
      expect(planClockFor('2026-11-10').now()).toEqual(new Date(2026, 10, 10, 15, 42, 10, 500));
      vi.setSystemTime(new Date(2026, 11, 14, 9, 5));
      expect(planClockFor('2026-11-10').now()).toEqual(new Date(2026, 10, 10, 9, 5));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the plan date as people read it', () => {
  it('is the day in full, or short', () => {
    expect(planDayLabel('2026-11-10')).toBe('Tue, Nov 10, 2026');
    expect(planDayLabel('2026-11-10', 'short')).toBe('Nov 10');
  });
});

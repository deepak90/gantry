/**
 * The crane's rental told day by day, as the site view plays it, and what new dates saved: Harbor's tower crane, on
 * rent Wed, Nov 25 to Sun, Dec 13 at $600 a day for the steel, Mon, Nov 30 to Fri, Dec 11, the weekend between paid.
 */
import { describe, expect, it } from 'vitest';
import type { DayKind, DayTile } from '../../src/gantt/fx3d/day-track';
import { daysOnRent, momentWords, rentalChange, rentalMoment, rentalSummary, savedWords, spendWords } from '../../src/gantt/fx3d/rental-story';

const RATE = 60_000;
const at = (month: number, day: number): number => new Date(2026, month - 1, day).getTime();
const money = (minor: number): string => `$${(minor / 100).toLocaleString('en-US')}`;

/** Every day the calendar shows from Mon, Nov 23 to Mon, Dec 14, as the plan has them, on rent from `first` to `last`. */
function crane(first: number, last: number, cover = false): DayTile[] {
  const tiles: DayTile[] = [];
  for (let day = new Date(2026, 10, 23); day <= new Date(2026, 11, 14); day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const time = day.getTime();
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const inWork = time >= at(11, 30) && time <= at(12, 11);
    const onRent = time >= first && time <= last;
    const kind: DayKind = inWork && !weekend ? 'work' : !onRent ? 'off' : inWork ? 'paid' : cover ? 'cover' : 'idle';
    tiles.push({ at: time, kind, costMinor: kind === 'work' || kind === 'off' ? 0 : RATE });
  }
  return tiles;
}

const asBooked = () => crane(at(11, 25), at(12, 13));

describe('a rental, day by day', () => {
  it('counts its days on rent and how they are spent', () => {
    const summary = rentalSummary(asBooked(), RATE)!;
    expect(summary).toMatchObject({ first: at(11, 25), last: at(12, 13), days: 19, idle: 7, work: 10, off: 2, cover: 0 });
    expect(summary.idleCostMinor).toBe(420_000);
    expect(summary.costMinor).toBe(1_140_000);
    expect(spendWords(summary, money)).toBe('7 idle days · $4,200');
    // Someone who may not see money sees the days alone.
    expect(spendWords(rentalSummary(asBooked(), 0)!, null)).toBe('7 idle days');
  });

  it('numbers the days on rent, leaving out the days around them', () => {
    const days = daysOnRent(asBooked());
    expect(days).toHaveLength(19);
    expect(days[0]).toMatchObject({ at: at(11, 25), kind: 'idle', n: 1 });
    expect(days[5]).toMatchObject({ at: at(11, 30), kind: 'work', n: 6 });
    expect(days[18]).toMatchObject({ at: at(12, 13), kind: 'idle', n: 19 });
  });

  it('says where each date of the play falls: idle before the steel, lifting during it, idle after', () => {
    const days = daysOnRent(asBooked());
    const noon = (month: number, day: number) => at(month, day) + 12 * 3_600_000;
    expect(rentalMoment(days, noon(11, 24)).day).toBeNull();
    const first = rentalMoment(days, noon(11, 25));
    expect(first).toMatchObject({ of: 19, idleSoFar: 1, idle: 7 });
    expect(momentWords(first, 'Tower crane')).toEqual({ badge: 'Idle', kind: 'idle', text: 'Nothing to lift · day 1 of 19 on rent' });
    const steel = rentalMoment(days, noon(11, 30));
    expect(steel.idleSoFar).toBe(5);
    expect(momentWords(steel, 'Tower crane')).toEqual({ badge: 'Working', kind: 'work', text: 'The tower crane lifting · day 6 of 19 on rent' });
    expect(momentWords(rentalMoment(days, noon(12, 5)), 'Tower crane')).toMatchObject({ badge: 'Crew off', kind: 'paid' });
    const last = rentalMoment(days, noon(12, 13));
    expect(last).toMatchObject({ idleSoFar: 7 });
    expect(momentWords(last, 'Tower crane')?.text).toBe('Nothing to lift · day 19 of 19 on rent');
    expect(rentalMoment(days, noon(12, 14)).day).toBeNull();
  });
});

describe('what new dates saved', () => {
  it('a day of cover either side: Sun, Nov 29 to Sat, Dec 12, five days fewer, $3,000', () => {
    const change = rentalChange(asBooked(), crane(at(11, 29), at(12, 12), true), RATE)!;
    expect(change.before).toMatchObject({ days: 19, idle: 7 });
    expect(change.after).toMatchObject({ first: at(11, 29), last: at(12, 12), days: 14, idle: 0, cover: 2 });
    expect(change.fewerDays).toBe(5);
    expect(change.savedMinor).toBe(300_000);
    expect(savedWords(change, money)).toBe('$3,000 saved');
    expect(spendWords(change.after, money)).toBe('2 days of cover, no idle days');
  });

  it('a working day of cover either side: Fri, Nov 27 to Mon, Dec 14, one day fewer, $600', () => {
    const change = rentalChange(asBooked(), crane(at(11, 27), at(12, 14), true), RATE)!;
    expect(change.after).toMatchObject({ days: 18, cover: 6, idle: 0 });
    expect(change.savedMinor).toBe(60_000);
    expect(savedWords(change, money)).toBe('$600 saved');
  });

  it('just the days of the work: seven days fewer, $4,200', () => {
    const change = rentalChange(asBooked(), crane(at(11, 30), at(12, 11)), RATE)!;
    expect(change.after).toMatchObject({ days: 12, idle: 0, cover: 0 });
    expect(change.savedMinor).toBe(420_000);
    expect(spendWords(change.after, money)).toBe('On rent only for its work');
  });

  it('says what a longer rental costs, nothing for one that did not change, and no money to who may not see it', () => {
    const longer = rentalChange(crane(at(11, 29), at(12, 12), true), asBooked(), RATE)!;
    expect(longer.savedMinor).toBe(-300_000);
    expect(savedWords(longer, money)).toBe('$3,000 more');
    expect(rentalChange(asBooked(), asBooked(), RATE)).toBeNull();
    const unseen = rentalChange(asBooked(), crane(at(11, 29), at(12, 12), true), 0)!;
    expect(unseen.savedMinor).toBe(0);
    expect(savedWords(unseen, money)).toBeNull();
  });
});

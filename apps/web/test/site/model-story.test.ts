/**
 * The hero model's story (src/site/landing/model-story.ts), against Harbor's plan as the engine dates it
 * (src/site/media/harbor-plan.json): what date is on show when, the order of the beats, the strip's rows, and the pace
 * the date runs at where the model needs it slow.
 */
import { describe, expect, it } from 'vitest';
import { builtBy } from '../../src/gantt/fx3d/building-plan';
import rows from '../../src/site/media/harbor-plan.json';
import { type HarborPlanRow, midnightOf, planTasks } from '../../src/site/landing/harbor';
import {
  BEATS,
  CLOSING_DAYS,
  dayName,
  dayStart,
  daysAt,
  machineClock,
  monotone,
  monthTicks,
  OPENING_DAY,
  orbitAt,
  paceAt,
  payBeat,
  rowProgress,
  RUN_KEYS,
  storyDate,
  stripRows,
  stripSpan,
} from '../../src/site/landing/model-story';

const tasks = planTasks(rows as unknown as HarborPlanRow[]);
const task = (name: string) => tasks.find((each) => each.name === name)!;
const strip = stripRows(tasks);
const row = (key: string) => strip.find((each) => each.key === key)!;
const moments = (from: number, to: number, step = 0.01) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, index) => from + index * step);

describe('the hero’s Harbor plan', () => {
  it('is every row of the plan, its days as local midnights', () => {
    expect(tasks).toHaveLength(rows.length);
    const steel = task('Erect steel and metal deck');
    expect(steel.start).toBe(new Date(2026, 11, 2).getTime());
    expect(steel.end).toBe(new Date(2026, 11, 17).getTime());
    expect(steel.workDays).toHaveLength(11);
    expect(steel.machine).toMatchObject({ kind: 'crane', booked: [midnightOf('2026-11-25'), midnightOf('2026-12-24')] });
    expect(task('Handover to tenant')).toMatchObject({ milestone: true, start: midnightOf('2027-05-27') });
  });
});

describe('the story’s dates', () => {
  it('opens on the end of Tue, Nov 10: the footings done, the slab not started', () => {
    expect(storyDate(0)).toBe(dayStart(OPENING_DAY, 1));
    expect(dayName(storyDate(0))).toBe('Tue, Nov 10');
    expect(builtBy(task('Strip forms and backfill'), storyDate(0))).toBe(1);
    expect(builtBy(task('Gravel base and vapor barrier'), storyDate(0))).toBe(0);
  });

  it('holds the date until the run, then only moves forward, and stops on the closing day', () => {
    expect(storyDate(BEATS.pay)).toBe(storyDate(0));
    expect(storyDate(BEATS.run)).toBe(storyDate(0));
    let last = -Infinity;
    for (const at of moments(0, BEATS.end)) {
      const days = daysAt(at);
      expect(days).toBeGreaterThanOrEqual(last);
      last = days;
    }
    expect(storyDate(BEATS.ran)).toBe(dayStart(OPENING_DAY, 1 + CLOSING_DAYS));
    expect(storyDate(BEATS.end)).toBe(storyDate(BEATS.ran));
    expect(dayName(storyDate(BEATS.end))).toBe('Mon, Feb 8');
  });

  it('passes through each of its keys', () => {
    for (const [seconds, days] of RUN_KEYS) expect(daysAt(seconds)).toBeCloseTo(days, 9);
  });

  it('takes the slab’s pour slowly enough to see it, and the decks’ quickly', () => {
    const pour = task('Pour slab on grade');
    const pouring = moments(BEATS.run, BEATS.ran).filter((at) => builtBy(pour, storyDate(at)) > 0 && builtBy(pour, storyDate(at)) < 1);
    expect(pouring.length * 0.01).toBeGreaterThan(0.5);
    for (const at of pouring) expect(paceAt(at)).toBeLessThan(4);
    for (const level of [1, 2, 3]) {
      const deck = task(`Pour deck, level ${level}`);
      const quick = moments(BEATS.run, BEATS.ran).filter((at) => builtBy(deck, storyDate(at)) > 0 && builtBy(deck, storyDate(at)) < 1);
      for (const at of quick) expect(paceAt(at)).toBeGreaterThan(4);
    }
  });

  it('gives the steel, with the crane at work, more than a second and a half', () => {
    const steel = task('Erect steel and metal deck');
    const rising = moments(BEATS.run, BEATS.ran).filter((at) => builtBy(steel, storyDate(at)) > 0 && builtBy(steel, storyDate(at)) < 1);
    expect(rising.length * 0.01).toBeGreaterThan(1.5);
  });

  it('closes on the building well advanced: the frame, the decks, the roof and the glass up, the fit-out to come', () => {
    const closing = storyDate(BEATS.end);
    for (const name of ['Erect steel and metal deck', 'Pour deck, level 3', 'Roofing', 'Curtain wall']) expect(builtBy(task(name), closing), name).toBe(1);
    expect(builtBy(task('Lobby finishes, ground floor'), closing)).toBe(0);
    expect(builtBy(task('Handover to tenant'), closing)).toBe(0);
  });
});

describe('the story’s beats', () => {
  it('pays, lifts the hold and only then runs the date, settling last', () => {
    expect(BEATS.pay).toBeLessThan(BEATS.lifted);
    expect(BEATS.pay).toBeLessThan(BEATS.run);
    expect(BEATS.run).toBeLessThan(BEATS.ran);
    expect(BEATS.ran).toBeLessThan(BEATS.end);
    // The slab can't start before the payment: the date stands still until after it lands.
    expect(daysAt(BEATS.pay + 0.3)).toBe(0);
  });

  it('lands the payment and lifts the hold in their own moments', () => {
    expect(payBeat(BEATS.pay - 0.01)).toEqual({ paid: false, landed: 0, lifted: 0 });
    expect(payBeat(BEATS.pay).paid).toBe(true);
    expect(payBeat(BEATS.pay + 0.35).landed).toBe(1);
    expect(payBeat(BEATS.lifted).lifted).toBe(1);
    expect(payBeat(BEATS.pay + 0.3).lifted).toBeGreaterThan(0);
    expect(payBeat(BEATS.pay + 0.3).lifted).toBeLessThan(1);
  });

  it('turns the camera from the first moment to the settle, easing in and out', () => {
    expect(orbitAt(0)).toBe(0);
    expect(orbitAt(BEATS.end)).toBe(1);
    expect(orbitAt(BEATS.end / 2)).toBeCloseTo(0.5, 9);
    expect(orbitAt(0.1)).toBeLessThan(0.1 / BEATS.end);
  });

  it('runs the machines four times as fast while the date runs, with no jump', () => {
    for (const at of moments(0, BEATS.run, 0.25)) expect(machineClock(at)).toBeCloseTo(at, 9);
    const middle = (BEATS.run + BEATS.ran) / 2;
    expect((machineClock(middle + 0.01) - machineClock(middle - 0.01)) / 0.02).toBeCloseTo(4, 6);
    for (const at of moments(0, BEATS.end, 0.005)) expect(machineClock(at + 0.005) - machineClock(at)).toBeLessThan(0.005 * 4 + 1e-9);
    expect(machineClock(BEATS.end) - BEATS.end).toBeCloseTo(3 * (BEATS.ran - BEATS.run - 0.5), 9);
  });

  it('draws a monotone curve that never overshoots its points', () => {
    const curve = monotone([
      [0, 0],
      [1, 10],
      [2, 10.5],
      [3, 30],
    ]);
    let last = -Infinity;
    for (const at of moments(0, 3)) {
      const value = curve(at);
      expect(value).toBeGreaterThanOrEqual(last - 1e-12);
      expect(value).toBeLessThanOrEqual(30);
      last = value;
    }
    expect(curve(1.5)).toBeGreaterThanOrEqual(10);
    expect(curve(1.5)).toBeLessThanOrEqual(10.5);
  });
});

describe('the schedule strip', () => {
  it('has the plan’s big pieces in order, ending on the handover', () => {
    expect(strip.map((each) => each.label)).toEqual(['Footings', 'Slab on grade', 'Steel', 'Decks', 'Envelope', 'Fit-out', 'Handover']);
    expect([row('footings').start, row('footings').end]).toEqual([midnightOf('2026-10-28'), midnightOf('2026-11-11')]);
    expect([row('slab').start, row('slab').end]).toEqual([midnightOf('2026-11-11'), midnightOf('2026-12-02')]);
    expect(row('handover')).toMatchObject({ milestone: true, start: midnightOf('2027-05-27') });
  });

  it('shows the footings done and the slab not started at the opening, the envelope done at the close', () => {
    const opening = storyDate(0);
    expect(rowProgress(row('footings'), opening)).toBe(1);
    expect(rowProgress(row('slab'), opening)).toBe(0);
    const closing = storyDate(BEATS.end);
    for (const key of ['footings', 'slab', 'steel', 'decks', 'envelope']) expect(rowProgress(row(key), closing), key).toBe(1);
    expect(rowProgress(row('fitout'), closing)).toBeLessThan(0.05);
    expect(rowProgress(row('handover'), closing)).toBe(0);
  });

  it('runs from October to the end of May, a tick on the first of each month', () => {
    const span = stripSpan(strip);
    expect(span).toEqual({ from: midnightOf('2026-10-01'), to: midnightOf('2027-06-01') });
    expect(monthTicks(span.from, span.to).map((tick) => tick.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan ’27', 'Feb', 'Mar', 'Apr', 'May']);
  });
});

/**
 * The crane's days as a calendar on the lot: whole weeks, Monday to Sunday, sized to the room the lot has; a point on
 * it finds its day; each day says what it is in a word (IDLE, WORK, COVER, OFF); when the rental changes, only the days
 * that change turn over, earliest first, and each says what it is once it has.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDayCalendar } from '../../src/gantt/fx3d/day-calendar';
import type { DayKind, DayTile } from '../../src/gantt/fx3d/day-track';

const COLORS = { bar: '#2f6fb3', idle: '#f3c46b', ink: '#1f2428', soft: '#5b646c', paper: '#ffffff', off: '#cfd3d6' };
const money = (minor: number): string => `$${(minor / 100).toLocaleString('en-US')}`;
const at = (month: number, day: number): number => new Date(2027, month - 1, day).getTime();

/** What the canvas was asked to write, in order. */
let written: string[] = [];

beforeAll(() => {
  const context = new Proxy(
    { fillText: (text: string) => written.push(text) },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : typeof key === 'string' && /^[a-z]/.test(key) ? () => undefined : undefined), set: () => true },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D);
});

afterAll(() => vi.restoreAllMocks());

/** Harbor's crane: on rent Wed, Jan 27 to Sun, Feb 14; steel Mon, Feb 1 to Fri, Feb 12, the weekend between paid. */
function craneDays(): DayTile[] {
  const tiles: DayTile[] = [];
  for (let day = new Date(2027, 0, 27); day <= new Date(2027, 1, 14); day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const time = day.getTime();
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const inWork = time >= at(2, 1) && time <= at(2, 12);
    const kind: DayKind = inWork ? (weekend ? 'paid' : 'work') : 'idle';
    tiles.push({ at: time, kind, costMinor: kind === 'work' ? 0 : 60_000 });
  }
  return tiles;
}

/** The middle of a day's square, as a point on the face: column across, week down (after the weekday letters). */
const uvOf = (column: number, week: number, weeks: number) => ({ u: (column + 0.5) / 7, v: 1 - (0.5 + week + 0.5) / (weeks + 0.5) });

describe('a machine’s days as a calendar on the lot', () => {
  it('lays whole weeks, Monday to Sunday, as large as the room allows', () => {
    const calendar = createDayCalendar(craneDays(), COLORS, money, { room: 70, largest: 20 });
    // Mon, Jan 25 to Sun, Feb 14: three weeks and the weekday letters, 70 deep at most.
    expect(calendar.depth).toBeCloseTo(70);
    expect(calendar.width).toBeCloseTo((70 / 3.5) * 7);
    const roomy = createDayCalendar(craneDays(), COLORS, money, { room: 200, largest: 20 });
    expect(roomy.width).toBe(140);
  });

  it('finds the day under a point, and says the days around the rental are not on it', () => {
    const calendar = createDayCalendar(craneDays(), COLORS, money);
    const find = (column: number, week: number) => {
      const { u, v } = uvOf(column, week, 3);
      return calendar.tileAtUv(u, v);
    };
    expect(find(2, 0)).toMatchObject({ at: at(1, 27), kind: 'idle', costMinor: 60_000 });
    expect(find(0, 1)).toMatchObject({ at: at(2, 1), kind: 'work' });
    expect(find(5, 1)).toMatchObject({ at: at(2, 6), kind: 'paid' });
    expect(find(6, 2)).toMatchObject({ at: at(2, 14), kind: 'idle' });
    // Mon, Jan 25 comes before the rental: on the calendar, not on rent.
    expect(find(0, 0)).toMatchObject({ at: at(1, 25), kind: 'off', costMinor: 0 });
    // The weekday letters are no day.
    expect(calendar.tileAtUv(0.5, 0.99)).toBeNull();
  });

  it('writes each day with what it is and what it costs, and names the month where one begins', () => {
    written = [];
    const calendar = createDayCalendar(craneDays(), COLORS, money);
    calendar.update(at(1, 27) + 12 * 3_600_000);
    expect(written).toContain('Jan 25');
    expect(written).toContain('Feb 1');
    // Seven days on rent with nothing to lift say so in a word; the weekend inside the work is off, not idle.
    expect(written.filter((text) => text === 'IDLE').length).toBe(7);
    expect(written.filter((text) => text === 'OFF').length).toBe(2);
    expect(written.filter((text) => text === 'WORK').length).toBe(10);
    expect(written.filter((text) => text === '−$600').length).toBe(9);
  });

  it('calls a day of cover around the work cover, not idle', () => {
    written = [];
    const days = craneDays()
      .filter((tile) => tile.at >= at(1, 31) && tile.at <= at(2, 13))
      .map((tile) => (tile.kind === 'idle' ? { ...tile, kind: 'cover' as const } : tile));
    const calendar = createDayCalendar(days, COLORS, money);
    calendar.update(at(2, 1));
    expect(written.filter((text) => text === 'COVER').length).toBe(2);
    expect(written).not.toContain('IDLE');
  });

  it('finds where the idle days lie, and those on rent, for the camera to go to', () => {
    const calendar = createDayCalendar(craneDays(), COLORS, money, { room: 70, largest: 20 });
    const side = calendar.width / 7;
    const idle = calendar.squaresOf(['idle'])!;
    // Wed, Jan 27 in the first week to Sun, Feb 14 in the last: the idle days reach across all three weeks.
    expect(idle.x0).toBeCloseTo(-calendar.width / 2 + 2 * side);
    expect(idle.x1).toBeCloseTo(calendar.width / 2);
    expect(idle.y1).toBeCloseTo(calendar.depth / 2 - 0.5 * side);
    expect(idle.y0).toBeCloseTo(-calendar.depth / 2);
    const onRent = calendar.squaresOf(['idle', 'work', 'paid', 'cover'])!;
    expect(onRent.x0).toBeCloseTo(-calendar.width / 2);
    expect(calendar.squaresOf(['cover'])).toBeNull();
  });

  it('makes the days on rent, or the idle ones, stand out and draws again only when that changes', () => {
    const calendar = createDayCalendar(craneDays(), COLORS, money);
    calendar.update(at(2, 14));
    written = [];
    calendar.emphasize('idle', 1);
    expect(written.filter((text) => text === 'IDLE').length).toBe(7);
    written = [];
    calendar.emphasize('idle', 1);
    expect(written).toEqual([]);
    calendar.emphasize(null);
    expect(written.length).toBeGreaterThan(0);
  });

  it('turns over only the days that change, earliest first, and then says what they are', () => {
    const calendar = createDayCalendar(craneDays(), COLORS, money);
    const booked = craneDays().filter((tile) => tile.at >= at(2, 1) && tile.at <= at(2, 12));
    calendar.setDays(booked);
    calendar.morph(0.3);
    const { u, v } = uvOf(2, 0, 3);
    // Part way: the first idle day has turned over and is not on rent; the last ones are still turning.
    expect(calendar.tileAtUv(u, v)).toMatchObject({ at: at(1, 27), kind: 'off' });
    calendar.morph(1);
    expect(calendar.idleAnchor()).toBeNull();
    const work = uvOf(0, 1, 3);
    expect(calendar.tileAtUv(work.u, work.v)).toMatchObject({ at: at(2, 1), kind: 'work' });
    const after = uvOf(5, 2, 3);
    expect(calendar.tileAtUv(after.u, after.v)).toMatchObject({ at: at(2, 13), kind: 'off' });
  });

  it('points at the first run of idle days', () => {
    const calendar = createDayCalendar(craneDays(), COLORS, money, { room: 70, largest: 20 });
    const anchor = calendar.idleAnchor();
    // Wed, Jan 27 to Sun, Jan 31: the first week's last five squares.
    const side = calendar.width / 7;
    expect(anchor?.x).toBeCloseTo(-calendar.width / 2 + 4.5 * side);
    expect(anchor?.y).toBeCloseTo(calendar.depth / 2 - 1 * side);
  });
});

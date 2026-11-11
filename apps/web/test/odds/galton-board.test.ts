/**
 * The Galton board's layout on Harbor's dates (a Jun 11, 2027 contract date, Memorial Day and Jul 5 off): one bin per
 * working day from May 24 to Jul 2, the deadline's glass after Jun 11, pegs between the walls, marbles let go across
 * the hopper's mouth; how marbles stack in a bin; and the words the board says.
 */
import { describe, expect, it } from 'vitest';
import { HARBOR_CONTRACT_DATE, isWorkingDay } from '@collab/shared/seed';
import { binAt, binOfDay, boardLayout, defaultRange, DEFAULT_SHAPE, marblesInRows, MARBLE_RADIUS, onTime, ROW_PITCH, rowOrder, rowsFor, slotPosition, weekdayOf, workingDays } from '../../src/odds/galton/board';
import { counterWords, deadlineWords, percentOf, resultWords } from '../../src/odds/galton/words';

const DAY = 86_400_000;
const dayOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;
const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const nonWorking = (day: number) => !isWorkingDay(isoOf(day), 'standard');
const CONTRACT = dayOf(HARBOR_CONTRACT_DATE);

function harbor(total = 1000) {
  const range = defaultRange(CONTRACT);
  return boardLayout({ days: workingDays(range.from, range.to, nonWorking), contractDay: CONTRACT, total });
}

describe('the bins', () => {
  it('has one bin per working day from May 24 to Jul 2 around a Jun 11 contract date, Memorial Day left out', () => {
    const range = defaultRange(CONTRACT);
    expect([isoOf(range.from), isoOf(range.to)]).toEqual(['2027-05-24', '2027-07-02']);
    const layout = harbor();
    expect(layout.bins).toHaveLength(29);
    const days = layout.bins.map((bin) => isoOf(bin.day));
    expect(days.slice(0, 6)).toEqual(['2027-05-24', '2027-05-25', '2027-05-26', '2027-05-27', '2027-05-28', '2027-06-01']);
    expect(days.at(-1)).toBe('2027-07-02');
    for (const bin of layout.bins) expect([1, 2, 3, 4, 5]).toContain(weekdayOf(bin.day));
  });

  it('lays the bins side by side, left to right by day, with a little more room where a week starts, centered on the board', () => {
    const layout = harbor();
    const inner = DEFAULT_SHAPE.perRow + DEFAULT_SHAPE.clearance * 2;
    layout.bins.forEach((bin, index) => {
      expect(bin.index).toBe(index);
      expect(bin.right - bin.left).toBeCloseTo(inner);
      expect(bin.center).toBeCloseTo((bin.left + bin.right) / 2);
      if (index === 0) return;
      const before = layout.bins[index - 1]!;
      expect(bin.day).toBeGreaterThan(before.day);
      expect(bin.weekStart).toBe(bin.day - before.day > 1);
      expect(bin.left - before.right).toBeCloseTo(DEFAULT_SHAPE.divider + (bin.weekStart ? DEFAULT_SHAPE.weekGap : 0));
    });
    expect(layout.left + layout.right).toBeCloseTo(0);
    expect(layout.bins[0]!.left).toBeCloseTo(layout.left);
    expect(layout.bins.at(-1)!.right).toBeCloseTo(layout.right);
  });

  it('stands the deadline’s glass after the contract day’s bin, taller and heavier than the other dividers', () => {
    const layout = harbor();
    const deadline = layout.deadline!;
    const jun11 = layout.bins.find((bin) => isoOf(bin.day) === '2027-06-11')!;
    const jun14 = layout.bins.find((bin) => isoOf(bin.day) === '2027-06-14')!;
    expect(deadline.kind).toBe('deadline');
    expect(deadline.x).toBeGreaterThan(jun11.right);
    expect(deadline.x).toBeLessThan(jun14.left);
    expect(deadline.top).toBeGreaterThan(layout.binTop);
    expect(deadline.thickness).toBeGreaterThan(DEFAULT_SHAPE.divider);
    expect(layout.dividers).toHaveLength(layout.bins.length + 1);
    expect(layout.dividers.filter((divider) => divider.kind === 'deadline')).toHaveLength(1);
  });

  it('has no deadline glass when every day on the board is on one side of the contract date', () => {
    const range = defaultRange(CONTRACT);
    const layout = boardLayout({ days: workingDays(range.from, CONTRACT, nonWorking), contractDay: CONTRACT, total: 1000 });
    expect(layout.deadline).toBeNull();
  });

  it('builds the bins tall enough for the busiest day the board is made for (16% of the runs)', () => {
    const layout = harbor();
    expect(layout.capacity).toBe(160);
    const top = slotPosition(layout.bins[0]!, layout.capacity - 1, DEFAULT_SHAPE.perRow).y + MARBLE_RADIUS;
    expect(top).toBeLessThan(layout.binTop);
    expect(layout.commitY).toBeLessThan(layout.binTop);
    // A smaller pass gets a lower board.
    expect(harbor(200).binTop).toBeLessThan(layout.binTop);
  });

  it('keeps the pegs between the walls in staggered rows clear of the glass, and lets marbles go across the hopper’s mouth', () => {
    const layout = harbor();
    const ys = new Set<number>();
    for (let i = 0; i < layout.pegs.length; i += 2) {
      const [x, y] = [layout.pegs[i]!, layout.pegs[i + 1]!];
      expect(x - DEFAULT_SHAPE.pegRadius).toBeGreaterThan(layout.left);
      expect(x + DEFAULT_SHAPE.pegRadius).toBeLessThan(layout.right);
      expect(y).toBeGreaterThanOrEqual(layout.pegBottom - 1e-4);
      expect(y).toBeLessThanOrEqual(layout.pegTop + 1e-4);
      ys.add(Math.round(y * 1000));
    }
    expect(ys.size).toBe(DEFAULT_SHAPE.pegRows);
    expect(layout.pegBottom - DEFAULT_SHAPE.pegRadius).toBeGreaterThan(layout.deadline!.top + 2 * MARBLE_RADIUS);
    // Neighboring rows are offset by half the spacing, so a marble can't fall straight through.
    const rowX = (row: number) => {
      const y = Math.round((layout.pegTop - row * DEFAULT_SHAPE.pegSpacing * (Math.sqrt(3) / 2)) * 1000);
      const xs: number[] = [];
      for (let i = 0; i < layout.pegs.length; i += 2) if (Math.round(layout.pegs[i + 1]! * 1000) === y) xs.push(layout.pegs[i]!);
      return xs;
    };
    const offset = (((rowX(0)[0]! - rowX(1)[0]!) % DEFAULT_SHAPE.pegSpacing) + DEFAULT_SHAPE.pegSpacing) % DEFAULT_SHAPE.pegSpacing;
    expect(offset).toBeCloseTo(DEFAULT_SHAPE.pegSpacing / 2);
    expect(layout.release.xMin).toBeGreaterThanOrEqual(layout.hopper.center - layout.hopper.exit / 2 + MARBLE_RADIUS);
    expect(layout.release.xMax).toBeLessThanOrEqual(layout.hopper.center + layout.hopper.exit / 2 - MARBLE_RADIUS);
    expect(layout.release.y).toBeGreaterThan(layout.pegTop);
    expect(layout.top).toBeGreaterThan(layout.release.y);
  });

  it('finds a handover day’s bin, and puts a day beyond the board in the bin at that end', () => {
    const layout = harbor();
    const index = (iso: string) => layout.bins.findIndex((bin) => isoOf(bin.day) === iso);
    expect(binOfDay(layout, dayOf('2027-06-11'))).toBe(index('2027-06-11'));
    expect(binOfDay(layout, dayOf('2027-05-24'))).toBe(0);
    expect(binOfDay(layout, dayOf('2027-05-03'))).toBe(0);
    expect(binOfDay(layout, dayOf('2027-08-02'))).toBe(layout.bins.length - 1);
    // A day the handover can't fall on goes to the working day after it.
    expect(binOfDay(layout, dayOf('2027-05-31'))).toBe(index('2027-06-01'));
  });

  it('tells which bin a marble is in from where it is, and none on a divider', () => {
    const layout = harbor();
    for (const bin of layout.bins) expect(binAt(layout, bin.center)).toBe(bin.index);
    expect(binAt(layout, layout.deadline!.x)).toBe(-1);
    expect(binAt(layout, layout.left - 1)).toBe(-1);
  });
});

describe('stacking marbles in a bin', () => {
  const bin = { center: 10 };
  const perRow = DEFAULT_SHAPE.perRow;

  it('fills each row from its middle outward', () => {
    expect(rowOrder(4)).toEqual([1, 2, 0, 3]);
    expect(rowOrder(3)).toEqual([1, 0, 2]);
    expect(rowOrder(1)).toEqual([0]);
  });

  it('alternates full rows and rows one short, each sitting in the hollows of the row below', () => {
    const first = [0, 1, 2, 3].map((k) => slotPosition(bin, k, perRow));
    expect(first.map((slot) => slot.y)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(first.map((slot) => slot.x - bin.center)).toEqual([-0.5, 0.5, -1.5, 1.5]);
    const second = [4, 5, 6].map((k) => slotPosition(bin, k, perRow));
    for (const slot of second) expect(slot.y).toBeCloseTo(0.5 + ROW_PITCH);
    expect(second.map((slot) => slot.x - bin.center)).toEqual([0, -1, 1]);
    expect(slotPosition(bin, 7, perRow).y).toBeCloseTo(0.5 + 2 * ROW_PITCH);
  });

  it('never overlaps two marbles and keeps every one inside the bin', () => {
    const slots = Array.from({ length: 160 }, (_, k) => slotPosition(bin, k, perRow));
    for (let a = 0; a < slots.length; a += 1) {
      expect(Math.abs(slots[a]!.x - bin.center)).toBeLessThanOrEqual(perRow / 2 - MARBLE_RADIUS + 1e-9);
      for (let b = a + 1; b < slots.length; b += 1) expect(Math.hypot(slots[a]!.x - slots[b]!.x, slots[a]!.y - slots[b]!.y)).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  it('stacks a pile as tall as its count: one more marble never makes a lower pile', () => {
    let top = 0;
    for (let k = 1; k <= 200; k += 1) {
      const slot = slotPosition(bin, k - 1, perRow);
      expect(slot.y).toBeGreaterThanOrEqual(top - 1e-9);
      top = Math.max(top, slot.y);
      expect(rowsFor(k, perRow)).toBe(slot.row + 1);
      expect(marblesInRows(rowsFor(k, perRow), perRow)).toBeGreaterThanOrEqual(k);
    }
  });

  it('counts rows as it stacks them', () => {
    expect(marblesInRows(2, 4)).toBe(7);
    expect(marblesInRows(3, 4)).toBe(11);
    expect([rowsFor(0, 4), rowsFor(4, 4), rowsFor(5, 4), rowsFor(7, 4), rowsFor(8, 4)]).toEqual([0, 1, 2, 2, 3]);
  });
});

describe('what the board says', () => {
  it('rounds the share on time as the odds panel does, and says it in plain words', () => {
    expect([percentOf(515, 1000), percentOf(839, 1000), percentOf(0, 0)]).toEqual([52, 84, 0]);
    expect(resultWords(515, 1000, CONTRACT)).toBe('515 of 1,000 finish by Fri, Jun 11');
    expect(deadlineWords(CONTRACT)).toBe('Deadline · Fri, Jun 11');
    expect(counterWords(312, 1000)).toBe('312 of 1,000');
  });

  it('counts a handover on the contract date as on time, and the next working day as late', () => {
    expect(onTime(CONTRACT, CONTRACT)).toBe(true);
    expect(onTime(CONTRACT - 1, CONTRACT)).toBe(true);
    expect(onTime(dayOf('2027-06-14'), CONTRACT)).toBe(false);
  });
});

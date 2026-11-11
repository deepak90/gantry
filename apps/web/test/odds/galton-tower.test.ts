/**
 * The runs as a building, on Harbor's board (a Jun 11, 2027 contract date): 1,000 runs stand in ten floors of a hundred,
 * 25 across, earliest handover at the bottom, clear of the bins' floor and under the pegs; the floor plates sit between
 * floors; the deadline's floor line has exactly the runs that make it under it, stepping down where a row is shared;
 * and two boards side by side stand in one order of the runs, so the band between their lines is the runs that make it
 * only on the right. The runs here are Harbor's own handover days from 1,000 engine runs (seed 7): paid today, 839 make
 * it; paid on the Friday pay run, every run is three working days later and 515 do.
 */
import { describe, expect, it } from 'vitest';
import { HARBOR_CONTRACT_DATE, isWorkingDay } from '@collab/shared/seed';
import { boardLayout, defaultRange, workingDays } from '../../src/odds/galton/board';
import { floorLine, floorPlates, rowBottom, sharedOrder, towerLayout, towerOrder, towerSlot, type TowerRun } from '../../src/odds/galton/tower';

const DAY = 86_400_000;
const dayOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;
const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const nonWorking = (day: number) => !isWorkingDay(isoOf(day), 'standard');
const CONTRACT = dayOf(HARBOR_CONTRACT_DATE);

function harborBoard(total = 1000) {
  const range = defaultRange(CONTRACT);
  return boardLayout({ days: workingDays(range.from, range.to, nonWorking), contractDay: CONTRACT, total });
}

/** Harbor's 1,000 runs paid today, by handover day (the engine's counts), and the same runs paid Friday. */
const PAID_TODAY: [string, number][] = [
  ['2027-05-27', 5], ['2027-05-28', 13], ['2027-06-01', 25], ['2027-06-02', 50], ['2027-06-03', 85], ['2027-06-04', 108],
  ['2027-06-07', 112], ['2027-06-08', 117], ['2027-06-09', 128], ['2027-06-10', 109], ['2027-06-11', 87], ['2027-06-14', 60],
  ['2027-06-15', 45], ['2027-06-16', 25], ['2027-06-17', 16], ['2027-06-18', 8], ['2027-06-21', 5], ['2027-06-22', 1], ['2027-06-23', 1],
];

function harborRuns(): { today: TowerRun[]; friday: TowerRun[] } {
  const days = workingDays(CONTRACT - 40, CONTRACT + 40, nonWorking);
  const later = (day: number, by: number) => days[days.indexOf(day) + by]!;
  const today: TowerRun[] = [];
  const friday: TowerRun[] = [];
  let k = 0;
  for (const [iso, count] of PAID_TODAY) {
    for (let i = 0; i < count; i += 1) {
      // Run numbers out of step with the days, as the engine's are.
      const run = (k * 619) % 1000;
      k += 1;
      const day = dayOf(iso);
      const fridayDay = later(day, 3);
      today.push({ run, day, onTime: day <= CONTRACT });
      friday.push({ run, day: fridayDay, onTime: fridayDay <= CONTRACT });
    }
  }
  return { today, friday };
}

describe('the tower', () => {
  it('stands 1,000 runs in ten floors of a hundred, 25 across, centered, clear of the bins’ floor and under the pegs', () => {
    const board = harborBoard();
    const tower = towerLayout(board, 1000);
    expect([tower.perRow, tower.perFloor, tower.floors]).toEqual([25, 100, 10]);
    expect(tower.left + tower.right).toBeCloseTo(0);
    expect(tower.right - tower.left).toBeCloseTo(25 * tower.cell);
    expect(tower.ground).toBeGreaterThanOrEqual(board.binTop * 0.35);
    expect(tower.top).toBeLessThan(board.pegTop);
    // Halfway up the room between the floor and the top row of pegs.
    expect(tower.ground).toBeCloseTo((board.pegTop - (tower.top - tower.ground)) / 2);
    // The deadline's floor line reaches past both sides and stays on the board.
    expect(tower.left - tower.shape.lineReach).toBeGreaterThan(board.left);
    expect(tower.right + tower.shape.lineReach).toBeLessThan(board.right);
  });

  it('fills each row left to right from the ground up, a floor plate’s room between floors, no two marbles overlapping', () => {
    const tower = towerLayout(harborBoard(), 1000);
    const first = towerSlot(tower, 0);
    expect(first).toMatchObject({ row: 0, floor: 0 });
    expect(first.x).toBeCloseTo(tower.left + tower.cell / 2);
    expect(first.y).toBeCloseTo(tower.ground + tower.cell / 2);
    expect(towerSlot(tower, 24).x).toBeCloseTo(tower.right - tower.cell / 2);
    expect(towerSlot(tower, 25)).toMatchObject({ row: 1, floor: 0 });
    expect(towerSlot(tower, 99)).toMatchObject({ row: 3, floor: 0 });
    expect(towerSlot(tower, 100)).toMatchObject({ row: 4, floor: 1 });
    // A new floor starts a floor plate's room above the last row of the one below.
    expect(towerSlot(tower, 100).y - towerSlot(tower, 75).y).toBeCloseTo(tower.cell + tower.shape.floorGap);
    expect(towerSlot(tower, 999)).toMatchObject({ row: 39, floor: 9 });
    expect(towerSlot(tower, 999).y + tower.cell / 2).toBeCloseTo(tower.top);
    const seen = new Set<string>();
    for (let k = 0; k < 1000; k += 1) {
      const at = towerSlot(tower, k);
      seen.add(`${at.x.toFixed(3)},${at.y.toFixed(3)}`);
      expect(at.x).toBeGreaterThan(tower.left);
      expect(at.x).toBeLessThan(tower.right);
    }
    expect(seen.size).toBe(1000);
    // Drawn a little smaller than its room, so the marbles stand apart.
    expect(tower.scale).toBeLessThan(tower.cell);
  });

  it('puts a plate between each two floors: nine on ten floors, each between a floor’s top row and the next one’s bottom', () => {
    const tower = towerLayout(harborBoard(), 1000);
    const plates = floorPlates(tower);
    expect(plates).toHaveLength(9);
    plates.forEach((y, index) => {
      const below = towerSlot(tower, (index + 1) * 100 - 1).y + tower.cell / 2;
      const above = towerSlot(tower, (index + 1) * 100).y - tower.cell / 2;
      expect(y).toBeGreaterThan(below);
      expect(y).toBeLessThan(above);
    });
  });

  it('draws the floor line with exactly the first runs under it, stepping down where a row is shared', () => {
    const tower = towerLayout(harborBoard(), 1000);
    for (const count of [0, 1, 99, 100, 101, 515, 839, 999, 1000]) {
      const line = floorLine(tower, count);
      expect(line.from).toBeLessThan(tower.left);
      expect(line.to).toBeGreaterThan(tower.right);
      for (let k = 0; k < 1000; k += 1) {
        const at = towerSlot(tower, k);
        const y = at.x < line.stepX ? line.leftY : line.rightY;
        if (k < count) expect(at.y + tower.cell / 2, `${k} under the line at ${count}`).toBeLessThanOrEqual(y + 1e-9);
        else expect(at.y - tower.cell / 2, `${k} over the line at ${count}`).toBeGreaterThanOrEqual(y - 1e-9);
      }
    }
    // 515 of 1,000: fifteen marbles into the sixth floor's first row, so the line steps down there.
    const friday = floorLine(tower, 515);
    expect(friday.stepX).toBeCloseTo(tower.left + 15 * tower.cell);
    expect(friday.leftY - friday.rightY).toBeCloseTo(tower.cell);
    expect(friday.rightY).toBeCloseTo(rowBottom(tower, 20));
    // A whole floor under it: the line lies on the floor plate.
    expect(floorLine(tower, 100).leftY).toBeCloseTo(floorPlates(tower)[0]!);
  });

  it('orders one board’s tower by handover day, then run number', () => {
    const order = towerOrder([
      { run: 4, day: 12, onTime: false },
      { run: 9, day: 10, onTime: true },
      { run: 2, day: 10, onTime: true },
      { run: 7, day: 11, onTime: false },
    ]);
    expect(order).toEqual([2, 9, 7, 4]);
  });

  it('stands Harbor’s two boards in one order: 515 under Friday’s line, 839 under today’s, and the 324 between them are the runs that make it only by paying today', () => {
    const { today, friday } = harborRuns();
    expect(friday.filter((run) => run.onTime)).toHaveLength(515);
    expect(today.filter((run) => run.onTime)).toHaveLength(839);
    const shared = sharedOrder(friday, today)!;
    expect(shared.band).toBe(324);
    expect(shared.order).toHaveLength(1000);
    const onFriday = new Map(friday.map((run) => [run.run, run]));
    const onToday = new Map(today.map((run) => [run.run, run]));
    // Each board's runs that make it are its lowest marbles: the line over 515 on the left, 839 on the right.
    shared.order.forEach((run, k) => {
      expect(onFriday.get(run)!.onTime, `run ${run} at ${k} on the left`).toBe(k < 515);
      expect(onToday.get(run)!.onTime, `run ${run} at ${k} on the right`).toBe(k < 839);
    });
    // Between the lines: the runs that hand over Jun 9, 10 or 11 when paid today, three working days later on Friday.
    const band = shared.order.slice(515, 839).map((run) => isoOf(onToday.get(run)!.day));
    expect(new Set(band)).toEqual(new Set(['2027-06-09', '2027-06-10', '2027-06-11']));
    // Earliest handover at the bottom, on both boards (the payment moves every run by the same three working days).
    for (let k = 1; k < 1000; k += 1) {
      expect(onToday.get(shared.order[k]!)!.day).toBeGreaterThanOrEqual(onToday.get(shared.order[k - 1]!)!.day);
      expect(onFriday.get(shared.order[k]!)!.day).toBeGreaterThanOrEqual(onFriday.get(shared.order[k - 1]!)!.day);
    }
  });

  it('gives no shared order when a run makes it only on the left: each board then keeps its own', () => {
    const left: TowerRun[] = [
      { run: 1, day: 5, onTime: true },
      { run: 2, day: 9, onTime: false },
    ];
    const right: TowerRun[] = [
      { run: 1, day: 9, onTime: false },
      { run: 2, day: 5, onTime: true },
    ];
    expect(sharedOrder(left, right)).toBeNull();
  });

  it('keeps ten floors for a smaller pass, and narrows the tower on a narrow board', () => {
    const small = towerLayout(harborBoard(200), 200);
    expect([small.perRow, small.perFloor, small.floors]).toEqual([5, 20, 10]);
    const narrow = towerLayout({ left: -12, right: 12, binTop: 10, pegTop: 60 }, 1000);
    expect(narrow.right - narrow.left + 2 * narrow.shape.lineReach).toBeLessThanOrEqual(24);
    expect(narrow.cell).toBeLessThan(narrow.shape.cell);
    expect(narrow.scale / narrow.cell).toBeCloseTo(narrow.shape.scale / narrow.shape.cell);
  });
});

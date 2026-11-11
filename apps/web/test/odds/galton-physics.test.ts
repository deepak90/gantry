/**
 * The board's physics with Rapier, on Harbor's board (29 working days from May 24 to Jul 2): the search finds a real
 * fall into every bin, the far tails included, and every fall it records ends inside its bin, never passes through a
 * peg, and is short enough for the board to settle soon after the last run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARBOR_CONTRACT_DATE, isWorkingDay } from '@collab/shared/seed';
import { binAt, boardLayout, defaultRange, MARBLE_RADIUS, workingDays, type BoardLayout } from '../../src/odds/galton/board';
import { DropCache, seededRandom } from '../../src/odds/galton/drop-cache';
import { createBoardWorld, DEFAULT_PHYSICS, frameRate, type BoardWorld, type Fall, type Rapier } from '../../src/odds/galton/physics';

const DAY = 86_400_000;
const dayOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;
const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

let layout: BoardLayout;
let world: BoardWorld;

beforeAll(async () => {
  const module = await import('@dimforge/rapier3d-compat');
  const R = (module.default ?? module) as Rapier;
  await R.init();
  const contract = dayOf(HARBOR_CONTRACT_DATE);
  const range = defaultRange(contract);
  layout = boardLayout({ days: workingDays(range.from, range.to, (day) => !isWorkingDay(isoOf(day), 'standard')), contractDay: contract, total: 1000 });
  world = createBoardWorld(R, layout);
});

afterAll(() => world?.dispose());

describe('the board’s physics', () => {
  it('finds a real fall into every bin, the far tails included, each ending in its bin without passing through a peg', () => {
    const search = new DropCache<Fall>({
      bins: layout.bins.length,
      release: layout.release,
      sideOf: (bin) => (layout.bins[bin]!.center < layout.hopper.center - 2 ? -1 : layout.bins[bin]!.center > layout.hopper.center + 2 ? 1 : 0),
      random: seededRandom(11),
      floor: 0,
    });
    search.expect(new Array<number>(layout.bins.length).fill(0), 0);
    let queue = layout.bins.map((bin) => bin.index);
    const found: Fall[] = [];
    const started = performance.now();
    for (let round = 0; round < 400 && queue.length > 0; round += 1) {
      const waiting = new Array<number>(layout.bins.length).fill(0);
      for (const bin of queue) waiting[bin] = (waiting[bin] ?? 0) + 1;
      search.setWaiting(waiting);
      const plan = search.next(32);
      world.simulate(plan.map((entry) => entry.drop)).forEach((fall, index) => (fall ? search.add(fall, plan[index]!.aimedAt) : search.lost(plan[index]!.aimedAt)));
      queue = queue.filter((bin) => {
        const fall = search.take(bin);
        if (fall) found.push(fall);
        return !fall;
      });
    }
    const ms = performance.now() - started;
    console.info(`Every bin of ${layout.bins.length} reached: ${search.stats.tried} falls tried (${search.stats.aimed} aimed at rare bins), ${Math.round(ms)} ms`);
    expect(queue).toEqual([]);
    expect(found.map((fall) => fall.bin).sort((a, b) => a - b)).toEqual(layout.bins.map((bin) => bin.index));

    const maxFrames = DEFAULT_PHYSICS.maxSeconds * frameRate(DEFAULT_PHYSICS) + 2;
    const clearance = layout.shape.pegRadius + MARBLE_RADIUS - 0.12;
    for (const fall of found) {
      const frames = fall.frames;
      const count = frames.length / 2;
      expect(count).toBeLessThanOrEqual(maxFrames);
      // It starts where it was let go, inside the hopper's mouth.
      expect(frames[0]).toBeCloseTo(fall.drop.x, 3);
      expect(frames[1]!).toBeGreaterThan(layout.pegTop);
      // It ends committed to its bin: below the walls' tops, between its two walls.
      const [x, y] = [frames[(count - 1) * 2]!, frames[(count - 1) * 2 + 1]!];
      expect(y).toBeLessThan(layout.commitY);
      const at = binAt(layout, x);
      expect(at === fall.bin || Math.abs(layout.bins[fall.bin]!.center - x) < layout.bins[fall.bin]!.right - layout.bins[fall.bin]!.center + 0.5).toBe(true);
      // Never inside a peg (the solver lets a contact sink in by a hair at most).
      for (let f = 0; f < count; f += 1) {
        const fx = frames[f * 2]!;
        const fy = frames[f * 2 + 1]!;
        if (fy > layout.pegTop + 1 || fy < layout.pegBottom - 1) continue;
        for (let p = 0; p < layout.pegs.length; p += 2) {
          const d = Math.hypot(layout.pegs[p]! - fx, layout.pegs[p + 1]! - fy);
          if (d < clearance) throw new Error(`A fall into bin ${fall.bin} passes ${d.toFixed(3)} from a peg's center at frame ${f}`);
        }
      }
    }
  }, 120_000);

  it('records the same fall for the same drop, alone or in a batch', () => {
    const drops = [
      { x: -1.234, vx: 0.4, spin: 1.5 },
      { x: 2.5, vx: -0.2, spin: -2 },
      { x: 0.01, vx: 0, spin: 0 },
    ];
    const batch = world.simulate(drops);
    const alone = drops.map((drop) => world.simulate([drop])[0]);
    batch.forEach((fall, index) => {
      expect(fall?.bin).toBe(alone[index]?.bin);
      expect(Array.from(fall?.frames ?? [])).toEqual(Array.from(alone[index]?.frames ?? []));
    });
  });
});

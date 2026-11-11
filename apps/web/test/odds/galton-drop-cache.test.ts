/**
 * The search for falls (odds/galton/drop-cache.ts), with a pretend board in place of the physics: the bin a drop
 * reaches depends on where across the hopper it is let go, in thin stripes (a nudge smaller than a stripe keeps the
 * bin, as a tiny jitter keeps a real fall), and the middle bins are far likelier than the ends. Every fall is kept for
 * the bin it reached and handed out once; a rare bin that is short gets aimed drops, jittered from its own; and a
 * whole pass is served, the rare bins included.
 */
import { describe, expect, it } from 'vitest';
import { DropCache, RARE, seededRandom, type Kept } from '../../src/odds/galton/drop-cache';
import type { Drop } from '../../src/odds/galton/physics';

const BINS = 29;
const RELEASE = { xMin: -4.45, xMax: 4.45 };
const STRIPE = 0.002;

function hash(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** The pretend board: two looks at the stripe a drop starts in, averaged, give a bin (triangular: the ends are rare). */
function pretendBin(drop: Drop): number {
  const stripe = Math.floor((drop.x - RELEASE.xMin) / STRIPE);
  const u = (hash(stripe * 2 + 1) + hash(stripe * 2 + 7919)) / 2;
  return Math.min(BINS - 1, Math.floor(u * BINS));
}

interface PretendFall extends Kept {
  id: number;
}
let nextId = 0;
const fall = (drop: Drop, bin = pretendBin(drop)): PretendFall => ({ drop, bin, id: nextId++ });

function cache(seed = 1, floor?: number): DropCache<PretendFall> {
  return new DropCache<PretendFall>({
    bins: BINS,
    release: RELEASE,
    sideOf: (bin) => (bin < 14 ? -1 : bin > 14 ? 1 : 0),
    random: seededRandom(seed),
    ...(floor !== undefined ? { floor } : {}),
  });
}

/** What the worker does: try a batch, keep every fall, hand out what is ready, oldest run first. */
function serve(search: DropCache<PretendFall>, needs: readonly number[], rounds = 4000): { left: number; handed: PretendFall[] } {
  let queue = [...needs];
  const handed: PretendFall[] = [];
  for (let round = 0; round < rounds && queue.length > 0; round += 1) {
    const waiting = new Array<number>(BINS).fill(0);
    for (const bin of queue) waiting[bin] = (waiting[bin] ?? 0) + 1;
    search.setWaiting(waiting);
    for (const { drop, aimedAt } of search.next(32)) search.add(fall(drop), aimedAt);
    queue = queue.filter((bin) => {
      const taken = search.take(bin);
      if (taken) handed.push(taken);
      return !taken;
    });
  }
  return { left: queue.length, handed };
}

describe('the drop cache', () => {
  it('hands out each fall once, the oldest first, and nothing it does not have', () => {
    const search = cache();
    const falls = [fall({ x: 0, vx: 0, spin: 0 }, 3), fall({ x: 1, vx: 0, spin: 0 }, 3), fall({ x: 2, vx: 0, spin: 0 }, 3)];
    falls.forEach((entry) => search.add(entry));
    expect([search.take(3), search.take(3), search.take(3), search.take(3)]).toEqual([falls[0], falls[1], falls[2], null]);
    expect(search.take(4)).toBeNull();
    expect(search.stats.handedOut).toBe(3);
  });

  it('keeps a fall for the bin it reached, whichever bin it was tried for', () => {
    const search = cache();
    search.add(fall({ x: 0.5, vx: 0, spin: 0 }, 7), 5);
    expect(search.stock(7)).toBe(1);
    expect(search.stock(5)).toBe(0);
    expect(search.seeds(7)).toBe(1);
    expect(search.stats.aimHits).toBe(0);
  });

  it('knows what each bin is short of: its share of the runs to come, a few spare, and the runs waiting now', () => {
    const search = cache(1, 2);
    const weights = new Array<number>(BINS).fill(0);
    weights[10] = 1;
    weights[12] = 3;
    search.expect(weights, 400);
    expect(search.deficit(10)).toBe(Math.ceil(100 * 1.15) + 2);
    expect(search.deficit(12)).toBe(Math.ceil(300 * 1.15) + 2);
    expect(search.deficit(0)).toBe(2);
    const waiting = new Array<number>(BINS).fill(0);
    waiting[0] = 3;
    search.setWaiting(waiting);
    expect(search.deficit(0)).toBe(5);
    for (let i = 0; i < 5; i += 1) search.add(fall({ x: i, vx: 0, spin: 0 }, 0));
    expect(search.deficit(0)).toBe(0);
    // A fall handed out counts against what the bin is expected to need.
    search.take(10);
    search.add(fall({ x: 0, vx: 0, spin: 0 }, 10));
    expect(search.take(10)).not.toBeNull();
    expect(search.deficit(10)).toBe(Math.ceil(99 * 1.15) + 2);
  });

  it('rests when no bin is short', () => {
    const search = cache(1, 1);
    search.expect(new Array<number>(BINS).fill(0), 0);
    expect(search.hungry()).toBe(true);
    for (let bin = 0; bin < BINS; bin += 1) search.add(fall({ x: bin, vx: 0, spin: 0 }, bin));
    expect(search.hungry()).toBe(false);
    expect(search.next(8).every((entry) => entry.aimedAt === null)).toBe(true);
  });

  it('tries fresh drops across the whole hopper until it has seen enough to tell which bins are rare', () => {
    const search = cache();
    const waiting = new Array<number>(BINS).fill(0);
    waiting[0] = 4;
    search.setWaiting(waiting);
    const first = search.next(64);
    expect(first.every((entry) => entry.aimedAt === null)).toBe(true);
    const xs = first.map((entry) => entry.drop.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(RELEASE.xMin);
    expect(Math.max(...xs)).toBeLessThanOrEqual(RELEASE.xMax);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan((RELEASE.xMax - RELEASE.xMin) * 0.8);
  });

  it('aims at a rare bin that is short, with at least a third of every batch still fresh', () => {
    const search = cache();
    for (let i = 0; i < 400; i += 1) {
      const drop = { x: RELEASE.xMin + ((i + 0.5) / 400) * (RELEASE.xMax - RELEASE.xMin), vx: 0, spin: 0 };
      search.add(fall(drop));
    }
    expect(search.rate(0)).toBeLessThan(RARE);
    expect(search.rate(14)).toBeGreaterThan(RARE);
    search.expect(new Array<number>(BINS).fill(0), 0);
    const waiting = new Array<number>(BINS).fill(0);
    waiting[0] = 3;
    waiting[14] = 3;
    search.setWaiting(waiting);
    const batch = search.next(30);
    const aimed = batch.filter((entry) => entry.aimedAt !== null);
    expect(aimed.length).toBeGreaterThan(0);
    expect(aimed.length).toBeLessThanOrEqual(20);
    // The busy bin is left to fresh drops: a fresh drop lands there often enough, on a path of its own.
    expect(aimed.some((entry) => entry.aimedAt === 14)).toBe(false);
  });

  it('jitters a rare bin’s own drops inside the hopper, narrower while they miss and wider while they land', () => {
    const search = cache();
    for (let i = 0; i < 200; i += 1) search.add(fall({ x: RELEASE.xMin + ((i + 0.5) / 200) * (RELEASE.xMax - RELEASE.xMin), vx: 0, spin: 0 }, 5));
    const seed = { x: RELEASE.xMax - 0.0001, vx: 0.3, spin: 1 };
    search.add(fall(seed, 0));
    const start = search.spread(0);
    for (let i = 0; i < 12; i += 1) search.add(fall({ x: 0, vx: 0, spin: 0 }, 3), 0);
    const narrower = search.spread(0);
    expect(narrower).toBeLessThan(start);
    for (let i = 0; i < 12; i += 1) search.add(fall({ x: 0, vx: 0, spin: 0 }, 0), 0);
    expect(search.spread(0)).toBeGreaterThan(narrower);
    search.expect(new Array<number>(BINS).fill(0), 0);
    const waiting = new Array<number>(BINS).fill(0);
    waiting[0] = 1;
    search.setWaiting(waiting);
    for (const { drop } of search.next(30).filter((entry) => entry.aimedAt === 0)) {
      expect(drop.x).toBeGreaterThanOrEqual(RELEASE.xMin);
      expect(drop.x).toBeLessThanOrEqual(RELEASE.xMax);
    }
  });

  it('serves every run of a pass, the rare bins too, each with a fall of its own', () => {
    const search = cache(7);
    // A pass on the pretend board: most runs in the middle bins, one in each bin at the very ends.
    const needs: number[] = [0, 1, BINS - 2, BINS - 1];
    for (let i = 0; i < 300; i += 1) needs.push(10 + (i % 9));
    const weights = new Array<number>(BINS).fill(0);
    for (const bin of needs) weights[bin] = (weights[bin] ?? 0) + 1;
    search.expect(weights, needs.length);
    const { left, handed } = serve(search, needs);
    expect(left).toBe(0);
    expect(handed).toHaveLength(needs.length);
    expect(new Set(handed.map((entry) => entry.id)).size).toBe(needs.length);
    for (const entry of handed) expect(pretendBin(entry.drop)).toBe(entry.bin);
    // Nearly nothing is thrown away: a miss for one run is another run's fall.
    expect(search.stats.tried / needs.length).toBeLessThan(40);
  });

  it('tries the same drops for the same seed', () => {
    expect(cache(3).next(10)).toEqual(cache(3).next(10));
    expect(cache(3).next(10)).not.toEqual(cache(4).next(10));
  });
});

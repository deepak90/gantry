/**
 * The search for falls: which drops to try next, and what to keep. The engine decides each marble's bin; this finds
 * a real fall, simulated by the physics, that ends there.
 *
 * Every fall simulated is kept for the bin it reached, whichever run it was tried for: a miss for one run is the
 * fall for another, so almost nothing is thrown away. Each fall is handed out once, so no two marbles share a path.
 *
 * The board is chaotic (a nudge of a thousandth of a marble's width sends nearly every drop to another bin), so for
 * the busy bins a fresh drop anywhere across the hopper is as good an aim as any, and its fall looks like no other.
 * Only a rare bin (the far tails) gets aimed drops: one that reached it before, jittered and simulated again (and so
 * re-verified: a jittered drop that ends elsewhere is kept for the bin it reached); a bin not reached yet gets fresh
 * drops from its side of the hopper, pushed its way. How far a bin's drops are jittered adapts to how often the
 * jittered ones still reach it, from a tenth of a marble's width down to a ten-millionth.
 *
 * Pure: the physics is passed in by whoever runs the search (galton/galton.worker.ts), and so is the dice.
 */
import type { Drop } from './physics';

export interface Kept {
  drop: Drop;
  bin: number;
}

export interface CacheOptions {
  bins: number;
  /** Bin indexes increase to the right; the hopper sits above this x, between these two. */
  release: { xMin: number; xMax: number };
  /** Which way a bin lies from the hopper: -1 left, 0 under it, 1 right. */
  sideOf: (bin: number) => -1 | 0 | 1;
  /** Uniform numbers in [0, 1). */
  random: () => number;
  /** The tiny push sideways (units a second) and spin (radians a second) a fresh drop may get. */
  maxPush?: number;
  maxSpin?: number;
  /** Falls each bin keeps ready beyond what it is expected to need. */
  floor?: number;
}

/** Below this share of fresh drops, a bin counts as rare: it gets aimed drops when it is short. */
export const RARE = 0.025;
/** Fresh drops seen before any bin is judged rare. */
const WARM = 160;
/** At least this share of every batch is fresh, so the shares stay known and the busy bins' paths stay their own. */
const FRESH_SHARE = 1 / 3;

export interface SearchStats {
  /** Falls simulated, and how many of them were aimed at a rare bin (jittered seeds, or nudged fresh drops). */
  tried: number;
  aimed: number;
  /** Aimed drops that reached the bin they were aimed at. */
  aimHits: number;
  failed: number;
  handedOut: number;
}

interface Pool<F> {
  stock: F[];
  seeds: Drop[];
  /** The seed a new one replaces once the list is full: the oldest. */
  ring: number;
  nextSeed: number;
  /** How far drops are jittered: x in units; push and spin scale with it. */
  spread: number;
  jitterTries: number;
  jitterHits: number;
  expected: number;
  served: number;
  waiting: number;
}

const MAX_SEEDS = 48;

/** A normal deviate from two uniform numbers (Box–Muller). */
function normal(random: () => number): number {
  const u = Math.max(1e-12, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class DropCache<F extends Kept> {
  private readonly pools: Pool<F>[];
  private readonly maxPush: number;
  private readonly maxSpin: number;
  private readonly floor: number;
  /** Fresh drops tried, and where they ended: each bin's share of them is how likely a fresh drop is to reach it. */
  private freshTried = 0;
  private readonly freshHits: number[];
  readonly stats: SearchStats = { tried: 0, aimed: 0, aimHits: 0, failed: 0, handedOut: 0 };

  constructor(private readonly options: CacheOptions) {
    this.maxPush = options.maxPush ?? 1.2;
    this.maxSpin = options.maxSpin ?? 3;
    this.floor = options.floor ?? 2;
    this.pools = Array.from({ length: options.bins }, () => ({ stock: [], seeds: [], ring: 0, nextSeed: 0, spread: 1e-4, jitterTries: 0, jitterHits: 0, expected: 0, served: 0, waiting: 0 }));
    this.freshHits = new Array<number>(options.bins).fill(0);
  }

  get bins(): number {
    return this.pools.length;
  }

  /** A fall the physics found: stock for its bin, its drop a seed for that bin; `aimedAt` is the bin it was tried for. */
  add(fall: F, aimedAt: number | null = null): void {
    const pool = this.pools[fall.bin];
    if (!pool) return;
    pool.stock.push(fall);
    if (pool.seeds.length < MAX_SEEDS) pool.seeds.push(fall.drop);
    else {
      pool.seeds[pool.ring] = fall.drop;
      pool.ring = (pool.ring + 1) % MAX_SEEDS;
    }
    if (aimedAt !== null) this.scoreJitter(aimedAt, fall.bin === aimedAt);
    else {
      this.freshTried += 1;
      this.freshHits[fall.bin] = (this.freshHits[fall.bin] ?? 0) + 1;
    }
  }

  /** A drop that never reached a bin (it is counted, nothing is kept). */
  lost(aimedAt: number | null = null): void {
    this.stats.failed += 1;
    if (aimedAt !== null) this.scoreJitter(aimedAt, false);
    else this.freshTried += 1;
  }

  /** How likely a fresh drop is to reach a bin, as seen so far. */
  rate(bin: number): number {
    return ((this.freshHits[bin] ?? 0) + 0.25) / (this.freshTried + 40);
  }

  /** Whether a bin is rare enough to aim at (only once enough fresh drops have been seen to tell). */
  rare(bin: number): boolean {
    return this.freshTried >= WARM && this.rate(bin) < RARE;
  }

  private scoreJitter(bin: number, hit: boolean): void {
    const pool = this.pools[bin];
    if (!pool) return;
    pool.jitterTries += 1;
    if (hit) {
      pool.jitterHits += 1;
      this.stats.aimHits += 1;
    }
    // Keep about a third of the jittered drops on target: wider when most land, much narrower when few do.
    if (pool.jitterTries % 6 === 0) {
      const rate = pool.jitterHits / pool.jitterTries;
      if (rate > 0.5) pool.spread = Math.min(0.1, pool.spread * 1.6);
      else if (rate < 0.17) pool.spread = Math.max(1e-7, pool.spread * 0.25);
      pool.jitterTries = 0;
      pool.jitterHits = 0;
    }
  }

  /** A fall for this bin, never one handed out before; null when there is none ready. */
  take(bin: number): F | null {
    const pool = this.pools[bin];
    if (!pool || pool.stock.length === 0) return null;
    // Oldest first: the stock was found over time, from all over the hopper.
    const fall = pool.stock.shift()!;
    pool.served += 1;
    this.stats.handedOut += 1;
    return fall;
  }

  stock(bin: number): number {
    return this.pools[bin]?.stock.length ?? 0;
  }

  seeds(bin: number): number {
    return this.pools[bin]?.seeds.length ?? 0;
  }

  spread(bin: number): number {
    return this.pools[bin]?.spread ?? 0;
  }

  /** What the next pass is expected to need: a share for each bin (any scale) of `total` marbles. */
  expect(weights: readonly number[], total: number): void {
    const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
    this.pools.forEach((pool, index) => {
      pool.expected = sum > 0 ? (Math.max(0, weights[index] ?? 0) / sum) * total : 0;
      pool.served = 0;
    });
  }

  /** Runs waiting for a fall in each bin, as the board knows them now. */
  setWaiting(waiting: readonly number[]): void {
    this.pools.forEach((pool, index) => {
      pool.waiting = waiting[index] ?? 0;
    });
  }

  /** Falls this bin is short of: what its runs still to come are expected to need, a few spare, and what waits now. */
  deficit(bin: number): number {
    const pool = this.pools[bin];
    if (!pool) return 0;
    const ahead = Math.max(0, pool.expected - pool.served);
    const target = Math.ceil(ahead * 1.15) + this.floor + pool.waiting;
    return target - pool.stock.length;
  }

  /** Whether any bin is short. */
  hungry(): boolean {
    for (let bin = 0; bin < this.pools.length; bin += 1) if (this.deficit(bin) > 0) return true;
    return false;
  }

  /**
   * The next `count` drops to try, each with the bin it is aimed at (null for a fresh drop). Bins with runs waiting
   * come first, then the bins furthest short of what they are expected to need; a busy bin is served by fresh drops
   * (one in a few lands there anyway, each on a path of its own), a rare one by aimed drops.
   */
  next(count: number): { drop: Drop; aimedAt: number | null }[] {
    const { random } = this.options;
    const needs: { bin: number; weight: number }[] = [];
    let total = 0;
    for (let bin = 0; bin < this.pools.length; bin += 1) {
      const pool = this.pools[bin]!;
      const short = this.deficit(bin);
      if (short <= 0) continue;
      const weight = short * (pool.waiting > 0 ? 12 : 1);
      needs.push({ bin, weight });
      total += weight;
    }
    const drops: { drop: Drop; aimedAt: number | null }[] = [];
    const aimable = Math.floor(count * (1 - FRESH_SHARE));
    for (let i = 0; i < count; i += 1) {
      let aimedAt: number | null = null;
      if (needs.length > 0 && i < aimable) {
        let pick = random() * total;
        let chosen = needs[needs.length - 1]!.bin;
        for (const need of needs) {
          pick -= need.weight;
          if (pick <= 0) {
            chosen = need.bin;
            break;
          }
        }
        if (this.rare(chosen)) aimedAt = chosen;
      }
      drops.push(aimedAt === null ? { drop: this.fresh(0), aimedAt } : { drop: this.aim(aimedAt), aimedAt });
    }
    this.stats.tried += drops.length;
    this.stats.aimed += drops.filter((entry) => entry.aimedAt !== null).length;
    return drops;
  }

  /** A drop aimed at a bin: one of its seeds, jittered; a fresh drop nudged its way when it has none yet. */
  private aim(bin: number): Drop {
    const pool = this.pools[bin]!;
    if (pool.seeds.length === 0) return this.fresh(this.options.sideOf(bin));
    const seed = pool.seeds[pool.nextSeed % pool.seeds.length]!;
    pool.nextSeed += 1;
    const { random, release } = this.options;
    const x = Math.min(release.xMax, Math.max(release.xMin, seed.x + normal(random) * pool.spread));
    const vx = Math.max(-this.maxPush * 2, Math.min(this.maxPush * 2, seed.vx + normal(random) * pool.spread * 2));
    const spin = seed.spin + normal(random) * pool.spread * 4;
    return { x, vx, spin };
  }

  /** A drop anywhere across the hopper's mouth; with a side, from that half and pushed that way. */
  private fresh(side: -1 | 0 | 1): Drop {
    const { random, release } = this.options;
    const middle = (release.xMin + release.xMax) / 2;
    let x = release.xMin + random() * (release.xMax - release.xMin);
    let vx = (random() * 2 - 1) * this.maxPush;
    if (side !== 0) {
      x = middle + side * random() * (release.xMax - middle);
      vx = side * random() * this.maxPush * 2;
    }
    return { x, vx, spin: (random() * 2 - 1) * this.maxSpin };
  }
}

/** A small, fast seeded generator (mulberry32): the same seed tries the same drops. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

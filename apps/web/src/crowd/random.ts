/**
 * A seeded random source, so a crowd run (and every test) can be replayed exactly.
 */

/** mulberry32: small, fast and good enough for motion and choices. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class Random {
  private readonly next: () => number;

  constructor(seed: number = Date.now()) {
    this.next = mulberry32(seed);
  }

  /** In [0, 1). */
  float(): number {
    return this.next();
  }

  /** In [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** -1 or 1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items.length ? items[Math.floor(this.next() * items.length)] : undefined;
  }

  /** One item, each as likely as its weight (weights ≤ 0 are never picked). */
  weighted<T>(entries: readonly (readonly [T, number])[]): T | undefined {
    const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
    if (total <= 0) return undefined;
    let roll = this.next() * total;
    for (const [item, weight] of entries) {
      if (weight <= 0) continue;
      roll -= weight;
      if (roll < 0) return item;
    }
    return entries.find(([, weight]) => weight > 0)?.[0];
  }

  /** Normally distributed (Box-Muller). */
  gauss(mean = 0, deviation = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
      const other = Math.floor(this.next() * (index + 1));
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  }

  /** A child source with its own sequence (one per person). */
  fork(): Random {
    return new Random(Math.floor(this.next() * 4_294_967_296));
  }
}

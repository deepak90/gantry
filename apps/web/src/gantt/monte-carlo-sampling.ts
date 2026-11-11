/**
 * The dice of the odds (gantt/monte-carlo.ts) and the statistics read from the runs. A run's dice come from the
 * seed, the run's number and the task alone, so the same seed rolls the same lengths in a test and in the browser,
 * and run 412 of one question is run 412 of the next: when something changes, each dot on screen is the same roll
 * of the dice, scheduled again. Nothing here touches Bryntum.
 */

export type Id = number | string;

/** A three-point range, in multiples of the planned length: the shortest, the most likely and the longest. */
export interface ThreePoint {
  low: number;
  likely: number;
  high: number;
}

/**
 * What kind of work a task is, which decides how much its length can vary: outdoor work in winter (site, concrete,
 * steel, roofing and envelope from November to March) the most, inspections and tests only ever longer.
 */
export type WorkKind = 'winter' | 'outdoor' | 'indoor' | 'inspection';

export const WORK_KINDS: readonly WorkKind[] = ['winter', 'outdoor', 'indoor', 'inspection'];

// ---------------------------------------------------------------------------------------------
// A seeded generator
// ---------------------------------------------------------------------------------------------

/** A 32-bit integer hash with a good spread from neighboring inputs (Chris Wellons' lowbias32). */
function hash32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** A task's key for its dice: its id, so adding a task elsewhere never changes another task's rolls. */
export function diceKey(id: Id): number {
  if (typeof id === 'number' && Number.isInteger(id)) return hash32(id ^ 0x27d4eb2d);
  // FNV-1a over the text of anything else (a new task's temporary id).
  let h = 0x811c9dc5;
  for (const char of String(id)) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h);
}

const TWO_32 = 4_294_967_296;

/** Two independent uniform numbers in [0, 1) for one task in one run. */
export function dice(seed: number, run: number, key: number): [number, number] {
  const h = hash32(hash32(hash32(seed) ^ hash32(run + 0x9e3779b9)) ^ key);
  return [hash32(h ^ 0x68e31da4) / TWO_32, hash32(h ^ 0xb5297a4d) / TWO_32];
}

// ---------------------------------------------------------------------------------------------
// Lengths
// ---------------------------------------------------------------------------------------------

/** A draw from a three-point (triangular) range, by its inverse distribution: `u` is uniform in [0, 1). */
export function triangular({ low, likely, high }: ThreePoint, u: number): number {
  if (!(high > low)) return low;
  const mode = Math.min(Math.max(likely, low), high);
  const split = (mode - low) / (high - low);
  return u < split ? low + Math.sqrt(u * (high - low) * (mode - low)) : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
}

/**
 * A length in whole units that keeps the drawn length's average: 3.3 days is 4 days three times in ten and 3 days
 * otherwise (`v` is uniform in [0, 1)). Rounding to the nearest day instead would keep every short task at its
 * planned length, whatever its range says.
 */
export function wholeUnits(length: number, v: number): number {
  const floor = Math.floor(length);
  return floor + (v < length - floor ? 1 : 0);
}

export interface Drawn {
  /** The planned length, in the task's own unit. */
  planned: number;
  /** The share of it already done (0 to 1): done work does not vary. */
  done: number;
}

/**
 * A task's length in one run: what is done stays, what is left is drawn from its range, in whole units, and work
 * that was planned to take time takes at least one unit.
 */
export function drawnLength({ planned, done }: Drawn, range: ThreePoint, u: number, v: number): number {
  const finished = planned * Math.min(1, Math.max(0, done));
  const length = finished + (planned - finished) * triangular(range, u);
  if (planned < 1) return length;
  return Math.max(1, Math.ceil(finished - 1e-9), wholeUnits(length, v));
}

// ---------------------------------------------------------------------------------------------
// Kinds of work
// ---------------------------------------------------------------------------------------------

const INSPECTION = /\b(inspect\w*|tests?|testing|commission\w*|certif\w*|walk-?through|sign-?off)\b/i;
const OUTDOOR = /\b(site|mobiliz\w*|excavat\w*|footings?|foundations?|backfill|grade|gravel|slab|pour\w*|concrete|rebar|forms?|formwork|shoring|cur(e|ing)|steel|deck|roof\w*|curtain wall|envelope|fa[cç]ade|cladding|masonry|brick\w*|paving|asphalt|landscap\w*|storefront|glaz\w*|windows?|earthwork|utilit\w*|trench\w*|piles?|piling|crane|structure)\b/i;
const OUTDOOR_TRADES = /earthwork|sitework|excavat|concrete|structural steel|steel erect|roofing|curtain wall|glazing|masonry|paving|landscap/i;
/** November to March. */
const WINTER_MONTHS = new Set([10, 11, 0, 1, 2]);

export interface KindClues {
  /** The task's own name. */
  name: string;
  /** The names of the groups it sits in, nearest first. */
  groups: readonly string[];
  /** The trades of the crews on it. */
  trades: readonly string[];
  /** When it starts in the plan. */
  start: Date | null;
}

/** What kind of work this is, from its name, its groups and its crews' trades. */
export function workKind({ name, groups, trades, start }: KindClues): WorkKind {
  if (INSPECTION.test(name)) return 'inspection';
  const outdoor = OUTDOOR.test(name) || trades.some((trade) => OUTDOOR_TRADES.test(trade)) || groups.some((group) => OUTDOOR.test(group));
  if (!outdoor) return 'indoor';
  return start && WINTER_MONTHS.has(start.getMonth()) ? 'winter' : 'outdoor';
}

// ---------------------------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A calendar day as a whole number (days since 1970-01-01, by the local date): safe across daylight saving. */
export const dayNumber = (date: Date): number => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);

/** The local midnight of a day number. */
export function dateOfDay(day: number): Date {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/** 0 is Sunday, as `Date.getDay`. */
export const weekdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7;

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

/** The value at or below which `q` of the values lie (nearest rank: always one of the values). */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const rank = Math.min(n, Math.max(1, Math.ceil(q * n - 1e-9)));
  return sorted[rank - 1]!;
}

/** Sorted copy, as numbers. */
export function sortedCopy(values: ArrayLike<number>): Float64Array {
  return Float64Array.from(values as ArrayLike<number>).sort();
}

/** Ranks from 1, ties sharing their average rank. */
export function ranks(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const order = Array.from({ length: n }, (_, index) => index).sort((a, b) => values[a]! - values[b]!);
  const out = new Float64Array(n);
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && values[order[end + 1]!] === values[order[start]!]) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) out[order[k]!] = rank;
    start = end + 1;
  }
  return out;
}

/** Pearson's correlation; 0 when either side doesn't vary. */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : 0;
}

/** Spearman's rank correlation: how closely one follows the other, whatever the shape. */
export function rankCorrelation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return correlation(ranks(a), ranks(b));
}

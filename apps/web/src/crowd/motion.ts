/**
 * How a hand moves a mouse, in screen pixels. A reach is a curved, ballistic primary movement whose
 * speed rises and falls like a bell (the minimum-jerk profile along the path), lasting about as long
 * as Fitts' law says for that distance and target size; it usually ends a little past the target (or
 * short of it) and a small corrective movement settles on it. On top of that the motor (hand.ts) adds
 * a faint tremor and the pauses, reading drifts and hesitations around clicks. No straight lines, no
 * constant speeds.
 *
 * Pure functions over a seeded random source: tests check the shapes, the crowd plays them back.
 */
import type { Random } from './random';

export interface Vec {
  x: number;
  y: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A movement through time: `at(0)` is where it starts, `at(duration)` (and later) where it ends. */
export interface Path {
  duration: number;
  at(t: number): Vec;
  readonly start: Vec;
  readonly end: Vec;
}

export interface MoveOptions {
  /** Size of what is aimed at (a cell, a bar end): small targets take longer and are approached more carefully. */
  targetWidth?: number;
  /** Slower (2) or quicker (0.8) than a usual reach. */
  pace?: number;
  /** Whether the reach may overshoot or fall short and correct (default: when the distance is worth it). */
  correct?: boolean;
  /** How much the path may bow sideways, as a share of the distance (default about 0.05 to 0.3). */
  bow?: number;
  bounds?: Bounds;
}

const distance = (a: Vec, b: Vec) => Math.hypot(b.x - a.x, b.y - a.y);
const add = (a: Vec, b: Vec, scale = 1): Vec => ({ x: a.x + b.x * scale, y: a.y + b.y * scale });

export function clampToBounds(point: Vec, bounds: Bounds | undefined): Vec {
  if (!bounds) return point;
  return { x: Math.min(bounds.right, Math.max(bounds.left, point.x)), y: Math.min(bounds.bottom, Math.max(bounds.top, point.y)) };
}

/** Minimum-jerk position profile: 0 → 1 with zero speed and acceleration at both ends. */
export function minimumJerk(tau: number): number {
  const t = Math.min(1, Math.max(0, tau));
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

/** Fitts' law (Shannon form): a reach of `distance` px to a target `width` px wide, in ms. */
export function fittsDuration(distancePx: number, widthPx: number): number {
  const width = Math.max(4, widthPx);
  return 170 + 135 * Math.log2(distancePx / width + 1);
}

function cubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/**
 * One smooth stroke along a cubic Bézier, timed by the minimum-jerk profile over its arc length (so the
 * speed bell is along the curve, not distorted by the curve's parameterisation).
 */
export function strokePath(points: readonly [Vec, Vec, Vec, Vec], duration: number, bounds?: Bounds): Path {
  const [p0, p1, p2, p3] = points;
  const steps = 48;
  const lengths: number[] = [0];
  let previous = p0;
  for (let index = 1; index <= steps; index++) {
    const point = cubic(p0, p1, p2, p3, index / steps);
    lengths.push(lengths[index - 1]! + distance(previous, point));
    previous = point;
  }
  const total = lengths[steps]!;
  const at = (t: number): Vec => {
    if (t >= duration || total === 0) return clampToBounds(p3, bounds);
    if (t <= 0) return clampToBounds(p0, bounds);
    const wanted = minimumJerk(t / duration) * total;
    let index = 1;
    while (index < steps && lengths[index]! < wanted) index++;
    const before = lengths[index - 1]!;
    const span = lengths[index]! - before || 1;
    const u = (index - 1 + (wanted - before) / span) / steps;
    return clampToBounds(cubic(p0, p1, p2, p3, u), bounds);
  };
  return { duration: Math.max(1, duration), at, start: clampToBounds(p0, bounds), end: clampToBounds(p3, bounds) };
}

/** Paths one after another. */
export function chain(paths: readonly Path[]): Path {
  const parts = paths.filter((path) => path.duration > 0);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) throw new Error('chain() needs at least one path');
  const duration = parts.reduce((sum, path) => sum + path.duration, 0);
  return {
    duration,
    start: first.start,
    end: last.end,
    at(t) {
      let rest = t;
      for (const path of parts) {
        if (rest <= path.duration) return path.at(rest);
        rest -= path.duration;
      }
      return last.end;
    },
  };
}

/** Standing still at a point for a while. */
export function holdPath(point: Vec, duration: number): Path {
  return { duration: Math.max(1, duration), at: () => point, start: point, end: point };
}

/** Control points for a bowed stroke from `from` to `to`: `bow` is the sideways bulge as a share of the distance. */
function bowed(from: Vec, to: Vec, bow: number, random: Random): [Vec, Vec, Vec, Vec] {
  const length = distance(from, to) || 1;
  const along = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  const across = { x: -along.y, y: along.x };
  const first = bow * random.range(0.7, 1.2);
  // Mostly an arc (both control points to one side, fading toward the target); now and then an S.
  const second = random.chance(0.15) ? -first * random.range(0.3, 0.7) : first * random.range(0.25, 0.9);
  const c1 = add(add(from, along, length * random.range(0.18, 0.38)), across, length * first);
  const c2 = add(add(from, along, length * random.range(0.62, 0.86)), across, length * second);
  return [from, c1, c2, to];
}

/**
 * A reach from `from` to `to`: curved, bell-shaped speed, about as long as Fitts' law says, and for
 * reaches worth it a primary movement that ends a little past (or short of) the target followed by a
 * short correction.
 */
export function planMove(from: Vec, to: Vec, random: Random, options: MoveOptions = {}): Path {
  const length = distance(from, to);
  const pace = options.pace ?? 1;
  const width = options.targetWidth ?? 24;
  if (length < 1.5) return holdPath(to, random.range(30, 80));
  const bow = (options.bow ?? random.range(0.05, 0.3)) * random.sign();
  const duration = fittsDuration(length, width) * random.range(0.85, 1.2) * pace;
  const corrects = options.correct ?? length > 60;
  if (!corrects) return strokePath(bowed(from, to, bow, random), duration, options.bounds);

  const along = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  const across = { x: -along.y, y: along.x };
  // Overshoot about two times in three; the error grows with the distance, within a few percent.
  const over = random.chance(0.65);
  const error = length * (over ? random.range(0.03, 0.085) : -random.range(0.02, 0.06));
  const miss = add(add(to, along, error), across, length * random.range(-0.02, 0.02));
  const primary = strokePath(bowed(from, miss, bow, random), duration * random.range(0.82, 0.9), options.bounds);
  const gap = distance(miss, to);
  const settle = holdPath(primary.end, random.range(20, 70));
  const correction = strokePath(bowed(primary.end, to, random.range(-0.15, 0.15), random), (110 + gap * 6) * random.range(0.9, 1.3) * pace, options.bounds);
  return chain([primary, settle, correction]);
}

/**
 * Slow drift while reading or thinking: a few small, unhurried strokes from `from` within `radius`,
 * mostly along `heading` (left to right when reading across a row), with pauses between them.
 */
export function planDrift(from: Vec, random: Random, options: { duration: number; radius?: number; heading?: Vec; bounds?: Bounds }): Path {
  const radius = options.radius ?? 30;
  const heading = options.heading ?? { x: 0, y: 0 };
  const parts: Path[] = [];
  let at = from;
  let left = options.duration;
  while (left > 40) {
    if (random.chance(0.45)) {
      const pause = Math.min(left, random.range(150, 700));
      parts.push(holdPath(at, pause));
      left -= pause;
      continue;
    }
    const step = random.range(radius * 0.15, radius * 0.6);
    const angle = random.range(0, Math.PI * 2);
    let next = add(at, { x: Math.cos(angle) * step + heading.x * step, y: Math.sin(angle) * step * 0.5 + heading.y * step });
    // Never wander off: past the radius the stroke turns back toward where the drift began.
    if (distance(next, from) > radius) next = add(from, { x: (next.x - from.x) * 0.4, y: (next.y - from.y) * 0.4 });
    next = clampToBounds(next, options.bounds);
    const duration = Math.min(left, random.range(280, 900));
    parts.push(strokePath(bowed(at, next, random.range(-0.25, 0.25), random), duration, options.bounds));
    at = next;
    left -= duration;
  }
  return parts.length ? chain(parts) : holdPath(from, Math.max(1, options.duration));
}

/**
 * A hand is never perfectly still: a few small sines at physiological tremor frequencies (6 to 11 Hz,
 * a fraction of a pixel to a pixel) and a slower sway. Deterministic for a given random source.
 */
export class Tremor {
  private readonly waves: { ax: number; ay: number; fx: number; fy: number; px: number; py: number }[];

  constructor(random: Random, amplitude = 0.8) {
    this.waves = [
      { ax: amplitude * 0.5, ay: amplitude * 0.45, fx: random.range(6, 11), fy: random.range(6, 11), px: random.range(0, 6.3), py: random.range(0, 6.3) },
      { ax: amplitude * 0.3, ay: amplitude * 0.35, fx: random.range(8, 12), fy: random.range(8, 12), px: random.range(0, 6.3), py: random.range(0, 6.3) },
      { ax: amplitude * 1.4, ay: amplitude * 1.1, fx: random.range(0.2, 0.6), fy: random.range(0.2, 0.6), px: random.range(0, 6.3), py: random.range(0, 6.3) },
    ];
  }

  /** The offset at `t` ms, scaled by `level` (0 while moving fast: the reach hides it). */
  at(t: number, level = 1): Vec {
    let x = 0;
    let y = 0;
    for (const wave of this.waves) {
      x += wave.ax * Math.sin((t / 1000) * 2 * Math.PI * wave.fx + wave.px);
      y += wave.ay * Math.sin((t / 1000) * 2 * Math.PI * wave.fy + wave.py);
    }
    return { x: x * level, y: y * level };
  }
}

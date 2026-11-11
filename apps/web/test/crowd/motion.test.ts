import { describe, expect, it } from 'vitest';
import { fittsDuration, minimumJerk, planDrift, planMove, Tremor, type Path, type Vec } from '../../src/crowd/motion';
import { Random } from '../../src/crowd/random';

const samples = (path: Path, stepMs = 5): { t: number; p: Vec }[] => {
  const out: { t: number; p: Vec }[] = [];
  for (let t = 0; t <= path.duration; t += stepMs) out.push({ t, p: path.at(t) });
  out.push({ t: path.duration, p: path.at(path.duration) });
  return out;
};

/** Distance of `p` from the straight line through `a` and `b`. */
const offLine = (p: Vec, a: Vec, b: Vec) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y);

const FROM = { x: 120, y: 140 };
const TO = { x: 980, y: 520 };
const LENGTH = Math.hypot(TO.x - FROM.x, TO.y - FROM.y);

describe('the motion model', () => {
  it('moves along curves, not straight lines', () => {
    let curved = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const path = planMove(FROM, TO, new Random(seed), { correct: false });
      const bulge = Math.max(...samples(path).map(({ p }) => offLine(p, FROM, TO)));
      if (bulge > LENGTH * 0.03) curved++;
    }
    expect(curved).toBeGreaterThanOrEqual(38);
  });

  it('speeds up and slows down (a bell, not a constant speed), and the duration follows Fitts’ law', () => {
    const path = planMove(FROM, TO, new Random(7), { correct: false });
    const points = samples(path, 10);
    const speeds = points.slice(1).map((sample, index) => Math.hypot(sample.p.x - points[index]!.p.x, sample.p.y - points[index]!.p.y) / 10);
    const peak = Math.max(...speeds);
    const tenth = Math.floor(speeds.length / 10);
    const startSpeed = Math.max(...speeds.slice(0, tenth));
    const endSpeed = Math.max(...speeds.slice(-tenth));
    expect(peak).toBeGreaterThan(startSpeed * 2.5);
    expect(peak).toBeGreaterThan(endSpeed * 2.5);
    // The fastest moment is in the middle half.
    const peakAt = speeds.indexOf(peak) / speeds.length;
    expect(peakAt).toBeGreaterThan(0.25);
    expect(peakAt).toBeLessThan(0.75);
    expect(minimumJerk(0)).toBe(0);
    expect(minimumJerk(0.5)).toBeCloseTo(0.5, 6);
    expect(minimumJerk(1)).toBe(1);
    expect(fittsDuration(800, 20)).toBeGreaterThan(fittsDuration(200, 20));
    expect(fittsDuration(400, 10)).toBeGreaterThan(fittsDuration(400, 80));
    expect(path.duration).toBeGreaterThan(400);
    expect(path.duration).toBeLessThan(1_500);
  });

  it('overshoots (or falls short) and settles exactly on the target', () => {
    let overshoots = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const path = planMove(FROM, TO, new Random(seed));
      const along = { x: (TO.x - FROM.x) / LENGTH, y: (TO.y - FROM.y) / LENGTH };
      const reach = Math.max(...samples(path).map(({ p }) => (p.x - FROM.x) * along.x + (p.y - FROM.y) * along.y));
      if (reach > LENGTH + 3) overshoots++;
      const end = path.at(path.duration + 50);
      expect(Math.hypot(end.x - TO.x, end.y - TO.y)).toBeLessThan(0.01);
    }
    // About two in three overshoot; the others fall short and correct forwards.
    expect(overshoots).toBeGreaterThan(25);
    expect(overshoots).toBeLessThan(55);
  });

  it('stays inside the screen even when aiming at its edge', () => {
    const bounds = { left: 4, top: 2, right: 1586, bottom: 716 };
    for (let seed = 1; seed <= 30; seed++) {
      const random = new Random(seed);
      const path = planMove({ x: 800, y: 360 }, { x: random.pick([bounds.left, bounds.right])!, y: random.range(bounds.top, bounds.bottom) }, random, { bounds });
      for (const { p } of samples(path)) {
        expect(p.x).toBeGreaterThanOrEqual(bounds.left);
        expect(p.x).toBeLessThanOrEqual(bounds.right);
        expect(p.y).toBeGreaterThanOrEqual(bounds.top);
        expect(p.y).toBeLessThanOrEqual(bounds.bottom);
      }
    }
  });

  it('drifts slowly while reading, within reach of where it started', () => {
    const start = { x: 400, y: 300 };
    const path = planDrift(start, new Random(3), { duration: 3_000, radius: 40, heading: { x: 1, y: 0 } });
    expect(path.duration).toBeCloseTo(3_000, -2);
    const points = samples(path, 20);
    for (const { p } of points) expect(Math.hypot(p.x - start.x, p.y - start.y)).toBeLessThan(60);
    const traveled = points.slice(1).reduce((sum, sample, index) => sum + Math.hypot(sample.p.x - points[index]!.p.x, sample.p.y - points[index]!.p.y), 0);
    expect(traveled).toBeGreaterThan(5);
    // Under 120 px a second on average: reading, not reaching.
    expect(traveled / 3).toBeLessThan(120);
  });

  it('trembles a little, never much', () => {
    const tremor = new Tremor(new Random(5));
    const offsets = Array.from({ length: 200 }, (_, index) => tremor.at(index * 7));
    const largest = Math.max(...offsets.map((offset) => Math.hypot(offset.x, offset.y)));
    expect(largest).toBeGreaterThan(0.3);
    expect(largest).toBeLessThan(4);
    expect(Math.hypot(tremor.at(100, 0).x, tremor.at(100, 0).y)).toBe(0);
  });
});

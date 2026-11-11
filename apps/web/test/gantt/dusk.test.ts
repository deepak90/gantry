/** The film's dusk shot: the evening comes down, then the floors come on one after another, in about 4 s for three. */
import { describe, expect, it } from 'vitest';
import { duskAt, duskSeconds } from '../../src/gantt/fx3d/dusk';

describe('the dusk shot', () => {
  it('runs a little over 3 s for three floors', () => {
    expect(duskSeconds(3)).toBeGreaterThan(2.9);
    expect(duskSeconds(3)).toBeLessThan(4.2);
  });

  it('starts in the day with every floor dark, and ends in the evening with every floor on', () => {
    expect(duskAt(0, 3)).toEqual({ evening: 0, floors: [0, 0, 0], done: false });
    expect(duskAt(duskSeconds(3), 3)).toEqual({ evening: 1, floors: [1, 1, 1], done: true });
  });

  it('brings the floors on lowest first, each within a second, with the next starting after it', () => {
    const onAt = (floor: number, level: number) => {
      for (let t = 0; t < 6; t += 0.01) if ((duskAt(t, 3).floors[floor] ?? 0) >= level) return t;
      return Infinity;
    };
    for (const floor of [0, 1, 2]) expect(onAt(floor, 0.99) - onAt(floor, 0.01)).toBeLessThan(1);
    expect(onAt(1, 0.01)).toBeGreaterThan(onAt(0, 0.5));
    expect(onAt(2, 0.01)).toBeGreaterThan(onAt(1, 0.5));
  });

  it('has the evening most of the way down before the first floor comes on', () => {
    const start = [...Array(500).keys()].map((n) => n / 100).find((t) => (duskAt(t, 3).floors[0] ?? 0) > 0)!;
    expect(duskAt(start, 3).evening).toBeGreaterThan(0.8);
  });

  it('holds for a floorless plan and still ends', () => {
    expect(duskAt(10, 0)).toEqual({ evening: 1, floors: [], done: true });
  });
});

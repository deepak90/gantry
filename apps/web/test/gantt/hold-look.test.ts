/**
 * The held link's stop mark (gantt/hold-look.ts): the Gantt draws a link from the held work back to the payment, so the
 * mark goes on the upright stretch nearest the payment, close to the payment's end of it, with the line broken around
 * it and the mark's strokes after the line's (the arrowhead is the path's start marker, so it stays on the held work).
 */
import { describe, expect, it } from 'vitest';
import { stopMarkPath } from '../../src/gantt/hold-look';

// Harbor's footings payment into its gravel base, as Bryntum's path finder gives it: from the gravel back to the payment.
const link = [
  { x1: 644.8, y1: 483, x2: 632.8, y2: 483 },
  { x1: 632.8, y1: 483, x2: 632.8, y2: 460 },
  { x1: 632.8, y1: 460, x2: 670.8, y2: 460 },
  { x1: 670.8, y1: 460, x2: 670.8, y2: 391 },
  { x1: 670.8, y1: 391, x2: 658.8, y2: 391 },
];

describe('the stop mark on a held link', () => {
  it('sits on the upright stretch leaving the payment, near the payment, and breaks the line around it', () => {
    const d = stopMarkPath(link, 6.5, 0)!;
    // The line still starts at the held work (where the arrowhead is drawn) and ends at the payment.
    expect(d.startsWith('M 644.8 483')).toBe(true);
    const circle = /M ([\d.]+) ([\d.]+) a 6.5 6.5 0 1 0 13 0/.exec(d)!;
    const [cx, cy] = [Number(circle[1]) + 6.5, Number(circle[2])];
    expect(cx).toBeCloseTo(670.8, 1);
    // 22 px down from the payment's end of the stretch, between the payment's row and the held work's.
    expect(cy).toBeCloseTo(391 + 22, 1);
    // A gap in the line around it, the mark drawn after the line.
    expect(d).toContain(`L 670.8 ${f(cy + 9)} M 670.8 ${f(cy - 9)}`);
    expect(d.indexOf(' a ')).toBeGreaterThan(d.lastIndexOf('L 658.8 391'));
  });

  it('rounds the line’s corners as Bryntum does, when it has a radius', () => {
    expect(stopMarkPath(link, 6.5, 5)).toContain('Q 632.8 483');
  });

  it('draws no mark where no stretch has room for it', () => {
    expect(stopMarkPath([{ x1: 0, y1: 0, x2: 10, y2: 0 }], 6.5)).toBeNull();
    expect(stopMarkPath([], 6.5)).toBeNull();
  });
});

const f = (value: number) => String(Math.round(value * 10) / 10);

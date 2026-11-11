/**
 * Where the coach's note goes: under a control in the header or the toolbar, beside anything lower down on its roomier
 * side, and never over the header, where the steps and the header's buttons are.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placeNote, type Box, type Spot } from '../../src/onboarding/StoryCoach';

const HEADER = 58;
const spot = (box: Box, onTab = false): Spot => ({ key: 'k', ...box, onTab, from: null, floor: HEADER });
const around = (box: Box): Box => ({ top: box.top - 5, left: box.left - 5, width: box.width + 10, height: box.height + 10 });

let width = 0;
let height = 0;
beforeEach(() => {
  width = window.innerWidth;
  height = window.innerHeight;
  Object.assign(window, { innerWidth: 1440, innerHeight: 900 });
});
afterEach(() => Object.assign(window, { innerWidth: width, innerHeight: height }));

describe('the coach’s note', () => {
  it('goes under a control in the toolbar, clear of the header', () => {
    const siteView = { top: 69, left: 433, width: 90, height: 26 };
    const { style, from } = placeNote(spot(siteView), around(siteView));
    expect(style.top).toBe(69 + 26 + 5 + 10);
    expect(style.left).toBe(428);
    expect(from).toEqual({ y: -6 });
  });

  it('goes under a control in the header too, kept inside the window', () => {
    const callRemy = { top: 13, left: 1131, width: 115, height: 30 };
    const { style } = placeNote(spot(callRemy), around(callRemy));
    expect(style.top).toBeGreaterThanOrEqual(HEADER + 10);
    expect(Number(style.left) + 284).toBeLessThanOrEqual(1440 - 10);
  });

  it('keeps clear of the side panel’s tabs when the control is near them', () => {
    const callRemy = { top: 13, left: 1290, width: 115, height: 30 };
    const { style } = placeNote({ ...spot(callRemy), edge: 1366 }, around(callRemy));
    expect(Number(style.left) + 284).toBeLessThanOrEqual(1366 - 10);
  });

  it('goes beside a control lower down, on its roomier side, never above the header', () => {
    const libraryCard = { top: 300, left: 1000, width: 300, height: 60 };
    const right = placeNote(spot(libraryCard), around(libraryCard));
    expect(right.style.right).toBe(1440 - 995 + 10);
    expect(right.style.top).toBe(300 + 30 - 48);
    const tab = { top: 64, left: 1366, width: 68, height: 44 };
    const beside = placeNote(spot(tab, true), around(tab));
    expect(beside.style.right).toBeDefined();
    expect(beside.style.top).toBe(HEADER + 10);
  });
});

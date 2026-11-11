/**
 * The board's runs stacked as a building, on the real board (odds/galton/odds-galton.ts) with a stand-in stage (jsdom
 * has no WebGL: the scene is real, frames are driven by hand): Harbor's 1,000 runs side by side, paid on the Friday pay
 * run and paid today; each side stacks on its own, its phases said as they are first on screen; every marble stands in
 * its tower slot, the teal ones exactly under the deadline's floor line; on the right the 324 runs that make it only by
 * paying today light up once and are counted beside their bracket; reduced motion and `jumpTo('stacked')` go straight
 * to the end; `unstack` puts the piles back; and one board, a fresh pass and a drain all work from the towers.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Color, InstancedMesh, Matrix4, Vector3, type Object3D } from 'three';
import { HARBOR_CONTRACT_DATE, isWorkingDay } from '@collab/shared/seed';
import { boardLayout, defaultRange, workingDays } from '../../src/odds/galton/board';
import { floorLine, sharedOrder, towerLayout, towerSlot, type TowerRun } from '../../src/odds/galton/tower';
import type { GaltonPhase, OddsGalton } from '../../src/odds/galton/odds-galton';

const stage = vi.hoisted(() => ({
  frame: null as null | ((now: number) => boolean),
  drawn: null as null | ((now: number) => void),
  scene: null as null | { children: Object3D[] },
}));

vi.mock('../../src/odds/galton/stage', async () => {
  const three = await import('three');
  return {
    createStage(container: HTMLElement, options: { frame(now: number): boolean; drawn?(now: number): void }) {
      stage.frame = options.frame;
      stage.drawn = options.drawn ?? null;
      const canvas = document.createElement('canvas');
      container.prepend(canvas);
      const scene = new three.Scene();
      stage.scene = scene;
      return {
        canvas,
        renderer: {},
        scene,
        camera: new three.PerspectiveCamera(20, 16 / 9, 4, 6000),
        size: { width: 1600, height: 900 },
        fitShadow() {},
        setGround() {},
        setBackground() {},
        wake() {},
        warm: async () => undefined,
        dispose() {},
      };
    },
  };
});

const { createOddsGalton } = await import('../../src/odds/galton/odds-galton');

const DAY = 86_400_000;
const dayOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;
const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const nonWorking = (day: number) => !isWorkingDay(isoOf(day), 'standard');
const CONTRACT = dayOf(HARBOR_CONTRACT_DATE);

/** Harbor's 1,000 runs paid today, by handover day (the engine's counts, seed 7); paid Friday, each is three working days later. */
const PAID_TODAY: [string, number][] = [
  ['2027-05-27', 5], ['2027-05-28', 13], ['2027-06-01', 25], ['2027-06-02', 50], ['2027-06-03', 85], ['2027-06-04', 108],
  ['2027-06-07', 112], ['2027-06-08', 117], ['2027-06-09', 128], ['2027-06-10', 109], ['2027-06-11', 87], ['2027-06-14', 60],
  ['2027-06-15', 45], ['2027-06-16', 25], ['2027-06-17', 16], ['2027-06-18', 8], ['2027-06-21', 5], ['2027-06-22', 1], ['2027-06-23', 1],
];

function harborRuns() {
  const days = workingDays(CONTRACT - 40, CONTRACT + 40, nonWorking);
  const runs: number[] = [];
  const today: number[] = [];
  const friday: number[] = [];
  let k = 0;
  for (const [iso, count] of PAID_TODAY) {
    for (let i = 0; i < count; i += 1) {
      runs.push((k * 619) % 1000);
      k += 1;
      today.push(dayOf(iso));
      friday.push(days[days.indexOf(dayOf(iso)) + 3]!);
    }
  }
  return { runs, today, friday };
}

// jsdom has no 2D canvas: the board's soft shadow gets a stand-in, and its colors fall back to the board's own.
beforeAll(() => {
  const paint = new Proxy({}, { get: (_target, key) => (key === 'getImageData' ? () => ({ data: [0, 0, 0, 255] }) : () => undefined), set: () => true });
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, _kind: string, options?: { willReadFrequently?: boolean }) {
    return options?.willReadFrequently ? null : paint;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const made: { board: OddsGalton; container: HTMLElement }[] = [];
afterEach(() => {
  made.splice(0).forEach(({ board, container }) => {
    board.dispose();
    container.remove();
  });
});

let clock = 0;
/** Lets promises settle (a stack resolves once its tower stands). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** One frame drawn, `ms` after the last one (the board's motion runs on the frames' own times). */
function tick(ms = 16): void {
  clock = Math.max(clock, performance.now()) + ms;
  stage.frame!(clock);
  stage.drawn?.(clock);
}
/** Frames for `ms`, every 16 ms. */
function play(ms: number): void {
  for (let t = 0; t < ms; t += 16) tick(16);
}

async function sideBySide(options: { reducedMotion?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const phases: GaltonPhase[] = [];
  const board = createOddsGalton(container, { size: 'hero', reducedMotion: options.reducedMotion ?? false, onPhase: (phase) => phases.push(phase), workers: 1 });
  made.push({ board, container });
  const { runs, today, friday } = harborRuns();
  board.begin({ fresh: true, total: runs.length, contractDay: CONTRACT, nonWorking, plannedDay: dayOf('2027-05-27') });
  await Promise.resolve();
  board.land(runs.map((run, i) => ({ run, day: friday[i]! })));
  board.settle();
  play(1200);
  expect(phases).toContain('result');
  board.compare({ runs, days: friday }, { runs, days: today });
  tick();
  expect(phases.at(-1)).toBe('compare');
  return { board, container, phases, runs, today, friday };
}

/** Each board's marbles as the scene has them: where each one is, its size, and whether it is the on-time color. */
function marblesOf(boardIndex: number): { x: number; y: number; scale: number; color: Color }[] {
  const groups = stage.scene!.children.filter((child) => child.type === 'Group');
  const group = groups[boardIndex]!;
  const mesh = group.children.find((child): child is InstancedMesh => child instanceof InstancedMesh && (child.geometry as { type: string }).type === 'SphereGeometry')!;
  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const out: { x: number; y: number; scale: number; color: Color }[] = [];
  for (let i = 0; i < mesh.count; i += 1) {
    mesh.getMatrixAt(i, matrix);
    position.setFromMatrixPosition(matrix);
    scale.setFromMatrixScale(matrix);
    const color = new Color();
    mesh.getColorAt(i, color);
    out.push({ x: position.x, y: position.y, scale: scale.x, color });
  }
  return out;
}

const TEAL = new Color('#14857b');
const AMBER = new Color('#d38a1f');
const close = (a: Color, b: Color) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.02;
const towerOf = () => {
  const { runs, today, friday } = harborRuns();
  const left: TowerRun[] = runs.map((run, i) => ({ run, day: friday[i]!, onTime: friday[i]! <= CONTRACT }));
  const right: TowerRun[] = runs.map((run, i) => ({ run, day: today[i]!, onTime: today[i]! <= CONTRACT }));
  return sharedOrder(left, right)!;
};

describe('the runs stacked as a building', () => {
  it('stacks the Friday board on its own: its phases said once on screen, every marble in its slot, teal exactly under the floor line', async () => {
    const { board, container, phases } = await sideBySide();
    let stood = false;
    void board.stack('left').then(() => (stood = true));
    expect(board.isStacked('left')).toBe(true);
    expect(board.isStacked('right')).toBe(false);
    // Nothing said until it is on screen.
    expect(phases.at(-1)).toBe('compare');
    tick();
    expect(phases.at(-1)).toBe('stacking');
    play(1000);
    expect(stood).toBe(false);
    play(2200);
    await flush();
    expect(stood).toBe(true);
    expect(phases.slice(-2)).toEqual(['stacking', 'stacked']);
    const marbles = marblesOf(0);
    expect(marbles).toHaveLength(1000);
    // Every marble in a slot of the tower, each slot taken once, at the tower's size.
    const tower = towerLayout(boardShapeOf(), 1000);
    const slots = new Map<string, number>();
    for (let k = 0; k < 1000; k += 1) {
      const at = towerSlot(tower, k);
      slots.set(`${at.x.toFixed(2)},${at.y.toFixed(2)}`, k);
    }
    const taken = new Set<number>();
    const line = floorLine(tower, 515);
    for (const marble of marbles) {
      const k = slots.get(`${marble.x.toFixed(2)},${marble.y.toFixed(2)}`);
      expect(k, `a marble at ${marble.x}, ${marble.y}`).toBeDefined();
      taken.add(k!);
      expect(marble.scale).toBeCloseTo(tower.scale);
      // Teal exactly under the line: the 515 that hand over by Fri, Jun 11 when paid on the Friday pay run.
      expect(close(marble.color, k! < 515 ? TEAL : AMBER), `slot ${k}`).toBe(true);
      const lineY = marble.x < line.stepX ? line.leftY : line.rightY;
      expect(marble.y < lineY).toBe(k! < 515);
    }
    expect(taken.size).toBe(1000);
    expect(tower.floors).toBe(10);
    // The deadline's name at the end of its floor line; the bins' dates gone with the bins.
    const floorLabel = container.querySelector<HTMLElement>('.galton-deadline.is-floor')!;
    expect(floorLabel.textContent).toBe('Deadline · Fri, Jun 11');
    expect(floorLabel.style.visibility).not.toBe('hidden');
    // The other board keeps its piles.
    expect(Math.max(...marblesOf(1).map((marble) => marble.y))).toBeLessThan(45);
    expect(container.querySelector('.galton-band')).toBeNull();
  });

  it('stacks the pay-today board in the same order: 839 under its line, the 324 between the lines lit once and counted', async () => {
    const { board, container, phases } = await sideBySide();
    await standAll(board, 'left');
    void board.stack('right');
    tick();
    expect(phases.at(-1)).toBe('stacking');
    const order = towerOf().order;
    const tower = towerLayout(boardShapeOf(), 1000);
    // Mid-way through the light: the band brighter than the rest of the teal.
    let lit = false;
    for (let t = 0; t < 4000 && !lit; t += 16) {
      tick(16);
      const marbles = marblesOf(1);
      const inBand = marbles.filter((marble) => {
        const k = slotIndex(tower, marble);
        return k !== null && k >= 515 && k < 839;
      });
      if (inBand.length === 324 && inBand.every((marble) => marble.color.r > TEAL.r + 0.05)) lit = true;
    }
    expect(lit).toBe(true);
    play(2500);
    expect(phases.at(-1)).toBe('stacked');
    for (const marble of marblesOf(1)) {
      const k = slotIndex(tower, marble);
      expect(k).not.toBeNull();
      expect(close(marble.color, k! < 839 ? TEAL : AMBER), `slot ${k}`).toBe(true);
    }
    expect(order).toHaveLength(1000);
    // Counted, not typed in: the runs between the two lines.
    const band = container.querySelector<HTMLElement>('.galton-band')!;
    expect(band.textContent).toBe('324 moreon time');
    expect([...container.querySelectorAll('.galton-deadline.is-floor')]).toHaveLength(2);
  });

  it('goes straight to the towers in reduced motion, and with jumpTo, its phases said in the same frame', async () => {
    const reduced = await sideBySide({ reducedMotion: true });
    let stood = false;
    void reduced.board.stack('right').then(() => (stood = true));
    await flush();
    expect(stood).toBe(true);
    tick();
    expect(reduced.phases.slice(-2)).toEqual(['stacking', 'stacked']);
    const tower = towerLayout(boardShapeOf(), 1000);
    expect(marblesOf(1).every((marble) => slotIndex(tower, marble) !== null)).toBe(true);
    reduced.board.dispose();
    made.splice(made.findIndex((entry) => entry.board === reduced.board), 1);

    const moving = await sideBySide();
    void moving.board.stack();
    tick();
    moving.board.jumpTo('stacked');
    tick();
    expect(moving.phases.at(-1)).toBe('stacked');
    expect(moving.board.isStacked('left') && moving.board.isStacked('right')).toBe(true);
    expect(marblesOf(0).every((marble) => slotIndex(tower, marble) !== null)).toBe(true);
    expect(marblesOf(1).every((marble) => slotIndex(tower, marble) !== null)).toBe(true);
  });

  it('stacks both with no side given, the right a moment after the left', async () => {
    const { board, phases } = await sideBySide();
    void board.stack();
    tick();
    expect(phases.filter((phase) => phase === 'stacking')).toHaveLength(1);
    play(1000);
    expect(phases.filter((phase) => phase === 'stacking')).toHaveLength(2);
    play(3500);
    expect(phases.filter((phase) => phase === 'stacked')).toHaveLength(2);
  });

  it('puts the piles back, and works from the towers: back to one board, a new pass, a drain', async () => {
    const { board, phases, runs, friday } = await sideBySide();
    await standAll(board);
    board.unstack('left');
    expect(board.isStacked('left')).toBe(false);
    play(1000);
    expect(phases.at(-1)).toBe('compare');
    // Back in the bins, at their own size.
    expect(Math.max(...marblesOf(0).map((marble) => marble.y))).toBeLessThan(45);
    expect(marblesOf(0).every((marble) => Math.abs(marble.scale - 1) < 1e-6)).toBe(true);
    // One board again, from towers: the answer from before the side by side, in its piles.
    board.single();
    tick();
    expect(board.isStacked()).toBe(false);
    expect(phases.at(-1)).toBe('result');
    expect(Math.max(...marblesOf(0).map((marble) => marble.y))).toBeLessThan(45);
    // A tower on the one board, then the odds asked again: it drains from the tower and pours afresh.
    await standAll(board);
    expect(board.isStacked()).toBe(true);
    board.begin({ fresh: false, total: runs.length, contractDay: CONTRACT, nonWorking });
    expect(board.isStacked()).toBe(false);
    play(1500);
    expect(phases).toContain('drained');
    board.land(runs.map((run, i) => ({ run, day: friday[i]! })));
    board.settle();
    play(1500);
    expect(phases.at(-1)).toBe('result');
    // And a fresh pass over towers side by side: one empty board.
    board.compare({ runs, days: friday }, { runs, days: friday });
    await standAll(board);
    board.begin({ fresh: true, total: runs.length, contractDay: CONTRACT, nonWorking });
    expect(board.isStacked()).toBe(false);
    expect(marblesOf(0)).toHaveLength(0);
  });

  it('does not stack while marbles are still falling', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const board = createOddsGalton(container, { size: 'hero', reducedMotion: false });
    made.push({ board, container });
    board.begin({ fresh: true, total: 10, contractDay: CONTRACT, nonWorking });
    expect(board.isStacked()).toBe(false);
    await board.stack();
    expect(board.isStacked()).toBe(false);
  });
});

/** Harbor's board as the board lays it out: the tower stands on it. */
function boardShapeOf() {
  const range = defaultRange(CONTRACT);
  return boardLayout({ days: workingDays(range.from, range.to, nonWorking), contractDay: CONTRACT, total: 1000 });
}

/** The tower slot a marble stands in, or null. */
function slotIndex(tower: ReturnType<typeof towerLayout>, marble: { x: number; y: number }): number | null {
  const column = Math.round((marble.x - tower.left) / tower.cell - 0.5);
  if (column < 0 || column >= tower.perRow) return null;
  for (let row = 0; row < tower.floors * tower.shape.rowsPerFloor; row += 1) {
    const k = row * tower.perRow + column;
    const at = towerSlot(tower, k);
    if (Math.abs(at.x - marble.x) < 1e-3 && Math.abs(at.y - marble.y) < 1e-3) return k;
  }
  return null;
}

/** Stacks (one side, or all) and plays the frames until it stands. */
async function standAll(board: OddsGalton, side?: 'left' | 'right'): Promise<void> {
  let stood = false;
  void board.stack(side).then(() => (stood = true));
  for (let t = 0; t < 8000 && !stood; t += 16) {
    tick(16);
    if (t % 400 === 0) await flush();
  }
  await flush();
  expect(stood).toBe(true);
}

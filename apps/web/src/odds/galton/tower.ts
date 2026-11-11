/**
 * The runs as a building (odds-galton.ts `stack`): a board's marbles lift out of the bins into a tower of ten floors,
 * a tenth of the runs to a floor, the earliest handover at the bottom, and the deadline becomes a floor line under the
 * runs that hand over by it. Two boards side by side stand their towers in one order of the runs, so on the second
 * board the band between the two boards' lines is exactly the runs that make it only that way.
 *
 * Numbers only, in the board's own units (marble diameters; x from the board's middle, y up from the bins' floor);
 * nothing here touches three.js or the DOM.
 */
import type { BoardLayout } from './board';

export interface TowerShape {
  /** Floors in the tower: a tenth of the runs to each. */
  floors: number;
  /** Rows of marbles to a floor. */
  rowsPerFloor: number;
  /** The room a marble has in the tower; it is drawn at `scale` of the bins' marbles. */
  cell: number;
  scale: number;
  /** Room between two floors, for the floor plate. */
  floorGap: number;
  /** How far the deadline's floor line reaches past either side of the tower. */
  lineReach: number;
}

/** A tower of 1,000 runs is 25 marbles across and ten floors of four rows: about a third of the board's width. */
export const DEFAULT_TOWER: TowerShape = { floors: 10, rowsPerFloor: 4, cell: 1.65, scale: 1.41, floorGap: 0.75, lineReach: 5.5 };

export interface TowerLayout {
  shape: TowerShape;
  /** Marbles in the tower; to a row and to a floor. */
  total: number;
  perRow: number;
  perFloor: number;
  /** Floors used (the top one may be part full). */
  floors: number;
  /** The room a marble has here (smaller than the shape's when the board is narrow), and its drawn size. */
  cell: number;
  scale: number;
  left: number;
  right: number;
  /** Where the tower stands, and its roof. */
  ground: number;
  top: number;
}

/**
 * The tower for `total` runs on a board: centered across it, and halfway up the room between the bins' floor and the
 * top row of pegs, so its lowest floors stand clear of anything laid along the bottom of the board.
 */
export function towerLayout(board: Pick<BoardLayout, 'left' | 'right' | 'binTop' | 'pegTop'>, total: number, overrides: Partial<TowerShape> = {}): TowerLayout {
  const shape: TowerShape = { ...DEFAULT_TOWER, ...overrides };
  const runs = Math.max(1, total);
  const perFloor = Math.max(1, Math.ceil(runs / shape.floors));
  const perRow = Math.max(1, Math.ceil(perFloor / shape.rowsPerFloor));
  const floors = Math.max(1, Math.ceil(runs / perFloor));
  // Narrower boards get a narrower tower: it always leaves room for the floor line either side.
  const room = board.right - board.left - 2 * (shape.lineReach + 2);
  const cell = Math.min(shape.cell, room / perRow);
  const scale = shape.scale * (cell / shape.cell);
  const height = floors * shape.rowsPerFloor * cell + (floors - 1) * shape.floorGap;
  const ground = Math.max(board.binTop * 0.35, (board.pegTop - height) / 2);
  const width = perRow * cell;
  return { shape, total: runs, perRow, perFloor, floors, cell, scale, left: -width / 2, right: width / 2, ground, top: ground + height };
}

/** The bottom of a row (rows from 0 at the ground): a floor plate's gap below the first row of every floor but the first. */
export function rowBottom(tower: TowerLayout, row: number): number {
  return tower.ground + row * tower.cell + Math.floor(row / tower.shape.rowsPerFloor) * tower.shape.floorGap;
}

/** Where the k-th marble of the tower stands (k from 0): rows from the ground up, each filled left to right. */
export function towerSlot(tower: TowerLayout, k: number): { x: number; y: number; row: number; floor: number } {
  const row = Math.floor(k / tower.perRow);
  const column = k % tower.perRow;
  return { x: tower.left + (column + 0.5) * tower.cell, y: rowBottom(tower, row) + tower.cell / 2, row, floor: Math.floor(row / tower.shape.rowsPerFloor) };
}

/** The heights of the floor plates between floors, from the lowest up (the ground and the roof are not among them). */
export function floorPlates(tower: TowerLayout): number[] {
  const plates: number[] = [];
  for (let floor = 1; floor < tower.floors; floor += 1) plates.push(rowBottom(tower, floor * tower.shape.rowsPerFloor) - tower.shape.floorGap / 2);
  return plates;
}

export interface FloorLine {
  /** The line's height left of the step and right of it (the same when the count fills its last row). */
  leftY: number;
  rightY: number;
  /** Where it steps down, between the last marble under it and the first above it. */
  stepX: number;
  /** Its ends, past the tower's sides. */
  from: number;
  to: number;
}

/**
 * The line over the first `count` marbles: where a row is shared, it steps down between the last marble under the
 * line and the first above it, so every marble under it, and none above, is among the first `count`.
 */
export function floorLine(tower: TowerLayout, count: number): FloorLine {
  const k = Math.max(0, Math.min(tower.total, count));
  const row = Math.floor(k / tower.perRow);
  const column = k % tower.perRow;
  const reach = tower.shape.lineReach;
  if (column === 0) {
    // A full row under it: the line runs along the bottom of the next row, on the floor plate between floors.
    const y = row > 0 && row % tower.shape.rowsPerFloor === 0 ? rowBottom(tower, row) - tower.shape.floorGap / 2 : rowBottom(tower, row);
    return { leftY: y, rightY: y, stepX: tower.left, from: tower.left - reach, to: tower.right + reach };
  }
  return { leftY: rowBottom(tower, row) + tower.cell, rightY: rowBottom(tower, row), stepX: tower.left + column * tower.cell, from: tower.left - reach, to: tower.right + reach };
}

/** One run on a board, as the tower orders it. */
export interface TowerRun {
  run: number;
  day: number;
  onTime: boolean;
}

/** One board's tower: by handover day, then run number, so the runs that make the deadline are its lowest floors. */
export function towerOrder(runs: readonly TowerRun[]): number[] {
  return [...runs].sort((a, b) => a.day - b.day || a.run - b.run).map((entry) => entry.run);
}

/**
 * Two boards' towers in one order of the runs (the same dice, paid two ways): first the runs on time both ways, then
 * those on time only on the right, then the rest; within each by the right's day, the left's, then run number. So each
 * board's runs on time are its lowest marbles, and between its line and the left board's stand exactly the runs that
 * make it only on the right: `band` of them. Null when a run makes it only on the left (then no one order would give
 * both boards a clean line): each board keeps its own order.
 */
export function sharedOrder(left: readonly TowerRun[], right: readonly TowerRun[]): { order: number[]; band: number } | null {
  const lefts = new Map(left.map((entry) => [entry.run, entry]));
  const rights = new Map(right.map((entry) => [entry.run, entry]));
  const runs = new Set([...lefts.keys(), ...rights.keys()]);
  const keyed: { run: number; group: number; rightDay: number; leftDay: number }[] = [];
  for (const run of runs) {
    const a = lefts.get(run);
    const b = rights.get(run);
    // A run on one board only (the other could not schedule it) goes by the board it is on.
    const leftOn = a ? a.onTime : (b?.onTime ?? false);
    const rightOn = b ? b.onTime : leftOn;
    if (leftOn && !rightOn) return null;
    keyed.push({ run, group: leftOn ? 0 : rightOn ? 1 : 2, rightDay: b?.day ?? a!.day, leftDay: a?.day ?? b!.day });
  }
  keyed.sort((x, y) => x.group - y.group || x.rightDay - y.rightDay || x.leftDay - y.leftDay || x.run - y.run);
  return { order: keyed.map((entry) => entry.run), band: keyed.filter((entry) => entry.group === 1).length };
}

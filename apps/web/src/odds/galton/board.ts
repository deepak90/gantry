/**
 * The Galton board of the odds, as numbers: one bin per working day the handover can fall on, the pegs, the hopper,
 * the deadline's glass divider and where each marble comes to rest in its bin. The physics (galton/physics.ts) and
 * the picture (galton/odds-galton.ts) both build from this one layout, so a marble is simulated against exactly the
 * board that is drawn.
 *
 * Units are marble diameters (a marble's radius is 0.5), y is up, the bins' floor is y = 0, and the board is centered
 * on x = 0. Nothing here touches three.js, Rapier or the DOM.
 *
 * Truth first: the board never decides anything. Each marble is one run of the plan on the scheduling engine, and its
 * bin is that run's handover day; the physics only finds a fall that ends there.
 */

export const MARBLE_RADIUS = 0.5;
/** Rows of marbles at rest are this far apart (hexagonal packing of touching marbles). */
export const ROW_PITCH = Math.sqrt(3) / 2;

export interface BoardShape {
  /** Marbles side by side across a full row of a bin. */
  perRow: number;
  /** Space either side of a full row, inside a bin. */
  clearance: number;
  divider: number;
  /** Extra space between a Friday's bin and the next Monday's, so the weeks read. */
  weekGap: number;
  pegRows: number;
  pegSpacing: number;
  pegRadius: number;
  /** Width of the hopper's mouth, where the marbles leave it. */
  hopperExit: number;
  /** Space between the bins' tops and the lowest row of pegs. */
  gap: number;
  /** The deadline's glass stands this much taller than the other dividers. */
  deadlineRise: number;
  /** The share of all runs the fullest bin is built to hold. */
  peakShare: number;
}

/** Tuned with Rapier so that every bin from about May 24 to Jul 2 is reachable from the hopper. */
export const DEFAULT_SHAPE: BoardShape = {
  perRow: 4,
  clearance: 0.08,
  divider: 0.24,
  weekGap: 0.7,
  pegRows: 15,
  pegSpacing: 4.4,
  pegRadius: 0.6,
  hopperExit: 10,
  gap: 3.2,
  deadlineRise: 5,
  peakShare: 0.16,
};

export interface Bin {
  index: number;
  day: number;
  /** Inside faces of the bin's walls. */
  left: number;
  right: number;
  center: number;
  /** The first working day after a non-working one (a Monday, or the day after a holiday). */
  weekStart: boolean;
}

export interface Divider {
  x: number;
  thickness: number;
  top: number;
  kind: 'bin' | 'deadline' | 'side';
}

export interface Hopper {
  center: number;
  exit: number;
  /** Height of the mouth. */
  y: number;
  /** The funnel's walls: from the mouth's edges up and outward, at this slope (radians from vertical), this long. */
  slope: number;
  wallLength: number;
}

export interface BoardLayout {
  shape: BoardShape;
  bins: Bin[];
  dividers: Divider[];
  /** Inside faces of the side walls. */
  left: number;
  right: number;
  binTop: number;
  /** Below this, a marble can't leave its bin: it is committed to it. */
  commitY: number;
  /** Peg centers, x and y in turn. */
  pegs: Float32Array;
  pegTop: number;
  pegBottom: number;
  hopper: Hopper;
  /** Where a marble is let go: its x is searched for inside [xMin, xMax]. */
  release: { y: number; xMin: number; xMax: number };
  /** Top of the frame. */
  top: number;
  /** The divider after the contract day's bin, or null when every bin is on one side. */
  deadline: Divider | null;
  contractDay: number;
  /** Marbles a bin holds before they pile over its walls. */
  capacity: number;
}

/** 0 is Sunday. */
export const weekdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7;

/** The board's days around a contract date: from 18 calendar days before it to 21 after (May 24 to Jul 2 for Jun 11). */
export function defaultRange(contractDay: number): { from: number; to: number } {
  return { from: contractDay - 18, to: contractDay + 21 };
}

/** The working days from `from` to `to`, both included, by the plan's calendar. */
export function workingDays(from: number, to: number, nonWorking: (day: number) => boolean): number[] {
  const days: number[] = [];
  for (let day = from; day <= to; day += 1) if (!nonWorking(day)) days.push(day);
  return days;
}

/** Weekends only, for when the plan's calendar isn't to hand. */
export const weekends = (day: number): boolean => weekdayOf(day) === 0 || weekdayOf(day) === 6;

/** How many marbles fit in `rows` rows of a bin (rows alternate full and one short, as touching marbles pack). */
export function marblesInRows(rows: number, perRow: number): number {
  return Math.floor(rows / 2) * (2 * perRow - 1) + (rows % 2) * perRow;
}

/** Rows a bin needs for `count` marbles. */
export function rowsFor(count: number, perRow: number): number {
  if (count <= 0) return 0;
  const pair = 2 * perRow - 1;
  const pairs = Math.floor(count / pair);
  const rest = count - pairs * pair;
  return pairs * 2 + (rest === 0 ? 0 : rest <= perRow ? 1 : 2);
}

const rowOrders = new Map<number, number[]>();

/** The order a row fills in: from its middle outward, the left of a pair first. */
export function rowOrder(across: number): number[] {
  let order = rowOrders.get(across);
  if (!order) {
    const middle = (across - 1) / 2;
    order = Array.from({ length: across }, (_, index) => index).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
    rowOrders.set(across, order);
  }
  return order;
}

/**
 * Where the k-th marble in a bin comes to rest (k from 0): rows from the floor up, alternating full rows and rows one
 * short that sit in the hollows of the row below, each row filled from its middle outward, so a part-filled top row
 * is a small mound, as marbles settle. Piles form neat columns, and the height of a pile is its count.
 */
export function slotPosition(bin: Pick<Bin, 'center'>, k: number, perRow: number): { x: number; y: number; row: number } {
  const pair = 2 * perRow - 1;
  const pairs = Math.floor(k / pair);
  let rest = k - pairs * pair;
  let row = pairs * 2;
  let across = perRow;
  if (rest >= perRow) {
    rest -= perRow;
    row += 1;
    across = perRow - 1;
  }
  const order = rowOrder(across);
  const column = order[rest]!;
  const middle = (across - 1) / 2;
  const x = bin.center + (column - middle);
  const y = MARBLE_RADIUS + row * ROW_PITCH;
  return { x, y, row };
}

export interface LayoutInput {
  /** The working days that get a bin, in order. */
  days: readonly number[];
  contractDay: number;
  /** Runs in a pass: the bins are built to hold `peakShare` of them. */
  total: number;
  shape?: Partial<BoardShape>;
}

/**
 * The board for a run of working days: bins side by side (a little extra space where a week starts), the deadline's
 * divider after the contract day's bin, a field of pegs in staggered rows above, and the hopper above the middle.
 */
export function boardLayout({ days, contractDay, total, shape: overrides }: LayoutInput): BoardLayout {
  if (days.length === 0) throw new Error('A board needs at least one day.');
  const shape: BoardShape = { ...DEFAULT_SHAPE, ...overrides };
  const inner = shape.perRow + shape.clearance * 2;
  const capacity = Math.max(shape.perRow * 2, Math.ceil(total * shape.peakShare));
  const binTop = MARBLE_RADIUS * 2 + (rowsFor(capacity, shape.perRow) - 1) * ROW_PITCH + 0.6;

  // Bins left to right from 0, then centered.
  const bins: Bin[] = [];
  let x = shape.divider;
  days.forEach((day, index) => {
    const weekStart = index > 0 && day - days[index - 1]! > 1;
    if (weekStart) x += shape.weekGap;
    bins.push({ index, day, left: x, right: x + inner, center: x + inner / 2, weekStart });
    x += inner + shape.divider;
  });
  const width = x;
  const shift = width / 2;
  for (const bin of bins) {
    bin.left -= shift;
    bin.right -= shift;
    bin.center -= shift;
  }
  const left = -shift + shape.divider;
  const right = shift - shape.divider;

  const dividers: Divider[] = [];
  let deadline: Divider | null = null;
  dividers.push({ x: -shift + shape.divider / 2, thickness: shape.divider, top: binTop, kind: 'side' });
  for (let i = 0; i < bins.length - 1; i += 1) {
    const a = bins[i]!;
    const b = bins[i + 1]!;
    const isDeadline = a.day <= contractDay && b.day > contractDay;
    const divider: Divider = isDeadline
      ? { x: (a.right + b.left) / 2, thickness: Math.max(shape.divider * 2, b.left - a.right - 0.12), top: binTop + shape.deadlineRise, kind: 'deadline' }
      : { x: (a.right + b.left) / 2, thickness: b.left - a.right, top: binTop, kind: 'bin' };
    if (isDeadline) deadline = divider;
    dividers.push(divider);
  }
  dividers.push({ x: shift - shape.divider / 2, thickness: shape.divider, top: binTop, kind: 'side' });

  // Pegs: staggered rows across the board, centered on the hopper so the middle column falls straight under it.
  const rowPitch = (shape.pegSpacing * Math.sqrt(3)) / 2;
  const pegBottom = Math.max(binTop, deadline?.top ?? 0) + shape.gap + shape.pegRadius;
  const pegTop = pegBottom + (shape.pegRows - 1) * rowPitch;
  const pegs: number[] = [];
  const margin = shape.pegRadius + 0.75;
  for (let row = 0; row < shape.pegRows; row += 1) {
    const y = pegTop - row * rowPitch;
    const offset = row % 2 === 1 ? shape.pegSpacing / 2 : 0;
    const first = Math.ceil((left + margin - offset) / shape.pegSpacing);
    for (let k = first; ; k += 1) {
      const px = offset + k * shape.pegSpacing;
      if (px > right - margin) break;
      pegs.push(px, y);
    }
  }

  const hopper: Hopper = { center: 0, exit: shape.hopperExit, y: pegTop + rowPitch * 0.62, slope: 0.82, wallLength: 9 };
  const release = { y: hopper.y + MARBLE_RADIUS + 0.15, xMin: hopper.center - hopper.exit / 2 + MARBLE_RADIUS + 0.05, xMax: hopper.center + hopper.exit / 2 - MARBLE_RADIUS - 0.05 };
  const top = hopper.y + Math.cos(hopper.slope) * hopper.wallLength + 1.2;

  return {
    shape,
    bins,
    dividers,
    left,
    right,
    binTop,
    commitY: binTop - 1.25,
    pegs: Float32Array.from(pegs),
    pegTop,
    pegBottom,
    hopper,
    release,
    top,
    deadline,
    contractDay,
    capacity,
  };
}

/** The bin a handover day falls in: the day's own, or the nearest one at either end of the board for a day beyond it. */
export function binOfDay(layout: Pick<BoardLayout, 'bins'>, day: number): number {
  const { bins } = layout;
  if (day <= bins[0]!.day) return 0;
  if (day >= bins[bins.length - 1]!.day) return bins.length - 1;
  // A day the handover can't fall on (it never should) goes to the working day after it.
  let lo = 0;
  let hi = bins.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bins[mid]!.day < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The bin a marble is in at x, or -1 outside every bin. */
export function binAt(layout: Pick<BoardLayout, 'bins'>, x: number): number {
  const { bins } = layout;
  let lo = 0;
  let hi = bins.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bin = bins[mid]!;
    if (x < bin.left) hi = mid - 1;
    else if (x > bin.right) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** On time: handed over by the end of the contract day. */
export const onTime = (day: number, contractDay: number): boolean => day <= contractDay;

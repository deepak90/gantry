/**
 * The odds as a Galton board: each marble is one run of the plan on the scheduling engine, released the moment the
 * run finishes, and its bin is that run's handover day. Teal marbles hand over by the contract date, amber after it.
 * The engine decides every bin; the physics (Rapier, in a worker) only finds a real fall through the pegs that ends
 * there, and the board plays it back. In its bin a marble settles into the next place in the pile, so the piles are
 * the distribution of handover days, the same one the dot plot draws.
 *
 * The interface mirrors the dot plot's (odds/dot-plot.ts): `begin`, `land`, `settle` (its `end`) and `morph` (its
 * `show`), so the odds controller can drive it through `galtonSink`. Built for a film cut into one-second shots: any
 * half second of the cascade shows hundreds of marbles pouring and the counter jumping; `jumpTo('result')` reaches
 * the poster frame (the piles, the deadline glass, the big number and its words) from any state; a pass that is not
 * fresh (PayPal paid, the odds asked again) first drains the board through its trapdoor; `compare` stands two boards
 * side by side. `onPhase` reports when each of these is first on screen.
 *
 * `stack` stands the runs up as a building (galton/tower.ts): the pegs shrink away, the dividers and the glass sink,
 * and the marbles lift out of their bins, earliest handover first, into a tower of ten floors, a tenth of the runs to a
 * floor, with the deadline as a floor line under the ones that make it. Side by side the two towers stand in one order
 * of the runs, so on the right the band between the two lines is exactly the runs that make it only that way: lit for
 * a moment and counted beside a bracket. Each side can stack on its own; `unstack` puts the piles back.
 */
import { Color, Matrix4, Vector3 } from 'three';
import { binOfDay, boardLayout, defaultRange, onTime as isOnTime, slotPosition, weekends, workingDays, type BoardLayout } from './board';
import { createBoardModel, marbleMatrix, type BoardModel, type Palette } from './board-model';
import { DEFAULT_PHYSICS, frameRate, type PhysicsSpec } from './physics';
import { floorLine, sharedOrder, towerLayout, towerOrder, towerSlot, type TowerLayout } from './tower';
import type { FallItem, FromWorker, ToWorker, WorkerStats } from './protocol';
import { count, dateOfDay, deadlineWords, MONTH, MONTH_DAY, percentOf, resultWords } from './words';
import { createStage, type Stage } from './stage';
import './galton.css';

export type GaltonSize = 'panel' | 'hero';
export type GaltonPhase = 'board' | 'cascade' | 'poured' | 'settled' | 'result' | 'drain' | 'drained' | 'compare' | 'stacking' | 'stacked';
/** One of two boards side by side: the left (the answer before) or the right (the one after). */
export type GaltonSide = 'left' | 'right';

/** A pass of runs, as the dot plot is told it (odds/dot-plot.ts PlotPass). */
export interface GaltonPass {
  fresh: boolean;
  total: number;
  contractDay: number;
  plannedDay?: number | null;
  /** Days the handover can't fall on (the plan's calendar); weekends when not given. */
  nonWorking?: (day: number) => boolean;
}

export interface GaltonResults {
  runs: ArrayLike<number>;
  days: ArrayLike<number>;
}

export interface GaltonOptions {
  size?: GaltonSize;
  /** Jump to every end state, with no motion. Follows the system setting when not given. */
  reducedMotion?: boolean;
  /** When each phase is first on screen: `at` is the frame's time (performance.now()). */
  onPhase?: (phase: GaltonPhase, at: number) => void;
  /** The days the board has bins for; around the contract date when not given (see board.ts defaultRange). */
  range?: (contractDay: number) => { from: number; to: number };
  /** The big number and its words; on for the hero size when not given. */
  headline?: boolean;
  /** Physics workers searching for falls. */
  workers?: number;
  physics?: PhysicsSpec;
}

export interface GaltonStats {
  worker: WorkerStats | null;
  /** Runs waiting for a fall, marbles falling, marbles at rest. */
  waiting: number;
  falling: number;
  resting: number;
  /** Milliseconds between a run landing and its marble leaving the hopper: mean and worst, this pass. */
  waitMean: number;
  waitWorst: number;
}

export interface OddsGalton {
  begin(pass: GaltonPass): void;
  land(landed: readonly { run: number; day: number }[]): void;
  /** The pass is over: these are the runs it made. */
  settle(runs?: readonly number[]): void;
  /** Shows a whole answer at once: the board drains and refills with it, or simply holds it (`instant`). */
  morph(results: GaltonResults, options?: { instant?: boolean }): void;
  /**
   * `'result'`: the poster frame, from any state: every marble in its place in the piles, the big number and its words.
   * `'stacked'`: every tower on its way up standing at once, with its floor line and its bracket.
   */
  jumpTo(state: 'result' | 'stacked'): void;
  /** Opens the trapdoor: the board empties into its drawer. */
  drain(): Promise<void>;
  /**
   * Two boards side by side, both filled: before on the left, after on the right, each under its title, a line under
   * that ("with PayPal"), its big number and its words. Titles and notes are short: each is sized to its own board.
   */
  compare(left: GaltonResults, right: GaltonResults, titles?: [string, string], notes?: [string, string]): void;
  /** Back to one board, with the latest answer. */
  single(): void;
  /**
   * The runs as a building: the marbles lift out of the bins, earliest handover first, into a tower of ten floors (a
   * tenth of the runs each), and the deadline becomes a floor line under the runs that make it. Side by side, `side`
   * stacks one board and the other keeps its piles; with no side both stack, the left first and the right a moment
   * later, in one order of the runs, the band between the two lines lit on the right and counted. Resolves when the
   * tower stands (at once in reduced motion, or with `instant`). Nothing stacks while marbles are still falling.
   */
  stack(side?: GaltonSide, options?: { instant?: boolean }): Promise<void>;
  /** The towers back into piles (the one side, or every board). */
  unstack(side?: GaltonSide, options?: { instant?: boolean }): void;
  /** Whether a board stands as a tower or is on its way up (the side of two, or any board). */
  isStacked(side?: GaltonSide): boolean;
  setSize(size: GaltonSize): void;
  /**
   * The camera's framing: the whole board (as while marbles pour) or in on the piles (as for the result), in 0.7 s or
   * at once. The board chooses on its own as it goes; a take can hold either.
   */
  setShot(shot: 'full' | 'piles', options?: { instant?: boolean }): void;
  setReducedMotion(reduced: boolean): void;
  /**
   * Resolves once the physics is loaded and has falls ready for the first runs (or after a second and a half at
   * most): a take can start the engine then, so the first marbles leave the hopper the moment their runs land.
   */
  whenReady(): Promise<void>;
  readonly phase: GaltonPhase | null;
  stats(): GaltonStats;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Colors and words
// ---------------------------------------------------------------------------------------------

const probe = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d', { willReadFrequently: true }) : null;

/** Any CSS color (oklch included) as a three.js color: the browser parses it. */
function cssColor(value: string, fallback: string): Color {
  if (!probe || !value) return new Color(fallback);
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return new Color().setRGB((r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255, 'srgb');
}

function readPalette(element: HTMLElement): Palette & { background: Color } {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => cssColor(style.getPropertyValue(name).trim(), fallback);
  const background = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cssColor(style.backgroundColor, '#f3f4ef') : new Color('#f3f4ef');
  return {
    background,
    panel: new Color('#eeebe4'),
    frame: new Color('#d7cab4'),
    divider: new Color('#e4ddd0'),
    steel: new Color('#c9ced5'),
    glass: new Color('#b9d3d0'),
    ink: token('--ink', '#1f2933'),
    onTime: token('--odds-on-time', '#14857b'),
    late: token('--odds-late', '#d38a1f'),
  };
}

// ---------------------------------------------------------------------------------------------
// Marbles
// ---------------------------------------------------------------------------------------------

/** Waiting for its fall; falling through the pegs; dropping into its place; at rest (in a bin or a tower); draining out; in the drawer. */
type MarbleState = 'waiting' | 'falling' | 'dropping' | 'resting' | 'draining' | 'gone';

interface Marble {
  run: number;
  day: number;
  bin: number;
  onTime: boolean;
  state: MarbleState;
  index: number;
  landedAt: number;
  t0: number;
  frames: Float32Array | null;
  offset: number;
  frameCount: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
  /** The drop into the bin: from, to, how long, and the start velocity. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  dropMs: number;
  /** Draining: when it lets go. */
  delay: number;
  /** Where it rests in its bin, kept while it stands in a tower (to go back to). */
  pileX?: number;
  pileY?: number;
}

const ENTRY_HIDDEN = -1;

/** A board's runs standing as a tower, or on their way up or back down. */
interface TowerState {
  layout: TowerLayout;
  /** The marbles in the tower's order, from the ground up. */
  order: Marble[];
  /** How many of them make the deadline: the floor line is over them. */
  onTime: number;
  /** On the right of two boards: the marbles that make it only here, between the two boards' lines. */
  band: { from: number; to: number } | null;
  /** Up to the tower (or standing), or back down to the piles. */
  direction: 'up' | 'down';
  /** When the motion starts: the first frame it is drawn in (null until then), plus `delay` for the second of two. */
  start: number | null;
  delay: number;
  done: boolean;
  /** 'stacking' said for it (on its first frame on screen). */
  told: boolean;
  /** How far the floor line and the bracket are shown (for their labels). */
  lineShown: number;
  bandShown: number;
  waiters: (() => void)[];
}

/** The tower's motion, in milliseconds: the fold, the lift (earliest handover first), each marble's flight, the parts. */
const STACK = {
  foldMs: 450,
  liftMs: 250,
  leaveMs: 1350,
  flightMs: 600,
  /** How high a marble swings on its way across, in marble diameters. */
  arc: 7,
  groundMs: 300,
  plateMs: 220,
  lineMs: 350,
  /** The band's light: after its line is in, up and back down. */
  glowDelayMs: 150,
  glowMs: 1000,
  glow: 0.42,
  bandDelayMs: 300,
  bandMs: 400,
  /** With no side given, the right board starts this much after the left. */
  bothStaggerMs: 900,
  /** Back down to the piles. */
  downMs: 800,
} as const;

class Board {
  readonly model: BoardModel;
  readonly fill: Int32Array;
  readonly marbles: Marble[] = [];
  private readonly free: number[] = [];
  private high = 0;
  private readonly matrix = new Matrix4();
  dirty = false;
  colorsDirty = false;
  trapdoor = 0;
  /** The answer on the board: on time and how many. */
  result: { onTime: number; total: number } | null = null;
  title = '';
  /** A line under the title, side by side ("with PayPal"). */
  note = '';
  /** Its runs standing as a tower, or on their way up or down. */
  tower: TowerState | null = null;

  constructor(
    readonly layout: BoardLayout,
    readonly palette: Palette,
    capacity: number,
  ) {
    this.model = createBoardModel(layout, palette, capacity);
    this.fill = new Int32Array(layout.bins.length);
  }

  allocate(marble: Marble): void {
    const index = this.free.pop() ?? this.high++;
    marble.index = index;
    const mesh = this.model.marbles;
    if (index >= mesh.instanceMatrix.count) return;
    mesh.count = Math.max(mesh.count, index + 1);
    mesh.setColorAt(index, marble.onTime ? this.palette.onTime : this.palette.late);
    this.colorsDirty = true;
  }

  release(marble: Marble): void {
    if (marble.index < 0) return;
    this.write(marble.index, 0, -1000, 0);
    this.free.push(marble.index);
    marble.index = ENTRY_HIDDEN;
  }

  write(index: number, x: number, y: number, scale = 1): void {
    if (index < 0 || index >= this.model.marbles.instanceMatrix.count) return;
    this.model.marbles.setMatrixAt(index, marbleMatrix(this.matrix, x, y, 0, scale));
    this.dirty = true;
  }

  clear(): void {
    this.dropTower();
    this.marbles.length = 0;
    this.free.length = 0;
    this.high = 0;
    this.fill.fill(0);
    this.model.marbles.count = 0;
    this.result = null;
    this.dirty = true;
  }

  /** No tower any more: the pegs, dividers and glass stand again, the marbles' colors are their own (they stay put). */
  dropTower(): void {
    const tower = this.tower;
    if (!tower) return;
    this.tower = null;
    this.model.setFolded(0);
    this.model.setTower(null);
    for (const marble of tower.order) if (marble.index >= 0) this.model.marbles.setColorAt(marble.index, marble.onTime ? this.palette.onTime : this.palette.late);
    this.colorsDirty = true;
    tower.waiters.splice(0).forEach((resolve) => resolve());
  }

  /** Puts a marble straight into the next place in its bin. */
  rest(marble: Marble): void {
    const slot = this.fill[marble.bin]!++;
    const at = slotPosition(this.layout.bins[marble.bin]!, slot, this.layout.shape.perRow);
    marble.x = at.x;
    marble.y = at.y;
    marble.state = 'resting';
    if (marble.index < 0) this.allocate(marble);
    this.write(marble.index, at.x, at.y);
  }

  flush(): void {
    const mesh = this.model.marbles;
    if (this.dirty) mesh.instanceMatrix.needsUpdate = true;
    if (this.colorsDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.dirty = false;
    this.colorsDirty = false;
  }

  dispose(): void {
    this.model.dispose();
  }
}

const hermite = (a: number, va: number, b: number, vb: number, u: number, span: number) => {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * span * va + (-2 * u3 + 3 * u2) * b + (u3 - u2) * span * vb;
};
const smoothstep = (u: number) => u * u * (3 - 2 * u);
const easeOut = (u: number) => 1 - (1 - u) ** 3;
const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

// ---------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------

/** Space between two boards side by side. */
const COMPARE_GAP = 22;

export { dayWords, percentOf, resultWords } from './words';

export function createOddsGalton(container: HTMLElement, options: GaltonOptions = {}): OddsGalton {
  let size: GaltonSize = options.size ?? 'panel';
  let reduced = options.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const physics = options.physics ?? DEFAULT_PHYSICS;
  const rate = frameRate(physics);
  container.classList.add('galton');
  const palette = readPalette(container);

  // ---- The HUD: plain HTML over the canvas, in the app's type ----------------------------------------------
  const hud = document.createElement('div');
  hud.className = 'galton-hud';
  const counter = document.createElement('p');
  counter.className = 'galton-counter';
  const headline = document.createElement('div');
  headline.className = 'galton-headline';
  const labels = document.createElement('div');
  labels.className = 'galton-labels';
  hud.append(labels, counter, headline);
  container.append(hud);

  let phase: GaltonPhase | null = null;
  const pendingPhases: GaltonPhase[] = [];
  const announce = (next: GaltonPhase) => {
    phase = next;
    pendingPhases.push(next);
    container.dataset.phase = next;
    stage.wake();
  };

  // ---- Boards ----------------------------------------------------------------------------------------------
  let boards: Board[] = [];
  let layout: BoardLayout | null = null;
  let layoutKey = '';
  let comparing = false;

  // ---- The pass --------------------------------------------------------------------------------------------
  let passId = 0;
  let pass: (GaltonPass & { landed: number; settled: boolean; done: boolean }) | null = null;
  const byRun = new Map<number, Marble>();
  let previousOdds: number | null = null;
  let jumping = false;
  let waits: number[] = [];
  let lastStats: WorkerStats | null = null;

  // ---- Workers ---------------------------------------------------------------------------------------------
  const workerCount = Math.max(1, options.workers ?? Math.min(2, Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2)));
  const workers: Worker[] = [];
  const workerStats: (WorkerStats | null)[] = [];
  let nextWorker = 0;
  function startWorkers(): void {
    if (workers.length > 0 || typeof Worker === 'undefined') return;
    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(new URL('./galton.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<FromWorker>) => onWorker(i, event.data);
      workers.push(worker);
      workerStats.push(null);
    }
  }
  /** The board the workers have their world for: they are only started, and told, when falls will be played. */
  let workersKey = '';
  function readyWorkersFor(): void {
    if (!layout || reduced || workersKey === layoutKey) return;
    startWorkers();
    workersKey = layoutKey;
    readyWorkers = 0;
    workerStats.fill(null);
    lastStats = null;
    tellAll((index) => ({ type: 'board', layout: layout!, physics, seed: 1 + index * 7919 }));
  }
  const tell = (worker: number, message: ToWorker) => workers[worker]?.postMessage(message);
  const tellAll = (message: (worker: number) => ToWorker) => workers.forEach((_, index) => tell(index, message(index)));

  let readyWorkers = 0;
  function onWorker(index: number, message: FromWorker): void {
    if (message.type === 'error') {
      console.error('Galton physics:', message.message);
      return;
    }
    if (message.type === 'ready') {
      readyWorkers += 1;
      return;
    }
    workerStats[index] = message.stats;
    lastStats = mergeStats(workerStats);
    if (message.type !== 'falls') return;
    const board = boards[0];
    if (!board) return;
    const now = performance.now();
    for (const item of message.items) {
      if (item.pass !== passId) continue;
      const marble = byRun.get(item.run);
      if (!marble || marble.state !== 'waiting') continue;
      startFall(board, marble, item, message.frames, now);
    }
    stage.wake();
  }

  function startFall(board: Board, marble: Marble, item: FallItem, frames: Float32Array, now: number): void {
    marble.frames = frames;
    marble.offset = item.offset;
    marble.frameCount = item.count;
    marble.vx = item.vx;
    marble.vy = item.vy;
    marble.t0 = now;
    marble.state = 'falling';
    marble.x = frames[item.offset]!;
    marble.y = frames[item.offset + 1]!;
    board.allocate(marble);
    board.write(marble.index, marble.x, marble.y);
    waits.push(now - marble.landedAt);
    if (phase === 'board' || phase === 'drain' || phase === 'drained' || phase === 'result') {
      if (phase !== 'drain') announce('cascade');
      else cascadeAfterDrain = true;
    }
  }
  let cascadeAfterDrain = false;

  // ---- Stage -----------------------------------------------------------------------------------------------
  container.dataset.size = size;
  const stage: Stage = createStage(container, {
    ground: false,
    frame: (now) => frame(now),
    drawn: (now) => {
      placeLabels();
      for (const name of pendingPhases.splice(0)) options.onPhase?.(name, now);
    },
    resized: () => {
      // Bins narrower on screen than a day's number: the weeks are named instead, or only the ends and the deadline's
      // day (and back again when wider). The labels' sizes follow the board's (they are in container units).
      if (labelsAt !== labelDensity()) buildLabels();
      else measureLabels();
      frameCamera(true);
      placeLabels();
    },
  });
  stage.setBackground(palette.background);

  // ---- Layout and models -----------------------------------------------------------------------------------
  function ensureBoard(contractDay: number, total: number, nonWorking: (day: number) => boolean): Board {
    const range = (options.range ?? defaultRange)(contractDay);
    const days = workingDays(range.from, range.to, nonWorking);
    const key = `${days.join(',')}|${contractDay}|${total}`;
    if (key !== layoutKey || boards.length === 0) {
      layoutKey = key;
      layout = boardLayout({ days, contractDay, total });
      boards.forEach((board) => {
        stage.scene.remove(board.model.group);
        board.dispose();
      });
      const board = new Board(layout, palette, Math.ceil(total * 1.05) + 8);
      board.model.group.position.set(0, 0, 0);
      stage.scene.add(board.model.group);
      boards = [board];
      comparing = false;
      workersKey = '';
      buildLabels();
      frameCamera(true);
      warming = warmBoard(board);
    }
    return boards[0]!;
  }

  /** Every shader the board will need, compiled before it is first shown: a marble stands in for all of them. */
  let warming: Promise<void> = Promise.resolve();
  async function warmBoard(board: Board): Promise<void> {
    const mesh = board.model.marbles;
    const shown = mesh.count;
    if (shown === 0) {
      mesh.count = 1;
      board.write(0, 0, board.layout.release.y + 30, 1);
      board.flush();
    }
    board.model.setTrapdoor(0.0001);
    await stage.warm();
    if (mesh.count === 1 && board.marbles.length === 0) mesh.count = 0;
    board.model.setTrapdoor(0);
  }

  // ---- Camera ----------------------------------------------------------------------------------------------
  const camera = stage.camera;
  /** The camera looks at the board from the front, a little from the left and above; at two boards, straight on. */
  const SIDE = new Vector3(-0.1, 0.08, 1).normalize();
  const FRONT = new Vector3(0, 0.07, 1).normalize();
  interface View {
    target: Vector3;
    look: Vector3;
    distance: number;
    offsetX: number;
    offsetY: number;
  }
  const view: View = { target: new Vector3(), look: SIDE.clone(), distance: 300, offsetX: 0, offsetY: 0 };
  let flight: { from: View; to: View; start: number; ms: number } | null = null;
  /** The whole board while marbles pour; the piles (and the lowest pegs) for the result. */
  type Shot = 'full' | 'piles';
  let shot: Shot = 'full';
  const copyView = (v: View): View => ({ ...v, target: v.target.clone(), look: v.look.clone() });

  function framing(): View {
    if (!layout || boards.length === 0) return copyView(view);
    const bounds = boards[0]!.model.bounds;
    const boardWidth = bounds.right - bounds.left;
    const lefts = boards.map((board) => board.model.group.position.x + bounds.left);
    const minX = Math.min(...lefts);
    const maxX = Math.max(...lefts) + boardWidth;
    // Where on the canvas the boards go, as fractions of it: in the middle while marbles pour; moved over for the
    // headline on the left of the hero view's result (under it, in a frame too narrow for both side by side, such as
    // the chart's side beside the odds panel); under the titles of two boards; under the panel's counter; and always
    // with room for the dates under the bins.
    const withHeadline = size === 'hero' && showHeadline() && !comparing && shot === 'piles';
    const rect = comparing
      ? { x: 0.03, y: 0.25, w: 0.94, h: 0.7 }
      : withHeadline
        ? headlineLayout() === 'stacked'
          ? { x: 0.03, y: 0.25, w: 0.94, h: 0.68 }
          : { x: 0.3, y: 0.05, w: 0.67, h: 0.86 }
        : size === 'panel'
          ? { x: 0.03, y: 0.12, w: 0.94, h: 0.78 }
          : { x: 0.03, y: 0.05, w: 0.94, h: 0.86 };
    const piles = shot === 'piles' && !comparing;
    // In on the piles, but never so close that a tower standing on the board loses its top floors.
    const towerTop = Math.max(0, ...boards.map((board) => (board.tower?.direction === 'up' ? board.tower.layout.top + 6 : 0)));
    let maxY = piles ? Math.max(layout.pegBottom + (layout.pegTop - layout.pegBottom) * 0.3, towerTop) : bounds.top;
    if (piles) {
      // As tall as the frame allows at the board's width: the plinth on the frame's floor, more pegs above.
      const aspect = (rect.w * stage.size.width) / (rect.h * stage.size.height);
      maxY = Math.min(bounds.top, Math.max(maxY, bounds.bottom + (maxX - minX) / aspect));
    }
    const box = { minX, maxX, minY: bounds.bottom, maxY, minZ: bounds.back, maxZ: bounds.front };
    const look = (comparing ? FRONT : SIDE).clone();
    const target = new Vector3((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, 0);
    const { width, height } = stage.size;
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const tanH = tanV * (width / height);
    const right = new Vector3().crossVectors(look.clone().negate(), new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, look.clone().negate()).normalize();
    let distance = 0;
    const corner = new Vector3();
    for (const x of [box.minX, box.maxX])
      for (const y of [box.minY, box.maxY])
        for (const z of [box.minZ, box.maxZ]) {
          corner.set(x, y, z).sub(target);
          const along = corner.dot(look);
          distance = Math.max(distance, Math.abs(corner.dot(right)) / (tanH * rect.w) + along, Math.abs(corner.dot(up)) / (tanV * rect.h) + along);
        }
    return { target, look, distance, offsetX: width / 2 - (rect.x + rect.w / 2) * width, offsetY: height / 2 - (rect.y + rect.h / 2) * height };
  }

  function applyView(v: View): void {
    camera.position.copy(v.target).addScaledVector(v.look, v.distance);
    camera.lookAt(v.target);
    const { width, height } = stage.size;
    camera.setViewOffset(width, height, v.offsetX, v.offsetY, width, height);
    camera.updateMatrixWorld();
  }

  /** The hero's big number beside the piles, or over them when the frame is too narrow for both side by side. */
  function headlineLayout(): 'side' | 'stacked' {
    return stage.size.width / Math.max(1, stage.size.height) < 1.3 ? 'stacked' : 'side';
  }

  /** Moves the camera to the framing the board's state calls for: in 0.7 s, or at once. */
  function frameCamera(instant: boolean): void {
    container.dataset.layout = headlineLayout();
    const to = framing();
    if (instant || reduced) {
      flight = null;
      Object.assign(view, to);
      applyView(view);
    } else {
      flight = { from: copyView(view), to, start: performance.now(), ms: 700 };
    }
    fitShadow();
    stage.wake();
  }

  function setShot(next: Shot, instant: boolean): void {
    if (next === shot && !flight) return;
    shot = next;
    frameCamera(instant);
  }

  function fitShadow(): void {
    if (!layout || boards.length === 0) return;
    const bounds = boards[0]!.model.bounds;
    const lefts = boards.map((board) => board.model.group.position.x + bounds.left);
    const minX = Math.min(...lefts);
    const maxX = Math.max(...lefts) + (bounds.right - bounds.left);
    stage.fitShadow(new Vector3((minX + maxX) / 2, (bounds.top + bounds.bottom) / 2, 0), (maxX - minX) / 2 + 4, (bounds.top - bounds.bottom) / 2 + 4, 6);
    stage.setGround(bounds.bottom);
  }

  // ---- Labels ----------------------------------------------------------------------------------------------
  interface Label {
    element: HTMLElement;
    board: number;
    x: number;
    y: number;
    z: number;
    /** Which point of the label sits on the spot: its middle, its left or right middle, or its bottom middle. */
    align: 'center' | 'left' | 'right' | 'above';
    /**
     * Who gives way: a label is shown only where it is clear of every label of a higher rank already shown, so no two
     * ever overlap. 0 is a title, which is sized to its board instead.
     */
    rank: number;
    /** The bins' dates and the glass's name go while the board stands as a tower; the tower's own come with it. */
    kind?: 'bins' | 'tower-line' | 'tower-band';
    /** Its size on screen, in CSS pixels (measured when built and when the board's size changes). */
    width: number;
    height: number;
  }
  let labelList: Label[] = [];

  /**
   * How many dates the bins get, by how wide a bin is on screen: every day's number (and the months) when it fits;
   * the first day of each week ("Jun 7"); or only the first day, the deadline's and the last ("May 24", "Jun 11",
   * "Jul 2"). The panel's board names weeks at most; two boards side by side never number every day.
   */
  type Density = 'days' | 'weeks' | 'ends';
  function labelDensity(): Density {
    if (!layout) return 'weeks';
    const share = comparing ? 0.94 / 2 : size === 'hero' && headlineLayout() === 'side' ? 0.67 : 0.94;
    const bin = (stage.size.width * share) / Math.max(1, layout.bins.length);
    if (bin >= 24 && size === 'hero' && !comparing) return 'days';
    return bin * 5 >= 56 ? 'weeks' : 'ends';
  }
  let labelsAt: Density = 'weeks';

  function addLabel(text: string, className: string, label: Omit<Label, 'element' | 'width' | 'height' | 'kind'> & { kind?: Label['kind'] }): HTMLElement {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    labels.append(element);
    labelList.push({ ...label, element, width: 0, height: 0 });
    return element;
  }

  function buildLabels(): void {
    labels.replaceChildren();
    labelList = [];
    labelsAt = labelDensity();
    boards.forEach((board, boardIndex) => {
      const { layout: l } = board;
      const contract = l.bins[binOfDay(l, l.contractDay)];
      if (labelsAt === 'weeks') {
        // The first day of each week, with its month ("Jun 7"); the deadline names its own day.
        for (const bin of l.bins) {
          if (!(bin.index === 0 || bin.weekStart)) continue;
          addLabel(MONTH_DAY.format(dateOfDay(bin.day)), 'galton-day is-week', { board: boardIndex, x: bin.left, y: -1.6, z: 3.6, align: 'left', rank: 70, kind: 'bins' });
        }
      } else if (labelsAt === 'ends') {
        // Only the ends and the deadline's day: "May 24", "Jun 11", "Jul 2".
        const first = l.bins[0]!;
        const last = l.bins[l.bins.length - 1]!;
        addLabel(MONTH_DAY.format(dateOfDay(first.day)), 'galton-day is-week', { board: boardIndex, x: first.left, y: -1.6, z: 3.6, align: 'left', rank: 80, kind: 'bins' });
        if (last !== first) addLabel(MONTH_DAY.format(dateOfDay(last.day)), 'galton-day is-week', { board: boardIndex, x: last.right, y: -1.6, z: 3.6, align: 'right', rank: 80, kind: 'bins' });
        if (contract && contract.day === l.contractDay && contract !== first && contract !== last) {
          addLabel(MONTH_DAY.format(dateOfDay(contract.day)), 'galton-day is-week is-contract', { board: boardIndex, x: contract.center, y: -1.6, z: 3.6, align: 'center', rank: 90, kind: 'bins' });
        }
      } else {
        let month = -1;
        for (const bin of l.bins) {
          const date = dateOfDay(bin.day);
          const isContract = bin.day === l.contractDay;
          addLabel(String(date.getDate()), `galton-day${isContract ? ' is-contract' : ''}${bin.weekStart ? ' is-week' : ''}`, { board: boardIndex, x: bin.center, y: -1.2, z: 3.6, align: 'center', rank: isContract ? 60 : 50, kind: 'bins' });
          if (date.getMonth() !== month) {
            month = date.getMonth();
            addLabel(MONTH.format(date), 'galton-month', { board: boardIndex, x: bin.left, y: -3.6, z: 3.6, align: 'left', rank: 40, kind: 'bins' });
          }
        }
      }
      if (l.deadline) {
        addLabel(deadlineWords(l.contractDay), 'galton-deadline', { board: boardIndex, x: l.deadline.x, y: l.deadline.top + 1.4, z: 1.6, align: 'center', rank: 100, kind: 'bins' });
      }
      // A tower: the deadline's name at the end of its floor line (the outer end, side by side), and on the right of
      // two boards the band's count beside its bracket.
      const tower = board.tower;
      if (tower && tower.direction === 'up') {
        const at = floorLine(tower.layout, tower.onTime);
        const outerLeft = comparing && boardIndex === 0;
        addLabel(deadlineWords(l.contractDay), 'galton-deadline is-floor', {
          board: boardIndex,
          x: outerLeft ? at.from - 0.6 : at.to + 0.6,
          y: outerLeft ? at.leftY : at.rightY,
          z: 1,
          align: outerLeft ? 'right' : 'left',
          rank: 110,
          kind: 'tower-line',
        });
        if (tower.band) {
          const more = tower.band.to - tower.band.from;
          const mid = (floorLine(tower.layout, tower.band.from).leftY + floorLine(tower.layout, tower.band.to).leftY) / 2;
          const element = addLabel('', 'galton-band', { board: boardIndex, x: tower.layout.left - 2.6, y: mid, z: 1, align: 'right', rank: 105, kind: 'tower-band' });
          const first = document.createElement('span');
          first.textContent = `${count(more)} more`;
          const second = document.createElement('span');
          second.textContent = 'on time';
          element.append(first, second);
        }
      }
      if (comparing) {
        const title = document.createElement('div');
        title.className = 'galton-title';
        const name = document.createElement('p');
        name.className = 'galton-title-name';
        name.textContent = board.title;
        // Always there, empty or not, so the two big numbers stand level.
        const note = document.createElement('p');
        note.className = 'galton-title-note';
        note.textContent = board.note || '\u00a0';
        const figure = document.createElement('p');
        figure.className = 'galton-title-figure';
        const words = document.createElement('p');
        words.className = 'galton-title-words';
        if (board.result) {
          figure.innerHTML = `${percentOf(board.result.onTime, board.result.total)}<span class="galton-unit">%</span>`;
          words.textContent = resultWords(board.result.onTime, board.result.total, l.contractDay);
        }
        title.append(name, note, figure, words);
        labels.append(title);
        labelList.push({ element: title, board: boardIndex, x: (l.left + l.right) / 2, y: l.top + 4.5, z: 0, align: 'above', rank: 0, width: 0, height: 0 });
      }
    });
    // The ones that must be seen first: each later one gives way to them.
    labelList.sort((a, b) => b.rank - a.rank);
    measureLabels();
    placeLabels();
  }

  /** Each label's size on screen (one layout read): the dates and the deadline's name are kept apart by it. */
  function measureLabels(): void {
    for (const label of labelList) {
      if (label.rank === 0) continue;
      label.width = label.element.offsetWidth;
      label.height = label.element.offsetHeight;
    }
  }

  const projected = new Vector3();
  const toScreen = (x: number, y: number, z: number): { x: number; y: number } => {
    projected.set(x, y, z).project(camera);
    return { x: ((projected.x + 1) / 2) * stage.size.width, y: ((1 - projected.y) / 2) * stage.size.height };
  };
  /** Left, top, right, bottom of the labels shown so far this frame. */
  const taken: number[] = [];
  const GAP_X = 6;
  const GAP_Y = 2;

  function placeLabels(): void {
    taken.length = 0;
    for (const label of labelList) {
      const board = boards[label.board];
      if (!board) continue;
      // The bins' labels go while the board stands as a tower; the tower's come in as their line and bracket do.
      const up = board.tower?.direction === 'up' ? board.tower : null;
      const shown = label.kind === 'bins' ? (up ? 0 : 1) : label.kind === 'tower-line' ? (up?.lineShown ?? 0) : label.kind === 'tower-band' ? (up?.bandShown ?? 0) : 1;
      if (label.kind) label.element.style.opacity = shown >= 1 ? '' : String(shown);
      if (shown <= 0) {
        label.element.style.visibility = 'hidden';
        continue;
      }
      const shift = board.model.group.position.x;
      const { x, y } = toScreen(label.x + shift, label.y, label.z);
      const anchor = label.align === 'left' ? '0, -50%' : label.align === 'right' ? '-100%, -50%' : label.align === 'above' ? '-50%, -100%' : '-50%, -50%';
      label.element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${anchor})`;
      if (label.rank === 0) {
        // A title is as wide as its board on screen, and its type is sized to fit that: two never meet.
        const from = toScreen(board.layout.left + shift, label.y, label.z).x;
        const to = toScreen(board.layout.right + shift, label.y, label.z).x;
        const width = Math.max(40, Math.round(to - from));
        label.element.style.width = `${width}px`;
        label.element.style.setProperty('--title-w', `${width}px`);
        continue;
      }
      const left = label.align === 'left' ? x : label.align === 'right' ? x - label.width : x - label.width / 2;
      const top = label.align === 'above' ? y - label.height : y - label.height / 2;
      const right = left + label.width;
      const bottom = top + label.height;
      let clear = true;
      for (let i = 0; i < taken.length; i += 4) {
        if (right + GAP_X > taken[i]! && left < taken[i + 2]! + GAP_X && bottom + GAP_Y > taken[i + 1]! && top < taken[i + 3]! + GAP_Y) {
          clear = false;
          break;
        }
      }
      label.element.style.visibility = clear ? '' : 'hidden';
      if (clear) taken.push(left, top, right, bottom);
    }
  }

  // ---- The headline: the big number and its words -----------------------------------------------------------
  const showHeadline = () => options.headline ?? size === 'hero';
  let figureFrom: number | null = null;
  let figureTo = 0;
  let figureStart = 0;
  /** As long as the push-in on the piles: the poster frame is reached when both have arrived. */
  const FIGURE_MS = 700;

  function renderHeadline(): void {
    headline.replaceChildren();
    const board = boards[0];
    if (!board?.result || comparing || !showHeadline()) {
      headline.classList.remove('is-shown');
      return;
    }
    const figure = document.createElement('p');
    figure.className = 'galton-figure';
    const digits = document.createElement('span');
    digits.className = 'galton-digits';
    figure.append(digits);
    const unit = document.createElement('span');
    unit.className = 'galton-unit';
    unit.setAttribute('aria-hidden', 'true');
    unit.textContent = '%';
    // What a screen reader says for the rolling drums: the number itself.
    const said = document.createElement('span');
    said.className = 'galton-said';
    figure.append(unit, said);
    const words = document.createElement('p');
    words.className = 'galton-words';
    words.textContent = resultWords(board.result.onTime, board.result.total, board.layout.contractDay);
    headline.append(figure, words);
    headline.classList.add('is-shown');
    figureTo = percentOf(board.result.onTime, board.result.total);
    // The number rolls from the answer before, unless the result was jumped to: a jump lands on the finished frame.
    figureFrom = previousOdds !== null && previousOdds !== figureTo && !reduced && !jumping ? previousOdds : null;
    figureStart = performance.now();
    drawFigure(figureFrom ?? figureTo);
  }

  /** The number as an hour meter's drums: each digit rolls, a digit turning over as the one below it passes 9. */
  function drawFigure(value: number): void {
    const digits = headline.querySelector<HTMLElement>('.galton-digits');
    if (!digits) return;
    const places = Math.max(1, String(Math.max(Math.round(value), figureTo, figureFrom ?? 0)).length);
    if (digits.childElementCount !== places) {
      digits.replaceChildren();
      for (let i = 0; i < places; i += 1) {
        const drum = document.createElement('span');
        drum.className = 'galton-drum';
        const strip = document.createElement('span');
        strip.className = 'galton-strip';
        strip.setAttribute('aria-hidden', 'true');
        for (const digit of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
          const cell = document.createElement('span');
          cell.textContent = String(digit);
          strip.append(cell);
        }
        drum.append(strip);
        digits.append(drum);
      }
    }
    const drums = [...digits.children] as HTMLElement[];
    drums.forEach((drum, i) => {
      const place = places - 1 - i;
      const scale = 10 ** place;
      const whole = Math.floor(value / scale);
      let position = whole % 10;
      // Turning over: the digits below this one are rolling from 9 to 0.
      const below = value - whole * scale;
      if (place === 0) position += value - Math.floor(value);
      else if (below > scale - 1) position += below - (scale - 1);
      const hidden = place > 0 && whole === 0 && value < scale;
      drum.style.visibility = hidden ? 'hidden' : 'visible';
      // The strip is eleven digits tall (0 to 9, then 0 again for the turn over).
      (drum.firstElementChild as HTMLElement).style.transform = `translateY(${(-position * 100) / 11}%)`;
    });
    const said = headline.querySelector<HTMLElement>('.galton-said');
    if (said) said.textContent = `${Math.round(value)}%`;
  }

  // ---- The counter -----------------------------------------------------------------------------------------
  function renderCounter(): void {
    if (!pass || comparing) {
      counter.textContent = '';
      counter.classList.remove('is-shown');
      return;
    }
    // Once the answer is on the board, the counter has said its piece (the headline, or the odds panel's, says the rest).
    if (pass.done && boards[0]?.result) {
      counter.classList.remove('is-shown');
      return;
    }
    // "412 of 1,000": the film's plain words, no "runs" on the board (words.ts counterWords).
    counter.innerHTML = `<span class="num">${count(pass.landed)}</span> of <span class="num">${count(pass.total)}</span>`;
    counter.classList.add('is-shown');
  }

  // ---- The frame -------------------------------------------------------------------------------------------
  let draining: { start: number; resolve: () => void; closing: number } | null = null;

  function frame(now: number): boolean {
    let busy = false;
    if (flight) {
      const u = Math.min(1, (now - flight.start) / flight.ms);
      const k = easeInOut(u);
      view.target.lerpVectors(flight.from.target, flight.to.target, k);
      view.look.lerpVectors(flight.from.look, flight.to.look, k).normalize();
      view.distance = flight.from.distance + (flight.to.distance - flight.from.distance) * k;
      view.offsetX = flight.from.offsetX + (flight.to.offsetX - flight.from.offsetX) * k;
      view.offsetY = flight.from.offsetY + (flight.to.offsetY - flight.from.offsetY) * k;
      applyView(view);
      if (u >= 1) {
        flight = null;
        if (resultPending) {
          resultPending = false;
          announce('result');
        }
      } else busy = true;
    }
    for (const board of boards) busy = updateBoard(board, now) || busy;
    for (const board of boards) busy = updateTower(board, now) || busy;
    if (draining) busy = updateDrain(now) || busy;
    if (figureFrom !== null) {
      const u = Math.min(1, (now - figureStart) / FIGURE_MS);
      drawFigure(figureFrom + (figureTo - figureFrom) * easeOut(u));
      if (u >= 1) figureFrom = null;
      else busy = true;
    }
    boards.forEach((board) => board.flush());
    checkSettled();
    return busy || pendingPhases.length > 0;
  }

  function updateBoard(board: Board, now: number): boolean {
    let busy = false;
    for (const marble of board.marbles) {
      switch (marble.state) {
        case 'waiting':
          busy = true;
          break;
        case 'falling': {
          busy = true;
          const f = ((now - marble.t0) / 1000) * rate;
          const last = marble.frameCount - 1;
          if (f >= last || jumping) {
            commit(board, marble, now);
            break;
          }
          const i = Math.floor(f);
          const u = f - i;
          const o = marble.offset + i * 2;
          const frames = marble.frames!;
          marble.x = frames[o]! + (frames[o + 2]! - frames[o]!) * u;
          marble.y = frames[o + 1]! + (frames[o + 3]! - frames[o + 1]!) * u;
          board.write(marble.index, marble.x, marble.y);
          break;
        }
        case 'dropping': {
          busy = true;
          // A drop can be set to start a moment later (the bottom of a pile first): until then it waits where it is.
          const u = Math.max(0, Math.min(1, (now - marble.t0) / marble.dropMs));
          marble.x = marble.fromX + (marble.toX - marble.fromX) * smoothstep(u);
          // From its speed at the bin's mouth to rest in its place.
          marble.y = hermite(marble.fromY, marble.vy / 1000, marble.toY, 0, u, marble.dropMs);
          if (u >= 1) {
            marble.state = 'resting';
            marble.x = marble.toX;
            marble.y = marble.toY;
          }
          board.write(marble.index, marble.x, marble.y);
          break;
        }
        default:
          break;
      }
    }
    return busy;
  }

  /** A marble reached its bin: it takes the next place in the pile and drops into it. */
  function commit(board: Board, marble: Marble, now: number): void {
    const slot = board.fill[marble.bin]!++;
    const to = slotPosition(board.layout.bins[marble.bin]!, slot, board.layout.shape.perRow);
    const frames = marble.frames!;
    const o = marble.offset + (marble.frameCount - 1) * 2;
    marble.fromX = frames[o]!;
    marble.fromY = frames[o + 1]!;
    marble.toX = to.x;
    marble.toY = to.y;
    const fall = Math.max(0, marble.fromY - to.y);
    const vy = Math.min(0, marble.vy);
    // As long as the fall would take from its speed at the mouth, and a little more to come to rest.
    const seconds = fall > 0 ? (vy + Math.sqrt(vy * vy + 2 * physics.gravity * fall)) / physics.gravity : 0.08;
    marble.dropMs = Math.max(70, seconds * 1000 * 1.22);
    marble.t0 = now;
    marble.state = jumping || reduced ? 'resting' : 'dropping';
    if (marble.state === 'resting') {
      marble.x = to.x;
      marble.y = to.y;
      board.write(marble.index, to.x, to.y);
    }
  }

  function checkSettled(): void {
    if (!pass || !pass.settled || pass.done) return;
    const board = boards[0];
    if (!board) return;
    for (const marble of board.marbles) if (marble.state !== 'resting' && marble.state !== 'draining' && marble.state !== 'gone') return;
    if (draining) return;
    pass.done = true;
    announce('settled');
    showResult();
  }

  function showResult(): void {
    const board = boards[0];
    if (!board || !pass) return;
    let onTime = 0;
    let total = 0;
    for (const marble of board.marbles) {
      if (marble.state === 'draining' || marble.state === 'gone') continue;
      total += 1;
      if (marble.onTime) onTime += 1;
    }
    board.result = { onTime, total };
    renderHeadline();
    renderCounter();
    previousOdds = percentOf(onTime, total);
    // The poster frame: in on the piles, in 0.7 s (at once when jumped to); it is reached when the camera arrives.
    setShot('piles', jumping);
    if (flight) resultPending = true;
    else announce('result');
  }
  let resultPending = false;

  // ---- The trapdoor ----------------------------------------------------------------------------------------
  function startDrain(): Promise<void> {
    const board = boards[0];
    if (!board) return Promise.resolve();
    // A tower standing: its marbles back in their piles first, then the trapdoor opens under them.
    if (snapBack(board)) buildLabels();
    if (draining) return new Promise((resolve) => {
      const previous = draining!.resolve;
      draining!.resolve = () => {
        previous();
        resolve();
      };
    });
    const now = performance.now();
    const top = board.layout.binTop;
    let any = false;
    for (const marble of board.marbles) {
      if (marble.state !== 'resting') continue;
      marble.state = 'draining';
      marble.fromY = marble.y;
      // The bottom of each pile lets go first; the rest follow it down.
      marble.delay = 25 + (marble.y / top) * 45;
      marble.t0 = now;
      any = true;
    }
    board.result = null;
    // The piles are on their way out: anything that reaches a bin from now on starts a new pile.
    board.fill.fill(0);
    headline.classList.remove('is-shown');
    if (!any || reduced) {
      for (const marble of board.marbles) if (marble.state === 'draining') board.release(marble);
      board.marbles.splice(0, board.marbles.length, ...board.marbles.filter((marble) => marble.state !== 'draining'));
      announce('drain');
      announce('drained');
      return Promise.resolve();
    }
    announce('drain');
    return new Promise((resolve) => {
      draining = { start: now, resolve, closing: 0 };
      stage.wake();
    });
  }

  const DRAIN_GRAVITY = 1.7 / 1000; // units per ms²: quicker than a fall, so the board empties in about 0.4 s

  function updateDrain(now: number): boolean {
    const board = boards[0];
    if (!board || !draining) return false;
    const elapsed = now - draining.start;
    board.trapdoor = Math.min(1, elapsed / 90);
    let left = 0;
    for (const marble of board.marbles) {
      if (marble.state !== 'draining') continue;
      const t = elapsed - marble.delay;
      if (t <= 0) {
        left += 1;
        continue;
      }
      marble.y = marble.fromY - 0.5 * DRAIN_GRAVITY * t * t;
      if (marble.y < board.model.drawerY) {
        board.release(marble);
        marble.state = 'gone';
        continue;
      }
      left += 1;
      board.write(marble.index, marble.x, marble.y);
    }
    if (left === 0) {
      // Every marble is in the drawer: the trapdoor shuts.
      if (!draining.closing) draining.closing = now;
      const u = Math.min(1, (now - draining.closing) / 110);
      board.trapdoor = 1 - easeOut(u);
      if (u >= 1) {
        board.marbles.splice(0, board.marbles.length, ...board.marbles.filter((marble) => marble.state !== 'gone'));
        board.trapdoor = 0;
        board.model.setTrapdoor(0);
        const done = draining.resolve;
        draining = null;
        announce('drained');
        if (cascadeAfterDrain) {
          cascadeAfterDrain = false;
          announce('cascade');
        }
        done();
        return true;
      }
    }
    board.model.setTrapdoor(easeOut(board.trapdoor));
    return true;
  }

  function restack(board: Board, marble: Marble): void {
    const slot = board.fill[marble.bin]!++;
    const at = slotPosition(board.layout.bins[marble.bin]!, slot, board.layout.shape.perRow);
    marble.x = at.x;
    marble.y = at.y;
    board.write(marble.index, at.x, at.y);
  }

  // ---- The runs as a building -------------------------------------------------------------------------------
  const glow = new Color();
  const WHITE = new Color('#ffffff');

  /** The boards a side names: one of two side by side, both with no side; a board standing alone is the one. */
  function boardsOf(side?: GaltonSide): Board[] {
    if (!comparing) return boards.slice(0, 1);
    if (!side) return [...boards];
    const board = boards[side === 'left' ? 0 : 1];
    return board ? [board] : [];
  }

  const runsOn = (board: Board) => board.marbles.filter((marble) => marble.state === 'resting').map((marble) => ({ run: marble.run, day: marble.day, onTime: marble.onTime }));

  function stack(side?: GaltonSide, stackOptions: { instant?: boolean } = {}): Promise<void> {
    const instant = Boolean(stackOptions.instant) || reduced || jumping;
    const targets = boardsOf(side);
    // Runs still coming in (or going out): nothing to stack yet.
    if (draining || targets.length === 0 || targets.some((board) => board.marbles.length === 0 || board.marbles.some((marble) => marble.state !== 'resting'))) return Promise.resolve();
    // Side by side, both towers stand in one order of the runs (the same dice, paid two ways).
    const shared = comparing && boards.length === 2 ? sharedOrder(runsOn(boards[0]!), runsOn(boards[1]!)) : null;
    const waits = targets.map((board, index) => stackBoard(board, shared, instant, !side && index > 0 && !instant ? STACK.bothStaggerMs : 0));
    buildLabels();
    frameCamera(instant);
    stage.wake();
    return Promise.all(waits).then(() => undefined);
  }

  function stackBoard(board: Board, shared: { order: number[]; band: number } | null, instant: boolean, delay: number): Promise<void> {
    const existing = board.tower;
    if (existing?.direction === 'up') return existing.done ? Promise.resolve() : new Promise((resolve) => existing.waiters.push(resolve));
    // On its way back down: in the piles at once, then up again from there.
    if (existing) snapBack(board);
    const resting = board.marbles.filter((marble) => marble.state === 'resting');
    const byRunHere = new Map(resting.map((marble) => [marble.run, marble]));
    const runs = shared ? shared.order : towerOrder(runsOn(board));
    const order = runs.map((run) => byRunHere.get(run)).filter((marble): marble is Marble => marble !== undefined);
    for (const marble of order) {
      marble.pileX = marble.x;
      marble.pileY = marble.y;
    }
    const onTime = order.reduce((sum, marble) => sum + (marble.onTime ? 1 : 0), 0);
    const band = shared && comparing && board === boards[1] && shared.band > 0 ? { from: onTime - shared.band, to: onTime } : null;
    const tower: TowerState = { layout: towerLayout(board.layout, order.length), order, onTime, band, direction: 'up', start: null, delay, done: false, told: false, lineShown: 0, bandShown: 0, waiters: [] };
    board.tower = tower;
    const standing = new Promise<void>((resolve) => tower.waiters.push(resolve));
    if (instant) finishTower(board);
    return standing;
  }

  function unstack(side?: GaltonSide, unstackOptions: { instant?: boolean } = {}): void {
    const instant = Boolean(unstackOptions.instant) || reduced || jumping;
    let any = false;
    for (const board of boardsOf(side)) {
      const tower = board.tower;
      if (!tower || tower.direction === 'down') continue;
      any = true;
      // Still on its way up: standing first, then down from there.
      if (!tower.done) finishTower(board);
      board.model.setTower(null);
      board.tower = { ...tower, direction: 'down', start: null, delay: 0, done: false, told: true, lineShown: 0, bandShown: 0, waiters: [] };
      if (instant) finishTower(board);
    }
    if (!any) return;
    buildLabels();
    frameCamera(instant);
    stage.wake();
  }

  /**
   * A tower's marbles straight back in their piles and the board as built; no phase is said (what comes next says it).
   * Whether there was a tower.
   */
  function snapBack(board: Board): boolean {
    const tower = board.tower;
    if (!tower) return false;
    for (const marble of tower.order) {
      if (marble.pileX === undefined || marble.pileY === undefined || marble.index < 0) continue;
      marble.x = marble.pileX;
      marble.y = marble.pileY;
      board.write(marble.index, marble.x, marble.y);
    }
    board.dropTower();
    return true;
  }

  /** The tower's motion at its end, at once: standing (with its floor line and bracket), or back in the piles. */
  function finishTower(board: Board): void {
    const tower = board.tower;
    if (!tower) return;
    if (!tower.told) {
      tower.told = true;
      announce('stacking');
    }
    if (tower.direction === 'down') {
      snapBack(board);
      announce(comparing ? 'compare' : 'result');
      stage.wake();
      return;
    }
    const { layout } = tower;
    tower.order.forEach((marble, k) => {
      const at = towerSlot(layout, k);
      marble.x = at.x;
      marble.y = at.y;
      board.write(marble.index, at.x, at.y, layout.scale);
      if (marble.index >= 0) board.model.marbles.setColorAt(marble.index, marble.onTime ? palette.onTime : palette.late);
    });
    board.colorsDirty = true;
    board.model.setFolded(1);
    tower.lineShown = 1;
    tower.bandShown = tower.band ? 1 : 0;
    board.model.setTower({ tower: layout, ground: 1, floors: layout.floors, line: { count: tower.onTime, shown: 1 }, band: tower.band ? { ...tower.band, shown: 1 } : null });
    tower.done = true;
    announce('stacked');
    tower.waiters.splice(0).forEach((resolve) => resolve());
    stage.wake();
  }

  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

  /** One frame of a tower's motion; whether it still moves. */
  function updateTower(board: Board, now: number): boolean {
    const tower = board.tower;
    if (!tower || tower.done) return false;
    // It starts on the first frame it is drawn in; the second of two waits its turn.
    tower.start ??= now + tower.delay;
    const t = now - tower.start;
    if (t < 0) return true;
    if (!tower.told) {
      tower.told = true;
      announce('stacking');
    }
    const { layout, order } = tower;
    const n = order.length;
    if (tower.direction === 'down') {
      // Every marble back to its place in its bin together, the pegs and dividers back up behind them.
      const e = easeInOut(clamp01(t / STACK.downMs));
      order.forEach((marble, k) => {
        const from = towerSlot(layout, k);
        marble.x = from.x + ((marble.pileX ?? from.x) - from.x) * e;
        marble.y = from.y + ((marble.pileY ?? from.y) - from.y) * e + Math.sin(Math.PI * e) * STACK.arc * 0.5;
        board.write(marble.index, marble.x, marble.y, layout.scale + (1 - layout.scale) * e);
      });
      board.model.setFolded(1 - easeInOut(clamp01((t - STACK.downMs * 0.45) / (STACK.downMs * 0.55))));
      if (t >= STACK.downMs) finishTower(board);
      return true;
    }
    // Up: the pegs, dividers and glass fold away; the marbles leave their bins earliest handover first and fly to
    // their places, floor by floor; the floor line comes in with the last marble under it.
    const departs = (k: number) => STACK.liftMs + (n > 1 ? (STACK.leaveMs * k) / (n - 1) : 0);
    const landed = (k: number) => departs(k) + STACK.flightMs;
    board.model.setFolded(easeInOut(clamp01(t / STACK.foldMs)));
    for (let k = 0; k < n; k += 1) {
      const marble = order[k]!;
      const u = clamp01((t - departs(k)) / STACK.flightMs);
      if (u <= 0) continue;
      const e = easeInOut(u);
      const at = towerSlot(layout, k);
      const fromX = marble.pileX ?? at.x;
      const fromY = marble.pileY ?? at.y;
      marble.x = fromX + (at.x - fromX) * e;
      marble.y = fromY + (at.y - fromY) * e + Math.sin(Math.PI * e) * STACK.arc;
      board.write(marble.index, marble.x, marble.y, 1 + (layout.scale - 1) * e);
    }
    // A plate as each floor's last marble lands, the roof last.
    let floors = 0;
    for (let floor = 0; floor < layout.floors; floor += 1) {
      const grown = clamp01((t - landed(Math.min(n - 1, (floor + 1) * layout.perFloor - 1))) / STACK.plateMs);
      floors += grown;
      if (grown < 1) break;
    }
    const lineAt = landed(Math.max(0, tower.onTime - 1));
    tower.lineShown = clamp01((t - lineAt) / STACK.lineMs);
    let end = Math.max(landed(n - 1) + STACK.plateMs, lineAt + STACK.lineMs);
    if (tower.band) {
      const { from, to } = tower.band;
      tower.bandShown = clamp01((t - lineAt - STACK.bandDelayMs) / STACK.bandMs);
      // The band lit up once, then back to the color of every run that makes it.
      const g = (t - lineAt - STACK.glowDelayMs) / STACK.glowMs;
      const amount = g > 0 && g < 1 ? STACK.glow * Math.sin(Math.PI * g) : 0;
      glow.copy(palette.onTime).lerp(WHITE, amount);
      for (let k = from; k < to; k += 1) {
        const marble = order[k];
        if (marble && marble.index >= 0) board.model.marbles.setColorAt(marble.index, glow);
      }
      board.colorsDirty = true;
      end = Math.max(end, lineAt + STACK.glowDelayMs + STACK.glowMs, lineAt + STACK.bandDelayMs + STACK.bandMs);
    }
    board.model.setTower({
      tower: layout,
      ground: clamp01((t - STACK.liftMs * 0.5) / STACK.groundMs),
      floors,
      line: { count: tower.onTime, shown: tower.lineShown },
      band: tower.band ? { ...tower.band, shown: tower.bandShown } : null,
    });
    if (t >= end) finishTower(board);
    return true;
  }

  // ---- What the controller says ----------------------------------------------------------------------------
  function begin(next: GaltonPass): void {
    if (comparing) single();
    const nonWorking = next.nonWorking ?? weekends;
    const fresh = next.fresh || !pass || boards.length === 0;
    const board = ensureBoard(next.contractDay, next.total, nonWorking);
    passId += 1;
    readyWorkersFor();
    tellAll(() => ({ type: 'forget' }));
    // What the runs are expected to need: the answer on the board now, if there is one, or a bell around the
    // contract date; each worker searches for its share.
    if (!reduced) {
      const weights = expectedWeights(board, next);
      tellAll(() => ({ type: 'expect', weights, total: Math.ceil(next.total / workerCount) }));
    }
    byRun.clear();
    waits = [];
    jumping = false;
    resultPending = false;
    pass = { ...next, landed: 0, settled: false, done: false };
    // The whole board while the runs pour: at once for a new board, back out over the drain otherwise.
    setShot('full', fresh);
    if (fresh) {
      // A board just built is empty already (and may still be warming up with a stand-in marble).
      if (board.marbles.length > 0 || board.result) board.clear();
      board.model.setTrapdoor(0);
      previousOdds = null;
      headline.classList.remove('is-shown');
      const mine = passId;
      void warming.then(() => {
        // An answer shown at once (the panel opened on one) is not taken back to an empty board.
        if (mine === passId && phase !== 'cascade' && !pass?.done) announce('board');
      });
    } else {
      // The odds asked again: the board drains, and the new runs pour in as they land.
      for (const marble of board.marbles) if (marble.state !== 'resting') board.release(marble);
      board.marbles.splice(0, board.marbles.length, ...board.marbles.filter((marble) => marble.state === 'resting'));
      void startDrain();
    }
    renderCounter();
    stage.wake();
  }

  function expectedWeights(board: Board, next: GaltonPass): number[] {
    const weights = new Array<number>(board.layout.bins.length).fill(0.5);
    const resting = board.marbles.filter((marble) => marble.state === 'resting');
    if (resting.length > 50) {
      for (const marble of resting) weights[marble.bin] = (weights[marble.bin] ?? 0) + 1;
      return weights;
    }
    const middle = binOfDay(board.layout, next.contractDay);
    const spread = 4;
    return weights.map((weight, bin) => weight + 100 * Math.exp(-((bin - middle) ** 2) / (2 * spread * spread)));
  }

  function land(landed: readonly { run: number; day: number }[]): void {
    const board = boards[0];
    if (!pass || !board || !layout) return;
    const now = performance.now();
    // Motion turned back on mid-pass: the physics starts now.
    readyWorkersFor();
    const items: { pass: number; run: number; bin: number }[][] = workers.map(() => []);
    for (const { run, day } of landed) {
      pass.landed += 1;
      if (byRun.has(run)) continue;
      const bin = binOfDay(layout, day);
      const marble: Marble = {
        run,
        day,
        bin,
        onTime: isOnTime(day, pass.contractDay),
        state: 'waiting',
        index: ENTRY_HIDDEN,
        landedAt: now,
        t0: now,
        frames: null,
        offset: 0,
        frameCount: 0,
        vx: 0,
        vy: 0,
        x: 0,
        y: 0,
        fromX: 0,
        fromY: 0,
        toX: 0,
        toY: 0,
        dropMs: 0,
        delay: 0,
      };
      byRun.set(run, marble);
      board.marbles.push(marble);
      if (jumping || reduced || workers.length === 0) {
        board.rest(marble);
        continue;
      }
      const worker = nextWorker++ % workers.length;
      items[worker]!.push({ pass: passId, run, bin });
    }
    items.forEach((need, worker) => {
      if (need.length > 0) tell(worker, { type: 'need', items: need });
    });
    renderCounter();
    stage.wake();
  }

  function settle(): void {
    if (!pass) return;
    pass.settled = true;
    announce('poured');
    renderCounter();
    stage.wake();
  }

  function jumpTo(state: 'result' | 'stacked'): void {
    if (state === 'stacked') {
      for (const board of boards) if (board.tower && !board.tower.done) finishTower(board);
      return;
    }
    if (state !== 'result') return;
    const board = boards[0];
    if (!board || !pass) return;
    // The poster frame is the piles: a tower goes back into them.
    if (boards.map((each) => snapBack(each)).some(Boolean)) {
      buildLabels();
      frameCamera(true);
    }
    jumping = true;
    flight = null;
    if (draining) {
      for (const marble of board.marbles) if (marble.state === 'draining') board.release(marble);
      board.marbles.splice(0, board.marbles.length, ...board.marbles.filter((marble) => marble.state !== 'draining' && marble.state !== 'gone'));
      draining.resolve();
      draining = null;
      board.model.setTrapdoor(0);
      announce('drained');
    }
    // Every marble straight into its place: the ones already resting keep theirs, the rest follow in run order.
    board.fill.fill(0);
    const ordered = [...board.marbles].sort((a, b) => (a.state === 'resting' ? 0 : 1) - (b.state === 'resting' ? 0 : 1) || a.run - b.run);
    for (const marble of ordered) {
      if (marble.state === 'resting') {
        restack(board, marble);
        continue;
      }
      board.rest(marble);
    }
    tellAll(() => ({ type: 'forget' }));
    if (pass.settled) {
      pass.done = true;
      showResult();
    } else {
      setShot('piles', true);
    }
    stage.wake();
  }

  function morph(results: GaltonResults, morphOptions: { instant?: boolean } = {}): void {
    const board = boards[0];
    if (!board || !pass) return;
    const instant = morphOptions.instant || reduced;
    const fill = () => {
      board.clear();
      byRun.clear();
      for (let i = 0; i < results.runs.length; i += 1) {
        const day = results.days[i]!;
        const marble: Marble = { run: results.runs[i]!, day, bin: binOfDay(board.layout, day), onTime: isOnTime(day, pass!.contractDay), state: 'waiting', index: ENTRY_HIDDEN, landedAt: 0, t0: 0, frames: null, offset: 0, frameCount: 0, vx: 0, vy: 0, x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0, dropMs: 0, delay: 0 };
        byRun.set(marble.run, marble);
        board.marbles.push(marble);
      }
      const now = performance.now();
      const ordered = [...board.marbles].sort((a, b) => a.run - b.run);
      for (const marble of ordered) {
        board.rest(marble);
        if (!instant) {
          // Settle in from just above, the bottom of each pile first.
          marble.state = 'dropping';
          marble.toX = marble.x;
          marble.toY = marble.y;
          marble.fromX = marble.x;
          marble.fromY = marble.y + 6;
          marble.vy = -60;
          marble.dropMs = 260;
          marble.t0 = now + (marble.y / board.layout.binTop) * 180;
          board.write(marble.index, marble.x, marble.fromY);
        }
      }
      pass!.landed = results.runs.length;
      pass!.settled = true;
      pass!.done = instant;
      if (instant) showResult();
      stage.wake();
    };
    if (instant) fill();
    else void startDrain().then(fill);
  }

  /** What the one board showed before two stood side by side: put back as it was when they go. */
  let beforeCompare: { runs: number[]; days: number[]; result: Board['result']; shot: Shot } | null = null;

  function compare(left: GaltonResults, right: GaltonResults, titles: [string, string] = ['Wait till Friday', 'Pay today'], notes: [string, string] = ['', 'with PayPal']): void {
    if (!layout || boards.length === 0 || !pass) return;
    // A tower standing on the one board: back in the piles, as the board was before.
    for (const board of boards) snapBack(board);
    if (!comparing) {
      const kept = boards[0]!.marbles.filter((marble) => marble.state !== 'draining' && marble.state !== 'gone');
      beforeCompare = { runs: kept.map((marble) => marble.run), days: kept.map((marble) => marble.day), result: boards[0]!.result, shot };
    }
    const width = boards[0]!.model.bounds.right - boards[0]!.model.bounds.left;
    while (boards.length < 2) {
      const board = new Board(layout, palette, boards[0]!.model.marbles.instanceMatrix.count);
      stage.scene.add(board.model.group);
      boards.push(board);
    }
    const shift = (width + COMPARE_GAP) / 2;
    boards[0]!.model.group.position.x = -shift;
    boards[1]!.model.group.position.x = shift;
    [left, right].forEach((results, index) => {
      const board = boards[index]!;
      board.clear();
      board.title = titles[index]!;
      board.note = notes[index]!;
      let onTime = 0;
      for (let i = 0; i < results.runs.length; i += 1) {
        const day = results.days[i]!;
        const marble: Marble = { run: results.runs[i]!, day, bin: binOfDay(board.layout, day), onTime: isOnTime(day, board.layout.contractDay), state: 'waiting', index: ENTRY_HIDDEN, landedAt: 0, t0: 0, frames: null, offset: 0, frameCount: 0, vx: 0, vy: 0, x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0, dropMs: 0, delay: 0 };
        if (marble.onTime) onTime += 1;
        board.marbles.push(marble);
      }
      for (const marble of [...board.marbles].sort((a, b) => a.run - b.run)) board.rest(marble);
      board.result = { onTime, total: results.runs.length };
      board.model.setTrapdoor(0);
    });
    comparing = true;
    jumping = false;
    flight = null;
    resultPending = false;
    headline.classList.remove('is-shown');
    counter.classList.remove('is-shown');
    buildLabels();
    frameCamera(true);
    announce('compare');
  }

  function single(): void {
    if (!comparing) return;
    for (const board of boards) snapBack(board);
    const extra = boards.splice(1);
    for (const board of extra) {
      stage.scene.remove(board.model.group);
      board.dispose();
    }
    const board = boards[0]!;
    board.model.group.position.x = 0;
    comparing = false;
    // The one board as it was before the side by side: every marble in its place again, the same answer.
    const kept = beforeCompare;
    beforeCompare = null;
    if (kept) {
      board.clear();
      byRun.clear();
      kept.runs.forEach((run, index) => {
        const day = kept.days[index]!;
        const marble: Marble = { run, day, bin: binOfDay(board.layout, day), onTime: isOnTime(day, board.layout.contractDay), state: 'waiting', index: ENTRY_HIDDEN, landedAt: 0, t0: 0, frames: null, offset: 0, frameCount: 0, vx: 0, vy: 0, x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0, dropMs: 0, delay: 0 };
        byRun.set(run, marble);
        board.marbles.push(marble);
        board.rest(marble);
      });
      board.result = kept.result;
      shot = kept.shot;
    } else {
      shot = board.result ? 'piles' : 'full';
    }
    buildLabels();
    frameCamera(true);
    renderHeadline();
    stage.wake();
    // The single board's answer is on screen again.
    if (board.result) announce('result');
  }

  frameCamera(true);

  return {
    begin,
    land,
    settle,
    morph,
    jumpTo,
    drain: startDrain,
    compare,
    single,
    stack,
    unstack,
    isStacked(side) {
      return boardsOf(side).some((board) => board.tower?.direction === 'up');
    },
    setSize(next) {
      if (next === size) return;
      size = next;
      container.dataset.size = size;
      buildLabels();
      renderHeadline();
      renderCounter();
      frameCamera(false);
    },
    setShot(next, shotOptions = {}) {
      setShot(next, shotOptions.instant ?? false);
    },
    setReducedMotion(next) {
      reduced = next;
    },
    async whenReady() {
      await warming;
      const started = performance.now();
      const enough = Math.min(400, Math.ceil((pass?.total ?? 1000) * 0.35));
      return new Promise<void>((resolve) => {
        const check = () => {
          const stocked = lastStats?.stocked ?? 0;
          if (reduced || workers.length === 0 || (readyWorkers >= workers.length && stocked >= enough) || performance.now() - started > 1500) resolve();
          else setTimeout(check, 40);
        };
        check();
      });
    },
    get phase() {
      return phase;
    },
    stats() {
      const board = boards[0];
      const tally = { waiting: 0, falling: 0, resting: 0 };
      for (const marble of board?.marbles ?? []) {
        if (marble.state === 'waiting') tally.waiting += 1;
        else if (marble.state === 'falling' || marble.state === 'dropping') tally.falling += 1;
        else if (marble.state === 'resting') tally.resting += 1;
      }
      const mean = waits.length > 0 ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
      return { worker: lastStats, ...tally, waitMean: mean, waitWorst: waits.length > 0 ? Math.max(...waits) : 0 };
    },
    dispose() {
      workers.forEach((worker) => worker.terminate());
      boards.forEach((board) => {
        board.dropTower();
        board.dispose();
      });
      stage.dispose();
      hud.remove();
      container.classList.remove('galton');
    },
  };
}

function mergeStats(all: readonly (WorkerStats | null)[]): WorkerStats | null {
  const known = all.filter((entry): entry is WorkerStats => entry !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, entry) => ({
    tried: sum.tried + entry.tried,
    aimed: sum.aimed + entry.aimed,
    aimHits: sum.aimHits + entry.aimHits,
    failed: sum.failed + entry.failed,
    handedOut: sum.handedOut + entry.handedOut,
    simulateMs: sum.simulateMs + entry.simulateMs,
    stocked: sum.stocked + entry.stocked,
    setupMs: Math.max(sum.setupMs, entry.setupMs),
  }));
}

/** The board as the odds controller's plot (odds/odds-controller.ts attachPlot): `end` settles, `show` morphs. */
export function galtonSink(board: OddsGalton) {
  return {
    begin: (pass: GaltonPass) => board.begin(pass),
    land: (landed: readonly { run: number; day: number }[]) => board.land(landed),
    end: (runs: readonly number[]) => board.settle(runs),
    show: (runs: ArrayLike<number>, days: ArrayLike<number>, instant?: boolean) => board.morph({ runs, days }, { instant: instant ?? false }),
  };
}

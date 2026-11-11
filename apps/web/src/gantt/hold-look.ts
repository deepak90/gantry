/**
 * The pay-to-proceed hold (gantt/pay-gates.ts), drawn so anyone can read it on the chart: what holds (the payment and
 * the work it pays for), what is held (the work after it), and the link between them drawn blocked, in caution amber
 * with a stop mark on it, until PayPal has paid. Then the block lifts: the mark goes, the link runs PayPal blue into
 * the held work for a moment, and the held work's hatching fades.
 *
 * The walkthrough lights the hold a part at a time (`lightHold`): the rest of the chart steps back slowly while the
 * part in question is outlined. Bryntum draws all of it: the bars' classes come from the task renderer (look.ts), the
 * link's from the Dependencies feature's `renderer`, which gets the line's points and may change its DomConfig. There
 * is one Gantt per page, so the state is kept here.
 */
import type { DependencyModel, DomConfig, Gantt, ProjectModel, TaskModel } from '@bryntum/gantt';
import { gateIndex, workUnder, type Gate } from './pay-gates';
import { walkTree } from './walk';

type Id = number | string;

/** The parts of a hold that can be lit: the payment with the work it pays for, the held work, the link between. */
export type HoldPart = 'holding' | 'held' | 'link';

/** How long the block takes to lift once PayPal has paid. */
export const LIFT_MS = 3600;

let chart: Gantt | null = null;
let lit: { gateId: Id; parts: Set<HoldPart> } | null = null;
/** Rows lit now, by id: the payment's side or the held side. */
let litRows = new Map<Id, 'holding' | 'held'>();
/** Gates whose block is lifting, until when (ms since the epoch); and the rows they release. */
const lifting = new Map<Id, number>();
let liftRows = new Set<Id>();
let liftTimer: ReturnType<typeof setTimeout> | undefined;
/** Something (the payment window) covers the chart: a release waits until it is uncovered, so it is seen. */
let covers = 0;
const queued = new Set<Id>();

const plan = () => (chart && !chart.isDestroyed ? (chart.project as unknown as ProjectModel) : null);

function rowsUnder(rows: readonly TaskModel[], into: Set<Id>): void {
  for (const row of rows) walkTree(row, (node) => into.add(node.id));
}

function gateById(gateId: Id): Gate | null {
  const project = plan();
  return project ? (gateIndex(project).gates.get(gateId) ?? null) : null;
}

/** Works out which rows are lit and which are being released, from the plan as it is now. */
function settle(): void {
  litRows = new Map();
  const gate = lit ? gateById(lit.gateId) : null;
  if (lit && gate) {
    if (lit.parts.has('holding')) {
      const paying = new Set<Id>([gate.id]);
      rowsUnder(gate.pays, paying);
      for (const task of workUnder(gate.pays)) paying.add(task.id);
      for (const id of paying) litRows.set(id, 'holding');
    }
    if (lit.parts.has('held')) {
      const held = new Set<Id>();
      rowsUnder(gate.holds, held);
      for (const id of held) litRows.set(id, 'held');
    }
  }
  liftRows = new Set();
  for (const gateId of lifting.keys()) {
    const lifted = gateById(gateId);
    if (lifted) rowsUnder(lifted.holds, liftRows);
  }
}

/** Redraws what the hold's look touches: the bars and their labels, the links (Bryntum caches drawn links). */
function redraw(): void {
  settle();
  if (!chart || chart.isDestroyed) return;
  chart.element?.classList.toggle('look-spotlight', litRows.size > 0);
  chart.refreshRows();
  (chart.features as unknown as { dependencies?: { reset?(): void } }).dependencies?.reset?.();
}

/**
 * Lights a hold's parts on the chart (the rest steps back), or puts it out with `null`. Parts already lit stay lit:
 * lighting `held` after `holding` adds the held work to the payment and its work.
 */
export function lightHold(gateId: Id | null, parts: readonly HoldPart[] = ['holding', 'held', 'link']): void {
  lit = gateId === null || parts.length === 0 ? null : { gateId, parts: new Set(parts) };
  redraw();
}

function lift(gateId: Id): void {
  lifting.set(gateId, Date.now() + LIFT_MS);
  redraw();
  clearTimeout(liftTimer);
  const next = Math.min(...lifting.values()) - Date.now();
  liftTimer = setTimeout(() => {
    const now = Date.now();
    for (const [id, until] of lifting) if (until <= now) lifting.delete(id);
    redraw();
  }, Math.max(0, next));
}

/** PayPal has paid this gate: its block lifts now, or as soon as nothing covers the chart. */
export function releaseHold(gateId: Id): void {
  if (covers > 0) queued.add(gateId);
  else lift(gateId);
}

/** Something covers the chart while `on` (the payment window): a payment landing meanwhile is lifted once it is gone. */
export function coverChart(on: boolean): void {
  covers = Math.max(0, covers + (on ? 1 : -1));
  if (covers > 0) return;
  for (const gateId of [...queued]) {
    queued.delete(gateId);
    lift(gateId);
  }
}

/** Whether a gate's block is lifting right now. */
export function isLifting(gateId: Id): boolean {
  return (lifting.get(gateId) ?? 0) > Date.now();
}

/**
 * The chart the hold is drawn on (GanttWorkspace sets it). Watches the plan's gates: one that turns paid, here or on
 * someone else's screen, has its block lifted. Returns the way to stop.
 */
export function drawHoldOn(gantt: Gantt | null): () => void {
  chart = gantt;
  const project = plan();
  if (!project) return () => {};
  const states = new Map<Id, string>();
  for (const gate of gateIndex(project).gates.values()) states.set(gate.id, gate.payGate.state);
  // After every listener of the change has run (the gate index forgets itself on the same change).
  const look = () =>
    queueMicrotask(() => {
      if (project.isDestroyed) return;
      for (const gate of gateIndex(project).gates.values()) {
        const before = states.get(gate.id);
        states.set(gate.id, gate.payGate.state);
        if (before !== undefined && before !== 'paid' && gate.payGate.state === 'paid') releaseHold(gate.id);
      }
      if (lit || lifting.size > 0) settle();
    });
  const store = project.taskStore as unknown as { on(config: object): () => void };
  const stop = store.on({ change: look, refresh: look });
  return () => {
    stop?.();
    if (chart === gantt) chart = null;
  };
}

// ---------------------------------------------------------------------------------------------
// What the renderers ask
// ---------------------------------------------------------------------------------------------

/** The hold's classes for a bar: lit (the payment's side or the held side), or being released. */
export function holdClasses(task: TaskModel): string[] {
  const classes: string[] = [];
  const side = litRows.get(task.id);
  if (side) classes.push('look-lit', `look-lit-${side}`);
  if (liftRows.has(task.id)) classes.push('look-lifting');
  return classes;
}

/** Whether a held row's tag says it was just released (while its block lifts). */
export const isBeingReleased = (task: TaskModel) => liftRows.has(task.id);

interface Point {
  x: number;
  y: number;
}

/** A stretch of a drawn link, as Bryntum's path finder gives it. */
export interface LinkSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const f = (value: number) => Math.round(value * 10) / 10;

/** A polyline with its corners rounded the way Bryntum rounds a link's (`radius`), as path commands. */
function rounded(points: readonly Point[], radius: number): string {
  const out = [`M ${f(points[0]!.x)} ${f(points[0]!.y)}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const [a, v, b] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const inLength = Math.hypot(v.x - a.x, v.y - a.y);
    const outLength = Math.hypot(b.x - v.x, b.y - v.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r <= 0.5) {
      out.push(`L ${f(v.x)} ${f(v.y)}`);
      continue;
    }
    const p1 = { x: v.x - ((v.x - a.x) / inLength) * r, y: v.y - ((v.y - a.y) / inLength) * r };
    const p2 = { x: v.x + ((b.x - v.x) / outLength) * r, y: v.y + ((b.y - v.y) / outLength) * r };
    out.push(`L ${f(p1.x)} ${f(p1.y)}`, `Q ${f(v.x)} ${f(v.y)} ${f(p2.x)} ${f(p2.y)}`);
  }
  const last = points.at(-1)!;
  out.push(`L ${f(last.x)} ${f(last.y)}`);
  return out.join(' ');
}

/**
 * The link redrawn with a stop mark on it: a circle with an X in it, the line broken around it. The Gantt draws a link
 * from the held work back to the payment (its arrowhead is the path's start marker), so the mark goes on the upright
 * stretch nearest the payment that has room, close to the payment's end of it; else in the middle of the longest
 * stretch. The mark's strokes come after the line's, so the arrowhead stays where it was. Null when no stretch has room.
 */
export function stopMarkPath(segments: readonly LinkSegment[], radius: number, corner = 0): string | null {
  if (segments.length === 0) return null;
  const points: Point[] = [{ x: segments[0]!.x1, y: segments[0]!.y1 }, ...segments.map((segment) => ({ x: segment.x2, y: segment.y2 }))];
  const stretches = points.slice(1).map((to, index) => {
    const from = points[index]!;
    return { index, from, to, length: Math.hypot(to.x - from.x, to.y - from.y), upright: Math.abs(to.x - from.x) < 0.5 };
  });
  const room = radius * 2 + 10;
  const upright = [...stretches].reverse().find((stretch) => stretch.upright && stretch.length >= room);
  const longest = stretches.reduce((best, stretch) => (stretch.length > best.length ? stretch : best));
  const chosen = upright ?? (longest.length >= room ? longest : null);
  if (!chosen) return null;
  // Measured from the payment's end of the stretch (its `to`, in the path's order).
  const ux = (chosen.to.x - chosen.from.x) / chosen.length;
  const uy = (chosen.to.y - chosen.from.y) / chosen.length;
  const back = upright ? Math.min(chosen.length / 2, Math.max(radius + 9, 22)) : chosen.length / 2;
  const cx = chosen.to.x - ux * back;
  const cy = chosen.to.y - uy * back;
  const gap = radius + 2.5;
  const before = [...points.slice(0, chosen.index + 1), { x: cx - ux * gap, y: cy - uy * gap }];
  const after = [{ x: cx + ux * gap, y: cy + uy * gap }, ...points.slice(chosen.index + 1)];
  const k = radius * 0.48;
  return [
    rounded(before, corner),
    rounded(after, corner),
    `M ${f(cx - radius)} ${f(cy)} a ${radius} ${radius} 0 1 0 ${f(radius * 2)} 0 a ${radius} ${radius} 0 1 0 ${f(-radius * 2)} 0`,
    `M ${f(cx - k)} ${f(cy - k)} L ${f(cx + k)} ${f(cy + k)} M ${f(cx - k)} ${f(cy + k)} L ${f(cx + k)} ${f(cy - k)}`,
  ].join(' ');
}

/**
 * The Dependencies feature's renderer: a link that leaves a payment not yet made is drawn blocked (caution amber, the
 * stop mark), larger while the walkthrough lights it; once paid, it runs PayPal blue into the held work while the block
 * lifts. Other links are left as Bryntum draws them.
 */
export function holdLinkRenderer({ domConfig, dependencyRecord, points }: { domConfig: DomConfig; dependencyRecord: DependencyModel; points?: readonly object[] }): void {
  const from = dependencyRecord.fromEvent as unknown as TaskModel | null;
  if (!from?.isMilestone) return;
  const project = (from as unknown as { project?: ProjectModel }).project;
  const gate = project?.taskStore ? gateIndex(project).gates.get(from.id) : undefined;
  if (!gate) return;
  const config = domConfig as DomConfig & { d?: string; class?: Record<string, unknown> };
  const classes = (config.class ??= {}) as Record<string, unknown>;
  if (gate.holding) {
    const big = lit?.gateId === gate.id && lit.parts.has('link');
    classes['look-dep-hold'] = 1;
    classes['is-lit'] = big ? 1 : 0;
    const corner = (chart?.features as unknown as { dependencies?: { radius?: number | null } } | undefined)?.dependencies?.radius ?? 0;
    const path = points ? stopMarkPath(points as readonly LinkSegment[], big ? 8 : 6.5, corner) : null;
    if (path) {
      config.d = path;
    }
  } else if (isLifting(gate.id)) {
    classes['look-dep-lifted'] = 1;
  }
}


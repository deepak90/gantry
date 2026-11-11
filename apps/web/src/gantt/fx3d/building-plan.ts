/**
 * The building in a plan: which rows build which part of it. Each task is read from its own name and the names of the
 * groups it sits in ("Pour deck, level 2" under "Concrete deck, level 2"), so the plan's outline and the model are the
 * same thing: a row is a piece of the building, a group is the pieces of its rows.
 *
 * The building is a stack of layers: the foundations below the ground, one layer per story from the ground floor up,
 * and the roof. A layer is everything from its floor plate to the floor plate above: the slab or deck it stands on,
 * the columns, the glass around it and what is built inside. The steel and the curtain wall are one row each that
 * goes up every story in turn; the clean and the handover are the whole building.
 *
 * Pure: no three.js here, so the reading can be tested on its own.
 */

export type PartKind =
  | 'mobilize'
  | 'excavate'
  | 'forms'
  | 'rebar'
  | 'pour'
  | 'cure'
  | 'strip'
  | 'base'
  | 'steel'
  | 'roofing'
  | 'curtainwall'
  | 'storefront'
  | 'lobby'
  | 'layout'
  | 'partitions'
  | 'rough'
  | 'drywall'
  | 'grid'
  | 'order'
  | 'delivery'
  | 'wiring'
  | 'lights'
  | 'test'
  | 'tiles'
  | 'paint'
  | 'flooring'
  | 'clean'
  | 'handover'
  | 'inspection'
  | 'other';

/** What a concrete step works on. */
export type PourTarget = 'footings' | 'slab' | 'deck';

export type MachineKind = 'crane' | 'pump' | 'lift' | 'excavator';

export interface PlanCrew {
  name: string;
  color: string;
  people: number;
}

export interface PlanMachine {
  kind: MachineKind;
  name: string;
  /** On rent from the first to the second (epoch ms, the second exclusive). */
  booked: readonly [number, number];
  /** What a day of it costs, in minor units; 0 for someone who may not see money. */
  rateMinor: number;
}

/** One row of the plan, as the building needs it. */
export interface PlanTask {
  id: number;
  name: string;
  /** The groups it sits in, outermost first. */
  path: readonly string[];
  /** The ids of those groups, outermost first. */
  pathIds: readonly number[];
  wbs: string;
  /** Epoch ms; the end is exclusive. */
  start: number;
  end: number;
  /** Midnights of its working days. */
  workDays: readonly number[];
  /** The bar's color on the chart. */
  color: string;
  crews: readonly PlanCrew[];
  machine: PlanMachine | null;
  /** Reported done, from 0 to 100. */
  percent: number;
  milestone: boolean;
}

export interface Part {
  task: PlanTask;
  kind: PartKind;
  /** The layer it builds in; -1 for work that goes up the whole building (steel, curtain wall, clean, handover). */
  layer: number;
  target: PourTarget | null;
}

export interface Layer {
  index: number;
  /** "Foundations", "Ground floor", "Level 2", "Roof". */
  name: string;
  short: string;
  /** Rows that build in it, in plan order. */
  parts: Part[];
  /** The plan's group for it, when there is one: what selecting the layer selects. */
  groupId: number | null;
}

export interface Booking {
  task: PlanTask;
  machine: PlanMachine;
  /** The layer it works on: the lift stands on a floor, the crane and the pump on the ground. */
  layer: number;
}

export interface BuildingPlan {
  /** Stories above the foundations, the ground floor first. */
  stories: number;
  /** Foundations (0), one per story (1 to `stories`), the roof (`stories + 1`). */
  layers: Layer[];
  parts: Part[];
  /** Every rental on the plan, in plan order. */
  bookings: Booking[];
  /** From the first day of work or rent to the last. */
  span: readonly [number, number];
}

export const FOUNDATIONS = 0;
const DAY_MS = 86_400_000;
export const roofOf = (plan: Pick<BuildingPlan, 'stories'>): number => plan.stories + 1;
/** The layer of a story: the ground floor is level 0. */
export const layerOfLevel = (level: number): number => level + 1;

const RULES: readonly { kind: PartKind; test: RegExp }[] = [
  { kind: 'handover', test: /hand ?over/ },
  { kind: 'inspection', test: /\binspect/ },
  { kind: 'clean', test: /\bclean/ },
  { kind: 'mobilize', test: /mobiliz|site set ?up|set up (the )?site|hoarding|\bfenc/ },
  { kind: 'excavate', test: /excavat|\bdig\b|earthwork|bulk dig/ },
  { kind: 'strip', test: /\bstrip|backfill/ },
  { kind: 'base', test: /gravel|vapou?r|sub-?base|stone base/ },
  { kind: 'forms', test: /\bforms?\b|formwork|shoring/ },
  { kind: 'rebar', test: /rebar|reinforc|\bmesh\b/ },
  { kind: 'pour', test: /\bpour|place concrete|concrete placement/ },
  { kind: 'cure', test: /\bcur(e|es|ing)\b/ },
  { kind: 'steel', test: /\bsteel\b|metal deck|structural frame|\berect\b/ },
  { kind: 'roofing', test: /\broof/ },
  { kind: 'curtainwall', test: /curtain ?wall|glazing|cladding|fa[cç]ade/ },
  { kind: 'storefront', test: /storefront|entrance/ },
  { kind: 'lobby', test: /\blobby/ },
  { kind: 'layout', test: /lay ?out/ },
  { kind: 'partitions', test: /partition|\bstuds?\b/ },
  { kind: 'rough', test: /rough-?in/ },
  { kind: 'drywall', test: /drywall|gypsum|hang and tape|plasterboard/ },
  { kind: 'order', test: /\border\b|\bprocure/ },
  { kind: 'delivery', test: /deliver/ },
  { kind: 'wiring', test: /wiring|mounting|\bwhips?\b/ },
  { kind: 'test', test: /\btest|\baim\b|commission/ },
  { kind: 'lights', test: /light|luminaire|fixture/ },
  { kind: 'grid', test: /ceiling grid|\bgrid\b/ },
  { kind: 'tiles', test: /\btiles?\b/ },
  { kind: 'paint', test: /\bpaint/ },
  { kind: 'flooring', test: /floor finish|carpet|flooring|floor covering/ },
];

const CONCRETE: ReadonlySet<PartKind> = new Set(['forms', 'rebar', 'pour', 'cure', 'strip', 'base']);
/** The rows of a pour's group: its concrete steps and the inspection that signs them off. */
const POUR_GROUP: ReadonlySet<PartKind> = new Set([...CONCRETE, 'inspection']);
/** Work that goes up the whole building rather than one layer. */
const WHOLE: ReadonlySet<PartKind> = new Set(['steel', 'curtainwall', 'clean', 'handover']);

export function kindOf(name: string): PartKind {
  const words = name.toLowerCase();
  return RULES.find((rule) => rule.test.test(words))?.kind ?? 'other';
}

/** The story a name speaks of: 0 for the ground floor, n for level n, null for none. */
export function levelIn(name: string): number | null {
  const words = name.toLowerCase();
  const level = /\blevel\s*(\d+)/.exec(words) ?? /\b(\d+)(?:st|nd|rd|th)\s+floor/.exec(words);
  if (level) return Number(level[1]);
  if (/ground floor|ground level|\blobby|storefront|slab on grade|slab-on-grade/.test(words)) return 0;
  return null;
}

function targetOf(task: PlanTask): PourTarget | null {
  for (const words of [task.name, ...[...task.path].reverse()].map((name) => name.toLowerCase())) {
    if (/footing|foundation/.test(words)) return 'footings';
    if (/slab on grade|slab-on-grade|ground slab/.test(words)) return 'slab';
    if (/\bdeck\b|\blevel\s*\d|floor slab/.test(words)) return 'deck';
  }
  return null;
}

/** The level of a row: its own name first, then its groups from the nearest out. */
function levelOf(task: PlanTask): number | null {
  for (const name of [task.name, ...[...task.path].reverse()]) {
    const level = levelIn(name);
    if (level !== null) return level;
  }
  return null;
}

/** Reads the building out of a plan; null when the plan is not a building of several stories. */
export function readBuilding(tasks: readonly PlanTask[]): BuildingPlan | null {
  const levels = new Set<number>();
  const read = tasks
    .filter((task) => task.end >= task.start)
    .map((task) => {
      const kind = kindOf(task.name);
      const level = levelOf(task);
      if (level !== null) levels.add(level);
      return { task, kind, level, target: CONCRETE.has(kind) ? targetOf(task) : null };
    });
  const known = read.filter((entry) => entry.kind !== 'other');
  // A building has floors to stand in and a structure or fit-out to show on them.
  if (levels.size < 3 || known.length < 6) return null;
  const stories = Math.max(...levels) + 1;
  const roof = stories + 1;
  const parts: Part[] = read.map(({ task, kind, level, target }) => {
    let layer: number;
    if (WHOLE.has(kind)) layer = -1;
    else if (kind === 'roofing') layer = roof;
    else if (kind === 'mobilize' || kind === 'excavate' || target === 'footings') layer = FOUNDATIONS;
    else if (target === 'slab') layer = layerOfLevel(0);
    else if (level !== null) layer = layerOfLevel(Math.min(level, stories - 1));
    else layer = FOUNDATIONS;
    return { task, kind, layer, target };
  });

  const layers: Layer[] = Array.from({ length: stories + 2 }, (_, index) => {
    const name = index === FOUNDATIONS ? 'Foundations' : index === roof ? 'Roof' : index === 1 ? 'Ground floor' : `Level ${index - 1}`;
    const short = index === FOUNDATIONS ? 'F' : index === roof ? 'R' : index === 1 ? 'G' : `L${index - 1}`;
    return { index, name, short, parts: parts.filter((part) => part.layer === index), groupId: null };
  });
  // A story's group is the one named for it that builds it out ("Level 2 build-out"): not a pour's group ("Concrete
  // deck, level 2"), which is chosen as the pour, so its own pieces are what shows.
  for (const layer of layers) {
    const groups = new Map<number, { name: string; count: number; concrete: boolean }>();
    for (const part of layer.parts) {
      const at = part.task.pathIds.length - 1;
      const id = part.task.pathIds[at];
      if (id === undefined) continue;
      const entry = groups.get(id) ?? { name: part.task.path[at] ?? '', count: 0, concrete: true };
      entry.count += 1;
      entry.concrete &&= POUR_GROUP.has(part.kind);
      groups.set(id, entry);
    }
    const level = layer.index - 1;
    const [best] = [...groups.entries()].filter(([, group]) => !group.concrete && levelIn(group.name) === level).sort((a, b) => b[1].count - a[1].count);
    if (best) layer.groupId = best[0];
  }

  const bookings: Booking[] = parts
    .filter((part) => part.task.machine)
    .map((part) => ({ task: part.task, machine: part.task.machine!, layer: part.task.machine!.kind === 'lift' && part.layer > 0 ? part.layer : FOUNDATIONS }));
  const times = tasks.flatMap((task) => [task.start, task.end, ...(task.machine ? task.machine.booked : [])]);
  // A day past the last date, so the end of the plan (a handover on its own day) can be seen as it stands.
  return { stories, layers, parts, bookings, span: [Math.min(...times), Math.max(...times) + DAY_MS] };
}

/**
 * How far a row has come on a date, from 0 to 1, by its working days: a weekend inside it builds nothing. A row with no
 * working days (a milestone) is done from its start.
 */
export function builtBy(task: Pick<PlanTask, 'workDays' | 'start' | 'end'>, date: number): number {
  const days = task.workDays;
  if (days.length === 0) return date >= task.start ? 1 : 0;
  let done = 0;
  for (const midnight of days) {
    if (date >= midnight + DAY_MS) done += 1;
    else if (date > midnight) {
      done += (date - midnight) / DAY_MS;
      break;
    } else break;
  }
  return Math.min(1, done / days.length);
}

/**
 * Whether a machine is on rent on a date, whether it has work then, and whether it is idle: on rent before or after
 * its work. A day off inside the work (a weekend) is paid for but not idle, since no new dates take it away.
 */
export function machineOn(booking: Pick<Booking, 'task' | 'machine'>, date: number): { booked: boolean; working: boolean; idle: boolean } {
  const [from, to] = booking.machine.booked;
  const booked = date >= from && date < to;
  const day = new Date(date);
  const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const inside = date >= booking.task.start && date < booking.task.end;
  return { booked, working: booked && inside && booking.task.workDays.includes(midnight), idle: booked && !inside };
}

/** Days on rent with no work planned up to a date, and what they come to. */
export function idleBy(booking: Pick<Booking, 'task' | 'machine'>, date: number): { days: number; costMinor: number } {
  const [from, to] = booking.machine.booked;
  const work = new Set(booking.task.workDays);
  let days = 0;
  for (let at = from; at < to && at <= date; at = nextMidnight(at)) {
    const inside = at >= booking.task.start && at < booking.task.end;
    // A weekend inside the work is paid but not idle: no new dates take it away.
    if (!work.has(at) && !inside) days += 1;
  }
  return { days, costMinor: days * booking.machine.rateMinor };
}

function nextMidnight(at: number): number {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
}

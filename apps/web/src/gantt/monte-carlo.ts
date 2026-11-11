/**
 * The odds: a Monte Carlo of the schedule, run by Bryntum's own scheduling engine. Each run is a branch of the live
 * engine graph (the way gantt/late-payment.ts asks what a late payment costs): every task with work left gets a
 * length drawn from its range, each payment hold is paid by the scenario's rule, the handover is read back, and the
 * branch is thrown away. The plan, its stores, its undo history and its revisions never see a run. A thousand runs
 * give the chance of handing over by the contract date, the spread of handover days, how late each task can finish,
 * and which tasks move the handover most.
 *
 * The rules of branching are the late-payment forecast's: commit first (a branch sees committed data only); never
 * branch while the engine is committing; postpone conflicts inside the branch; never touch split tasks' segments;
 * only use calendars already in the plan (a new calendar, or a change to one, would reach the live plan); read in
 * the same turn as the writes; always clear the branch.
 *
 * Runs go in slices of a few milliseconds, giving the browser a turn between slices, so the page stays live and the
 * dots can land as the runs finish. Other people keep working meanwhile: a question is about the plan as it was
 * asked, and if an edit lands before it is answered, the rest of its runs go on a copy of that plan (OddsQuestion),
 * as the late-payment forecast falls back to a copy. Every number is the engine's; the assumptions (the ranges, the
 * seed, the pay rule, the Saturday premium) are the person's, and are shown with the results.
 */
import type { CalendarModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import { readPayGate, type PayGateState, type ProjectInlineData } from '@collab/shared';
import { handoverTask, isOutsidersTask, onWorkingTime, saturdayCalendar } from './late-payment';
import { crewSizeOn, laborOf } from './look';
import { firmOf, gateIndex } from './pay-gates';
import { createProjectModel, loadProjectInlineData, readProjectInlineData } from './project';
import { planClock } from '../plan-clock';
import {
  dateOfDay,
  dayNumber,
  diceKey,
  dice,
  drawnLength,
  percentile,
  rankCorrelation,
  sortedCopy,
  weekdayOf,
  workKind,
  WORK_KINDS,
  type Id,
  type ThreePoint,
  type WorkKind,
} from './monte-carlo-sampling';
import { walkTree } from './walk';

export { dateOfDay, dayNumber, type Id, type ThreePoint, type WorkKind } from './monte-carlo-sampling';

// ---------------------------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------------------------

/** How a payment hold still waiting for its money is paid: on the Friday pay run, or on the day it falls due. */
export type PayPolicy = 'payRun' | 'due';

export interface OddsAssumptions {
  /** Each kind of work's range, in multiples of its planned length. */
  ranges: Record<WorkKind, ThreePoint>;
  /** How many runs answer a question. */
  runs: number;
  seed: number;
  /** What a Saturday costs against a weekday: 1.5 is time and a half. */
  saturdayPremium: number;
  /** What an hour of a crew member costs, loaded, in dollars: the premium is paid on it. */
  hourlyRate: number;
  /** How the holds still waiting are paid, unless a scenario says otherwise for one of them. */
  payPolicy: PayPolicy;
}

/** The defaults, in one place. */
export const DEFAULT_ASSUMPTIONS: OddsAssumptions = {
  ranges: {
    winter: { low: 0.9, likely: 1, high: 1.35 },
    outdoor: { low: 0.95, likely: 1, high: 1.2 },
    indoor: { low: 0.95, likely: 1, high: 1.15 },
    inspection: { low: 1, likely: 1, high: 1.5 },
  },
  runs: 1000,
  seed: 7,
  saturdayPremium: 1.5,
  hourlyRate: 65,
  payPolicy: 'payRun',
};

/** The hours of a Saturday worked. */
export const SATURDAY_HOURS = 8;

export const KIND_WORDS: Record<WorkKind, string> = {
  winter: 'Outdoor work in winter',
  outdoor: 'Outdoor work',
  indoor: 'Indoor work',
  inspection: 'Inspections and tests',
};

/** The pay run's day of the week (Friday). */
export const PAY_RUN_WEEKDAY = 5;

// ---------------------------------------------------------------------------------------------
// The plan, as the runs see it
// ---------------------------------------------------------------------------------------------

export interface VaryingTask {
  task: TaskModel;
  id: Id;
  name: string;
  kind: WorkKind;
  /** Its planned length, in its own duration unit. */
  planned: number;
  /** The share of it already done (0 to 1). */
  done: number;
  key: number;
}

export interface HoldLever {
  id: Id;
  task: TaskModel;
  /** The milestone's name ("Footings paid"). */
  name: string;
  /** The work it pays for ("Footings"). */
  pays: string;
  /** The work it holds ("Slab on grade"). */
  holds: string;
  /** The tasks its payment waits for: it falls due on the last day of the last of them. */
  sources: TaskModel[];
  state: PayGateState;
  /** The plan has the payment set for a later day than it falls due. */
  pinned: boolean;
  /** The day it falls due in the plan as it stands. */
  dueDay: number | null;
}

export interface OddsPlan {
  project: ProjectModel;
  handover: TaskModel;
  /** The day the keys must change hands by: a deadline on the handover, a finish-no-later-than date, or the day it was first planned. */
  contractDay: number;
  contractFrom: 'deadline' | 'constraint' | 'baseline' | 'plan';
  /** The handover in the plan as it stands (a working day). */
  plannedDay: number | null;
  /** Tasks with work left: their lengths vary. */
  varying: VaryingTask[];
  /** Holds still waiting for their money, in the order they fall due. */
  holds: HoldLever[];
  calendar: CalendarModel | null;
  /** The plan's Monday-to-Saturday calendar, if it has one. */
  saturdays: CalendarModel | null;
  hoursPerDay: number;
  /** Every task whose finish the runs read (for each task's P80 finish). */
  finishes: TaskModel[];
  /** The kinds of work that vary, in a fixed order. */
  kinds: WorkKind[];
  /** Split tasks keep their planned length (their pieces are never touched in a branch). */
  splitKept: number;
  /** Payments can't be made before today (the plan's today: plan-clock.ts). */
  todayDay: number;
  /** What the plan was when this was read: a run on a plan that has changed since is stale. */
  signature: string;
}

export class OddsError extends Error {}

export class OddsCanceledError extends OddsError {
  constructor() {
    super('Canceled.');
  }
}

interface TreeNode {
  isLeaf: boolean;
  isRoot?: boolean;
  parent: TaskModel | null;
  traverse(fn: (node: TaskModel) => void): void;
}
const tree = (task: TaskModel) => task as unknown as TreeNode;

const fieldOf = (task: TaskModel, field: string): unknown => (task as unknown as Record<string, unknown>)[field];
const numberOf = (task: TaskModel, field: string): number => {
  const value = fieldOf(task, field);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

function groupsOf(task: TaskModel): string[] {
  const names: string[] = [];
  for (let parent = tree(task).parent; parent && !tree(parent).isRoot; parent = tree(parent).parent) names.push(parent.name ?? '');
  return names;
}

function tradesOf(task: TaskModel): string[] {
  const trades: string[] = [];
  for (const assignment of (task.assignments ?? []) as { resource?: { trade?: string; kind?: string } | null }[]) {
    const trade = assignment.resource?.trade;
    if (trade && assignment.resource?.kind !== 'equipment') trades.push(trade);
  }
  return trades;
}

const hasSegments = (task: TaskModel) => {
  const segments = fieldOf(task, 'segments');
  return Array.isArray(segments) && segments.length > 0;
};

/** The day the keys must change hands by, and where that date comes from. */
export function contractDayOf(handover: TaskModel, calendar: CalendarModel | null): { day: number; from: OddsPlan['contractFrom'] } {
  const deadline = fieldOf(handover, 'deadlineDate');
  if (deadline instanceof Date) return { day: dayNumber(deadline), from: 'deadline' };
  const constraint = handover.constraintType;
  if ((constraint === 'finishnolaterthan' || constraint === 'mustfinishon') && handover.constraintDate instanceof Date) {
    return { day: dayNumber(handover.constraintDate), from: 'constraint' };
  }
  const baseline = (handover as TaskModel & { baselines?: { first?: { startDate?: Date } } }).baselines?.first?.startDate;
  if (baseline instanceof Date) return { day: dayNumber(onWorkingTime(calendar, baseline)), from: 'baseline' };
  const start = handover.startDate instanceof Date ? handover.startDate : planClock.now();
  return { day: dayNumber(onWorkingTime(calendar, start)), from: 'plan' };
}

/**
 * A short fingerprint of everything the runs depend on (dates, lengths, progress, constraints, calendars, links,
 * payments, budgets), to tell whether the plan has changed since a question was asked. Names, notes and crews are
 * left out: they change no run.
 */
export function planSignature(project: ProjectModel): string {
  const time = (value: unknown) => (value instanceof Date ? value.getTime() : 0);
  const parts: string[] = [];
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    const calendar = (fieldOf(task, 'calendar') as { id?: unknown } | null | undefined)?.id ?? '';
    const segments = fieldOf(task, 'segments');
    parts.push(
      [
        task.id,
        time(task.startDate),
        time(task.endDate),
        task.duration,
        task.durationUnit,
        task.percentDone,
        task.constraintType ?? '',
        time(task.constraintDate),
        String(calendar),
        fieldOf(task, 'ignoreResourceCalendar') ? 1 : 0,
        fieldOf(task, 'manuallyScheduled') ? 1 : 0,
        fieldOf(task, 'inactive') ? 1 : 0,
        Array.isArray(segments) ? segments.length : 0,
        readPayGate(fieldOf(task, 'payGate'))?.state ?? '',
        numberOf(task, 'budgetMinor'),
      ].join(':'),
    );
  }
  for (const link of project.dependencyStore.allRecords as unknown as { fromEvent?: { id?: unknown } | null; toEvent?: { id?: unknown } | null; type?: number; lag?: number; lagUnit?: string; active?: boolean }[]) {
    parts.push(`>${String(link.fromEvent?.id)}>${String(link.toEvent?.id)}>${link.type}>${link.lag}>${link.lagUnit}>${link.active === false ? 0 : 1}`);
  }
  const text = parts.join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${text.length}`;
}

/** The day a hold's money falls due: the last day of the last task it pays for, as the plan has them. */
function liveDueDay(sources: readonly TaskModel[], gate: TaskModel): number | null {
  const ends = sources.map((task) => task.endDate).filter((end): end is Date => end instanceof Date);
  const at = ends.length > 0 ? new Date(Math.max(...ends.map((end) => end.getTime()))) : gate.startDate instanceof Date ? gate.startDate : null;
  return at ? dueDayOf(at) : null;
}

/** Work that ends at the start of a day was done the day before. */
const dueDayOf = (end: Date): number => (end.getHours() === 0 && end.getMinutes() === 0 ? dayNumber(end) - 1 : dayNumber(end));

/**
 * The plan as the runs see it: the tasks whose lengths vary and their kinds, the holds, the handover and the
 * contract date. Throws OddsError when there is nothing to ask (no handover milestone, nothing left to do).
 */
export function readOddsPlan(project: ProjectModel, options: { today?: Date } = {}): OddsPlan {
  const handover = handoverTask(project);
  if (!handover) throw new OddsError('The plan has no handover milestone to aim for.');
  const calendar = (project as unknown as { calendar?: CalendarModel }).calendar ?? null;
  const contract = contractDayOf(handover, calendar);
  const plannedDay = handover.startDate instanceof Date ? dayNumber(onWorkingTime(calendar, handover.startDate)) : null;
  const { gates } = gateIndex(project);

  const varying: VaryingTask[] = [];
  const finishes: TaskModel[] = [];
  let splitKept = 0;
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    if (tree(task).isRoot || !(task.startDate instanceof Date) || !(task.endDate instanceof Date)) continue;
    if (!task.isMilestone) finishes.push(task);
    if (!task.isLeaf || task.isMilestone || gates.has(task.id) || fieldOf(task, 'inactive') === true) continue;
    const planned = typeof task.duration === 'number' && Number.isFinite(task.duration) ? task.duration : 0;
    const done = (typeof task.percentDone === 'number' ? task.percentDone : 0) / 100;
    if (planned <= 0 || done >= 1) continue;
    if (hasSegments(task)) {
      splitKept += 1;
      continue;
    }
    varying.push({
      task,
      id: task.id,
      name: task.name ?? '',
      kind: workKind({ name: task.name ?? '', groups: groupsOf(task), trades: tradesOf(task), start: task.startDate }),
      planned,
      done,
      key: diceKey(task.id),
    });
  }
  if (varying.length === 0) throw new OddsError('Every task in the plan is done: there is nothing left to vary.');

  const holds: HoldLever[] = [];
  for (const gate of gates.values()) {
    if (!gate.holding) continue;
    const sources = [...((gate.task as unknown as { incomingDeps?: Set<{ fromEvent?: TaskModel | null }> }).incomingDeps ?? [])]
      .map((link) => link.fromEvent)
      .filter((task): task is TaskModel => Boolean(task));
    holds.push({
      id: gate.id,
      task: gate.task,
      name: gate.task.name ?? 'Payment',
      pays: gate.pays.map((row) => row.name).join(' and '),
      holds: gate.holds.map((row) => row.name).join(' and '),
      sources,
      state: gate.payGate.state,
      pinned: gate.task.constraintType === 'startnoearlierthan',
      dueDay: liveDueDay(sources, gate.task),
    });
  }
  holds.sort((a, b) => (a.dueDay ?? 0) - (b.dueDay ?? 0));

  const today = options.today ?? planClock.now();
  const kinds = WORK_KINDS.filter((kind) => varying.some((task) => task.kind === kind));
  return {
    project,
    handover,
    contractDay: contract.day,
    contractFrom: contract.from,
    plannedDay,
    varying,
    holds,
    calendar,
    saturdays: saturdayCalendar(project),
    hoursPerDay: (project as unknown as { hoursPerDay?: number }).hoursPerDay ?? 24,
    finishes,
    kinds,
    splitKept,
    todayDay: dayNumber(today),
    signature: planSignature(project),
  };
}

// ---------------------------------------------------------------------------------------------
// Scenarios: what the person chooses, and what the optimizer tries
// ---------------------------------------------------------------------------------------------

export interface OddsScenario {
  /** How a hold is paid, by its id; holds not named follow the assumptions' rule. */
  pay?: ReadonlyMap<Id, PayPolicy>;
  /** Rows (groups or tasks) whose work left runs on the plan's Monday-to-Saturday calendar. */
  saturdays?: readonly Id[];
}

/** The day a hold is paid under a rule: never before today; on the pay run, the first Friday it can be paid. */
export function payDayFor(policy: PayPolicy, dueDay: number, todayDay: number): number {
  const earliest = Math.max(dueDay, todayDay);
  if (policy === 'due') return earliest;
  return earliest + ((PAY_RUN_WEEKDAY - weekdayOf(earliest) + 7) % 7);
}

/** The rule a hold is paid by: PayPal already paying it counts as paid now. */
export function policyOf(hold: HoldLever, scenario: OddsScenario, assumptions: OddsAssumptions): PayPolicy {
  if (hold.state === 'paying') return 'due';
  return scenario.pay?.get(hold.id) ?? assumptions.payPolicy;
}

interface SaturdayLeaf {
  task: TaskModel;
  /** The calendar it keeps in the plan, to count which of its working days are Saturdays. */
  usual: CalendarModel | null;
  /** The people on it, whose Saturday hours cost the premium. */
  people: number;
}

/**
 * The people on a task: each crew's headcount as the plan has it, or the usual size of a crew of its trade where the
 * plan doesn't say (as the chart and the site view count them). Rented machines are not people.
 */
export function peopleOn(task: TaskModel): number {
  return laborOf(task).reduce((sum, crew) => sum + crewSizeOn(task, crew).people, 0);
}

/**
 * What one Saturday worked on a task costs on top of the same day on a weekday: the premium (1.5× pays half a day
 * more) on each person's hours, at the loaded rate. Materials cost the same any day, so they are left out.
 */
export function saturdayPremiumMinor(people: number, assumptions: Pick<OddsAssumptions, 'hourlyRate' | 'saturdayPremium'>): number {
  return people * SATURDAY_HOURS * assumptions.hourlyRate * 100 * Math.max(0, assumptions.saturdayPremium - 1);
}

interface SaturdayRow {
  id: Id;
  leaves: SaturdayLeaf[];
}

/** The tasks with work left under a row (the row itself if it is one), which Saturdays would apply to. */
export function workLeft(row: TaskModel): TaskModel[] {
  const leaves: TaskModel[] = [];
  walkTree(row, (node) => {
    if (!node.isLeaf || node.isMilestone || hasSegments(node)) return;
    if ((typeof node.percentDone === 'number' ? node.percentDone : 0) >= 100) return;
    if (readPayGate(fieldOf(node, 'payGate')) || isOutsidersTask(node)) return;
    leaves.push(node);
  });
  return leaves;
}

function saturdayRows(plan: OddsPlan, scenario: OddsScenario): SaturdayRow[] {
  if (!plan.saturdays || !scenario.saturdays?.length) return [];
  const store = plan.project.taskStore;
  const rows: SaturdayRow[] = [];
  for (const id of scenario.saturdays) {
    const row = store.getById(id) as TaskModel | undefined;
    if (!row) continue;
    rows.push({
      id,
      leaves: workLeft(row).map((task) => ({
        task,
        usual: (fieldOf(task, 'calendar') as CalendarModel | null | undefined) ?? plan.calendar,
        people: peopleOn(task),
      })),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

interface Branch {
  write(atom: unknown, value: unknown): void;
  read(atom: unknown): unknown;
  clearBranch(): void;
}

interface Replica {
  isCommitting?: boolean;
  branch?(config: object): Branch;
}

const atomsOf = (record: unknown) => (record as { $: Record<string, unknown> }).$;
const replicaOf = (project: ProjectModel) => (project as unknown as { replica?: Replica }).replica;

interface Prepared {
  plan: OddsPlan;
  assumptions: OddsAssumptions;
  scenario: OddsScenario;
  policies: PayPolicy[];
  rows: SaturdayRow[];
  /** Saturdays worked are counted against this many milliseconds of work a day. */
  dayMs: number;
}

interface Reading {
  day: number;
  /** Lengths drawn, in the order of `plan.varying`. */
  lengths: Float64Array | null;
  /** Finish of each of `plan.finishes`, ms. */
  ends: Float64Array | null;
  /** Saturdays worked and their premium, by Saturday row. */
  saturdays: Float64Array | null;
  premium: Float64Array | null;
}

const asDate = (value: unknown): Date | null => (value instanceof Date ? value : null);

function workingMs(calendar: CalendarModel | null, start: Date, end: Date): number {
  if (!calendar || end <= start) return 0;
  return (calendar as unknown as { calculateDurationMs(start: Date, end: Date): number }).calculateDurationMs(start, end);
}

/**
 * One run on a branch of the live engine: write the drawn lengths, the Saturdays and the pay days, read the
 * handover (and what else is asked for), clear the branch.
 */
function runOnce(prepared: Prepared, run: number, want: { lengths: boolean; ends: boolean }): Reading {
  const { plan, assumptions, rows } = prepared;
  const branch = replicaOf(plan.project)!.branch!({ autoCommit: false, onComputationCycle: 'throw' });
  try {
    branch.write(atomsOf(plan.project).autoPostponeConflicts, true);
    const lengths = want.lengths ? new Float64Array(plan.varying.length) : null;
    for (let i = 0; i < plan.varying.length; i += 1) {
      const task = plan.varying[i]!;
      const [u, v] = dice(assumptions.seed, run, task.key);
      const length = drawnLength(task, assumptions.ranges[task.kind], u, v);
      if (lengths) lengths[i] = length;
      if (length !== task.planned) branch.write(atomsOf(task.task).duration, length);
    }
    // Saturdays: the plan's own Monday-to-Saturday calendar, and the crews' calendars set aside, as a person would.
    for (const row of rows) {
      for (const leaf of row.leaves) {
        branch.write(atomsOf(leaf.task).calendar, plan.saturdays);
        branch.write(atomsOf(leaf.task).ignoreResourceCalendar, true);
      }
    }
    // Each hold, upstream first: it falls due when the work it pays for is done in this run, and the work it
    // holds starts the morning after the money lands.
    for (let h = 0; h < plan.holds.length; h += 1) {
      const hold = plan.holds[h]!;
      const ends = hold.sources.map((task) => asDate(branch.read(atomsOf(task).endDate))).filter((end): end is Date => end !== null);
      const due = ends.length > 0 ? dueDayOf(new Date(Math.max(...ends.map((end) => end.getTime())))) : hold.dueDay;
      if (due === null) continue;
      const payDay = payDayFor(prepared.policies[h]!, due, plan.todayDay);
      const gate = atomsOf(hold.task);
      if (payDay > due) {
        branch.write(gate.constraintType, 'startnoearlierthan');
        branch.write(gate.constraintDate, dateOfDay(payDay + 1));
      } else if (hold.pinned) {
        branch.write(gate.constraintType, null);
        branch.write(gate.constraintDate, null);
      }
    }
    const start = asDate(branch.read(atomsOf(plan.handover).startDate));
    if (!start) throw new OddsError('The engine gave the handover no date.');
    const day = dayNumber(onWorkingTime(plan.calendar, start));
    let ends: Float64Array | null = null;
    if (want.ends) {
      ends = new Float64Array(plan.finishes.length);
      for (let i = 0; i < plan.finishes.length; i += 1) ends[i] = asDate(branch.read(atomsOf(plan.finishes[i]!).endDate))?.getTime() ?? Number.NaN;
    }
    let saturdays: Float64Array | null = null;
    let premium: Float64Array | null = null;
    if (rows.length > 0) {
      saturdays = new Float64Array(rows.length);
      premium = new Float64Array(rows.length);
      for (let r = 0; r < rows.length; r += 1) {
        for (const leaf of rows[r]!.leaves) {
          const from = asDate(branch.read(atomsOf(leaf.task).startDate));
          const to = asDate(branch.read(atomsOf(leaf.task).endDate));
          if (!from || !to) continue;
          // The days it works on the Saturday calendar that it would not work on its own: its Saturdays.
          const extra = Math.max(0, Math.round((workingMs(plan.saturdays, from, to) - workingMs(leaf.usual, from, to)) / prepared.dayMs));
          saturdays[r]! += extra;
          premium[r]! += extra * saturdayPremiumMinor(leaf.people, assumptions);
        }
      }
    }
    return { day, lengths, ends, saturdays, premium };
  } finally {
    branch.clearBranch();
  }
}

// ---------------------------------------------------------------------------------------------
// Many runs, in slices
// ---------------------------------------------------------------------------------------------

export interface SimulateOptions {
  /** The runs to make, by number (their dice): 0 to `assumptions.runs - 1` unless given. */
  runIndices?: ArrayLike<number>;
  /** Read each task's finish in every run (for P80 finishes): a little slower. */
  finishes?: boolean;
  /** Keep each run's drawn lengths (for the threats). */
  lengths?: boolean;
  /** Milliseconds of runs before the browser gets a turn. */
  sliceMs?: number;
  /** How the browser gets its turn between slices (tests pass a plain promise). */
  yieldNow?: () => Promise<void>;
  signal?: AbortSignal;
  /** After each slice: how many runs are done, and the handover day of each run that just finished. */
  onProgress?: (done: number, total: number, landed: readonly { run: number; day: number }[]) => void;
}

export interface Simulation {
  scenario: OddsScenario;
  /** The run numbers made, in order, and the handover day of each. */
  runs: Int32Array;
  days: Int32Array;
  /** Runs the engine could not schedule (left out of every number). */
  failed: number;
  contractDay: number;
  onTime: number;
  /** onTime / runs made. */
  odds: number;
  p10: number;
  p50: number;
  p80: number;
  p90: number;
  /** Each task's P80 finish (ms), when asked for. */
  finishes: Map<Id, number> | null;
  /** The drawn lengths, run after run (runs made × plan.varying), when asked for. */
  lengths: Float64Array | null;
  /** Average Saturdays worked and premium (minor units) per run, by Saturday row. */
  saturdays: Map<Id, { days: number; premiumMinor: number }>;
  ms: number;
  /** The plan the runs answer for (its fingerprint when the question was asked). */
  signature: string;
  /** Some runs went on a copy of the plan as it was asked, because the live plan changed meanwhile. */
  onCopy: boolean;
}

let channel: MessageChannel | null = null;
const waiting: (() => void)[] = [];

/** A task of its own, as soon as possible (a zero timeout is held back to 4 ms once nested). */
function nextTask(): Promise<void> {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0));
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => waiting.shift()?.();
  }
  const port = channel.port2;
  return new Promise((resolve) => {
    waiting.push(resolve);
    port.postMessage(null);
  });
}

/**
 * Gives the browser a frame: the next slice of runs starts right after the next frame is painted, so the dots land
 * at the screen's own pace. (Yielding to the task queue alone is not enough: the browser goes on running slices and
 * paints only when it has gone a tenth of a second without.) A page out of sight paints nothing: there, a task.
 */
export function yieldToBrowser(): Promise<void> {
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  if (typeof requestAnimationFrame !== 'function' || !visible) return nextTask();
  return new Promise((resolve) => requestAnimationFrame(() => void nextTask().then(resolve)));
}

function prepare(plan: OddsPlan, assumptions: OddsAssumptions, scenario: OddsScenario): Prepared {
  return {
    plan,
    assumptions,
    scenario,
    policies: plan.holds.map((hold) => policyOf(hold, scenario, assumptions)),
    rows: saturdayRows(plan, scenario),
    dayMs: plan.hoursPerDay * 3_600_000,
  };
}

// ---------------------------------------------------------------------------------------------
// A question: the plan as it was when it was asked
// ---------------------------------------------------------------------------------------------

/** The copy's view of the plan, in the live view's order, so a run reads the same tasks in the same slots. */
function alignPlan(copy: OddsPlan, live: OddsPlan): OddsPlan {
  const pick = <T extends { id: Id }>(from: readonly T[], order: readonly { id: Id }[]): T[] => {
    const byId = new Map(from.map((item) => [item.id, item]));
    return order.map((item) => {
      const found = byId.get(item.id);
      if (!found) throw new OddsError('The copy of the plan does not match the plan.');
      return found;
    });
  };
  return {
    ...copy,
    varying: pick(copy.varying, live.varying),
    finishes: pick(copy.finishes, live.finishes),
    holds: pick(copy.holds, live.holds),
    contractDay: live.contractDay,
    contractFrom: live.contractFrom,
    signature: live.signature,
  };
}

/**
 * One question to the engine, about the plan as it was when the question was asked. The runs go on branches of the
 * live engine while the plan stays as it was. If it changes before the question is answered (someone's edit lands),
 * the rest of the runs go on branches of a copy of the plan as it was asked, so that every run answers for the same
 * plan. A branch kept from before an edit is no answer: the engine reads some of the plan through its live records.
 */
export class OddsQuestion {
  readonly live: OddsPlan;
  /** When it was asked, on the real clock (the panel's "since these runs at 3:42 PM"). */
  readonly askedAt = new Date();
  private copyPlan: OddsPlan | null = null;
  private copyProject: ProjectModel | null = null;
  private loading: Promise<OddsPlan> | null = null;
  private touched = false;
  private readonly detach: (() => void) | undefined;
  private closed = false;

  private constructor(
    readonly project: ProjectModel,
    live: OddsPlan,
    private readonly asOf: string,
    readonly today: Date,
  ) {
    this.live = live;
    this.detach = project.on('dataReady', () => {
      this.touched = true;
    }) as unknown as (() => void) | undefined;
  }

  /**
   * Commits what is pending (a branch sees committed data only) and reads the plan as it now stands. The copy kept
   * for later is taken a frame after, so that neither step holds the page up; if an edit lands in between, the
   * plan is read again.
   */
  static async ask(project: ProjectModel, options: { today?: Date; yieldNow?: () => Promise<void> } = {}): Promise<OddsQuestion> {
    const yieldNow = options.yieldNow ?? yieldToBrowser;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await project.commitAsync();
      if (project.isDestroyed) throw new OddsCanceledError();
      const today = options.today ?? planClock.now();
      const live = readOddsPlan(project, { today });
      await yieldNow();
      if (project.isDestroyed) throw new OddsCanceledError();
      if (replicaOf(project)?.isCommitting || planSignature(project) !== live.signature) continue;
      return new OddsQuestion(project, live, JSON.stringify(readProjectInlineData(project)), today);
    }
    throw new OddsError('The plan kept changing while it was being read. Try again in a moment.');
  }

  get signature(): string {
    return this.live.signature;
  }

  /** Some runs had to go on a copy of the plan. */
  get onCopy(): boolean {
    return this.copyPlan !== null;
  }

  /** Whether the live plan is no longer the plan this question is about. */
  changedSince(): boolean {
    return !this.project.isDestroyed && planSignature(this.project) !== this.live.signature;
  }

  /** The plan the next runs go on, or null while the live engine is in the middle of a commit (ask again after a turn). */
  async planNow(): Promise<OddsPlan | null> {
    if (this.closed || this.project.isDestroyed) throw new OddsCanceledError();
    if (this.copyPlan) return this.copyPlan;
    if (this.loading) return this.loading;
    if (replicaOf(this.project)?.isCommitting) {
      this.touched = true;
      return null;
    }
    if (this.touched) {
      this.touched = false;
      if (planSignature(this.project) !== this.live.signature) return this.useCopy();
    }
    return this.live;
  }

  /** The plan to read (for the parts of the plan an action could go on), waiting out a commit. */
  async plan(yieldNow: () => Promise<void> = yieldToBrowser): Promise<OddsPlan> {
    for (;;) {
      const plan = await this.planNow();
      if (plan) return plan;
      await yieldNow();
    }
  }

  private useCopy(): Promise<OddsPlan> {
    this.loading ??= (async () => {
      const copy = createProjectModel();
      await loadProjectInlineData(copy, JSON.parse(this.asOf) as ProjectInlineData);
      if (this.closed) {
        copy.destroy();
        throw new OddsCanceledError();
      }
      this.copyProject = copy;
      this.copyPlan = alignPlan(readOddsPlan(copy, { today: this.today }), this.live);
      return this.copyPlan;
    })();
    return this.loading;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach?.();
    this.copyProject?.destroy();
    this.copyProject = null;
  }
}

/**
 * Runs the plan many times on branches of the engine, in slices, giving the browser a turn between slices. Every
 * run answers for the plan as the question was asked (see OddsQuestion).
 */
export async function simulate(question: OddsQuestion, assumptions: OddsAssumptions, scenario: OddsScenario, options: SimulateOptions = {}): Promise<Simulation> {
  const started = performance.now();
  const { live } = question;
  const runIndices = options.runIndices ?? Int32Array.from({ length: assumptions.runs }, (_, index) => index);
  const total = runIndices.length;
  const sliceMs = options.sliceMs ?? 12;
  const yieldNow = options.yieldNow ?? yieldToBrowser;
  const want = { lengths: options.lengths === true, ends: options.finishes === true };

  const runs = new Int32Array(total);
  const days = new Int32Array(total);
  const lengths = want.lengths ? new Float64Array(total * live.varying.length) : null;
  const ends = want.ends ? live.finishes.map(() => new Float64Array(total)) : null;
  const saturdayTotals = new Map<Id, { days: number; premiumMinor: number }>();
  let plan: OddsPlan | null = null;
  let prepared: Prepared | null = null;
  let made = 0;
  let failed = 0;
  let next = 0;
  // Whatever asked for the runs gets its frame first: the first slice starts on a fresh one.
  await yieldNow();
  while (next < total) {
    if (options.signal?.aborted) throw new OddsCanceledError();
    const current = await question.planNow();
    if (!current) {
      await yieldNow();
      continue;
    }
    if (current !== plan || !prepared) {
      plan = current;
      prepared = prepare(plan, assumptions, scenario);
    }
    const sliceStart = performance.now();
    const landed: { run: number; day: number }[] = [];
    let runStart = sliceStart;
    do {
      const run = runIndices[next]!;
      next += 1;
      let reading: Reading;
      runStart = performance.now();
      try {
        reading = runOnce(prepared, run, want);
      } catch (error) {
        if (error instanceof OddsError) throw error;
        // A run the engine refuses (a cycle, say) is left out and counted, never passed off as an answer.
        failed += 1;
        continue;
      }
      runs[made] = run;
      days[made] = reading.day;
      if (lengths && reading.lengths) lengths.set(reading.lengths, made * live.varying.length);
      if (ends && reading.ends) for (let i = 0; i < ends.length; i += 1) ends[i]![made] = reading.ends[i]!;
      if (reading.saturdays && reading.premium) {
        prepared.rows.forEach((row, index) => {
          const sum = saturdayTotals.get(row.id) ?? { days: 0, premiumMinor: 0 };
          sum.days += reading.saturdays![index]!;
          sum.premiumMinor += reading.premium![index]!;
          saturdayTotals.set(row.id, sum);
        });
      }
      made += 1;
      landed.push({ run, day: reading.day });
      // Another run only if it should end inside the slice: a run takes about as long as the one before.
    } while (next < total && 2 * performance.now() - runStart - sliceStart <= sliceMs);
    options.onProgress?.(made + failed, total, landed);
    if (next < total) await yieldNow();
  }
  if (made === 0) throw new OddsError('The engine could not schedule any of the runs.');

  const madeRuns = runs.slice(0, made);
  const madeDays = days.slice(0, made);
  const sorted = sortedCopy(madeDays);
  let onTime = 0;
  for (const day of madeDays) if (day <= live.contractDay) onTime += 1;
  let finishes: Map<Id, number> | null = null;
  if (ends) {
    finishes = new Map();
    for (let i = 0; i < live.finishes.length; i += 1) {
      const values = sortedCopy(ends[i]!.subarray(0, made)).filter((value) => Number.isFinite(value));
      if (values.length > 0) finishes.set(live.finishes[i]!.id, percentile(values, 0.8));
    }
  }
  const saturdays = new Map<Id, { days: number; premiumMinor: number }>();
  for (const [id, sum] of saturdayTotals) saturdays.set(id, { days: sum.days / made, premiumMinor: sum.premiumMinor / made });
  return {
    scenario,
    runs: madeRuns,
    days: madeDays,
    failed,
    contractDay: live.contractDay,
    onTime,
    odds: onTime / made,
    p10: percentile(sorted, 0.1),
    p50: percentile(sorted, 0.5),
    p80: percentile(sorted, 0.8),
    p90: percentile(sorted, 0.9),
    finishes,
    lengths: lengths ? lengths.slice(0, made * live.varying.length) : null,
    saturdays,
    ms: performance.now() - started,
    signature: live.signature,
    onCopy: question.onCopy,
  };
}

/**
 * One run with every length as planned (no dice), under a scenario: the plan's own answer, for a quick look at what
 * an action does before its runs are made.
 */
export function plannedRun(plan: OddsPlan, assumptions: OddsAssumptions, scenario: OddsScenario): { day: number; saturdays: Map<Id, { days: number; premiumMinor: number }> } {
  const flat: OddsAssumptions = {
    ...assumptions,
    ranges: { winter: ONE, outdoor: ONE, indoor: ONE, inspection: ONE },
  };
  const prepared = prepare(plan, flat, scenario);
  const reading = runOnce(prepared, 0, { lengths: false, ends: false });
  const saturdays = new Map<Id, { days: number; premiumMinor: number }>();
  prepared.rows.forEach((row, index) => saturdays.set(row.id, { days: reading.saturdays?.[index] ?? 0, premiumMinor: reading.premium?.[index] ?? 0 }));
  return { day: reading.day, saturdays };
}

const ONE: ThreePoint = { low: 1, likely: 1, high: 1 };

// ---------------------------------------------------------------------------------------------
// What moves the handover
// ---------------------------------------------------------------------------------------------

export interface TaskThreat {
  kind: 'task';
  id: Id;
  name: string;
  /** Rank correlation between the task's drawn length and the handover day across the runs (0 to 1). */
  correlation: number;
}

export interface HoldThreat {
  kind: 'hold';
  id: Id;
  name: string;
  /** Points of odds the hold costs paid on the pay run, against paid when due. */
  points: number;
  oddsWhenDue: number;
  oddsOnPayRun: number;
}

/** The tasks whose lengths the handover follows most closely, strongest first. */
export function taskThreats(plan: OddsPlan, simulation: Simulation, limit = 5): TaskThreat[] {
  const { lengths } = simulation;
  const made = simulation.days.length;
  const count = plan.varying.length;
  if (!lengths || made < 10) return [];
  const threats: TaskThreat[] = [];
  const column = new Float64Array(made);
  for (let i = 0; i < count; i += 1) {
    for (let run = 0; run < made; run += 1) column[run] = lengths[run * count + i]!;
    const correlation = rankCorrelation(column, simulation.days);
    const task = plan.varying[i]!;
    if (correlation > 0.05) threats.push({ kind: 'task', id: task.id, name: task.name, correlation });
  }
  return threats.sort((a, b) => b.correlation - a.correlation).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const SHORT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "Thu, May 27" */
export const dayWords = (day: number): string => SHORT_DAY.format(dateOfDay(day));
/** "May 27" */
export const monthDay = (day: number): string => MONTH_DAY.format(dateOfDay(day));

/** Which tasks' crews (firms) a row's work belongs to, for words. */
export function firmsOf(rows: readonly TaskModel[]): string[] {
  const firms = new Set<string>();
  for (const row of rows) for (const task of workLeft(row)) {
    const firm = firmOf(task);
    if (firm) firms.add(firm);
  }
  return [...firms];
}

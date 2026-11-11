/**
 * Read-only analysis of the plan behind the assistant's tools: float and the critical path, one task
 * in full, finding tasks, crew workload by week, a schedule health check, work worth saving to the
 * library, and other places a library piece just dropped into the plan could also go.
 *
 * There is no scheduling engine in Node, so everything is worked out from the PlanSnapshot alone. The
 * early dates are the dates the engine last gave the tasks; a backward pass over the links from the
 * plan's finish gives the late dates; working days are counted on the seed calendars (a task's own
 * calendar for its work, the successor's calendar for a lag). Dates are 'YYYY-MM-DD', task ends are
 * exclusive, and every result is plain JSON with short lists and rounded numbers, because it is handed
 * to a language model.
 */
import { addDays, addWorkingDays, countWorkingDays, isWorkingDay, subtractWorkingDays, type SeedCalendarId } from '@collab/shared/seed';
import { lastDay } from './format';
import { neededOn, type PlanDependency, type PlanSnapshot, type PlanTask } from './snapshot';

// ---------------------------------------------------------------------------------------------
// The plan as a tree, in plan order
// ---------------------------------------------------------------------------------------------

export type TaskKind = 'phase' | 'group' | 'task' | 'milestone';

interface Crew {
  resourceId: number;
  name: string;
  kind: 'labor' | 'equipment';
  company: string;
  trade: string;
  units: number;
  /** A machine's own dates on this task (the end exclusive); without them it goes by the task's days. */
  rentalStart?: string | null;
  rentalEnd?: string | null;
}

interface PlanIndex {
  byId: Map<number, PlanTask>;
  /** Children in plan order; `null` holds the top-level rows. */
  children: Map<number | null, PlanTask[]>;
  /** Every task in plan (WBS) order. */
  ordered: PlanTask[];
  rank: Map<number, number>;
  /** Leaves under each task in plan order (a leaf: itself). Inactive tasks included. */
  leaves: Map<number, PlanTask[]>;
  crews: Map<number, Crew[]>;
  /** Active links between tasks that are in the plan and active. */
  links: PlanDependency[];
}

const CALENDAR_LABEL: Record<SeedCalendarId, string> = { standard: 'Mon-Fri', site: 'Mon-Sat', inspector: 'City inspector' };

const LINK_WORDS: Record<number, string> = { 0: 'start-to-start', 1: 'start-to-finish', 2: 'finish-to-start', 3: 'finish-to-finish' };

const FS = 2;

function indexPlan(plan: PlanSnapshot): PlanIndex {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const position = new Map(plan.tasks.map((task, index) => [task.id, index]));
  const children = new Map<number | null, PlanTask[]>();
  for (const task of plan.tasks) {
    const key = task.parentId !== null && byId.has(task.parentId) && task.parentId !== task.id ? task.parentId : null;
    const list = children.get(key) ?? [];
    list.push(task);
    children.set(key, list);
  }
  const at = (task: PlanTask) => position.get(task.id) ?? 0;
  for (const list of children.values()) {
    list.sort((a, b) => {
      const left = a.order ?? Number.MAX_SAFE_INTEGER;
      const right = b.order ?? Number.MAX_SAFE_INTEGER;
      return left !== right ? left - right : at(a) - at(b);
    });
  }
  const ordered: PlanTask[] = [];
  const leaves = new Map<number, PlanTask[]>();
  const seen = new Set<number>();
  const visit = (task: PlanTask): PlanTask[] => {
    if (seen.has(task.id)) return [];
    seen.add(task.id);
    ordered.push(task);
    const kids = children.get(task.id) ?? [];
    const under = kids.length === 0 ? [task] : kids.flatMap(visit);
    leaves.set(task.id, under);
    return under;
  };
  for (const root of children.get(null) ?? []) visit(root);
  const crews = new Map<number, Crew[]>();
  const resources = new Map(plan.resources.map((resource) => [resource.id, resource]));
  for (const assignment of plan.assignments) {
    const resource = resources.get(assignment.resourceId);
    if (!resource || !byId.has(assignment.taskId)) continue;
    const list = crews.get(assignment.taskId) ?? [];
    list.push({ resourceId: resource.id, name: resource.name, kind: resource.kind, company: resource.company, trade: resource.trade ?? '', units: assignment.units, rentalStart: assignment.rentalStart, rentalEnd: assignment.rentalEnd });
    crews.set(assignment.taskId, list);
  }
  const links = plan.dependencies.filter((link) => {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    return link.active !== false && from && to && !from.inactive && !to.inactive && from.id !== to.id;
  });
  return { byId, children, ordered, rank: new Map(ordered.map((task, index) => [task.id, index])), leaves, crews, links };
}

const isGroup = (index: PlanIndex, task: PlanTask) => (index.children.get(task.id)?.length ?? 0) > 0;

function kindOf(index: PlanIndex, task: PlanTask): TaskKind {
  if (isGroup(index, task)) return task.parentId === null || !index.byId.has(task.parentId) ? 'phase' : 'group';
  return task.start === task.end ? 'milestone' : 'task';
}

function parentOf(index: PlanIndex, task: PlanTask): PlanTask | null {
  return task.parentId === null ? null : (index.byId.get(task.parentId) ?? null);
}

/** Ancestors, top first. */
function ancestorsOf(index: PlanIndex, task: PlanTask): PlanTask[] {
  const path: PlanTask[] = [];
  const seen = new Set<number>([task.id]);
  for (let parent = parentOf(index, task); parent && !seen.has(parent.id); parent = parentOf(index, parent)) {
    seen.add(parent.id);
    path.unshift(parent);
  }
  return path;
}

function isInside(index: PlanIndex, task: PlanTask, group: PlanTask): boolean {
  return ancestorsOf(index, task).some((ancestor) => ancestor.id === group.id);
}

const activeLeaves = (index: PlanIndex, task: PlanTask) => (index.leaves.get(task.id) ?? []).filter((leaf) => !leaf.inactive);

/** The days a task works: its working days, skipping the pauses of a split task. */
function workDates(task: PlanTask): string[] {
  const dates: string[] = [];
  for (const span of task.segments ?? [{ start: task.start, end: task.end }]) {
    for (let date = span.start; date < span.end; date = addDays(date, 1)) if (isWorkingDay(date, task.calendar)) dates.push(date);
  }
  return dates;
}

/** Working days of work (a split task: its pieces only). */
const workDays = (task: PlanTask) => (task.start === task.end ? 0 : workDates(task).length);

/** Working days the bar spans, pauses included: the length the backward pass moves a task by. */
const spanDays = (task: PlanTask) => (task.start === task.end ? 0 : countWorkingDays(task.start, task.end, task.calendar));

/** The last day a task works on (a milestone: its day). */
const lastWorkDay = (task: PlanTask) => (task.start === task.end ? task.start : lastDay(task.end));

/** Signed working days from `from` to `to` on a calendar. */
function workingDaysBetween(from: string, to: string, calendar: SeedCalendarId): number {
  return to >= from ? countWorkingDays(from, to, calendar) : -countWorkingDays(to, from, calendar);
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

const quote = (text: string) => `“${text}”`;

function namesOf(tasks: PlanTask[], max = 3): string {
  const names = tasks.slice(0, max).map((task) => quote(task.name));
  const more = tasks.length - names.length;
  return names.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

// ---------------------------------------------------------------------------------------------
// Float and the critical path
// ---------------------------------------------------------------------------------------------

export interface TaskFloat {
  /** Total float in working days of the task's calendar; negative when the task already finishes too late. */
  float_days: number;
  critical: boolean;
}

/** One link seen from a leaf predecessor: the latest finish the link allows it. */
interface LeafEdge {
  link: PlanDependency;
  pred: PlanTask;
  succ: PlanTask;
}

interface BackwardPass {
  finish: { task: PlanTask | null; date: string };
  lateFinish: Map<number, string>;
  float: Map<number, number>;
  edges: LeafEdge[];
  bound: (edge: LeafEdge) => string;
  /** The successor leaves whose late date the link reads: the leaf itself, or the leaves that set a group's late start or finish. */
  drivenLeaves: (edge: LeafEdge) => PlanTask[];
}

/** The predecessor side of a link reads the predecessor's start (start-to-start, start-to-finish). */
const predUsesStart = (type: number) => type === 0 || type === 1;
/** The successor side reads the successor's start (finish-to-start, start-to-start). */
const succUsesStart = (type: number) => type === 0 || type === FS;

/** Moves a late date back over a lag (a lead moves it forward), in working days of `calendar`. */
function backOverLag(date: string, lag: number, calendar: SeedCalendarId): string {
  const days = Math.round(lag);
  return days > 0 ? subtractWorkingDays(date, days, calendar) : days < 0 ? addWorkingDays(date, -days, calendar) : date;
}

function lateStartOf(task: PlanTask, lateFinish: string): string {
  const span = spanDays(task);
  return span === 0 ? lateFinish : subtractWorkingDays(lateFinish, span, task.calendar);
}

function lateFinishFromStart(task: PlanTask, lateStart: string): string {
  const span = spanDays(task);
  return span === 0 ? lateStart : addWorkingDays(lateStart, span, task.calendar);
}

/** The plan's finish: the handover milestone, else the latest leaf end. */
function planFinish(plan: PlanSnapshot, index: PlanIndex): { task: PlanTask | null; date: string } {
  const handover = index.byId.get(plan.handoverTaskId);
  if (handover && !handover.inactive) return { task: handover, date: handover.end };
  const ends = plan.tasks.filter((task) => !isGroup(index, task) && !task.inactive).map((task) => task.end).sort();
  return { task: null, date: ends.at(-1) ?? plan.statusDate };
}

/**
 * Late finishes by relaxing every link until nothing moves (the links form no loop in a plan the
 * engine accepted; a loop stops after as many rounds as there are tasks). A link to or from a group
 * stands for its leaves: a group finishes with its last leaf and starts with its first, so a link
 * from a group's finish holds back every leaf in it, one from its start the leaves that start it, and
 * a link into a group reads the earliest late start (or the latest late finish) of its leaves.
 */
function backwardPass(plan: PlanSnapshot, index: PlanIndex): BackwardPass {
  const finish = planFinish(plan, index);
  const leaves = plan.tasks.filter((task) => !isGroup(index, task) && !task.inactive);
  const lateFinish = new Map(leaves.map((leaf) => [leaf.id, finish.date]));
  const edges: LeafEdge[] = [];
  for (const link of index.links) {
    const from = index.byId.get(link.from)!;
    const to = index.byId.get(link.to)!;
    if (isInside(index, from, to) || isInside(index, to, from)) continue;
    let preds = activeLeaves(index, from);
    if (isGroup(index, from) && predUsesStart(link.type)) {
      const first = preds.map((leaf) => leaf.start).sort()[0];
      preds = preds.filter((leaf) => leaf.start === first);
    }
    if (activeLeaves(index, to).length === 0) continue;
    for (const pred of preds) edges.push({ link, pred, succ: to });
  }
  const leafDate = (edge: LeafEdge, leaf: PlanTask): string => {
    const late = lateFinish.get(leaf.id) ?? finish.date;
    return succUsesStart(edge.link.type) ? lateStartOf(leaf, late) : late;
  };
  const succDate = (edge: LeafEdge): string => {
    const dates = activeLeaves(index, edge.succ).map((leaf) => leafDate(edge, leaf)).sort();
    return (succUsesStart(edge.link.type) ? dates[0] : dates.at(-1)) ?? finish.date;
  };
  const drivenLeaves = (edge: LeafEdge): PlanTask[] => {
    const date = succDate(edge);
    return activeLeaves(index, edge.succ).filter((leaf) => leafDate(edge, leaf) === date);
  };
  const bound = (edge: LeafEdge): string => {
    const date = backOverLag(succDate(edge), edge.link.lag, edge.succ.calendar);
    return predUsesStart(edge.link.type) ? lateFinishFromStart(edge.pred, date) : date;
  };
  // Successors that start later go first, so most plans settle in one round.
  edges.sort((a, b) => (a.succ.start < b.succ.start ? 1 : a.succ.start > b.succ.start ? -1 : 0));
  for (let sweep = 0, moved = true; moved && sweep <= leaves.length + 1; sweep++) {
    moved = false;
    for (const edge of edges) {
      const allowed = bound(edge);
      if (allowed < (lateFinish.get(edge.pred.id) ?? finish.date)) {
        lateFinish.set(edge.pred.id, allowed);
        moved = true;
      }
    }
  }
  const float = new Map(leaves.map((leaf) => [leaf.id, workingDaysBetween(leaf.end, lateFinish.get(leaf.id) ?? finish.date, leaf.calendar)]));
  return { finish, lateFinish, float, edges, bound, drivenLeaves };
}

/** Total float of every active leaf task, in working days, keyed by task id. Critical: no float left. */
export function scheduleFloat(plan: PlanSnapshot): Record<number, TaskFloat> {
  const { float } = backwardPass(plan, indexPlan(plan));
  const result: Record<number, TaskFloat> = {};
  for (const [id, days] of float) result[id] = { float_days: days, critical: days <= 0 };
  return result;
}

export interface PathTask {
  id: number;
  name: string;
  phase: string;
  start: string;
  last_day: string;
  days: number;
  float_days: number;
}

export interface CriticalPath {
  /** What the plan finishes with: the handover milestone (or the last task) and the day it lands. */
  finish: { task_id: number | null; name: string; date: string };
  /** Critical tasks not yet finished. */
  critical_count: number;
  /** Chains of critical tasks (ids, first to last), each ending at the finish; at most four. */
  chains: number[][];
  /** Every critical task not yet finished, in time order (at most 40). */
  tasks: PathTask[];
  /** Unfinished tasks with 1 to 3 working days of float (at most 15), least float first. */
  near_critical: PathTask[];
}

function pathTask(task: PlanTask, float: number): PathTask {
  return { id: task.id, name: task.name, phase: task.phase, start: task.start, last_day: lastWorkDay(task), days: workDays(task), float_days: float };
}

const byStart = (a: PlanTask, b: PlanTask) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : a.id - b.id);

/**
 * The critical path as chains of work ending at the handover, walking back from it over the links
 * that hold each task in place, and the near-critical work. Finished tasks are left out: they can no
 * longer move the handover.
 */
export function criticalPath(plan: PlanSnapshot): CriticalPath {
  const index = indexPlan(plan);
  const pass = backwardPass(plan, index);
  const open = (task: PlanTask) => task.percentDone < 100;
  const isCritical = (task: PlanTask) => (pass.float.get(task.id) ?? 1) <= 0;
  // Driving links between critical leaves: the link is what sets the predecessor's late finish.
  const drivers = new Map<number, PlanTask[]>();
  for (const edge of pass.edges) {
    if (!isCritical(edge.pred) || !open(edge.pred) || pass.bound(edge) !== pass.lateFinish.get(edge.pred.id)) continue;
    for (const succ of pass.drivenLeaves(edge).filter(isCritical)) {
      const list = drivers.get(succ.id) ?? [];
      if (!list.includes(edge.pred)) list.push(edge.pred);
      drivers.set(succ.id, list);
    }
  }
  for (const list of drivers.values()) list.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : a.id - b.id));
  const ends = pass.finish.task
    ? [pass.finish.task].filter(isCritical)
    : plan.tasks.filter((task) => !isGroup(index, task) && !task.inactive && task.end === pass.finish.date && isCritical(task));
  const chains: number[][] = [];
  let steps = 0;
  const walk = (task: PlanTask, path: number[]) => {
    if (chains.length >= 4 || steps++ > 5000) return;
    const next = (drivers.get(task.id) ?? []).filter((pred) => !path.includes(pred.id));
    if (next.length === 0) {
      chains.push([...path].reverse());
      return;
    }
    for (const pred of next) walk(pred, [...path, pred.id]);
  };
  for (const end of ends) walk(end, [end.id]);
  const leaves = plan.tasks.filter((task) => !isGroup(index, task) && !task.inactive && open(task));
  const critical = leaves.filter(isCritical).sort(byStart);
  const near = leaves
    .filter((task) => {
      const float = pass.float.get(task.id) ?? 0;
      return float >= 1 && float <= 3;
    })
    .sort((a, b) => (pass.float.get(a.id) ?? 0) - (pass.float.get(b.id) ?? 0) || byStart(a, b));
  const finishTask = pass.finish.task;
  return {
    finish: {
      task_id: finishTask?.id ?? null,
      name: finishTask?.name ?? 'Last task',
      date: finishTask ? lastWorkDay(finishTask) : lastDay(pass.finish.date),
    },
    critical_count: critical.length,
    chains,
    tasks: critical.slice(0, 40).map((task) => pathTask(task, pass.float.get(task.id) ?? 0)),
    near_critical: near.slice(0, 15).map((task) => pathTask(task, pass.float.get(task.id) ?? 0)),
  };
}

// ---------------------------------------------------------------------------------------------
// One task in full
// ---------------------------------------------------------------------------------------------

export interface LinkedTask {
  link_id: number | null;
  task_id: number;
  name: string;
  type: string;
  /** Working days; negative is a lead. */
  lag_days: number;
  start: string;
  last_day: string;
  /** For a group: the task inside it the link is attached to. */
  via?: { task_id: number; name: string };
  /** Present (false) on a link switched off. */
  active?: false;
}

export interface TaskDetail {
  id: number;
  name: string;
  /** Its outline number (WBS), as the plan shows it. */
  wbs: string | null;
  kind: TaskKind;
  /** Names of the groups above it, the phase first. */
  path: string[];
  phase: string;
  /** Direct children in plan order (groups only; at most 30). */
  children: { id: number; name: string; kind: TaskKind }[];
  children_count: number;
  start: string;
  last_day: string;
  /** Working days of work (a split task: its pieces). */
  days: number;
  calendar: string;
  /** The working pieces of a split task. */
  segments: { start: string; last_day: string; days: number }[] | null;
  percent_done: number;
  baseline: { start: string; last_day: string; start_slip_days: number; finish_slip_days: number } | null;
  /** `on_site`: a machine's own dates on this task; without them it goes by the task's days. */
  crews: { name: string; units: number; kind: 'labor' | 'equipment'; company: string; trade: string; on_site?: { from: string; last_day: string } }[];
  predecessors: LinkedTask[];
  successors: LinkedTask[];
  /** A group: the least float of its tasks. Null for an inactive task. */
  float_days: number | null;
  critical: boolean;
  note: string | null;
  constraint: { type: string; date: string | null } | null;
  /** The date it must be done by (a contract date: it moves nothing). */
  deadline: string | null;
  manually_scheduled: boolean;
  inactive: boolean;
  /** Minor units (a group: the sum of its tasks). Callers decide who may see them. */
  money: { budget_minor: number; forecast_minor: number; incurred_minor: number; paid_minor: number };
}

/** Everything about one task, or null when the plan has no such task. */
export function taskDetail(plan: PlanSnapshot, taskId: number): TaskDetail | null {
  const index = indexPlan(plan);
  const task = index.byId.get(taskId);
  if (!task) return null;
  const group = isGroup(index, task);
  const pass = backwardPass(plan, index);
  const leaves = index.leaves.get(task.id) ?? [task];
  const inGroup = new Set([task.id, ...index.ordered.filter((other) => isInside(index, other, task)).map((other) => other.id)]);
  const linked = (link: PlanDependency, otherId: number, ownId: number): LinkedTask | null => {
    const other = index.byId.get(otherId);
    if (!other) return null;
    const own = index.byId.get(ownId);
    const row: LinkedTask = {
      link_id: link.id ?? null,
      task_id: other.id,
      name: other.name,
      type: LINK_WORDS[link.type] ?? 'finish-to-start',
      lag_days: round(link.lag, 2),
      start: other.start,
      last_day: lastWorkDay(other),
    };
    if (own && own.id !== task.id) row.via = { task_id: own.id, name: own.name };
    if (link.active === false) row.active = false;
    return row;
  };
  const predecessors = plan.dependencies
    .filter((link) => inGroup.has(link.to) && !inGroup.has(link.from))
    .map((link) => linked(link, link.from, link.to))
    .filter((row): row is LinkedTask => row !== null);
  const successors = plan.dependencies
    .filter((link) => inGroup.has(link.from) && !inGroup.has(link.to))
    .map((link) => linked(link, link.to, link.from))
    .filter((row): row is LinkedTask => row !== null);
  const floats = leaves.map((leaf) => pass.float.get(leaf.id)).filter((value): value is number => value !== undefined);
  const float = floats.length > 0 ? Math.min(...floats) : null;
  const crewRows = new Map<string, TaskDetail['crews'][number]>();
  for (const leaf of leaves) {
    for (const crew of index.crews.get(leaf.id) ?? []) {
      const seen = crewRows.get(crew.name);
      if (!seen || seen.units < crew.units) crewRows.set(crew.name, { name: crew.name, units: crew.units, kind: crew.kind, company: crew.company, trade: crew.trade, ...(crew.rentalStart && crew.rentalEnd ? { on_site: { from: crew.rentalStart, last_day: lastDay(crew.rentalEnd) } } : {}) });
    }
  }
  const sum = (pick: (leaf: PlanTask) => number) => (group ? leaves.reduce((total, leaf) => total + pick(leaf), 0) : pick(task));
  const kids = index.children.get(task.id) ?? [];
  return {
    id: task.id,
    name: task.name,
    wbs: task.wbs ?? null,
    kind: kindOf(index, task),
    path: ancestorsOf(index, task).map((ancestor) => ancestor.name),
    phase: task.phase,
    children: kids.slice(0, 30).map((child) => ({ id: child.id, name: child.name, kind: kindOf(index, child) })),
    children_count: kids.length,
    start: task.start,
    last_day: lastWorkDay(task),
    days: group ? countWorkingDays(task.start, task.end, task.calendar) : workDays(task),
    calendar: CALENDAR_LABEL[task.calendar] ?? task.calendar,
    segments: task.segments?.map((segment) => ({ start: segment.start, last_day: lastDay(segment.end), days: countWorkingDays(segment.start, segment.end, task.calendar) })) ?? null,
    percent_done: Math.round(task.percentDone),
    baseline:
      task.baselineStart && task.baselineEnd
        ? {
            start: task.baselineStart,
            last_day: task.baselineStart === task.baselineEnd ? task.baselineStart : lastDay(task.baselineEnd),
            start_slip_days: workingDaysBetween(task.baselineStart, task.start, task.calendar),
            finish_slip_days: workingDaysBetween(task.baselineEnd, task.end, task.calendar),
          }
        : null,
    crews: [...crewRows.values()],
    predecessors: predecessors.slice(0, 20),
    successors: successors.slice(0, 20),
    float_days: float,
    critical: float !== null && float <= 0,
    note: task.note ?? null,
    constraint: task.constraintType ? { type: task.constraintType, date: task.constraintDate ?? null } : null,
    deadline: task.deadline ?? null,
    manually_scheduled: task.manuallyScheduled ?? false,
    inactive: task.inactive ?? false,
    money: {
      budget_minor: sum((leaf) => leaf.budgetMinor),
      forecast_minor: sum((leaf) => leaf.forecastMinor),
      incurred_minor: sum((leaf) => leaf.incurredMinor),
      paid_minor: sum((leaf) => leaf.paidMinor),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Every task as a row (the query tool reads these)
// ---------------------------------------------------------------------------------------------

/** One task as the query tool sees it: what it is, where, when, how it stands on the critical path, and its money. */
export interface TaskFact {
  id: number;
  name: string;
  wbs: string | null;
  kind: TaskKind;
  parent: string | null;
  /** The groups above it and itself, "Structure › Concrete deck, level 1 › Pour deck, level 1". */
  path: string;
  phase: string;
  start: string;
  last_day: string;
  working_days: number;
  calendar: string;
  percent_done: number;
  status: 'not_started' | 'in_progress' | 'done';
  /** Null for an inactive task. A group: its tasks' least float. */
  critical: boolean | null;
  total_slack_days: number | null;
  baseline_start: string | null;
  baseline_last_day: string | null;
  /** Working days its finish moved from the baseline (late is positive). */
  finish_slip_days: number | null;
  constraint_type: string | null;
  constraint_date: string | null;
  deadline: string | null;
  manually_scheduled: boolean;
  inactive: boolean;
  /** The crews and machines on it, by name. */
  crews: string;
  crew_count: number;
  /** Links into it and out of it. */
  waits_for: number;
  leads_to: number;
  budget_minor: number;
  forecast_minor: number;
  spent_minor: number;
  paid_minor: number;
  /** A payment hold: the work after it waits until a progress payment is made. */
  pay_hold: boolean;
  note: string | null;
}

/** Every task in plan (WBS) order. */
export function taskFacts(plan: PlanSnapshot): TaskFact[] {
  const index = indexPlan(plan);
  const pass = backwardPass(plan, index);
  return index.ordered.map((task) => {
    const group = isGroup(index, task);
    const leaves = index.leaves.get(task.id) ?? [task];
    const floats = leaves.map((leaf) => pass.float.get(leaf.id)).filter((value): value is number => value !== undefined);
    const float = task.inactive || floats.length === 0 ? null : Math.min(...floats);
    const sum = (pick: (leaf: PlanTask) => number) => (group ? leaves.reduce((total, leaf) => total + pick(leaf), 0) : pick(task));
    const crews = [...new Set(leaves.flatMap((leaf) => (index.crews.get(leaf.id) ?? []).map((crew) => crew.name)))];
    const ancestors = ancestorsOf(index, task);
    const percent = Math.round(task.percentDone);
    return {
      id: task.id,
      name: task.name,
      wbs: task.wbs ?? null,
      kind: kindOf(index, task),
      parent: ancestors.at(-1)?.name ?? null,
      path: [...ancestors, task].map((each) => each.name).join(' › '),
      phase: task.phase,
      start: task.start,
      last_day: lastWorkDay(task),
      working_days: group ? countWorkingDays(task.start, task.end, task.calendar) : workDays(task),
      calendar: CALENDAR_LABEL[task.calendar] ?? task.calendar,
      percent_done: percent,
      status: percent >= 100 ? 'done' : percent > 0 ? 'in_progress' : 'not_started',
      critical: float === null ? null : float <= 0,
      total_slack_days: float,
      baseline_start: task.baselineStart,
      baseline_last_day: task.baselineStart && task.baselineEnd ? (task.baselineStart === task.baselineEnd ? task.baselineStart : lastDay(task.baselineEnd)) : null,
      finish_slip_days: task.baselineEnd ? workingDaysBetween(task.baselineEnd, task.end, task.calendar) : null,
      constraint_type: task.constraintType ?? null,
      constraint_date: task.constraintDate ?? null,
      deadline: task.deadline ?? null,
      manually_scheduled: task.manuallyScheduled ?? false,
      inactive: task.inactive ?? false,
      crews: crews.join(', '),
      crew_count: crews.length,
      waits_for: plan.dependencies.filter((link) => link.to === task.id).length,
      leads_to: plan.dependencies.filter((link) => link.from === task.id).length,
      budget_minor: sum((leaf) => leaf.budgetMinor),
      forecast_minor: sum((leaf) => leaf.forecastMinor),
      spent_minor: sum((leaf) => leaf.incurredMinor),
      paid_minor: sum((leaf) => leaf.paidMinor),
      pay_hold: Boolean(task.payGate),
      note: task.note ? task.note.slice(0, 200) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Finding tasks
// ---------------------------------------------------------------------------------------------

export type TaskStatus = 'not_started' | 'in_progress' | 'done' | 'late' | 'critical' | 'milestone';

export interface TaskFilter {
  /** Words that must all appear in the name, note or phase (any case). */
  text?: string;
  /** A crew's name (or part of it, or its company), or its id. */
  crew?: string | number;
  /** A phase or group name (or part of it), or its id: tasks under it. */
  phase?: string | number;
  /** Tasks working on or after this day... */
  from?: string;
  /** ...and on or before this day. */
  to?: string;
  status?: TaskStatus;
  leaves_only?: boolean;
  /** Rows returned (default 25, at most 100); `total` counts every match. */
  limit?: number;
}

export interface TaskRow {
  id: number;
  name: string;
  kind: TaskKind;
  phase: string;
  parent: string | null;
  start: string;
  last_day: string;
  days: number;
  percent_done: number;
  crews: string[];
  critical: boolean;
}

function matchingCrews(plan: PlanSnapshot, crew: string | number): Set<number> {
  const wanted = String(crew).trim().toLowerCase();
  return new Set(
    plan.resources
      .filter(
        (resource) =>
          String(resource.id) === wanted ||
          resource.name.toLowerCase().includes(wanted) ||
          (wanted.length > 2 && (resource.company.toLowerCase().includes(wanted) || (resource.trade ?? '').toLowerCase().includes(wanted))),
      )
      .map((resource) => resource.id),
  );
}

/** Tasks matching a filter, in plan order, as compact rows. */
export function findTasks(plan: PlanSnapshot, filter: TaskFilter = {}): { total: number; tasks: TaskRow[] } {
  const index = indexPlan(plan);
  const pass = backwardPass(plan, index);
  const words = (filter.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const crewIds = filter.crew !== undefined && String(filter.crew).trim() ? matchingCrews(plan, filter.crew) : null;
  const phase = filter.phase !== undefined && String(filter.phase).trim() ? String(filter.phase).trim().toLowerCase() : null;
  const floatOf = (task: PlanTask): number | null => {
    const floats = (index.leaves.get(task.id) ?? [task]).map((leaf) => pass.float.get(leaf.id)).filter((value): value is number => value !== undefined);
    return floats.length > 0 ? Math.min(...floats) : null;
  };
  const critical = (task: PlanTask) => task.percentDone < 100 && (floatOf(task) ?? 1) <= 0;
  const late = (task: PlanTask) =>
    task.percentDone < 100 && ((task.baselineEnd !== null && workingDaysBetween(task.baselineEnd, task.end, task.calendar) > 0) || lastWorkDay(task) < plan.statusDate);
  const matches = (task: PlanTask): boolean => {
    const group = isGroup(index, task);
    if (filter.leaves_only && group) return false;
    if (words.length > 0) {
      const haystack = `${task.name} ${task.note ?? ''} ${task.phase}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    if (crewIds && (group || !(index.crews.get(task.id) ?? []).some((crew) => crewIds.has(crew.resourceId)))) return false;
    if (phase !== null) {
      const above = ancestorsOf(index, task);
      if (!above.some((ancestor) => String(ancestor.id) === phase || ancestor.name.toLowerCase().includes(phase))) return false;
    }
    if (filter.from && lastWorkDay(task) < filter.from) return false;
    if (filter.to && task.start > filter.to) return false;
    switch (filter.status) {
      case 'not_started':
        return task.percentDone === 0;
      case 'in_progress':
        return task.percentDone > 0 && task.percentDone < 100;
      case 'done':
        return task.percentDone >= 100;
      case 'late':
        return late(task);
      case 'critical':
        return !group && critical(task);
      case 'milestone':
        return !group && task.start === task.end;
      default:
        return true;
    }
  };
  const found = index.ordered.filter(matches);
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 25)));
  return {
    total: found.length,
    tasks: found.slice(0, limit).map((task) => ({
      id: task.id,
      name: task.name,
      kind: kindOf(index, task),
      phase: task.phase,
      parent: parentOf(index, task)?.name ?? null,
      start: task.start,
      last_day: lastWorkDay(task),
      days: isGroup(index, task) ? countWorkingDays(task.start, task.end, task.calendar) : workDays(task),
      percent_done: Math.round(task.percentDone),
      crews: [...new Set((index.leaves.get(task.id) ?? [task]).flatMap((leaf) => (index.crews.get(leaf.id) ?? []).map((crew) => crew.name)))].slice(0, 6),
      critical: critical(task),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Crew workload
// ---------------------------------------------------------------------------------------------

export interface CrewLoad {
  crew: string;
  kind: 'labor' | 'equipment';
  company: string;
  trade: string;
  /** Crew-days booked in the window (a day at 100% is 1). */
  booked_days: number;
  /** Working days with any work. */
  busy_days: number;
  tasks: number;
  /** Crew-days per week (weeks start on Monday; weeks with no work left out; at most 30). */
  weeks: { week_of: string; days: number }[];
  peak_week: { week_of: string; days: number } | null;
  /** Days the crew is needed above 100% (at most 10, earliest first). */
  overloaded_days: { date: string; units: number; tasks: string[] }[];
  overloaded_day_count: number;
}

/** Monday of the week a day falls in. */
function weekOf(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

interface DayLoad {
  units: number;
  tasks: PlanTask[];
}

/** Each crew's booked working days per day, from its assignments on active, dated work. */
function dailyLoad(plan: PlanSnapshot, index: PlanIndex, resourceId: number, from?: string, to?: string): Map<string, DayLoad> {
  const load = new Map<string, DayLoad>();
  for (const assignment of plan.assignments) {
    if (assignment.resourceId !== resourceId) continue;
    const task = index.byId.get(assignment.taskId);
    if (!task || task.inactive || isGroup(index, task) || task.start === task.end) continue;
    for (const date of workDates(task).filter((candidate) => neededOn(assignment, candidate))) {
      if ((from && date < from) || (to && date > to)) continue;
      const entry = load.get(date) ?? { units: 0, tasks: [] };
      entry.units += assignment.units;
      if (!entry.tasks.includes(task)) entry.tasks.push(task);
      load.set(date, entry);
    }
  }
  return load;
}

/** Per crew: crew-days per week in the window, the peak week, and days the crew is needed twice. */
export function crewWorkload(
  plan: PlanSnapshot,
  options: { crew?: string | number; from?: string; to?: string } = {},
): { from: string | null; to: string | null; crews: CrewLoad[]; idle_crews: string[] } {
  const index = indexPlan(plan);
  const wanted = options.crew !== undefined && String(options.crew).trim() ? matchingCrews(plan, options.crew) : null;
  const crews: CrewLoad[] = [];
  const idle: string[] = [];
  for (const resource of plan.resources) {
    if (wanted && !wanted.has(resource.id)) continue;
    const load = dailyLoad(plan, index, resource.id, options.from, options.to);
    if (load.size === 0 && !wanted) {
      idle.push(resource.name);
      continue;
    }
    const weeks = new Map<string, number>();
    const tasks = new Set<number>();
    let booked = 0;
    for (const [date, entry] of load) {
      weeks.set(weekOf(date), (weeks.get(weekOf(date)) ?? 0) + entry.units / 100);
      booked += entry.units / 100;
      for (const task of entry.tasks) tasks.add(task.id);
    }
    const weekRows = [...weeks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week_of, days]) => ({ week_of, days: round(days) }));
    const peak = weekRows.reduce<{ week_of: string; days: number } | null>((best, week) => (!best || week.days > best.days ? week : best), null);
    const over = [...load.entries()].filter(([, entry]) => entry.units > 100).sort(([a], [b]) => (a < b ? -1 : 1));
    crews.push({
      crew: resource.name,
      kind: resource.kind,
      company: resource.company,
      trade: resource.trade ?? '',
      booked_days: round(booked),
      busy_days: load.size,
      tasks: tasks.size,
      weeks: weekRows.slice(0, 30),
      peak_week: peak,
      overloaded_days: over.slice(0, 10).map(([date, entry]) => ({ date, units: Math.round(entry.units), tasks: entry.tasks.map((task) => task.name) })),
      overloaded_day_count: over.length,
    });
  }
  crews.sort((a, b) => b.overloaded_day_count - a.overloaded_day_count || b.booked_days - a.booked_days);
  return { from: options.from ?? null, to: options.to ?? null, crews, idle_crews: idle };
}

// ---------------------------------------------------------------------------------------------
// Schedule health
// ---------------------------------------------------------------------------------------------

export interface HealthCheck {
  id: string;
  label: string;
  passed: boolean;
  count: number;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  /** The tasks behind the count (at most 12). */
  task_ids: number[];
}

const HARD_CONSTRAINTS = new Set(['muststarton', 'mustfinishon', 'startnolaterthan', 'finishnolaterthan']);

const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

/**
 * A DCMA-style check list adapted to this plan: logic, leads and lags, link types, hard constraints,
 * long tasks, crews, overloads, slips against the baseline and negative float. Open work is what the
 * checks on tasks look at (active, not finished); the link checks look at every active link.
 */
export function scheduleHealth(plan: PlanSnapshot): { checks: HealthCheck[]; passed: number; total: number } {
  const index = indexPlan(plan);
  const pass = backwardPass(plan, index);
  const leaves = plan.tasks.filter((task) => !isGroup(index, task) && !task.inactive);
  const open = leaves.filter((task) => task.percentDone < 100);
  const working = open.filter((task) => task.start !== task.end);
  const firstStart = leaves.map((task) => task.start).sort()[0];
  const linked = (task: PlanTask, side: 'from' | 'to') => {
    const ids = new Set([task.id, ...ancestorsOf(index, task).map((ancestor) => ancestor.id)]);
    return index.links.some((link) => ids.has(link[side]));
  };
  const check = (id: string, label: string, severity: HealthCheck['severity'], tasks: PlanTask[], passed: boolean, detail: string, count = tasks.length): HealthCheck => ({
    id,
    label,
    passed,
    count,
    severity,
    detail,
    task_ids: [...new Set(tasks.map((task) => task.id))].slice(0, 12),
  });
  const checks: HealthCheck[] = [];

  const noBefore = open.filter((task) => task.start !== firstStart && !linked(task, 'to'));
  const noAfter = open.filter((task) => task.id !== plan.handoverTaskId && !linked(task, 'from'));
  const loose = [...new Set([...noBefore, ...noAfter])];
  checks.push(
    check(
      'missing_logic',
      'Every task is linked to work before and after it',
      'high',
      loose,
      loose.length === 0,
      loose.length === 0
        ? `All ${open.length} open tasks have a link before them (or start the plan) and after them (or are the handover).`
        : `${noBefore.length} open tasks have nothing before them and ${noAfter.length} nothing after them: ${namesOf(loose)}. A change elsewhere will not move them.`,
    ),
  );

  const links = index.links;
  const succTasks = (list: PlanDependency[]) => list.map((link) => index.byId.get(link.to)).filter((task): task is PlanTask => task !== undefined);
  const leads = links.filter((link) => link.lag < 0);
  checks.push(
    check('leads', 'No links with a lead (negative lag)', 'medium', succTasks(leads), leads.length === 0,
      leads.length === 0 ? 'No link starts work before the work it waits for allows.' : `${leads.length} links overlap work with a lead: ${namesOf(succTasks(leads))}. Leads hide how the work really overlaps.`,
      leads.length),
  );

  const longLags = links.filter((link) => link.lag > 5);
  checks.push(
    check('long_lags', 'Few long lags (over 5 working days)', 'low', succTasks(longLags), percent(longLags.length, links.length) <= 5,
      longLags.length === 0 ? 'No link waits more than 5 working days.' : `${longLags.length} of ${links.length} links wait more than 5 working days: ${namesOf(succTasks(longLags))}. A long wait is often a task in disguise.`,
      longLags.length),
  );

  const nonFs = links.filter((link) => link.type !== FS);
  const byType = [0, 1, 3]
    .map((type) => ({ type, count: nonFs.filter((link) => link.type === type).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${LINK_WORDS[entry.type]}`);
  checks.push(
    check('link_types', 'Most links are finish-to-start (at least 90%)', 'low', succTasks(nonFs), percent(nonFs.length, links.length) <= 10,
      nonFs.length === 0 ? `All ${links.length} links are finish-to-start.` : `${nonFs.length} of ${links.length} links (${percent(nonFs.length, links.length)}%) are not finish-to-start: ${byType.join(', ')}.`,
      nonFs.length),
  );

  const hard = open.filter((task) => task.constraintType && HARD_CONSTRAINTS.has(task.constraintType.toLowerCase()));
  checks.push(
    check('hard_constraints', 'Few fixed dates (at most 5% of tasks)', 'medium', hard, percent(hard.length, open.length) <= 5,
      hard.length === 0 ? 'No task is pinned with a must-start, must-finish or no-later-than date.' : `${hard.length} tasks are pinned to a date (${namesOf(hard)}); they stop the plan showing the real ripple effect of a delay.`),
  );

  const long = working.filter((task) => workDays(task) > 20);
  checks.push(
    check('long_durations', 'Few long tasks (over 20 working days)', 'low', long, percent(long.length, working.length) <= 5,
      long.length === 0 ? 'No open task runs longer than 20 working days.' : `${long.length} tasks run longer than 20 working days: ${namesOf(long)}. Splitting them makes progress easier to see.`),
  );

  const noCrew = working.filter((task) => (index.crews.get(task.id) ?? []).length === 0);
  checks.push(
    check('no_crew', 'Every working task has a crew', 'low', noCrew, noCrew.length === 0,
      noCrew.length === 0 ? 'Every open working task has a crew or machine on it.' : `${noCrew.length} of ${working.length} open working tasks have no crew: ${namesOf(noCrew)}. Fine for suppliers and waiting time; otherwise nobody is booked.`),
  );

  const overloaded: { resource: string; days: number; tasks: PlanTask[] }[] = [];
  for (const resource of plan.resources) {
    const over = [...dailyLoad(plan, index, resource.id).values()].filter((entry) => entry.units > 100);
    if (over.length > 0) overloaded.push({ resource: resource.name, days: over.length, tasks: [...new Set(over.flatMap((entry) => entry.tasks))] });
  }
  checks.push(
    check('crew_overloads', 'No crew needed twice on the same day', 'medium', overloaded.flatMap((entry) => entry.tasks), overloaded.length === 0,
      overloaded.length === 0 ? 'No crew or machine is booked above 100% on any working day.' : overloaded.map((entry) => `${entry.resource} on ${entry.days} days`).join('; ') + '.',
      overloaded.length),
  );

  const slipped = leaves.filter((task) => task.baselineEnd !== null && workingDaysBetween(task.baselineEnd, task.end, task.calendar) > 0);
  const handoverSlip = slipped.find((task) => task.id === plan.handoverTaskId);
  checks.push(
    check('finish_slips', 'Tasks finish on their baseline', handoverSlip ? 'high' : 'medium', slipped, slipped.length === 0,
      slipped.length === 0
        ? 'No task finishes later than its baseline.'
        : `${slipped.length} tasks finish later than their baseline: ${namesOf(slipped)}.` +
            (handoverSlip ? ` The handover is ${workingDaysBetween(handoverSlip.baselineEnd ?? handoverSlip.end, handoverSlip.end, handoverSlip.calendar)} working days late.` : ''),
    ),
  );

  const negative = open.filter((task) => (pass.float.get(task.id) ?? 0) < 0);
  checks.push(
    check('negative_float', 'No task finishes too late for the handover', 'high', negative, negative.length === 0,
      negative.length === 0 ? 'Every open task can finish in time for the handover.' : `${negative.length} tasks finish too late for the handover as linked: ${namesOf(negative)}.`),
  );

  return { checks, passed: checks.filter((entry) => entry.passed).length, total: checks.length };
}

// ---------------------------------------------------------------------------------------------
// Repeating work and other places for a dropped piece
// ---------------------------------------------------------------------------------------------

/** Words a number or letter is often written after: "Room 2", "Level B", "Bay 4a". */
const NUMBERED = 'rooms?|levels?|floors?|stor(?:e)?ys?|blocks?|zones?|units?|bays?|areas?|flats?|apartments?|wings?|plots?|lots?|stages?|phases?|wards?|suites?|bathrooms?|restrooms?|bedrooms?|houses?|cores?|sections?|buildings?|parts?|pours?|lifts?|grids?|lines?|no|nr|number';

/** Lowercase words of a name without its numbering: "Room 2 – rough-in (east)" -> "room rough-in east". */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|ground|upper|lower|top|basement)\s+(floor|level|storey|story|stage|phase)\b/g, '$2')
    .replace(new RegExp(`\\b(${NUMBERED})(?:\\s*(?:#|no\\.?)?\\s*\\d+[a-z]?|\\s+(?:#\\s*)?(?:[ivx]+|[a-z]))\\b`, 'g'), '$1')
    .replace(/\b\d+(st|nd|rd|th)\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(normalizeName(a).split(' ').filter(Boolean));
  const right = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

/** Jaccard over two multisets of names (repeated names count). */
function multisetSimilarity(a: string[], b: string[]): number {
  const count = (names: string[]) => names.reduce((map, name) => map.set(name, (map.get(name) ?? 0) + 1), new Map<string, number>());
  const left = count(a);
  const right = count(b);
  let shared = 0;
  let either = 0;
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    shared += Math.min(left.get(name) ?? 0, right.get(name) ?? 0);
    either += Math.max(left.get(name) ?? 0, right.get(name) ?? 0);
  }
  return either === 0 ? 0 : shared / either;
}

export interface RepeatCandidate {
  /** Every occurrence, in plan order (at most 10). */
  group_ids: number[];
  /** The occurrence to save. */
  sample_id: number;
  name: string;
  leaf_count: number;
  /** Working days the sample spans. */
  span_days: number;
  crews: string[];
  reason: 'repeats' | 'self_contained';
  score: number;
}

/** Links between tasks inside a group, and links crossing its edge. */
function groupLinks(index: PlanIndex, group: PlanTask): { inside: PlanDependency[]; crossing: number } {
  const members = new Set([group.id, ...index.ordered.filter((task) => isInside(index, task, group)).map((task) => task.id)]);
  const inside: PlanDependency[] = [];
  let crossing = 0;
  for (const link of index.links) {
    const from = members.has(link.from);
    const to = members.has(link.to);
    if (from && to && link.from !== group.id && link.to !== group.id) inside.push(link);
    else if (from !== to) crossing += 1;
  }
  return { inside, crossing };
}

/** Whether a group's leaves form one piece through the links between them, and its entry and exit tasks. */
function linkShape(index: PlanIndex, group: PlanTask): { connected: boolean; entries: number; exits: number; inside: number; crossing: number } {
  const leaves = activeLeaves(index, group);
  const { inside, crossing } = groupLinks(index, group);
  const ids = new Map<number, number[]>();
  for (const leaf of leaves) ids.set(leaf.id, [leaf.id]);
  const leavesOf = (id: number) => (index.byId.get(id) ? activeLeaves(index, index.byId.get(id)!) : []).map((leaf) => leaf.id);
  const root = new Map(leaves.map((leaf) => [leaf.id, leaf.id]));
  const find = (id: number): number => {
    let at = id;
    while (root.get(at) !== at) at = root.get(at) ?? at;
    return at;
  };
  const hasPred = new Set<number>();
  const hasSucc = new Set<number>();
  for (const link of inside) {
    const from = leavesOf(link.from);
    const to = leavesOf(link.to);
    for (const a of from) hasSucc.add(a);
    for (const b of to) hasPred.add(b);
    const all = [...from, ...to];
    for (const id of all.slice(1)) if (root.has(id) && root.has(all[0]!)) root.set(find(id), find(all[0]!));
  }
  const components = new Set(leaves.map((leaf) => find(leaf.id)));
  return {
    connected: leaves.length > 0 && components.size === 1,
    entries: leaves.filter((leaf) => !hasPred.has(leaf.id)).length,
    exits: leaves.filter((leaf) => !hasSucc.has(leaf.id)).length,
    inside: inside.length,
    crossing,
  };
}

/**
 * Work worth saving as a reusable library piece: groups that repeat (their tasks have the same names
 * once the numbering is taken out), and groups that stand on their own (their tasks are linked into
 * one piece, best with one task to start it and one to finish it). At most eight, best first.
 */
export function repeatingWork(plan: PlanSnapshot): RepeatCandidate[] {
  const index = indexPlan(plan);
  const groups = index.ordered.filter((task) => {
    if (!isGroup(index, task) || task.inactive) return false;
    const count = activeLeaves(index, task).length;
    return count >= 2 && count <= 30;
  });
  const names = new Map(groups.map((group) => [group.id, activeLeaves(index, group).map((leaf) => normalizeName(leaf.name))]));
  const related = (a: PlanTask, b: PlanTask) => isInside(index, a, b) || isInside(index, b, a);
  const root = new Map(groups.map((group) => [group.id, group.id]));
  const find = (id: number): number => {
    let at = id;
    while (root.get(at) !== at) at = root.get(at) ?? at;
    return at;
  };
  const similarity = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!;
      const b = groups[j]!;
      if (related(a, b)) continue;
      const score = multisetSimilarity(names.get(a.id) ?? [], names.get(b.id) ?? []);
      if (score < 0.6) continue;
      similarity.set(`${a.id}:${b.id}`, score);
      root.set(find(b.id), find(a.id));
    }
  }
  const clusters = new Map<number, PlanTask[]>();
  for (const group of groups) {
    const key = find(group.id);
    clusters.set(key, [...(clusters.get(key) ?? []), group]);
  }
  const crewNames = (group: PlanTask) =>
    [...new Set(activeLeaves(index, group).flatMap((leaf) => (index.crews.get(leaf.id) ?? []).map((crew) => crew.name)))].slice(0, 6);
  const candidates: RepeatCandidate[] = [];
  const repeated = new Set<number>();
  const repeatGroups: PlanTask[][] = [];
  for (const members of clusters.values()) {
    // A cluster can hold two groups where one sits inside the other through a third; keep the outermost.
    const occurrences = members.filter((group) => !members.some((other) => other !== group && isInside(index, group, other)));
    if (occurrences.length < 2) continue;
    repeatGroups.push(occurrences);
    for (const group of members) repeated.add(group.id);
  }
  for (const occurrences of repeatGroups) {
    const pairs: number[] = [];
    for (let i = 0; i < occurrences.length; i++) {
      for (let j = i + 1; j < occurrences.length; j++) {
        const [a, b] = [occurrences[i]!, occurrences[j]!];
        pairs.push(similarity.get(`${a.id}:${b.id}`) ?? similarity.get(`${b.id}:${a.id}`) ?? multisetSimilarity(names.get(a.id) ?? [], names.get(b.id) ?? []));
      }
    }
    const average = pairs.reduce((total, value) => total + value, 0) / Math.max(1, pairs.length);
    const sample = [...occurrences].sort((a, b) => linkShape(index, b).inside - linkShape(index, a).inside || (index.rank.get(a.id) ?? 0) - (index.rank.get(b.id) ?? 0))[0]!;
    const leafCount = activeLeaves(index, sample).length;
    // Repeats inside a larger repeat (the same rooms on every level) count for less than the larger one.
    const nested = repeatGroups.some((other) => other !== occurrences && occurrences.every((group) => other.some((outer) => isInside(index, group, outer))));
    candidates.push({
      group_ids: occurrences.slice(0, 10).map((group) => group.id),
      sample_id: sample.id,
      name: sample.name,
      leaf_count: leafCount,
      span_days: countWorkingDays(sample.start, sample.end, sample.calendar),
      crews: crewNames(sample),
      reason: 'repeats',
      score: round((2 + Math.min(occurrences.length, 6) * average + Math.min(leafCount, 12) / 12) * (nested ? 0.5 : 1), 2),
    });
  }
  for (const group of groups) {
    if (repeated.has(group.id)) continue;
    const leafCount = activeLeaves(index, group).length;
    if (leafCount < 3 || leafCount > 15) continue;
    const shape = linkShape(index, group);
    if (!shape.connected) continue;
    const share = shape.inside / Math.max(1, shape.inside + shape.crossing);
    candidates.push({
      group_ids: [group.id],
      sample_id: group.id,
      name: group.name,
      leaf_count: leafCount,
      span_days: countWorkingDays(group.start, group.end, group.calendar),
      crews: crewNames(group),
      reason: 'self_contained',
      score: round(0.5 + (shape.entries === 1 ? 0.4 : 0) + (shape.exits === 1 ? 0.4 : 0) + 0.5 * share, 2),
    });
  }
  return candidates.sort((a, b) => b.score - a.score || (index.rank.get(a.sample_id) ?? 0) - (index.rank.get(b.sample_id) ?? 0)).slice(0, 8);
}

export interface PlaceSuggestion {
  /** The group to put the piece in (null: the top level of the plan). */
  parent_id: number | null;
  /** The task to put it after; null puts it at the end of the group (or its start, see `position`). */
  anchor_id: number | null;
  position: 'after' | 'end' | 'start';
  label: string;
  why: string;
  score: number;
}

/**
 * After a library piece was dropped into the plan, other places it plausibly belongs: groups named
 * like the one it went into ("Level 2 rooms" for "Level 1 rooms"), after the task there named like the
 * one it was dropped after ("Room 3 rough-in" for "Room 1 rough-in"), including other such tasks in
 * the same group. A place that already has a task named like the piece is left out. At most eight,
 * best first.
 */
export function similarPlaces(
  plan: PlanSnapshot,
  drop: { added_top_ids: number[]; anchor_id: number | null; parent_id: number | null },
): PlaceSuggestion[] {
  const index = indexPlan(plan);
  const tops = drop.added_top_ids.map((id) => index.byId.get(id)).filter((task): task is PlanTask => task !== undefined);
  if (tops.length === 0) return [];
  const dropped = new Set(tops.flatMap((top) => [top.id, ...index.ordered.filter((task) => isInside(index, task, top)).map((task) => task.id)]));
  const parent = drop.parent_id === null ? null : (index.byId.get(drop.parent_id) ?? null);
  const anchor = drop.anchor_id === null ? null : (index.byId.get(drop.anchor_id) ?? null);
  const childrenOf = (group: PlanTask | null) => (index.children.get(group?.id ?? null) ?? []).filter((task) => !dropped.has(task.id));
  const parentKids = index.children.get(parent?.id ?? null) ?? [];
  const anchorIsChild = anchor !== null && parentKids.some((task) => task.id === anchor.id);
  const atStart = !anchor && parentKids.length > 0 && dropped.has(parentKids[0]!.id);
  const position: PlaceSuggestion['position'] = anchorIsChild ? 'after' : atStart ? 'start' : 'end';
  const namedLikePiece = (task: PlanTask) => tops.some((top) => normalizeName(top.name) === normalizeName(task.name) || tokenSimilarity(top.name, task.name) >= 0.8);
  /** Whether any of these tasks, or anything under them, is named like the piece. */
  const holdsPiece = (tasks: PlanTask[]) => tasks.some((task) => namedLikePiece(task) || index.ordered.some((other) => isInside(index, other, task) && namedLikePiece(other)));
  const groupName = (group: PlanTask | null) => (group ? quote(group.name) : 'the top level of the plan');
  const pieceName = tops.length === 1 ? quote(tops[0]!.name) : `${quote(tops[0]!.name)} and ${tops.length - 1} more`;

  const candidates: { group: PlanTask | null; similarity: number }[] = [{ group: parent, similarity: 1 }];
  if (parent) {
    for (const group of index.ordered) {
      if (group.id === parent.id || dropped.has(group.id) || !isGroup(index, group) || group.inactive) continue;
      if (isInside(index, group, parent) || isInside(index, parent, group)) continue;
      const similarity = normalizeName(group.name) === normalizeName(parent.name) ? 1 : tokenSimilarity(group.name, parent.name);
      if (similarity >= 0.6) candidates.push({ group, similarity });
    }
  }

  const places: PlaceSuggestion[] = [];
  for (const { group, similarity } of candidates) {
    const kids = childrenOf(group);
    const same = group?.id === parent?.id;
    if (anchorIsChild && anchor) {
      const analogues = kids
        .map((task, at) => ({ task, at, match: normalizeName(task.name) === normalizeName(anchor.name) ? 1 : tokenSimilarity(task.name, anchor.name) }))
        .filter((entry) => entry.task.id !== anchor.id && entry.match >= 0.75);
      for (const [n, entry] of analogues.entries()) {
        // The stretch after this task up to the next one like it: where the piece would sit.
        const next = analogues[n + 1]?.at ?? kids.length;
        const stretch = analogues.length > 1 ? kids.slice(entry.at + 1, next) : kids;
        if (holdsPiece(stretch)) continue;
        places.push({
          parent_id: group?.id ?? null,
          anchor_id: entry.task.id,
          position: 'after',
          label: `After ${quote(entry.task.name)} in ${groupName(group)}`,
          why: same
            ? `${quote(entry.task.name)} is laid out like ${quote(anchor.name)} in the same group, and has no ${pieceName} after it yet.`
            : entry.task.name === anchor.name
              ? `${groupName(group)} is laid out like ${groupName(parent)} and has its own ${quote(entry.task.name)}; there is no ${pieceName} there yet.`
              : `${groupName(group)} is laid out like ${groupName(parent)}, and ${quote(entry.task.name)} matches ${quote(anchor.name)}; there is no ${pieceName} there yet.`,
          score: round(0.5 * similarity + 0.5 * entry.match - (same ? 0.05 : 0), 2),
        });
      }
      if (analogues.length > 0 || same || holdsPiece(kids)) continue;
      places.push({
        parent_id: group?.id ?? null,
        anchor_id: null,
        position: 'end',
        label: `At the end of ${groupName(group)}`,
        why: `${groupName(group)} is laid out like ${groupName(parent)} but has no task like ${quote(anchor.name)}, and no ${pieceName} yet.`,
        score: round(0.5 * similarity, 2),
      });
      continue;
    }
    if (same || holdsPiece(kids)) continue;
    places.push({
      parent_id: group?.id ?? null,
      anchor_id: null,
      position,
      label: `${position === 'start' ? 'At the start of' : 'At the end of'} ${groupName(group)}`,
      why: `${groupName(group)} is laid out like ${groupName(parent)} and has no ${pieceName} yet.`,
      score: round(0.8 * similarity, 2),
    });
  }
  return places.sort((a, b) => b.score - a.score || (index.rank.get(a.anchor_id ?? a.parent_id ?? 0) ?? 0) - (index.rank.get(b.anchor_id ?? b.parent_id ?? 0) ?? 0)).slice(0, 8);
}

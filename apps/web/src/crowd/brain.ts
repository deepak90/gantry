/**
 * What a simulated person does next. First anything the ledger says is due to be brought back (the
 * scheduler takes date changes first); otherwise something that fits their current intent, on a task
 * of their area that nobody else is on: a name tweak, a note, a progress nudge, a move or resize
 * within float, or a crew swap within a trade. Every plan carries the governed change that will make it.
 *
 * Between changes, and always in a look-only crowd, they only look (`chooseLook`): nothing it can pick
 * changes the plan.
 */
import type { AssignmentModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import type { ContentBook, Intent } from './content';
import { sameValue, type CrewValue, type DriftEntry, type DriftValue, type GovernedChange, type Governor, type StartValue } from './governor';
import type { ActionKind, Persona } from './personas';
import type { Random } from './random';
import { planClock } from '../plan-clock';

// -----------------------------------------------------------------------------------------
// Looking
// -----------------------------------------------------------------------------------------

/**
 * Ways of looking at the plan, none of which changes it: reading a row, moving the pointer somewhere,
 * selecting a cell, scrolling, resting the hand; and in a look-only crowd also opening the task panel
 * on a row to read it (the pointer goes over to the panel, nothing is typed), resting on a bar to read
 * its hover card, and going over to the row a colleague has selected, as if talking it over.
 */
export const LOOK_KINDS = ['read', 'wander', 'select', 'scroll', 'rest', 'peek', 'inspect', 'glance'] as const;
export type LookKind = (typeof LOOK_KINDS)[number];

export interface LookSituation {
  /** Time left to look around (ms). */
  left: number;
  /** A look-only crowd: also peeks, inspects and glances, and keeps to the part of the plan in view. */
  lookOnly?: boolean;
  /** Look-only: the moment a change would come (every 10 to 15 seconds), so something others notice. */
  turn?: boolean;
  /** Look-only: another simulated person has a task selected on this person's screen. */
  colleague?: boolean;
}

/** How a person looks around next. Never an edit: only ever one of `LOOK_KINDS`. */
export function chooseLook(random: Random, situation: LookSituation): LookKind | undefined {
  const { left } = situation;
  if (!situation.lookOnly) {
    // Between changes (the weights the crowd has always had).
    return random.weighted<LookKind>([
      ['read', 4],
      ['wander', 3],
      ['select', 2],
      ['scroll', left > 2_500 ? 1.5 : 0],
      ['rest', 1.5],
    ]);
  }
  const colleague = situation.colleague ? 1 : 0;
  if (situation.turn) {
    return random.weighted<LookKind>([
      ['peek', 3],
      ['inspect', 3],
      ['glance', 2.5 * colleague],
      ['select', 2],
      ['read', 1],
      ['scroll', left > 2_500 ? 0.8 : 0],
    ]);
  }
  return random.weighted<LookKind>([
    ['read', 4],
    ['wander', 2.5],
    ['select', 2],
    ['inspect', 1.5],
    ['glance', 0.8 * colleague],
    ['scroll', left > 2_500 ? 0.7 : 0],
    ['rest', 1.5],
  ]);
}

export type Via = 'cell' | 'panel' | 'bar';

export interface Plan {
  kind: ActionKind;
  via: Via;
  /** Cell edits: the column edited (one of the screen's columns). */
  column: string | null;
  /** Bar edits: grab the bar (move) or its end (resize). */
  grip?: 'body' | 'end';
  taskId: number;
  /** For the status page: what it does, in a few words. */
  summary: string;
  change: GovernedChange;
  /** Bar edits: how far the pointer drags, in calendar days (negative: earlier or shorter). */
  dragDays?: number;
  /** Set when this brings back a ledger entry. */
  restores?: DriftEntry;
}

export interface BrainContext {
  persona: Persona;
  who: { id: string; name: string };
  project: ProjectModel;
  governor: Governor;
  content: ContentBook;
  /** Their tasks. */
  area: readonly number[];
  /** Everyone's editable tasks, for a person whose own area has nothing free (a small project). */
  pool: readonly number[];
  /** Pinned to one part of the plan (their area): what they bring back is only ever from there. */
  pinned?: boolean;
  /** Someone else is on this task (a claim, a selection, an activity). */
  busy(taskId: number): boolean;
  intent: Intent | null;
  /** Their last few changes, newest first: they vary what they do and where. */
  recent?: readonly { taskId: number; kind: ActionKind }[];
  random: Random;
  now: number;
  /** A look-only crowd: no plan at all, not even bringing something back. */
  lookOnly?: boolean;
}

const DAY_MS = 86_400_000;
/** A change is never brought back sooner than this after it was made. */
const EARLY_MS = 60_000;
const quote = (task: TaskModel) => `“${String(task.name ?? '')}”`;
const record = (task: TaskModel) => task as TaskModel & Record<string, unknown>;
const timeOf = (value: unknown): number | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : null);

function readStart(task: TaskModel): StartValue {
  const fields = record(task);
  return { constraintType: (fields.constraintType as string | null | undefined) ?? null, constraintDate: timeOf(fields.constraintDate), start: timeOf(task.startDate) };
}

/** Calendar days that `working` working days span from `from` (weekends skipped), for drawing a drag. */
function calendarDays(from: Date, working: number): number {
  const step = Math.sign(working);
  let days = 0;
  let left = Math.abs(working);
  const cursor = new Date(from);
  while (left > 0 && Math.abs(days) < 30) {
    cursor.setDate(cursor.getDate() + step);
    days += step;
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return days;
}

function assignmentsOf(task: TaskModel): AssignmentModel[] {
  return ((task as unknown as { assignments?: AssignmentModel[] }).assignments ?? []).filter(Boolean);
}

interface CrewFields {
  kind?: string;
  trade?: string;
}

function crewOf(project: ProjectModel, assignmentId: number): CrewValue | null {
  const assignment = project.assignmentStore.getById(assignmentId) as AssignmentModel | undefined;
  const resource = assignment?.resource as ResourceModel | undefined;
  return assignment && resource && typeof resource.id === 'number' ? { assignmentId, resourceId: resource.id, resourceName: String(resource.name ?? '') } : null;
}

// -----------------------------------------------------------------------------------------
// Changes
// -----------------------------------------------------------------------------------------

function renameChange(taskId: number, name: string, restoring = false): GovernedChange {
  return {
    title: 'Rename task',
    taskId,
    field: 'name',
    movesDates: false,
    restoring,
    read: (task) => String(task.name ?? ''),
    write: (task) => {
      task.name = name;
    },
  };
}

function noteChange(taskId: number, note: string, restoring = false): GovernedChange {
  return {
    title: 'Edit notes',
    taskId,
    field: 'note',
    movesDates: false,
    restoring,
    read: (task) => String(record(task).note ?? ''),
    write: (task) => {
      record(task).note = note;
    },
  };
}

function progressChange(taskId: number, percent: number, restoring = false): GovernedChange {
  return {
    title: 'Edit progress',
    taskId,
    field: 'progress',
    movesDates: false,
    restoring,
    // Exact, so bringing it back restores a seed of 2.5% as 2.5%, not 3%.
    read: (task) => Number(task.percentDone) || 0,
    write: (task) => {
      task.percentDone = percent;
    },
  };
}

function moveChange(taskId: number, start: Date): GovernedChange {
  return {
    title: 'Move task',
    taskId,
    field: 'start',
    movesDates: true,
    read: readStart,
    write: (task) => {
      void task.setStartDate(start, true);
    },
  };
}

function restoreStartChange(taskId: number, seed: StartValue): GovernedChange {
  return {
    title: 'Move task',
    taskId,
    field: 'start',
    movesDates: true,
    restoring: true,
    read: readStart,
    write: (task) => {
      const fields = task as unknown as { constraintType: string | null; constraintDate: Date | null };
      fields.constraintType = seed.constraintType;
      fields.constraintDate = seed.constraintDate === null ? null : new Date(seed.constraintDate);
    },
  };
}

function durationChange(taskId: number, days: number, restoring = false): GovernedChange {
  return {
    title: 'Edit duration',
    taskId,
    field: 'duration',
    movesDates: true,
    restoring,
    read: (task) => Number(task.duration),
    write: (task) => {
      void task.setDuration(days, task.durationUnit ?? 'day');
    },
  };
}

function crewChange(taskId: number, assignmentId: number, resourceId: number, restoring = false): GovernedChange {
  return {
    title: 'Change crew',
    taskId,
    field: 'crew',
    movesDates: false,
    restoring,
    read: (_task, project) => crewOf(project, assignmentId),
    write: (_task, project) => {
      const assignment = project.assignmentStore.getById(assignmentId) as AssignmentModel | undefined;
      const resource = project.resourceStore.getById(resourceId) as ResourceModel | undefined;
      if (!assignment || !resource) throw new Error('crew gone');
      assignment.resource = resource;
    },
  };
}

// -----------------------------------------------------------------------------------------
// Plans
// -----------------------------------------------------------------------------------------

/**
 * Bringing a ledger entry back, done the way the original kind of change is done. Null when there is
 * nothing to bring back: the task is gone, or somebody changed the value since (then it is theirs).
 */
export function restorePlan(ctx: Pick<BrainContext, 'project' | 'random'>, entry: DriftEntry): Plan | null {
  const plan = restoreFor(ctx, entry);
  const task = ctx.project.taskStore.getById(entry.taskId) as TaskModel | undefined;
  if (!plan || !task || !sameValue(entry.field, plan.change.read(task, ctx.project), entry.current)) return null;
  return plan;
}

function restoreFor(ctx: Pick<BrainContext, 'project' | 'random'>, entry: DriftEntry): Plan | null {
  const task = ctx.project.taskStore.getById(entry.taskId) as TaskModel | undefined;
  if (!task) return null;
  const base = { taskId: entry.taskId, restores: entry };
  const seed = entry.seed as DriftValue;
  switch (entry.field) {
    case 'name':
      return { ...base, kind: 'rename', via: 'cell', column: 'task', summary: `put the name of ${quote(task)} back`, change: renameChange(entry.taskId, String(seed ?? ''), true) };
    case 'note':
      return { ...base, kind: 'note', via: 'panel', column: null, summary: `${seed ? 'restored' : 'cleared'} the note on ${quote(task)}`, change: noteChange(entry.taskId, String(seed ?? ''), true) };
    case 'progress': {
      const via = ctx.random.chance(0.5) ? 'cell' : 'panel';
      return { ...base, kind: 'progress', via, column: via === 'cell' ? 'schedule-when' : null, summary: `set ${quote(task)} back to ${Math.round(Number(seed))}%`, change: progressChange(entry.taskId, Number(seed), true) };
    }
    case 'start': {
      const start = seed as StartValue;
      const current = timeOf(task.startDate);
      const days = start.start !== null && current !== null ? Math.round((start.start - current) / DAY_MS) : -1;
      return { ...base, kind: 'move', via: 'bar', grip: 'body', column: null, dragDays: days, summary: `moved ${quote(task)} back`, change: restoreStartChange(entry.taskId, start) };
    }
    case 'duration': {
      const days = Number(seed);
      if (!Number.isFinite(days) || days <= 0) return null;
      const end = task.endDate instanceof Date ? task.endDate : planClock.now();
      return { ...base, kind: 'resize', via: 'bar', grip: 'end', column: null, dragDays: calendarDays(end, days - Number(task.duration)), summary: `${quote(task)} back to ${days} days`, change: durationChange(entry.taskId, days, true) };
    }
    case 'crew': {
      const crew = seed as CrewValue | null;
      if (!crew || !ctx.project.assignmentStore.getById(crew.assignmentId) || !ctx.project.resourceStore.getById(crew.resourceId)) return null;
      const via = ctx.random.chance(0.6) ? 'cell' : 'panel';
      return { ...base, kind: 'crew', via, column: via === 'cell' ? 'schedule-crew' : null, summary: `${crew.resourceName} back on ${quote(task)}`, change: crewChange(entry.taskId, crew.assignmentId, crew.resourceId, true) };
    }
  }
}

/** One kind of edit on one task, or null when it does not fit. */
export function editPlan(ctx: BrainContext, task: TaskModel, kind: ActionKind): Plan | null {
  const { governor, persona, random, who } = ctx;
  const id = task.id as number;
  const mine = (field: Parameters<Governor['mayDisplace']>[2]) => governor.mayDisplace(who.id, id, field);
  switch (kind) {
    case 'rename': {
      if (!mine('name') || governor.ledger.get(id, 'name')) return null;
      const name = ctx.content.rename(persona, task);
      if (!name) return null;
      return { kind, via: 'cell', column: 'task', taskId: id, summary: `renamed ${quote(task)} to “${name}”`, change: renameChange(id, name) };
    }
    case 'note': {
      if (!mine('note')) return null;
      const note = ctx.content.note(persona, task);
      if (!note) return null;
      return { kind, via: 'panel', column: null, taskId: id, summary: `noted on ${quote(task)}: “${note}”`, change: noteChange(id, note) };
    }
    case 'progress': {
      if (!mine('progress')) return null;
      const current = Math.round(Number(task.percentDone) || 0);
      const seed = Number(governor.ledger.get(id, 'progress')?.seed ?? current);
      if (seed >= 100) return null;
      // Progress only goes up here; bringing it back is someone else's later edit.
      const step = random.pick([5, 5, 10, 10, 15])!;
      const value = Math.round(Math.min(95, seed + 25, current + step) / 5) * 5;
      if (value <= current) return null;
      const via = random.chance(0.5) ? 'cell' : 'panel';
      return { kind, via, column: via === 'cell' ? 'schedule-when' : null, taskId: id, summary: `progress on ${quote(task)} ${current}% → ${value}%`, change: progressChange(id, value) };
    }
    case 'move': {
      if (!mine('start') || governor.ledger.get(id, 'start')) return null;
      const room = governor.room(task);
      if (room < 1 || !(task.startDate instanceof Date)) return null;
      const days = random.int(1, Math.min(3, room));
      const start = new Date(task.startDate.getFullYear(), task.startDate.getMonth(), task.startDate.getDate() + days);
      const via = random.chance(0.75) ? 'bar' : 'cell';
      return {
        kind,
        via,
        grip: 'body',
        column: via === 'cell' ? 'schedule-when' : null,
        taskId: id,
        dragDays: days,
        summary: `moved ${quote(task)} ${days} day${days === 1 ? '' : 's'} later (float ${room + 2}d)`,
        change: moveChange(id, start),
      };
    }
    case 'resize': {
      if (!mine('duration') || governor.ledger.get(id, 'duration')) return null;
      const duration = Number(task.duration);
      if (!Number.isFinite(duration) || duration < 1 || String(task.durationUnit ?? 'day') !== 'day') return null;
      // Only tasks with float: shortening a critical task would pull the handover in.
      if (governor.room(task) < 1) return null;
      const longer = duration < 3 || random.chance(0.65);
      const next = duration + (longer ? 1 : -1);
      const via = random.chance(0.75) ? 'bar' : 'cell';
      const end = task.endDate instanceof Date ? task.endDate : planClock.now();
      return {
        kind,
        via,
        grip: 'end',
        column: via === 'cell' ? 'schedule-when' : null,
        taskId: id,
        dragDays: calendarDays(end, next - duration),
        summary: `made ${quote(task)} ${next} days (was ${duration})`,
        change: durationChange(id, next),
      };
    }
    case 'crew': {
      if (!mine('crew') || governor.ledger.get(id, 'crew')) return null;
      const assigned = assignmentsOf(task);
      const onTask = new Set(assigned.map((assignment) => (assignment.resource as ResourceModel | undefined)?.id));
      for (const assignment of random.shuffle(assigned)) {
        const resource = assignment.resource as (ResourceModel & CrewFields) | undefined;
        if (!resource || typeof assignment.id !== 'number' || !resource.trade) continue;
        const others = (ctx.project.resourceStore.records as (ResourceModel & CrewFields)[]).filter(
          (other) => other !== resource && typeof other.id === 'number' && other.trade === resource.trade && (other.kind ?? 'labor') === (resource.kind ?? 'labor') && !onTask.has(other.id),
        );
        const other = random.pick(others);
        if (!other) continue;
        const via = random.chance(0.6) ? 'cell' : 'panel';
        return {
          kind,
          via,
          column: via === 'cell' ? 'schedule-crew' : null,
          taskId: id,
          summary: `put ${String(other.name)} on ${quote(task)} instead of ${String(resource.name)}`,
          change: crewChange(id, assignment.id, other.id as number),
        };
      }
      return null;
    }
  }
}

/** The next plan, or null to just look around this time (always, in a look-only crowd). */
export function choosePlan(ctx: BrainContext): Plan | null {
  if (ctx.lookOnly) return null;
  const { governor, random, project } = ctx;
  // Pinned to a part of the plan: someone else's part is left to them, put-backs included.
  const ours = (entry: { taskId: number }) => !ctx.pinned || ctx.area.includes(entry.taskId);
  const due = governor.ledger.due(ctx.who.id, ctx.now).filter((entry) => !ctx.busy(entry.taskId) && ours(entry));
  if (due.length && random.chance(ctx.persona.tidiesDates ? 0.95 : 0.8)) {
    const ordered = ctx.persona.tidiesDates ? [...due].sort((a, b) => Number(b.field === 'start' || b.field === 'duration') - Number(a.field === 'start' || a.field === 'duration')) : due;
    for (const entry of ordered) {
      const task = project.taskStore.getById(entry.taskId) as TaskModel | undefined;
      const plan = task && !governor.refusal(task) ? restorePlan(ctx, entry) : null;
      if (plan) return plan;
      // The task is gone or out of bounds now: nothing to bring back.
      governor.ledger.drop(entry.key);
    }
  }
  // Nothing new may be moved (their share of the drift is out): something a while old, made by
  // somebody else, is brought back instead of standing idle.
  if (governor.ledger.countBy(ctx.who.id) >= governor.perPerson && random.chance(0.7)) {
    for (const entry of governor.ledger.early(ctx.who.id, EARLY_MS, ctx.now)) {
      if (ctx.busy(entry.taskId) || !ours(entry)) continue;
      const task = project.taskStore.getById(entry.taskId) as TaskModel | undefined;
      const plan = task && !governor.refusal(task) ? restorePlan(ctx, entry) : null;
      if (plan) return plan;
    }
  }
  const usable = (ids: readonly number[]) =>
    ids
      .map((id) => project.taskStore.getById(id) as TaskModel | undefined)
      .filter((task): task is TaskModel => Boolean(task) && !governor.refusal(task) && !ctx.busy(task!.id as number));
  const recent = ctx.recent ?? [];
  // Not the same task again straight away, while there is another.
  const fresh = (tasks: TaskModel[]) => {
    const others = tasks.filter((task) => !recent.slice(0, 2).some((entry) => entry.taskId === task.id));
    return others.length ? others : tasks;
  };
  const focus = fresh(usable(ctx.intent?.focus ?? []));
  let area = fresh(usable(ctx.area));
  // A small project spread over many people: borrow a free task now and then.
  if (area.length < 2 && random.chance(0.5)) area = fresh([...area, ...usable(ctx.pool)]);
  if (!focus.length && !area.length) return null;
  const boosted = new Set(ctx.intent?.kinds ?? []);
  // Varied work: the kind of edit just made is less likely next.
  const damp = (kind: ActionKind) => (recent[0]?.kind === kind ? 0.3 : recent.slice(1, 3).some((entry) => entry.kind === kind) ? 0.65 : 1);
  const kinds = Object.entries(ctx.persona.weights).map(([kind, weight]) => [kind as ActionKind, weight * (boosted.has(kind as ActionKind) ? 3 : 1) * damp(kind as ActionKind)] as const);
  for (let attempt = 0; attempt < 10; attempt++) {
    const task = focus.length && (random.chance(0.55) || !area.length) ? random.pick(focus)! : random.pick(area)!;
    const kind = random.weighted(kinds);
    if (!kind) return null;
    const plan = editPlan(ctx, task, kind);
    if (plan) return plan;
  }
  return null;
}

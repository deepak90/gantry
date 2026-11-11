/**
 * What the task panel shows, read from the live project: where the task sits, its schedule and
 * scheduling settings (the fields of Bryntum's own task editor), the links into and out of it, its
 * crews and its money. Pure reads: nothing here writes to a record, so reading never produces a
 * revision.
 *
 * Grouped views show linked copies of tasks; every read goes to the original record.
 */
import { DateHelper } from '@bryntum/gantt';
import type { AssignmentModel, CalendarModel, DependencyModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import {
  crewColor,
  crewIcon,
  lastWorkingDay,
  original,
  rolledUpMoney,
  slipDays,
  statusOf,
  taskIcon,
  taskPath,
  type StatusKey,
  type TaskMoney, usualCrewSize } from '../../gantt/look';
import { lagInDays, waitText } from '../../gantt/cell-editors';
import { TaskCostLine } from '@collab/shared';

const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

// -----------------------------------------------------------------------------------------
// Units
// -----------------------------------------------------------------------------------------

/** Duration units offered for a link's lag and a task's effort (Bryntum unit names). */
export type TimeUnitName = 'minute' | 'hour' | 'day' | 'week' | 'month';

export const LAG_UNITS: readonly TimeUnitName[] = ['hour', 'day', 'week', 'month'];

/** Bryntum's own spelling of a unit (`d`, `days`, `w` → `day`, `week`), or null when it is not one offered here. */
export function normalUnit(unit: unknown): TimeUnitName | null {
  if (typeof unit !== 'string' || !unit) return null;
  const normal = (DateHelper as unknown as { normalizeUnit(unit: string): string | undefined }).normalizeUnit(unit);
  return normal === 'minute' || normal === 'hour' || normal === 'day' || normal === 'week' || normal === 'month' ? normal : null;
}

/** `2 days`, `1 week`, `-4 hours`. */
export function amountText(magnitude: number, unit: string): string {
  const value = Math.round(magnitude * 100) / 100;
  return `${value} ${unit}${Math.abs(value) === 1 ? '' : 's'}`;
}

// -----------------------------------------------------------------------------------------
// Links
// -----------------------------------------------------------------------------------------

/** Bryntum dependency types: 0 start-to-start, 1 start-to-finish, 2 finish-to-start, 3 finish-to-finish. */
export type LinkType = 0 | 1 | 2 | 3;

/** All four dependency types, in the order scheduling tools list them. */
export const LINK_TYPE_CHOICES: readonly { type: LinkType; code: 'FS' | 'SS' | 'FF' | 'SF'; label: string }[] = [
  { type: 2, code: 'FS', label: 'Finish-to-Start (FS)' },
  { type: 0, code: 'SS', label: 'Start-to-Start (SS)' },
  { type: 3, code: 'FF', label: 'Finish-to-Finish (FF)' },
  { type: 1, code: 'SF', label: 'Start-to-Finish (SF)' },
];

const isLinkType = (value: unknown): value is LinkType => value === 0 || value === 1 || value === 2 || value === 3;

/**
 * The kind of a link from the side of the task that waits ("Waits for X: after it finishes") or
 * of the task that leads ("Leads to Y: after this finishes").
 */
export function linkKindText(type: number, side: 'waits' | 'leads'): string {
  const other = side === 'waits' ? 'it' : 'this';
  switch (type) {
    case 0:
      return `when ${other} starts`;
    case 1:
      return `finishes once ${other} starts`;
    case 3:
      return 'finish together';
    default:
      return `after ${other} finishes`;
  }
}

/** `+2 days wait`, `1 day overlap`, `no wait`: working days in the task calendar. */
export const lagText = waitText;

/**
 * What a link makes the successor do, in one sentence from the panel's task: "Starts 2 days after
 * Deliver steel finishes", "Bolt-up finishes 1 day before this starts".
 */
export function linkSentence(type: number, side: 'waits' | 'leads', otherName: string, lag: number, lagUnit: string): string {
  const successorMoves = type === 2 || type === 0 ? 'starts' : 'finishes';
  const predecessorPoint = type === 2 || type === 3 ? 'finishes' : 'starts';
  const gap = lag === 0 ? (type === 2 ? 'once' : 'when') : `${amountText(Math.abs(lag), lagUnit)} ${lag > 0 ? 'after' : 'before'}`;
  if (side === 'waits') return `${successorMoves === 'starts' ? 'Starts' : 'Finishes'} ${gap} ${otherName} ${predecessorPoint}`;
  return `${otherName} ${successorMoves} ${gap} this ${predecessorPoint}`;
}

export interface LinkView {
  id: number | string;
  /** The task at the other end. */
  otherId: number | string;
  otherName: string;
  otherPath: string[];
  otherIsPhase: boolean;
  otherIcon: string;
  type: number;
  /** FS, SS, FF or SF. */
  typeCode: string;
  kind: string;
  /** The lag in working days (other units converted), for the wording. */
  lag: number;
  lagText: string;
  /** The lag as stored: magnitude and unit. */
  lagValue: number;
  lagUnit: TimeUnitName;
  /** "Starts 2 days after Deliver steel finishes". */
  sentence: string;
  active: boolean;
}

// -----------------------------------------------------------------------------------------
// Constraints
// -----------------------------------------------------------------------------------------

export type ConstraintType =
  | 'assoonaspossible'
  | 'aslateaspossible'
  | 'muststarton'
  | 'mustfinishon'
  | 'startnoearlierthan'
  | 'startnolaterthan'
  | 'finishnoearlierthan'
  | 'finishnolaterthan';

export interface ConstraintChoice {
  type: ConstraintType | null;
  label: string;
  hint: string;
  /** Which date the constraint holds: the start, the finish, or none (no date). */
  side: 'start' | 'finish' | null;
  /** Only for tasks, not phases (the engine drops these on a summary task). */
  leafOnly: boolean;
}

/** Bryntum's constraint types (with ASAP/ALAP, the Gantt's default), in its own order. */
export const CONSTRAINT_CHOICES: readonly ConstraintChoice[] = [
  { type: null, label: 'None', hint: 'No constraint: its links and the scheduling direction of its phase or the project place it.', side: null, leafOnly: false },
  { type: 'assoonaspossible', label: 'As soon as possible', hint: 'Starts as early as its links allow (schedules forward).', side: null, leafOnly: false },
  { type: 'aslateaspossible', label: 'As late as possible', hint: 'Finishes as late as its successors and the project end allow (schedules backward).', side: null, leafOnly: false },
  { type: 'muststarton', label: 'Must start on', hint: 'Starts exactly on the constraint date, whatever its links say.', side: 'start', leafOnly: true },
  { type: 'mustfinishon', label: 'Must finish on', hint: 'Its last working day is exactly the constraint date.', side: 'finish', leafOnly: true },
  { type: 'startnoearlierthan', label: 'Start no earlier than', hint: 'Starts on the constraint date or later, even when its links allow earlier.', side: 'start', leafOnly: false },
  { type: 'startnolaterthan', label: 'Start no later than', hint: 'Starts on the constraint date or earlier.', side: 'start', leafOnly: true },
  { type: 'finishnoearlierthan', label: 'Finish no earlier than', hint: 'Finishes on the constraint date or later.', side: 'finish', leafOnly: true },
  { type: 'finishnolaterthan', label: 'Finish no later than', hint: 'Finishes on the constraint date or earlier.', side: 'finish', leafOnly: false },
];

export function constraintChoice(type: string | null | undefined): ConstraintChoice | null {
  return CONSTRAINT_CHOICES.find((choice) => choice.type === (type || null)) ?? null;
}

export function isConstraintType(value: unknown): value is ConstraintType {
  return typeof value === 'string' && CONSTRAINT_CHOICES.some((choice) => choice.type === value);
}

/** True for the types that need a constraint date. */
export function constraintNeedsDate(type: string | null | undefined): boolean {
  return Boolean(constraintChoice(type)?.side);
}

/** The constraint types a task (all) or a phase (the engine's summary subset) can carry. */
export function constraintChoicesFor(isPhase: boolean): readonly ConstraintChoice[] {
  return isPhase ? CONSTRAINT_CHOICES.filter((choice) => !choice.leafOnly) : CONSTRAINT_CHOICES;
}

const dayAfter = (date: Date): Date => DateHelper.add(DateHelper.clearTime(date), 1, 'day');

/**
 * The day a constraint date stands for, as the panel shows it. A start constraint holds a start
 * (the 00:00 of its day); a finish constraint holds an end, which in Bryntum is exclusive (a task
 * finishing on Friday ends Saturday 00:00), so it is shown as the day before, the last working day.
 */
export function constraintDay(type: string | null | undefined, date: Date | null | undefined): Date | null {
  if (!isDate(date)) return null;
  return constraintChoice(type)?.side === 'finish' ? DateHelper.clearTime(new Date(date.getTime() - 1)) : DateHelper.clearTime(date);
}

/** The constraint date to store for a day picked in the panel (the inverse of `constraintDay`). */
export function constraintDateFor(type: string | null | undefined, day: Date): Date {
  return constraintChoice(type)?.side === 'finish' ? dayAfter(day) : DateHelper.clearTime(day);
}

/** The date a constraint gets when its type is picked and it has none yet: the task's own start or finish. */
export function defaultConstraintDate(type: string | null | undefined, task: TaskModel): Date | null {
  const record = original(task);
  const side = constraintChoice(type)?.side;
  if (side === 'start') return isDate(record.startDate) ? DateHelper.clearTime(record.startDate) : null;
  if (side === 'finish') return isDate(record.endDate) ? record.endDate : null;
  return null;
}

const SHORT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * What the engine did with the constraint, when it is not simply met: ignored (manually
 * scheduled, inactive) or not met (the dates break it, e.g. a must-start-on date on a weekend).
 */
function constraintNote(task: TaskModel, type: ConstraintType | null, date: Date | null, manual: boolean, inactive: boolean): { tone: 'warn' | 'neutral'; text: string } | null {
  const choice = constraintChoice(type);
  if (!choice || !type) return null;
  if (manual && type !== 'assoonaspossible' && type !== 'aslateaspossible') {
    return { tone: 'neutral', text: 'Manually scheduled: the constraint is kept but ignored until the task is scheduled automatically again.' };
  }
  if (inactive) return { tone: 'neutral', text: 'Inactive: the task takes no part in scheduling, so the constraint has no effect.' };
  if (!choice.side || !date) return null;
  const start = task.startDate;
  const end = task.endDate;
  if (!isDate(start) || !isDate(end)) return null;
  const day = constraintDay(type, date)!;
  const startText = SHORT_DAY.format(start);
  const lastText = SHORT_DAY.format(lastWorkingDay(task));
  const dayText = SHORT_DAY.format(day);
  const t = date.getTime();
  switch (type) {
    case 'muststarton':
      return start.getTime() === t ? null : { tone: 'warn', text: `Not met: it starts ${startText}, not on ${dayText}.` };
    case 'mustfinishon':
      return end.getTime() === t ? null : { tone: 'warn', text: `Not met: it finishes ${lastText}, not on ${dayText}.` };
    case 'startnoearlierthan':
      return start.getTime() >= t ? null : { tone: 'warn', text: `Not met: it starts ${startText}, before ${dayText}.` };
    case 'startnolaterthan':
      return start.getTime() <= t ? null : { tone: 'warn', text: `Not met: it starts ${startText}, after ${dayText}.` };
    case 'finishnoearlierthan':
      return end.getTime() >= t ? null : { tone: 'warn', text: `Not met: it finishes ${lastText}, before ${dayText}.` };
    case 'finishnolaterthan':
      return end.getTime() <= t ? null : { tone: 'warn', text: `Not met: it finishes ${lastText}, after ${dayText}.` };
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------------------
// Scheduling settings
// -----------------------------------------------------------------------------------------

export type SchedulingMode = 'Normal' | 'FixedDuration' | 'FixedEffort' | 'FixedUnits';

export const SCHEDULING_MODE_CHOICES: readonly { mode: SchedulingMode; label: string; hint: string }[] = [
  { mode: 'Normal', label: 'Normal', hint: 'The default: dates, duration and effort follow from its calendar and its crews.' },
  { mode: 'FixedDuration', label: 'Fixed Duration', hint: 'The duration stays put; adding or removing crews changes the effort instead.' },
  { mode: 'FixedEffort', label: 'Fixed Effort', hint: 'The amount of work stays put: more crews finish it sooner, fewer take longer.' },
  { mode: 'FixedUnits', label: 'Fixed Units', hint: "Each crew's share of time stays put; the effort or the duration changes instead (see Effort driven)." },
];

export const isSchedulingMode = (value: unknown): value is SchedulingMode => SCHEDULING_MODE_CHOICES.some((choice) => choice.mode === value);

export type ProjectBorder = 'honor' | 'ignore' | 'conflict';

export const PROJECT_BORDER_CHOICES: readonly { value: ProjectBorder; label: string; hint: string }[] = [
  { value: 'honor', label: 'Honor', hint: 'It is never scheduled before the project start (after the project end when scheduling backward).' },
  { value: 'ignore', label: 'Ignore', hint: 'It may be scheduled before the project start.' },
  { value: 'conflict', label: 'Ask', hint: 'Moving it past the project border asks what to do (a scheduling conflict).' },
];

export const isProjectBorder = (value: unknown): value is ProjectBorder => value === 'honor' || value === 'ignore' || value === 'conflict';

/** Bryntum's named task colors (its `eventColor` palette), with the swatch shown for each. */
/** The colors a task can be given (Bryntum's named event colors). */
export { TASK_COLORS } from '../../gantt/look';

export interface CalendarChoice {
  id: string | number;
  name: string;
}

/** The project's calendars, by name. */
export function calendarChoices(project: ProjectModel): CalendarChoice[] {
  const store = (project as ProjectModel & { calendarManagerStore?: { allRecords?: CalendarModel[] } }).calendarManagerStore;
  return ((store?.allRecords ?? []) as CalendarModel[])
    .filter((calendar) => calendar.id !== undefined && calendar.id !== null)
    .map((calendar) => ({ id: calendar.id as string | number, name: (calendar as CalendarModel & { name?: string }).name || String(calendar.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type EffectiveDirection = { kind?: string; direction?: string; inheritedFrom?: unknown; enforcedBy?: unknown };

function directionSource(source: unknown): string {
  const owner = source as { isProjectModel?: boolean; isRoot?: boolean; name?: string } | null | undefined;
  if (!owner || owner.isProjectModel || owner.isRoot) return 'the project';
  return owner.name ? `“${owner.name}”` : 'its phase';
}

// -----------------------------------------------------------------------------------------
// The view
// -----------------------------------------------------------------------------------------

export interface CrewView {
  assignmentId: number | string;
  resourceId: number | string;
  name: string;
  company: string;
  equipment: boolean;
  color: string;
  icon: string;
  /** Share of the crew's time, in percent. */
  units: number;
  /** How many people it has on this task, if the plan says; `usualPeople` is what counts until it does. */
  people: number | null;
  usualPeople: number;
}

export interface SegmentView {
  /** Which part of the task, from the start: what an edit names it by. */
  index: number;
  name: string;
  start: Date;
  lastDay: Date;
  days: number;
}

export interface TaskView {
  id: number | string;
  name: string;
  /** Phase › work package, outermost first. */
  path: string[];
  /** The task's place in the outline (Bryntum `wbsCode`), e.g. `2.3.1`. */
  wbsCode: string;
  icon: string;
  isPhase: boolean;
  isMilestone: boolean;
  status: StatusKey;
  start: Date | null;
  lastDay: Date | null;
  /** Exclusive end (Bryntum `endDate`). */
  end: Date | null;
  /** Duration in the task's duration unit (days). */
  days: number;
  durationUnit: string;
  progress: number;
  /** Working days later than the plan (baseline); 0 when on plan. */
  slip: number;
  plannedLastDay: Date | null;
  /** Start, finish and duration can be edited: a task, or a manually scheduled phase. */
  canEditDates: boolean;
  /** Bryntum `manuallyScheduled`: links and constraint no longer move it. */
  isManual: boolean;
  /** Bryntum `inactive`: takes no part in scheduling. */
  isInactive: boolean;
  /** Bryntum `effort` with its unit (a phase: the sum of its tasks). */
  effort: { value: number; unit: TimeUnitName };
  schedulingMode: SchedulingMode;
  effortDriven: boolean;
  constraint: {
    type: ConstraintType | null;
    /** The stored constraint date. */
    date: Date | null;
    /** The day the panel shows for it (finish constraints: the last working day). */
    day: Date | null;
    /** What the engine did with it, when it is not simply met. */
    note: { tone: 'warn' | 'neutral'; text: string } | null;
  };
  direction: { value: 'Forward' | 'Backward'; kind: 'own' | 'inherited' | 'enforced'; source: string | null };
  calendar: {
    /** The task's own calendar, or null when it uses the project calendar. */
    ownId: string | number | null;
    /** The calendar the engine schedules it with. */
    effectiveName: string;
    projectName: string;
    /** Manually scheduled tasks count every day (the engine's 24/7 calendar). */
    countsEveryDay: boolean;
  };
  ignoreResourceCalendar: boolean;
  projectBorder: ProjectBorder;
  rollup: boolean;
  deadline: Date | null;
  /** Calendar days the finish lies past the deadline; 0 when on time or no deadline. */
  pastDeadline: number;
  /** Bryntum `eventColor`, or null. */
  color: string | null;
  segments: SegmentView[];
  waitsFor: LinkView[];
  leadsTo: LinkView[];
  crew: CrewView[];
  /** Crews working on the tasks inside a phase (read-only). */
  crewInside: CrewView[];
  money: TaskMoney;
  /** What the task costs and who is paid (from a library piece); empty when it has none. */
  costLines: TaskCostLine[];
  costCode: string;
  note: string;
  /** How many leaves are inside a phase and how many are done. */
  inside: { tasks: number; done: number } | null;
}

/** The live task for an id, or null when it is not (or no longer) in the plan. */
export function findTask(project: ProjectModel, taskId: number | string | null | undefined): TaskModel | null {
  if (taskId === null || taskId === undefined) return null;
  const found = project.taskStore.getById(taskId) as TaskModel | undefined;
  if (!found || found.isRoot) return null;
  return original(found);
}

function linkView(project: ProjectModel, dependency: DependencyModel, side: 'waits' | 'leads'): LinkView | null {
  const record = dependency as DependencyModel & { fromEvent?: TaskModel | null; toEvent?: TaskModel | null; active?: boolean; lag?: number; lagUnit?: string };
  const other = side === 'waits' ? record.fromEvent : record.toEvent;
  if (!other) return null;
  const type = isLinkType(record.type) ? record.type : 2;
  const lag = lagInDays(project, record as { lag?: number; lagUnit?: string });
  const lagValue = typeof record.lag === 'number' && Number.isFinite(record.lag) ? record.lag : 0;
  const lagUnit = normalUnit(record.lagUnit) ?? 'day';
  return {
    id: record.id as number | string,
    otherId: other.id as number | string,
    otherName: other.name ?? '',
    otherPath: taskPath(other),
    otherIsPhase: !other.isLeaf,
    otherIcon: other.isLeaf ? taskIcon(other) : 'layer-group',
    type,
    typeCode: LINK_TYPE_CHOICES.find((choice) => choice.type === type)!.code,
    kind: linkKindText(type, side),
    lag,
    lagText: lagUnit === 'day' ? lagText(lag) : lagValue === 0 ? 'no wait' : `${lagValue > 0 ? '+' : ''}${amountText(lagValue, lagUnit)} ${lagValue > 0 ? 'wait' : 'overlap'}`,
    lagValue,
    lagUnit,
    sentence: linkSentence(type, side, other.name ?? '', lagValue, lagUnit),
    active: record.active !== false,
  };
}

function crewView(assignment: AssignmentModel): CrewView | null {
  const resource = assignment.resource as (ResourceModel & { company?: string; kind?: string }) | null | undefined;
  if (!resource || typeof resource !== 'object') return null;
  return {
    assignmentId: assignment.id as number | string,
    resourceId: resource.id as number | string,
    name: resource.name ?? '',
    company: resource.company ?? '',
    equipment: resource.kind === 'equipment',
    color: crewColor(resource),
    icon: crewIcon(resource),
    units: typeof assignment.units === 'number' ? Math.round(assignment.units) : 100,
    people: (assignment as AssignmentModel & { headcount?: number | null }).headcount ?? null,
    usualPeople: usualCrewSize((resource as ResourceModel & { trade?: string }).trade),
  };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

type CalendarLike = { skipNonWorkingTime?(date: Date, forward: boolean): unknown };

/** The last working day before an exclusive end (Bryntum ends are the 00:00 after the last day). */
function lastDayBefore(task: TaskModel, end: Date, start?: Date): Date {
  const calendar = (task as TaskModel & { effectiveCalendar?: CalendarLike }).effectiveCalendar;
  const workEnd = calendar?.skipNonWorkingTime?.(end, false);
  const last = isDate(workEnd) && (!start || workEnd.getTime() > start.getTime()) ? workEnd : end;
  const day = new Date(last.getTime() - 1);
  day.setHours(0, 0, 0, 0);
  return start && day < start ? start : day;
}

function segmentViews(task: TaskModel, project: ProjectModel): SegmentView[] {
  const segments = ((task as TaskModel & { segments?: TaskModel[] | null }).segments ?? []) as TaskModel[];
  if (!Array.isArray(segments) || segments.length < 2) return [];
  const hoursPerDay = (project as ProjectModel & { hoursPerDay?: number }).hoursPerDay || 24;
  return segments.flatMap((segment, index) => {
      if (!isDate(segment.startDate)) return [];
      const start = segment.startDate;
      const end = isDate(segment.endDate) ? segment.endDate : start;
      const unit = segment.durationUnit ?? 'day';
      const raw = typeof segment.duration === 'number' ? segment.duration : 0;
      const days = unit.startsWith('h') ? raw / hoursPerDay : raw;
      // A part goes by the task's name unless it was given one of its own, and "Part 2" says more than that.
      const named = segment.name && segment.name !== task.name ? segment.name : `Part ${index + 1}`;
      return [{ index, name: named, start, lastDay: lastDayBefore(task, end, start), days: Math.round(days * 10) / 10 }];
    });
}

function crewInside(task: TaskModel): CrewView[] {
  const seen = new Map<string, CrewView>();
  for (const child of (task.allChildren ?? []) as TaskModel[]) {
    for (const assignment of (child.assignments ?? []) as AssignmentModel[]) {
      const view = crewView(assignment);
      if (view && !seen.has(String(view.resourceId))) seen.set(String(view.resourceId), view);
    }
  }
  return [...seen.values()].sort(byName);
}

const DAY_MS = 86_400_000;

type SchedulingRecord = TaskModel & {
  constraintType?: string | null;
  constraintDate?: Date | null;
  note?: string | null;
  costCode?: string;
  baselines?: { first?: { endDate?: Date } };
  wbsCode?: string | { toString(): string } | null;
  manuallyScheduled?: boolean;
  inactive?: boolean | null;
  effort?: number;
  effortUnit?: string;
  schedulingMode?: string;
  effortDriven?: boolean;
  effectiveDirection?: EffectiveDirection | null;
  calendar?: CalendarModel | string | number | null;
  effectiveCalendar?: CalendarModel | null;
  ignoreResourceCalendar?: boolean | null;
  projectConstraintResolution?: string;
  rollup?: boolean;
  deadlineDate?: Date | null;
  eventColor?: string | null;
};

/** Everything the panel shows about one task. */
export function taskView(project: ProjectModel, shown: TaskModel): TaskView {
  const task = original(shown);
  const record = task as SchedulingRecord;
  const isPhase = !task.isLeaf;
  const start = isDate(task.startDate) ? task.startDate : null;
  const end = isDate(task.endDate) ? task.endDate : null;
  const lastDay = start ? lastWorkingDay(task) : null;
  const manual = Boolean(record.manuallyScheduled);
  const inactive = Boolean(record.inactive);
  const constraintType = isConstraintType(record.constraintType) ? record.constraintType : null;
  const constraintDate = isDate(record.constraintDate) ? record.constraintDate : null;
  const planned = record.baselines?.first?.endDate;
  const leaves = isPhase ? ((task.allChildren ?? []) as TaskModel[]).filter((child) => child.isLeaf) : [];
  const direction = record.effectiveDirection ?? null;
  const directionKind = direction?.kind === 'own' || direction?.kind === 'enforced' ? direction.kind : 'inherited';
  const projectCalendar = (project as ProjectModel & { effectiveCalendar?: CalendarModel | null }).effectiveCalendar ?? null;
  const ownCalendar = record.calendar && typeof record.calendar === 'object' ? record.calendar : null;
  const calendarName = (calendar: CalendarModel | null | undefined) => (calendar ? (calendar as CalendarModel & { name?: string }).name || String(calendar.id) : '');
  const deadline = isDate(record.deadlineDate) ? record.deadlineDate : null;
  const effortUnit = normalUnit(record.effortUnit) ?? 'hour';
  const mode = isSchedulingMode(record.schedulingMode) ? record.schedulingMode : 'Normal';
  return {
    id: task.id as number | string,
    name: task.name ?? '',
    path: taskPath(task),
    wbsCode: record.wbsCode ? String(record.wbsCode) : '',
    icon: isPhase ? 'layer-group' : taskIcon(task),
    isPhase,
    isMilestone: Boolean(task.isMilestone),
    status: statusOf(task),
    start,
    lastDay: lastDay && isDate(lastDay) ? lastDay : null,
    end,
    days: typeof task.duration === 'number' ? Math.round(task.duration * 10) / 10 : 0,
    durationUnit: task.durationUnit ?? 'day',
    progress: Math.round(task.percentDone ?? 0),
    slip: slipDays(task),
    plannedLastDay: isDate(planned) ? lastDayBefore(task, planned) : null,
    canEditDates: !isPhase || manual,
    isManual: manual,
    isInactive: inactive,
    effort: { value: typeof record.effort === 'number' && Number.isFinite(record.effort) ? Math.round(record.effort * 100) / 100 : 0, unit: effortUnit },
    schedulingMode: mode,
    effortDriven: Boolean(record.effortDriven),
    constraint: {
      type: constraintType,
      date: constraintChoice(constraintType)?.side ? constraintDate : null,
      day: constraintChoice(constraintType)?.side ? constraintDay(constraintType, constraintDate) : null,
      note: constraintNote(task, constraintType, constraintDate, manual, inactive),
    },
    direction: {
      value: direction?.direction === 'Backward' ? 'Backward' : 'Forward',
      kind: directionKind,
      source: directionKind === 'inherited' ? directionSource(direction?.inheritedFrom) : directionKind === 'enforced' ? directionSource(direction?.enforcedBy) : null,
    },
    calendar: {
      ownId: ownCalendar ? (ownCalendar.id as string | number) : null,
      effectiveName: calendarName(ownCalendar ?? projectCalendar),
      projectName: calendarName(projectCalendar),
      countsEveryDay: manual,
    },
    ignoreResourceCalendar: Boolean(record.ignoreResourceCalendar),
    projectBorder: isProjectBorder(record.projectConstraintResolution) ? record.projectConstraintResolution : 'honor',
    rollup: Boolean(record.rollup),
    deadline,
    pastDeadline: deadline && end ? Math.max(0, Math.ceil((end.getTime() - dayAfter(deadline).getTime()) / DAY_MS)) : 0,
    color: typeof record.eventColor === 'string' && record.eventColor ? record.eventColor : null,
    segments: segmentViews(task, project),
    waitsFor: ((task.predecessors ?? []) as DependencyModel[])
      .map((dependency) => linkView(project, dependency, 'waits'))
      .filter((link): link is LinkView => link !== null),
    leadsTo: ((task.successors ?? []) as DependencyModel[])
      .map((dependency) => linkView(project, dependency, 'leads'))
      .filter((link): link is LinkView => link !== null),
    crew: ((task.assignments ?? []) as AssignmentModel[]).map(crewView).filter((crew): crew is CrewView => crew !== null),
    crewInside: isPhase ? crewInside(task) : [],
    money: rolledUpMoney(task),
    costLines: costLinesOf((task as { costLines?: unknown }).costLines),
    costCode: typeof record.costCode === 'string' ? record.costCode : '',
    note: typeof record.note === 'string' ? record.note : '',
    inside: isPhase ? { tasks: leaves.length, done: leaves.filter((leaf) => statusOf(leaf) === 'done').length } : null,
  };
}

// -----------------------------------------------------------------------------------------
// Pickers
// -----------------------------------------------------------------------------------------

export interface TaskOption {
  id: number | string;
  name: string;
  /** Phase › work package. */
  path: string;
  isPhase: boolean;
  icon: string;
}

/** Every task in plan order (the order of the tree). */
function tasksInOrder(project: ProjectModel): TaskModel[] {
  const tasks: TaskModel[] = [];
  const root = project.taskStore.rootNode as unknown as TaskModel;
  root.traverse((node) => {
    if (!(node as TaskModel).isRoot) tasks.push(node as TaskModel);
  });
  return tasks;
}

/**
 * Tasks that can be linked to `shown` on the given side: not the task itself, not a phase it sits
 * in or a task inside it (the engine refuses those links), and not already linked that way.
 * Loops (A waits for B waits for A) are checked by the engine when the link is added.
 */
export function linkCandidates(project: ProjectModel, shown: TaskModel, side: 'waits' | 'leads'): TaskOption[] {
  const task = original(shown);
  const excluded = new Set<unknown>([task]);
  let parent = task.parent as TaskModel | null | undefined;
  while (parent && !parent.isRoot) {
    excluded.add(parent);
    parent = parent.parent as TaskModel | null | undefined;
  }
  for (const child of (task.allChildren ?? []) as TaskModel[]) excluded.add(child);
  const linked = side === 'waits' ? ((task.predecessors ?? []) as DependencyModel[]).map((d) => d.fromEvent) : ((task.successors ?? []) as DependencyModel[]).map((d) => d.toEvent);
  linked.forEach((other) => excluded.add(other));
  return tasksInOrder(project)
    .filter((candidate) => !excluded.has(candidate) && typeof candidate.id === 'number')
    .map((candidate) => ({
      id: candidate.id as number,
      name: candidate.name ?? '',
      path: taskPath(candidate).join(' › '),
      isPhase: !candidate.isLeaf,
      icon: candidate.isLeaf ? taskIcon(candidate) : 'layer-group',
    }));
}

export interface CrewOption {
  id: number | string;
  name: string;
  company: string;
  equipment: boolean;
  color: string;
  icon: string;
}

/** Crews and equipment not yet on the task, labor first, by name. */
export function crewCandidates(project: ProjectModel, shown: TaskModel): CrewOption[] {
  const task = original(shown);
  const assigned = new Set(((task.assignments ?? []) as AssignmentModel[]).map((assignment) => (assignment.resource as ResourceModel | null)?.id));
  return ((project.resourceStore.allRecords ?? []) as (ResourceModel & { company?: string; kind?: string })[])
    .filter((resource) => !assigned.has(resource.id) && typeof resource.id === 'number')
    .map((resource) => ({
      id: resource.id as number,
      name: resource.name ?? '',
      company: resource.company ?? '',
      equipment: resource.kind === 'equipment',
      color: crewColor(resource),
      icon: crewIcon(resource),
    }))
    .sort((a, b) => Number(a.equipment) - Number(b.equipment) || a.name.localeCompare(b.name));
}

/** A task's cost lines, leaving out anything malformed. */
function costLinesOf(value: unknown): TaskCostLine[] {
  return Array.isArray(value) ? value.filter((line): line is TaskCostLine => TaskCostLine.safeParse(line).success) : [];
}

/**
 * Every edit the task panel makes. Each one is ONE short transaction inside the project queue
 * (`runProjectTransaction`): one field committed = one revision for the other person, never a
 * half-applied edit and never a queue held open while the panel stays open. An edit that changes
 * nothing sends nothing.
 *
 * Records are looked up again inside the queued step, so an edit queued behind an incoming change
 * acts on the plan as it is then: a task, link or crew the other person removed in the meantime is
 * reported (`EditError`) instead of written to a detached record.
 *
 * Writes are plain field assignments (or the model's own setters), which the engine turns into a
 * recalculation when the transaction commits. When the engine cannot schedule the result (a
 * scheduling conflict, e.g. a must-start-on date before a predecessor finishes) the Gantt asks
 * what to do; canceled there (or with no Gantt to ask, headless) the engine rolls the change back
 * and the edit is reported in plain words instead.
 */
import type { AssignmentModel, CalendarModel, DependencyModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { firstLockedWithin, lockMessage } from '../../gantt/payment-lock';
import { runProjectTransaction } from '../../scenario/publish';
import {
  applyMoneyChange,
  isEmptyScheduleChange,
  scheduleChanges,
  scheduleDraftFor,
  writeScheduleChange,
  type MoneyChange,
  type ScheduleChange,
} from '../../gantt/cell-editors';
import {
  LAG_UNITS,
  TASK_COLORS,
  constraintChoice,
  findTask,
  isConstraintType,
  isProjectBorder,
  isSchedulingMode,
  normalUnit,
  type ConstraintType,
  type LinkType,
  type ProjectBorder,
  type SchedulingMode,
  type TimeUnitName,
} from './model';

/** A plain-words reason an edit could not be made; nothing was changed. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

const GONE = 'This task is no longer in the plan; someone may have removed it.';
const LINK_GONE = 'This link is no longer in the plan; someone may have removed it.';
const CONFLICT =
  'The scheduler could not fit that into the plan: it conflicts with a link, a constraint or the project border. Nothing was changed.';

const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());
const validDate = (value: unknown): Date | null => (isDate(value) ? value : null);
const modeOf = (value: unknown): SchedulingMode => (isSchedulingMode(value) ? value : 'Normal');
const borderOf = (value: unknown): ProjectBorder => (isProjectBorder(value) ? value : 'honor');
const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (isDate(a) && isDate(b) ? a.getTime() === b.getTime() : !isDate(a) && !isDate(b));

/** The scheduling fields of a task (engine fields the typings declare loosely or not at all). */
interface SchedulingFields {
  constraintType: ConstraintType | null;
  constraintDate: Date | null;
  manuallyScheduled: boolean;
  inactive: boolean | null;
  schedulingMode: SchedulingMode;
  effortDriven: boolean;
  effort: number;
  effortUnit: string;
  calendar: CalendarModel | string | number | null;
  ignoreResourceCalendar: boolean | null;
  projectConstraintResolution: ProjectBorder;
  rollup: boolean;
  deadlineDate: Date | null;
  eventColor: string | null;
  note?: string | null;
}

/** The task's scheduling fields, read and written as plain engine fields. */
const fields = (task: TaskModel): SchedulingFields => task as unknown as SchedulingFields;

function liveTask(project: ProjectModel, taskId: number | string): TaskModel {
  const task = findTask(project, taskId);
  if (!task) throw new EditError(GONE);
  return task;
}

/**
 * One transaction that reports a change the engine rolled back (a scheduling conflict nobody
 * resolved) as an `EditError`. The listener is attached inside the queued step, so only this
 * transaction's commit is watched.
 */
function transact(project: ProjectModel, title: string, write: () => unknown): Promise<void> {
  let rejected = false;
  let detach: (() => void) | undefined;
  return runProjectTransaction(project, title, () => {
    detach = project.on('commitRejected', () => {
      rejected = true;
    }) as unknown as () => void;
    return write();
  }).then(
    () => {
      detach?.();
      if (rejected) throw new EditError(CONFLICT);
    },
    (error: unknown) => {
      detach?.();
      throw rejected && !(error instanceof EditError) ? new EditError(CONFLICT) : error;
    },
  );
}

/** Runs `write` on the live task as one transaction. */
function editTask(project: ProjectModel, taskId: number | string, title: string, write: (task: TaskModel) => unknown): Promise<void> {
  if (!findTask(project, taskId)) return Promise.reject(new EditError(GONE));
  return transact(project, title, () => write(liveTask(project, taskId)));
}

interface FieldEdit<T> {
  title: string;
  read(task: TaskModel): T;
  write(task: TaskModel, value: T): unknown;
  /** Why this task cannot take the edit (a phase, say), or null. */
  refuse?(task: TaskModel): string | null;
  same?(current: T, next: T): boolean;
}

/** One field of one task: refused, a no-op when unchanged, or one transaction. */
function editField<T>(project: ProjectModel, taskId: number | string, value: T, edit: FieldEdit<T>): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  const refusal = edit.refuse?.(task);
  if (refusal) return Promise.reject(new EditError(refusal));
  if ((edit.same ?? Object.is)(edit.read(task), value)) return Promise.resolve();
  return editTask(project, taskId, edit.title, (live) => {
    // Checked again on the plan as it is when the step runs.
    const late = edit.refuse?.(live);
    if (late) throw new EditError(late);
    return edit.write(live, value);
  });
}

const onlyTasks = (message: string) => (task: TaskModel) => (task.isLeaf ? null : message);

// -----------------------------------------------------------------------------------------
// Name, notes, color, money
// -----------------------------------------------------------------------------------------

export function renameTask(project: ProjectModel, taskId: number | string, name: string): Promise<void> {
  const value = name.trim();
  if (!value) return Promise.reject(new EditError('A task needs a name.'));
  return editField(project, taskId, value, {
    title: 'Rename task',
    read: (task) => task.name,
    write: (task, next) => {
      task.name = next;
    },
  });
}

export function setTaskNote(project: ProjectModel, taskId: number | string, note: string): Promise<void> {
  return editField(project, taskId, note, {
    title: 'Edit notes',
    read: (task) => fields(task).note ?? '',
    write: (task, next) => {
      fields(task).note = next;
    },
  });
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The task color (Bryntum `eventColor`): one of its named colors, a hex color, or none (`null`). */
export function setTaskColor(project: ProjectModel, taskId: number | string, color: string | null): Promise<void> {
  const value = color?.trim() || null;
  if (value !== null && !HEX_COLOR.test(value) && !TASK_COLORS.some((entry) => entry.name === value)) {
    return Promise.reject(new EditError('Pick one of the colors shown, or none.'));
  }
  return editField(project, taskId, value, {
    title: 'Edit color',
    read: (task) => fields(task).eventColor || null,
    write: (task, next) => {
      fields(task).eventColor = next;
    },
  });
}

/** Budget and expected cost of a task (not a phase: a phase adds up the tasks inside it). */
export function setTaskMoney(project: ProjectModel, taskId: number | string, change: MoneyChange): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  if (!task.isLeaf) return Promise.reject(new EditError("A phase's money adds up the tasks inside it; change those instead."));
  const record = task as TaskModel & MoneyChange;
  const effective: MoneyChange = {};
  if (change.budgetMinor !== undefined && change.budgetMinor !== record.budgetMinor) effective.budgetMinor = change.budgetMinor;
  if (change.forecastMinor !== undefined && change.forecastMinor !== record.forecastMinor) effective.forecastMinor = change.forecastMinor;
  return applyMoneyChange(project, task, effective);
}

// -----------------------------------------------------------------------------------------
// Dates, duration, effort, progress
// -----------------------------------------------------------------------------------------

export type ScheduleField = 'start' | 'lastDay' | 'days';

const PHASE_DATES = "A phase's dates follow the tasks inside it while it is scheduled automatically; make it manually scheduled to set them.";
const PHASE_ROLLUP = "A phase's progress adds up the tasks inside it; change those instead.";

/** What changing one schedule field does to the task, start/finish/days kept in step like the popup does. */
function scheduleFieldChange(project: ProjectModel, task: TaskModel, field: ScheduleField, value: Date | number): ScheduleChange {
  const opened = scheduleDraftFor(project, task);
  const draft = scheduleDraftFor(project, task);
  if (field === 'start' && isDate(value)) draft.setStart(value);
  else if (field === 'lastDay' && isDate(value)) draft.setLastDay(value);
  else if (field === 'days' && typeof value === 'number' && Number.isFinite(value)) draft.setDays(value);
  return scheduleChanges(opened, draft);
}

const datesLocked = (task: TaskModel) => (task.isLeaf || fields(task).manuallyScheduled ? null : PHASE_DATES);

/**
 * Moves the start (keeping the duration), the finish (the last working day: changes the duration)
 * or the duration (moves the finish). A task, or a manually scheduled phase.
 */
export function setScheduleField(project: ProjectModel, taskId: number | string, field: ScheduleField, value: Date | number): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  const locked = datesLocked(task);
  if (locked) return Promise.reject(new EditError(locked));
  if (field === 'days' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return Promise.reject(new EditError('Enter a duration of 0 days or more.'));
  if (isEmptyScheduleChange(scheduleFieldChange(project, task, field, value))) return Promise.resolve();
  return editTask(project, taskId, 'Edit schedule', (live) => {
    const late = datesLocked(live);
    if (late) throw new EditError(late);
    // Recomputed on the plan as it is when the step runs.
    writeScheduleChange(project, live, scheduleFieldChange(project, live, field, value));
  });
}

/** % complete, a whole number from 0 to 100 (a phase's is rolled up from its tasks). */
export function setProgress(project: ProjectModel, taskId: number | string, percent: number): Promise<void> {
  if (!Number.isFinite(percent)) return Promise.reject(new EditError('Enter a percentage from 0 to 100.'));
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return editField(project, taskId, value, {
    title: 'Edit progress',
    refuse: onlyTasks(PHASE_ROLLUP),
    read: (task) => Math.round(task.percentDone ?? 0),
    write: (task, next) => {
      task.percentDone = next;
    },
  });
}

/** A milestone is a date with no length; turning it back gives it one working day. */
export function setMilestone(project: ProjectModel, taskId: number | string, milestone: boolean): Promise<void> {
  return editField(project, taskId, milestone, {
    title: milestone ? 'Make milestone' : 'Make task',
    refuse: onlyTasks('A phase cannot be a milestone.'),
    read: (task) => Boolean(task.isMilestone),
    write: (task, next) => {
      void task.setDuration(next ? 0 : 1, task.durationUnit ?? 'day');
    },
  });
}

/** The deadline (Bryntum `deadlineDate`): a day the task should finish by; it does not move the task. `null` removes it. */
export function setDeadline(project: ProjectModel, taskId: number | string, day: Date | null): Promise<void> {
  if (day !== null && !isDate(day)) return Promise.reject(new EditError('Pick a deadline date, or clear it.'));
  const value = day ? new Date(day.getFullYear(), day.getMonth(), day.getDate()) : null;
  return editField<Date | null>(project, taskId, value, {
    title: value ? 'Set deadline' : 'Remove deadline',
    read: (task) => validDate(fields(task).deadlineDate),
    same: sameTime,
    write: (task, next) => {
      fields(task).deadlineDate = next;
    },
  });
}

// -----------------------------------------------------------------------------------------
// Scheduling (Bryntum's Advanced tab)
// -----------------------------------------------------------------------------------------

/**
 * Manually scheduled: links and the constraint no longer move the task (or a phase: it no longer
 * follows the tasks inside it). Turning it off lets the scheduler place it again.
 */
export function setManuallyScheduled(project: ProjectModel, taskId: number | string, manual: boolean): Promise<void> {
  return editField(project, taskId, manual, {
    title: manual ? 'Schedule manually' : 'Schedule automatically',
    read: (task) => Boolean(fields(task).manuallyScheduled),
    write: (task, next) => {
      fields(task).manuallyScheduled = next;
    },
  });
}

/** Inactive: the task takes no part in scheduling (its links stop pushing, its work and cost stop counting). */
export function setInactive(project: ProjectModel, taskId: number | string, inactive: boolean): Promise<void> {
  return editField(project, taskId, inactive, {
    title: inactive ? 'Make inactive' : 'Make active',
    read: (task) => Boolean(fields(task).inactive),
    write: (task, next) => {
      fields(task).inactive = next;
    },
  });
}

const PHASE_MODE = 'Scheduling mode, effort driven and resource calendars apply to tasks; a phase follows the tasks inside it.';

export function setSchedulingMode(project: ProjectModel, taskId: number | string, mode: SchedulingMode): Promise<void> {
  if (!isSchedulingMode(mode)) return Promise.reject(new EditError('Pick Normal, Fixed Duration, Fixed Effort or Fixed Units.'));
  return editField(project, taskId, mode, {
    title: 'Edit scheduling mode',
    refuse: onlyTasks(PHASE_MODE),
    read: (task) => modeOf(fields(task).schedulingMode),
    write: (task, next) => {
      fields(task).schedulingMode = next;
    },
  });
}

export function setEffortDriven(project: ProjectModel, taskId: number | string, effortDriven: boolean): Promise<void> {
  return editField(project, taskId, effortDriven, {
    title: 'Edit effort driven',
    refuse: onlyTasks(PHASE_MODE),
    read: (task) => Boolean(fields(task).effortDriven),
    write: (task, next) => {
      fields(task).effortDriven = next;
    },
  });
}

export function setIgnoreResourceCalendar(project: ProjectModel, taskId: number | string, ignore: boolean): Promise<void> {
  return editField(project, taskId, ignore, {
    title: 'Edit resource calendars',
    refuse: onlyTasks(PHASE_MODE),
    read: (task) => Boolean(fields(task).ignoreResourceCalendar),
    write: (task, next) => {
      fields(task).ignoreResourceCalendar = next;
    },
  });
}

/** Show the task on its phase's bar (Bryntum `rollup`, drawn by the Gantt's rollups). */
export function setRollup(project: ProjectModel, taskId: number | string, rollup: boolean): Promise<void> {
  return editField(project, taskId, rollup, {
    title: 'Edit rollup',
    read: (task) => Boolean(fields(task).rollup),
    write: (task, next) => {
      fields(task).rollup = next;
    },
  });
}

/** How the task treats the project border (Bryntum `projectConstraintResolution`). */
export function setProjectBorder(project: ProjectModel, taskId: number | string, border: ProjectBorder): Promise<void> {
  if (!isProjectBorder(border)) return Promise.reject(new EditError('Pick Honor, Ignore or Ask.'));
  return editField(project, taskId, border, {
    title: 'Edit project border',
    read: (task) => borderOf(fields(task).projectConstraintResolution),
    write: (task, next) => {
      fields(task).projectConstraintResolution = next;
    },
  });
}

function calendarRecord(project: ProjectModel, calendarId: string | number): CalendarModel | null {
  const store = (project as ProjectModel & { calendarManagerStore?: { getById(id: string | number): CalendarModel | undefined } }).calendarManagerStore;
  return (store?.getById(calendarId) as CalendarModel | undefined) ?? null;
}

const ownCalendarId = (task: TaskModel): string | number | null => {
  const calendar = fields(task).calendar;
  if (calendar && typeof calendar === 'object') return calendar.id as string | number;
  return calendar ?? null;
};

/** The task's calendar, or `null` for the project calendar. */
export function setCalendar(project: ProjectModel, taskId: number | string, calendarId: string | number | null): Promise<void> {
  if (calendarId !== null && !calendarRecord(project, calendarId)) return Promise.reject(new EditError('That calendar is no longer in the project.'));
  return editField(project, taskId, calendarId, {
    title: 'Edit calendar',
    read: ownCalendarId,
    write: (task, next) => {
      const calendar = next === null ? null : calendarRecord(project, next);
      if (next !== null && !calendar) throw new EditError('That calendar is no longer in the project.');
      fields(task).calendar = calendar;
    },
  });
}

const PHASE_CONSTRAINTS = 'A phase can only be None, As soon as possible, As late as possible, Start no earlier than or Finish no later than.';

/**
 * The constraint (Bryntum `constraintType` and `constraintDate`). The date-bearing types need a
 * date: a start constraint holds the start (00:00 of its day), a finish constraint the exclusive
 * end (`constraintDateFor` converts a picked last day). None, as soon as possible and as late as
 * possible carry no date (the last two set the scheduling direction).
 */
export function setConstraint(project: ProjectModel, taskId: number | string, type: ConstraintType | null, date?: Date | null): Promise<void> {
  if (type !== null && !isConstraintType(type)) return Promise.reject(new EditError('Pick a constraint type from the list.'));
  const choice = constraintChoice(type)!;
  if (choice.side && !isDate(date)) return Promise.reject(new EditError(`${choice.label} needs a constraint date.`));
  const value = { type, date: choice.side ? (date as Date) : null };
  return editField(project, taskId, value, {
    title: type ? `Set constraint: ${choice.label.toLowerCase()}` : 'Remove constraint',
    refuse: (task) => (!task.isLeaf && choice.leafOnly ? PHASE_CONSTRAINTS : null),
    read: (task) => {
      const { constraintType, constraintDate } = fields(task);
      return { type: isConstraintType(constraintType) ? constraintType : null, date: validDate(constraintDate) };
    },
    same: (current, next) => current.type === next.type && (!choice.side || sameTime(current.date, next.date)),
    write: (task, next) => {
      // The date first: a type written without one makes the engine fill in a date of its own.
      fields(task).constraintDate = next.date;
      fields(task).constraintType = next.type;
    },
  });
}

// -----------------------------------------------------------------------------------------
// Links
// -----------------------------------------------------------------------------------------

type LinkRecord = DependencyModel & { lag?: number; lagUnit?: string; active?: boolean; fromEvent?: TaskModel; toEvent?: TaskModel };

function liveDependency(project: ProjectModel, dependencyId: number | string): LinkRecord {
  const dependency = project.dependencyStore.getById(dependencyId) as LinkRecord | undefined;
  if (!dependency) throw new EditError(LINK_GONE);
  return dependency;
}

/** The lag (positive: a wait; negative: a lead, they overlap) with its unit, in the successor's working time. */
export function setLinkLag(project: ProjectModel, dependencyId: number | string, lag: number, unit: string = 'day'): Promise<void> {
  if (!Number.isFinite(lag)) return Promise.reject(new EditError('Enter a lag, e.g. 2 days or -1 day.'));
  const lagUnit = normalUnit(unit) as TimeUnitName | null;
  if (!lagUnit || !LAG_UNITS.includes(lagUnit)) return Promise.reject(new EditError('Lag is in hours, days, weeks or months.'));
  const value = Math.round(lag * 100) / 100;
  const dependency = project.dependencyStore.getById(dependencyId) as LinkRecord | undefined;
  if (!dependency) return Promise.reject(new EditError(LINK_GONE));
  if (dependency.lag === value && normalUnit(dependency.lagUnit ?? 'day') === lagUnit) return Promise.resolve();
  return transact(project, 'Edit link lag', () => {
    liveDependency(project, dependencyId).set({ lag: value, lagUnit });
  });
}

/** An inactive link stays in the plan but no longer moves its successor. */
export function setLinkActive(project: ProjectModel, dependencyId: number | string, active: boolean): Promise<void> {
  const dependency = project.dependencyStore.getById(dependencyId) as LinkRecord | undefined;
  if (!dependency) return Promise.reject(new EditError(LINK_GONE));
  if ((dependency.active !== false) === active) return Promise.resolve();
  return transact(project, active ? 'Activate link' : 'Deactivate link', () => {
    liveDependency(project, dependencyId).set({ active });
  });
}

const LOOP = 'That link would make a loop: one of these tasks already waits for the other.';

type Validating = ProjectModel & { isValidDependency(from: unknown, to: unknown, type: number, ignore?: unknown): Promise<boolean> };

/** Changes the dependency type: finish-to-start, start-to-start, finish-to-finish or start-to-finish. */
export async function setLinkKind(project: ProjectModel, dependencyId: number | string, type: LinkType): Promise<void> {
  if (type !== 0 && type !== 1 && type !== 2 && type !== 3) throw new EditError('Pick a dependency type from the list.');
  const dependency = project.dependencyStore.getById(dependencyId) as LinkRecord | undefined;
  if (!dependency) throw new EditError(LINK_GONE);
  if (dependency.type === type) return;
  const valid = await (project as Validating).isValidDependency(dependency.fromEvent, dependency.toEvent, type, dependency);
  if (!valid) throw new EditError(LOOP);
  await transact(project, 'Edit link type', () => {
    liveDependency(project, dependencyId).set({ type });
  });
}

export interface NewLink {
  /** The task that goes first. */
  fromId: number | string;
  /** The task that waits. */
  toId: number | string;
  type: LinkType;
  /** Working days; negative overlaps. */
  lag?: number;
}

/** Adds a link after checking with the engine that it makes no loop. */
export async function addLink(project: ProjectModel, link: NewLink): Promise<void> {
  const from = findTask(project, link.fromId);
  const to = findTask(project, link.toId);
  if (!from || !to) throw new EditError(GONE);
  if (from === to) throw new EditError('A task cannot wait for itself.');
  const exists = ((to.predecessors ?? []) as DependencyModel[]).some((dependency) => (dependency.fromEvent as unknown) === from);
  if (exists) throw new EditError(`${to.name} already waits for ${from.name}.`);
  const valid = await (project as Validating).isValidDependency(from, to, link.type);
  if (!valid) throw new EditError(LOOP);
  await transact(project, 'Add link', () => {
    const fromEvent = liveTask(project, link.fromId);
    const toEvent = liveTask(project, link.toId);
    project.dependencyStore.add({ fromEvent: fromEvent.id, toEvent: toEvent.id, type: link.type, lag: link.lag ?? 0, lagUnit: 'day' } as never);
  });
}

export function removeLink(project: ProjectModel, dependencyId: number | string): Promise<void> {
  if (!project.dependencyStore.getById(dependencyId)) return Promise.resolve();
  return transact(project, 'Remove link', () => {
    const dependency = project.dependencyStore.getById(dependencyId);
    if (dependency) project.dependencyStore.remove(dependency as never);
  });
}

// -----------------------------------------------------------------------------------------
// Crew
// -----------------------------------------------------------------------------------------

/** Puts a crew (or a piece of equipment) on a task, full time unless `units` says otherwise. */
export function assignCrew(project: ProjectModel, taskId: number | string, resourceId: number | string, units = 100): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  if (!task.isLeaf) return Promise.reject(new EditError('Crews work on the tasks inside a phase; add them there.'));
  if (!project.resourceStore.getById(resourceId)) return Promise.reject(new EditError('That crew is no longer on the project.'));
  const assigned = ((task.assignments ?? []) as AssignmentModel[]).some((assignment) => (assignment.resource as ResourceModel | null)?.id === resourceId);
  if (assigned) return Promise.resolve();
  return editTask(project, taskId, 'Add crew', (live) => {
    if (!project.resourceStore.getById(resourceId)) throw new EditError('That crew is no longer on the project.');
    const already = ((live.assignments ?? []) as AssignmentModel[]).some((assignment) => (assignment.resource as ResourceModel | null)?.id === resourceId);
    if (!already) project.assignmentStore.add({ event: live.id, resource: resourceId, units } as never);
  });
}

/** How many people this crew has on this task; nothing, or less than one, goes back to the usual size. */
export function setCrewSize(project: ProjectModel, assignmentId: number | string, people: number | null): Promise<void> {
  const size = people !== null && Number.isFinite(people) && people >= 1 ? Math.min(999, Math.round(people)) : null;
  return transact(project, 'Change crew size', () => {
    const assignment = project.assignmentStore.getById(assignmentId) as (AssignmentModel & { headcount?: number | null }) | undefined;
    if (assignment && assignment.headcount !== size) assignment.headcount = size;
  });
}

// -----------------------------------------------------------------------------------------
// Effort
// -----------------------------------------------------------------------------------------

/** The work in a task, with its unit. It matters to how the task is scheduled once it is effort driven. */
export function setEffort(project: ProjectModel, taskId: number | string, effort: number, unit: string): Promise<void> {
  if (!Number.isFinite(effort) || effort < 0) return Promise.reject(new EditError('Effort cannot be negative.'));
  return editField(project, taskId, { effort, unit }, {
    title: 'Change effort',
    read: (task) => ({ effort: fields(task).effort, unit: fields(task).effortUnit }),
    write: (task, next) => (task as unknown as { setEffort(effort: number, unit: string): Promise<void> }).setEffort(next.effort, next.unit),
    refuse: onlyTasks('A phase adds up the effort of the tasks inside it.'),
    same: (current, next) => current.effort === next.effort && current.unit === next.unit,
  });
}

// -----------------------------------------------------------------------------------------
// The parts of a split task
// -----------------------------------------------------------------------------------------

/** A part of a split task, as the engine has it. */
interface TaskPart {
  setStartDate(date: Date, keepDuration?: boolean): Promise<void>;
  setDuration(duration: number): Promise<void>;
}

interface Splittable {
  segments?: TaskPart[] | null;
  splitToSegments(from: Date, lag?: number, lagUnit?: string): Promise<void>;
  mergeSegments(first?: TaskPart, second?: TaskPart): Promise<void>;
}

const NO_PART = 'That part of the task is no longer there.';
const partsOf = (task: TaskModel): TaskPart[] => (task as unknown as Splittable).segments ?? [];

function editPart(project: ProjectModel, taskId: number | string, index: number, title: string, write: (part: TaskPart, task: TaskModel) => unknown): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  if (!partsOf(task)[index]) return Promise.reject(new EditError(NO_PART));
  return editTask(project, taskId, title, (live) => {
    const part = partsOf(live)[index];
    if (!part) throw new EditError(NO_PART);
    return write(part, live);
  });
}

/** Cuts a task in two at this day, with a gap of this many days before the second part. */
export function splitTask(project: ProjectModel, taskId: number | string, from: Date, gapDays: number): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  if (!task.isLeaf || task.isMilestone) return Promise.reject(new EditError('Only a task with days of its own can be split.'));
  if (!isDate(task.startDate) || !isDate(task.endDate) || from <= task.startDate || from >= task.endDate) return Promise.reject(new EditError('Split on a day inside the task.'));
  return editTask(project, taskId, 'Split task', (live) => (live as unknown as Splittable).splitToSegments(from, Math.max(0, gapDays), 'day'));
}

export function moveSegment(project: ProjectModel, taskId: number | string, index: number, start: Date): Promise<void> {
  return editPart(project, taskId, index, 'Move part of a task', (part) => part.setStartDate(start, true));
}

export function resizeSegment(project: ProjectModel, taskId: number | string, index: number, days: number): Promise<void> {
  if (!Number.isFinite(days) || days <= 0) return Promise.reject(new EditError('A part takes at least some of a day.'));
  return editPart(project, taskId, index, 'Change part of a task', (part) => part.setDuration(days));
}

/** Joins a part with the one after it; when those were the only two, the task is whole again. */
export function joinSegments(project: ProjectModel, taskId: number | string, index: number): Promise<void> {
  const task = findTask(project, taskId);
  if (task && !partsOf(task)[index + 1]) return Promise.reject(new EditError(NO_PART));
  return editPart(project, taskId, index, 'Join parts of a task', (part, live) => {
    const next = partsOf(live)[index + 1];
    if (!next) throw new EditError(NO_PART);
    return (live as unknown as Splittable).mergeSegments(part, next);
  });
}

// -----------------------------------------------------------------------------------------
// Where a task sits in the plan
// -----------------------------------------------------------------------------------------

interface TreeNode {
  parent: TreeNode;
  firstChild: TaskModel | null;
  previousSibling: TaskModel | null;
  nextSibling: TaskModel | null;
  tryInsertChild(child: unknown, before?: unknown): Promise<boolean>;
  nextOrderedSibling: TaskModel | null;
  insertChild(child: unknown, before?: unknown, silent?: boolean, options?: { orderedBeforeNode?: unknown }): TaskModel | TaskModel[];
}

const tree = (task: TaskModel): TreeNode => task as unknown as TreeNode;
const firstOf = <T>(added: T | T[]): T => (Array.isArray(added) ? (added[0] as T) : added);
const newTask = (project: ProjectModel, start: Date | null | undefined) => (project.taskStore as unknown as { createRecord(data: object): unknown }).createRecord({ name: 'New task', startDate: start ?? undefined, duration: 1, durationUnit: 'day' });

async function addTask(project: ProjectModel, taskId: number | string, title: string, place: (reference: TaskModel) => TaskModel | TaskModel[]): Promise<TaskModel> {
  if (!findTask(project, taskId)) throw new EditError(GONE);
  let added: TaskModel | null = null;
  await transact(project, title, () => {
    added = firstOf(place(liveTask(project, taskId)));
  });
  if (!added) throw new EditError(CONFLICT);
  return added;
}

/** A new task right below this one, on the same day. */
export function addTaskBelow(project: ProjectModel, taskId: number | string): Promise<TaskModel> {
  return addTask(project, taskId, 'Add task', (reference) => {
    const node = tree(reference);
    return node.parent.insertChild(newTask(project, reference.startDate as Date | null), node.nextSibling, false, { orderedBeforeNode: node.nextOrderedSibling });
  });
}

/** A new first task inside this one, which makes it a phase. */
export function addSubtask(project: ProjectModel, taskId: number | string): Promise<TaskModel> {
  return addTask(project, taskId, 'Add subtask', (reference) => tree(reference).insertChild(newTask(project, reference.startDate as Date | null), tree(reference).firstChild));
}

function restructure(project: ProjectModel, taskId: number | string, how: 'indent' | 'outdent'): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  const locked = firstLockedWithin([task]);
  if (locked) return Promise.reject(new EditError(lockMessage(locked)));
  const refused = how === 'indent' ? "It can't go inside the task above: there is none, or the two are linked." : "It can't move out: it is already at the top of the plan.";
  // The store runs its own transaction, as it does for the chart's menu. What it can't do it just doesn't do.
  const store = project.taskStore as unknown as Record<typeof how, (records: TaskModel[]) => Promise<unknown>>;
  return (project as unknown as { queue(step: () => unknown): Promise<unknown> })
    .queue(async () => {
      const live = liveTask(project, taskId);
      const parent = live.parent;
      await store[how]([live]);
      if (live.parent === parent) throw new EditError(refused);
    })
    .then(() => undefined);
}

/** Dragging a row up or down among its neighbors: a move on the plan, which is its own transaction as it is for the drag. */
function moveAmongNeighbors(project: ProjectModel, taskId: number | string, direction: 'up' | 'down'): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  const locked = firstLockedWithin([task]);
  if (locked) return Promise.reject(new EditError(lockMessage(locked)));
  const node = tree(task);
  const neighbor = direction === 'up' ? node.previousSibling : node.nextSibling;
  if (!neighbor) return Promise.reject(new EditError(`It is already at the ${direction === 'up' ? 'top' : 'bottom'} of its group.`));
  const before = direction === 'up' ? neighbor : tree(neighbor).nextSibling;
  return node.parent.tryInsertChild(task, before).then((moved) => {
    if (!moved) throw new EditError(CONFLICT);
  });
}

export function moveTaskUp(project: ProjectModel, taskId: number | string): Promise<void> {
  return moveAmongNeighbors(project, taskId, 'up');
}

export function moveTaskDown(project: ProjectModel, taskId: number | string): Promise<void> {
  return moveAmongNeighbors(project, taskId, 'down');
}

export function indentTask(project: ProjectModel, taskId: number | string): Promise<void> {
  return restructure(project, taskId, 'indent');
}

export function outdentTask(project: ProjectModel, taskId: number | string): Promise<void> {
  return restructure(project, taskId, 'outdent');
}

/** Takes a task out of the plan, with what is inside it and on it. */
export function deleteTask(project: ProjectModel, taskId: number | string): Promise<void> {
  const task = findTask(project, taskId);
  if (!task) return Promise.reject(new EditError(GONE));
  const locked = firstLockedWithin([task]);
  if (locked) return Promise.reject(new EditError(lockMessage(locked)));
  return transact(project, 'Delete task', () => (project.taskStore as unknown as { remove(record: TaskModel): unknown }).remove(liveTask(project, taskId)));
}

export function unassignCrew(project: ProjectModel, assignmentId: number | string): Promise<void> {
  if (!project.assignmentStore.getById(assignmentId)) return Promise.resolve();
  return transact(project, 'Remove crew', () => {
    const assignment = project.assignmentStore.getById(assignmentId);
    if (assignment) project.assignmentStore.remove(assignment as never);
  });
}

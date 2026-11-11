/**
 * Filling (the fill handle) and clearing (Delete / Backspace over selected cells) for every column,
 * the collapsed ones included: a Schedule cell stands for start, length and progress, a Budget ·
 * Forecast cell for two money fields, so filling or clearing one acts on all of them.
 *
 * Bryntum's own fill writes only `column.field` and reads values through the column's editor, which
 * the collapsed columns do not have, so a fill over Schedule cells changed nothing. Here every cell is
 * filled the way Bryntum fills a plain cell, field by field: one source cell is copied; two or more
 * that step evenly (dates, numbers) continue the series; anything else repeats. Dragging up or left
 * runs the series backwards from the first source cell, as Bryntum does.
 *
 * Clearing means "take back what was entered here": progress back to 0%, the date pins (constraints,
 * manual scheduling) removed so the task returns to where its links put it, money to zero, text
 * emptied, crews, equipment and links on the cell removed. What the plan works out by itself (names, lengths,
 * float, spent and paid, WBS) is left alone.
 *
 * Every fill and every clear is ONE transaction: one change, one revision for the other person.
 */
import type { AssignmentModel, DependencyModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { runProjectTransaction } from '../scenario/publish';
import { isGeneratedParent, original } from './look';

export type FillValue = number | Date | string | boolean | null | undefined;

/**
 * Bryntum's fill rule for one column (or row) of source values, nearest-first for the targets:
 * evenly stepping numbers or dates continue, several other values repeat in turn, one value is copied.
 */
export function fillSeries(values: readonly FillValue[], negative: boolean): () => FillValue {
  const last = values[negative ? 0 : values.length - 1];
  const numbers = values.length > 0 && values.every((value) => typeof value === 'number' && Number.isFinite(value));
  const dates = values.length > 0 && values.every((value) => value instanceof Date && !Number.isNaN(value.getTime()));
  if ((numbers || dates) && values.length > 1) {
    const steps = values.slice(1).map((value, index) => Number(value) - Number(values[index]));
    if (new Set(steps).size === 1) {
      const step = steps[0]! * (negative ? -1 : 1);
      let current = Number(last);
      return () => {
        current += step;
        return dates ? new Date(current) : current;
      };
    }
  }
  if (values.length > 1) {
    const cycle = negative ? [...values].reverse() : [...values];
    let index = -1;
    return () => {
      index = (index + 1) % cycle.length;
      return cycle[index];
    };
  }
  return () => (last instanceof Date ? new Date(last.getTime()) : last);
}

const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

type Task = TaskModel & Record<string, unknown> & {
  manuallyScheduled?: boolean;
  constraintType?: string | null;
  constraintDate?: Date | null;
  inactive?: boolean;
  segments?: unknown[] | null;
};

/** A leaf, or a phase whose dates are fixed by hand: dates that a person can set. */
function datesEditable(task: Task): boolean {
  return Boolean(task.isLeaf || task.manuallyScheduled);
}

interface CollapsedColumn {
  /** The fields the one cell stands for, read from the task. */
  read(task: Task): Record<string, FillValue>;
  /** Whether a fill or a clear may change this task's cell. */
  editable(task: Task): boolean;
  /** Writes filled values; returns what the fill asked for, to compare with what the plan made of it. */
  write(task: Task, values: Record<string, FillValue>): void;
  clear(task: Task): boolean;
}

/** Removes what pins a task's dates (a constraint, manual scheduling): it goes back to where its links put it. */
function unpin(task: Task): boolean {
  let changed = false;
  if (task.constraintType) {
    task.constraintType = null;
    task.constraintDate = null;
    changed = true;
  }
  if (task.manuallyScheduled) {
    task.manuallyScheduled = false;
    changed = true;
  }
  return changed;
}

function resetProgress(task: Task): boolean {
  if (!task.isLeaf || !task.percentDone) return false;
  task.percentDone = 0;
  return true;
}

function zeroMoney(task: Task, fields: readonly string[]): boolean {
  if (!task.isLeaf) return false;
  const changes: Record<string, number> = {};
  for (const field of fields) if (finite(task[field]) && task[field] !== 0) changes[field] = 0;
  if (Object.keys(changes).length === 0) return false;
  task.set(changes);
  return true;
}

export const COLLAPSED_COLUMNS: Readonly<Record<string, CollapsedColumn>> = {
  'schedule-when': {
    read: (task) => ({ start: task.startDate, duration: task.duration, percentDone: task.percentDone }),
    editable: datesEditable,
    write(task, { start, duration, percentDone }) {
      // Start first, keeping the length; then the length (the finish follows); then progress.
      if (isDate(start) && start.getTime() !== (task.startDate as Date | undefined)?.getTime()) void task.setStartDate(start, true);
      if (finite(duration) && duration >= 0 && duration !== task.duration && !(Array.isArray(task.segments) && task.segments.length > 1)) {
        void task.setDuration(Math.round(duration * 100) / 100, task.durationUnit ?? 'day');
      }
      if (finite(percentDone) && task.isLeaf) task.percentDone = Math.max(0, Math.min(100, Math.round(percentDone)));
    },
    clear: (task) => {
      const unpinned = unpin(task);
      return resetProgress(task) || unpinned;
    },
  },
  'cost-plan': {
    read: (task) => ({ budgetMinor: task.budgetMinor as number, forecastMinor: task.forecastMinor as number }),
    editable: (task) => Boolean(task.isLeaf),
    write(task, values) {
      const changes: Record<string, number> = {};
      for (const field of ['budgetMinor', 'forecastMinor']) {
        const value = values[field];
        if (finite(value)) changes[field] = Math.max(0, Math.round(value));
      }
      task.set(changes);
    },
    clear: (task) => zeroMoney(task, ['budgetMinor', 'forecastMinor']),
  },
  // Spent and paid come from the work done and from PayPal: never filled or cleared by hand.
  'cost-actual': {
    read: () => ({}),
    editable: () => false,
    write: () => undefined,
    clear: () => false,
  },
};

export function isCollapsedColumn(columnId: string | undefined | null): boolean {
  return typeof columnId === 'string' && columnId in COLLAPSED_COLUMNS;
}

function removeLinks(project: ProjectModel, links: readonly DependencyModel[]): boolean {
  const live = links.filter((link) => project.dependencyStore.includes(link as never));
  if (live.length === 0) return false;
  project.dependencyStore.remove(live as never);
  return true;
}

/** What Delete means for the plain columns; a column not listed here is left alone. */
const CLEARERS: Readonly<Record<string, (task: Task, project: ProjectModel) => boolean>> = {
  start: (task) => (datesEditable(task) ? unpin(task) : false),
  finish: (task) => (datesEditable(task) ? unpin(task) : false),
  progress: resetProgress,
  'constraint-type': (task) => {
    if (!task.constraintType) return false;
    task.constraintType = null;
    task.constraintDate = null;
    return true;
  },
  'constraint-date': (task) => {
    if (!task.constraintType) return false;
    task.constraintType = null;
    task.constraintDate = null;
    return true;
  },
  deadline: (task) => {
    if (!task.deadlineDate) return false;
    task.set('deadlineDate', null);
    return true;
  },
  manual: (task) => {
    if (!task.manuallyScheduled) return false;
    task.manuallyScheduled = false;
    return true;
  },
  calendar: (task) => {
    if (!task.getData?.('calendar')) return false;
    void task.setCalendar(null as never);
    return true;
  },
  'scheduling-mode': (task) => {
    if (!task.schedulingMode || task.schedulingMode === 'Normal') return false;
    task.set('schedulingMode', 'Normal');
    return true;
  },
  inactive: (task) => {
    if (!task.inactive) return false;
    task.inactive = false;
    return true;
  },
  notes: (task) => {
    if (!task.note) return false;
    task.set('note', '');
    return true;
  },
  'schedule-crew': (task, project) => {
    const assignments = ((task.assignments ?? []) as AssignmentModel[]).filter((assignment) => project.assignmentStore.includes(assignment as never));
    if (assignments.length === 0) return false;
    project.assignmentStore.remove(assignments as never);
    return true;
  },
  // The machines only, and not while PayPal pays for the task. The rental itself stays.
  equipment: (task, project) => {
    if (task.readOnly) return false;
    const machines = ((task.assignments ?? []) as AssignmentModel[]).filter((assignment) => (assignment.resource as (ResourceModel & { kind?: string }) | null)?.kind === 'equipment' && project.assignmentStore.includes(assignment as never));
    if (machines.length === 0) return false;
    project.assignmentStore.remove(machines as never);
    return true;
  },
  predecessors: (task, project) => removeLinks(project, (task.predecessors ?? []) as DependencyModel[]),
  successors: (task, project) => removeLinks(project, (task.successors ?? []) as DependencyModel[]),
  budget: (task) => zeroMoney(task, ['budgetMinor']),
  expected: (task) => zeroMoney(task, ['forecastMinor']),
  'cost-code': (task) => {
    if (!task.costCode) return false;
    task.set('costCode', '');
    return true;
  },
};

export interface CellRef {
  /** The row's task (a linked copy while grouped is fine). */
  task: TaskModel;
  columnId: string;
  /** The record field behind a plain column. */
  field?: string;
}

export interface CellOpReport {
  /** Cells that changed. */
  changed: number;
  /** Cells left alone: read-only, worked out by the plan, or a phase row. */
  skipped: number;
  /** Fill only: tasks that could not start as early as filled, because what they wait for finishes later. */
  heldByLinks: number;
}

const usable = (task: TaskModel) => !isGeneratedParent(task) && !(original(task) as TaskModel & { isRoot?: boolean }).isRoot;

/** Clears the cells as one change; resolves with what happened. */
export async function clearCells(project: ProjectModel, cells: readonly CellRef[]): Promise<CellOpReport> {
  const report: CellOpReport = { changed: 0, skipped: 0, heldByLinks: 0 };
  const work = cells.filter((cell) => usable(cell.task));
  report.skipped = cells.length - work.length;
  if (work.length === 0) return report;
  await runProjectTransaction(project, 'Clear cells', () => {
    for (const cell of work) {
      const task = original(cell.task) as Task;
      const collapsed = COLLAPSED_COLUMNS[cell.columnId];
      const clearer = collapsed ? (collapsed.editable(task) ? collapsed.clear : null) : CLEARERS[cell.columnId];
      if (clearer?.(task, project)) report.changed++;
      else report.skipped++;
    }
  });
  return report;
}

export interface FillRequest {
  /** The cells the fill starts from, in grid order (top to bottom, left to right). */
  source: readonly CellRef[];
  /** The cells to fill, nearest to the source first. */
  targets: readonly CellRef[];
  /** Dragged sideways along rows rather than down or up columns. */
  horizontal: boolean;
  /** Dragged up (or left): series run backwards from the first source cell. */
  negative: boolean;
}

const rowKey = (cell: CellRef) => String(original(cell.task).id);

function readPlain(cell: CellRef): FillValue {
  const task = original(cell.task) as Task;
  return cell.field ? (task.get(cell.field) as FillValue) : undefined;
}

function plainEditable(cell: CellRef, value: FillValue, horizontal: boolean): boolean {
  const task = original(cell.task) as Task;
  if (!cell.field || task.isEditable?.(cell.field) === false) return false;
  if (!horizontal) return true;
  // Sideways, a value only lands in a column of the same kind (a date in a date column, and so on).
  const current = task[cell.field];
  return value === null || value === undefined || current === null || current === undefined || typeof current === typeof value || (current instanceof Date && value instanceof Date);
}

/** Fills the cells as one change; resolves with what happened. */
export async function fillCells(project: ProjectModel, { source, targets, horizontal, negative }: FillRequest): Promise<CellOpReport> {
  const report: CellOpReport = { changed: 0, skipped: 0, heldByLinks: 0 };
  // One series per column (filling down or up) or per row (filling sideways), per field of a collapsed cell.
  const lineOf = (cell: CellRef) => (horizontal ? rowKey(cell) : cell.columnId);
  const bySeries = new Map<string, Map<string, () => FillValue>>();
  const sourcesOf = new Map<string, CellRef[]>();
  for (const cell of source) {
    const line = lineOf(cell);
    sourcesOf.set(line, [...(sourcesOf.get(line) ?? []), cell]);
  }
  const series = (line: string, field: string, read: (cell: CellRef) => FillValue) => {
    const fields = bySeries.get(line) ?? new Map<string, () => FillValue>();
    bySeries.set(line, fields);
    let next = fields.get(field);
    if (!next) {
      next = fillSeries((sourcesOf.get(line) ?? []).map(read), negative);
      fields.set(field, next);
    }
    return next;
  };

  const work = targets.filter((cell) => usable(cell.task));
  report.skipped = targets.length - work.length;
  const asked: { task: Task; start: Date }[] = [];
  if (work.length > 0) {
    await runProjectTransaction(project, 'Fill cells', () => {
      for (const cell of work) {
        const task = original(cell.task) as Task;
        const collapsed = COLLAPSED_COLUMNS[cell.columnId];
        const line = lineOf(cell);
        // A collapsed cell is filled from cells of its own column only (sideways it has no counterpart).
        if (collapsed) {
          const sameColumn = (sourcesOf.get(line) ?? []).every((from) => from.columnId === cell.columnId);
          if (horizontal || !sameColumn || !collapsed.editable(task)) {
            report.skipped++;
            continue;
          }
          const fields = Object.keys(collapsed.read(original((sourcesOf.get(line) ?? [cell])[0]!.task) as Task));
          const values: Record<string, FillValue> = {};
          for (const field of fields) values[field] = series(line, field, (from) => collapsed.read(original(from.task) as Task)[field])();
          collapsed.write(task, values);
          if (isDate(values.start)) asked.push({ task, start: values.start });
          report.changed++;
          continue;
        }
        const value = series(line, cell.field ?? cell.columnId, readPlain)();
        if (value === undefined || !plainEditable(cell, value, horizontal)) {
          report.skipped++;
          continue;
        }
        task.set(cell.field!, value);
        report.changed++;
      }
    });
  }
  // The plan may keep a task later than filled: it cannot start before what it waits for is done.
  for (const { task, start } of asked) {
    const now = task.startDate as Date | undefined;
    if (isDate(now) && now.getTime() - start.getTime() > 60_000) report.heldByLinks++;
  }
  return report;
}

/** One line for the person who filled or cleared, e.g. "Filled 4 cells · 2 tasks stay later: they wait for earlier work". */
export function describeCellOp(kind: 'fill' | 'clear', report: CellOpReport): string | null {
  const cells = (count: number) => `${count} cell${count === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (report.changed > 0) parts.push(`${kind === 'fill' ? 'Filled' : 'Cleared'} ${cells(report.changed)}`);
  if (report.heldByLinks > 0) {
    parts.push(`${report.heldByLinks} task${report.heldByLinks === 1 ? ' stays' : 's stay'} later: ${report.heldByLinks === 1 ? 'it waits' : 'they wait'} for earlier work`);
  }
  if (report.skipped > 0) parts.push(`${cells(report.skipped)} unchanged (worked out by the plan, read-only or already empty)`);
  if (report.changed === 0 && report.skipped === 0) return null;
  return parts.join(' · ');
}

/**
 * What Remy's cursor reaches on the chart (assistant/remy-ui.ts): a task's row and its cells, made visible first (the
 * groups above it opened, the chart scrolled to it), a row by its place on screen, a column by its name in plain
 * words, and Remy's own filter. Everything goes through Bryntum's API; nothing here sends events to the page.
 */
import type { Gantt, Model, Store, TaskModel } from '@bryntum/gantt';
import { COLUMN_CATALOG, TASK_COLUMN_ID } from './column-layout';
import { crewOf, original } from './look';

/** The row shown for a task: the task itself, or its linked copy while the plan is grouped. */
export function shownRecord(gantt: Gantt, taskId: number): TaskModel | null {
  const task = gantt.project.taskStore.getById(taskId) as TaskModel | undefined;
  if (!task) return null;
  const store = gantt.store as Store;
  return (store.getById(taskId) as TaskModel | undefined) ?? (store.find((record: Model) => original(record as TaskModel) === task, true) as TaskModel | undefined) ?? null;
}

/**
 * Opens the groups above a task and scrolls the chart to it, its row in the middle and its bar in view. Resolves with
 * the row's record, or says why there is none: the task isn't in the plan (`gone`), or a filter keeps it off the
 * chart (`filtered`: its groups are open and it still has no row).
 */
export async function revealTask(gantt: Gantt, taskId: number, options: { animate?: boolean } = {}): Promise<{ record: TaskModel } | { missing: 'gone' | 'filtered' }> {
  const record = shownRecord(gantt, taskId);
  if (!record) return { missing: 'gone' };
  await gantt.expandTo(record as never, false);
  if (gantt.isDestroyed) return { missing: 'gone' };
  if (rowOf(gantt, record) === null) return { missing: 'filtered' };
  await gantt.scrollTaskIntoView(record, { block: 'center', animate: options.animate ?? true } as never);
  return { record };
}

/** The task on row `row` of the chart as it is shown now (open groups, filters and all), counted from 1. */
export function rowAt(gantt: Gantt, row: number): TaskModel | null {
  const store = gantt.store as Store & { getAt(index: number): Model | undefined; count: number };
  if (!Number.isInteger(row) || row < 1 || row > store.count) return null;
  return (store.getAt(row - 1) as TaskModel | undefined) ?? null;
}

/** Which row of the chart a record is on now, counted from 1 (null when it isn't shown). */
export function rowOf(gantt: Gantt, record: TaskModel): number | null {
  const index = (gantt.store as Store & { indexOf(record: Model): number }).indexOf(record as never);
  return index >= 0 ? index + 1 : null;
}

/** A cell of a record's row, once Bryntum has drawn it (scroll first: rows off screen are not drawn). */
export function cellOf(gantt: Gantt, record: TaskModel, columnId: string): HTMLElement | null {
  const column = (gantt.columns as unknown as Store).getById(columnId);
  if (!column || (column as { hidden?: boolean }).hidden) return null;
  return (gantt.getCell({ record, column } as never) as HTMLElement | null) ?? null;
}

/** The task's bar, when it is drawn. */
export function barOf(gantt: Gantt, record: TaskModel): HTMLElement | null {
  return (gantt.getElementFromTaskRecord(record) as HTMLElement | null) ?? null;
}

/** Words people use for each column, beyond its own label. */
const COLUMN_WORDS: Readonly<Record<string, readonly string[]>> = {
  [TASK_COLUMN_ID]: ['task', 'name', 'title', 'task name'],
  'schedule-crew': ['crew', 'crews', 'who', 'resource', 'resources', 'assigned'],
  equipment: ['equipment', 'machine', 'machines', 'rental', 'rentals'],
  'schedule-when': ['schedule', 'when', 'dates'],
  start: ['start', 'starts', 'start date', 'begin', 'begins'],
  finish: ['finish', 'finishes', 'end', 'ends', 'end date', 'finish date', 'last day'],
  duration: ['days', 'duration', 'length', 'how long', 'working days'],
  progress: ['progress', 'percent', 'percent done', '% done', 'done', 'complete', 'completion'],
  'total-slack': ['slack', 'float', 'total slack', 'total float'],
  predecessors: ['predecessors', 'waits for', 'depends on', 'dependencies'],
  successors: ['successors', 'leads to'],
  'constraint-type': ['constraint', 'constraint type'],
  'constraint-date': ['constraint date'],
  deadline: ['deadline', 'due'],
  notes: ['note', 'notes', 'comment', 'comments'],
  wbs: ['wbs', 'outline', 'outline number', 'number'],
  'cost-plan': ['cost', 'costs', 'budget and forecast'],
  'cost-actual': ['spent and paid'],
  budget: ['budget'],
  expected: ['forecast', 'expected', 'expected cost'],
  spent: ['spent', 'incurred'],
  paid: ['paid'],
};

/** Columns whose one cell holds several fields: a field that isn't shown on its own is read there. */
const HELD_BY: Readonly<Record<string, readonly string[]>> = {
  start: ['schedule-when'],
  finish: ['schedule-when'],
  duration: ['schedule-when'],
  progress: ['schedule-when'],
  budget: ['cost-plan'],
  expected: ['cost-plan'],
  spent: ['cost-actual'],
  paid: ['cost-actual'],
};

const clean = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/\b(the|its|column|cell|field)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface ColumnMeant {
  id: string;
  label: string;
  /** Whether it is on the chart now (a column can be added from the + in the header). */
  shown: boolean;
}

/**
 * The column people mean by their words ("start", "% done", "the crew"), preferring one on the chart: a field shown
 * only inside a column that holds several (dates in Schedule) is found there. Null when no column fits.
 */
export function columnMeant(gantt: Gantt | null, words: string): ColumnMeant | null {
  const said = clean(words);
  if (!said) return null;
  const isShown = (id: string) => {
    const column = gantt ? (gantt.columns as unknown as Store).getById(id) : null;
    return Boolean(column) && !(column as { hidden?: boolean }).hidden;
  };
  const exists = (id: string) => (gantt ? Boolean((gantt.columns as unknown as Store).getById(id)) : true);
  const scored = COLUMN_CATALOG.filter((column) => exists(column.id)).map((column) => {
    const names = [column.label.toLowerCase(), ...(COLUMN_WORDS[column.id] ?? [])];
    const score = names.includes(said) ? 3 : names.some((name) => name.length > 2 && (said.includes(name) || name.includes(said))) ? 1 : 0;
    return { column, score };
  });
  const best = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || Number(isShown(b.column.id)) - Number(isShown(a.column.id)));
  const top = best[0];
  if (!top) return null;
  if (!isShown(top.column.id)) {
    const holder = (HELD_BY[top.column.id] ?? []).find(isShown);
    if (holder) {
      const definition = COLUMN_CATALOG.find((column) => column.id === holder)!;
      return { id: holder, label: definition.label, shown: true };
    }
  }
  return { id: top.column.id, label: top.column.label, shown: isShown(top.column.id) };
}

/** Remy's filter: a crew's work, work in a span of days, or both, named on its chip above the chart. */
export interface PlanFilter {
  crewIds: readonly number[] | null;
  /** `YYYY-MM-DD`, both included. */
  from: string | null;
  to: string | null;
  /** What the chip says ("Volt Electric · Jun 1 to Jun 30"): whose work, and when. */
  label: string;
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dayOf = (iso: string) => DAY.format(new Date(`${iso}T00:00:00`));

/** The chip's words for a filter. */
export function filterLabel(crewLabel: string | null | undefined, from: string | null | undefined, to: string | null | undefined): string {
  const dates = from && to ? `${dayOf(from)} to ${dayOf(to)}` : from ? `from ${dayOf(from)}` : to ? `until ${dayOf(to)}` : null;
  return [crewLabel ?? null, dates].filter(Boolean).join(' · ') || 'Filtered';
}

const isoDay = (value: unknown): string | null => {
  if (!(value instanceof Date)) return null;
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};

/** Whether a task stays on the chart under the filter: a group stays when something in it does, so what is kept is seen where it is. */
export function keepsTask(filter: PlanFilter, task: TaskModel): boolean {
  const record = original(task);
  if (!record.isLeaf) return ((task.children as TaskModel[] | boolean | undefined) instanceof Array ? (task.children as TaskModel[]) : []).some((child) => keepsTask(filter, child));
  if (filter.crewIds && filter.crewIds.length > 0) {
    const crews = new Set(filter.crewIds.map(String));
    if (!crewOf(record).some((resource) => crews.has(String(resource.id)))) return false;
  }
  const start = isoDay(record.startDate);
  // The end is the day after the last day of work.
  const end = isoDay(record.endDate);
  if (filter.from && end !== null && end <= filter.from) return false;
  if (filter.to && start !== null && start > filter.to) return false;
  return true;
}

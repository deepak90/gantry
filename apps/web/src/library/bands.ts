/**
 * Time ranges from the library, drawn on the timeline. A dropped snippet keeps its time ranges on its
 * top task (the `bands` field: each one tied to the start or end of a task inside, by position), so
 * they travel in revisions like any task edit. The server does not take Bryntum's time range store
 * in a revision, so here it is only a view: after every schedule change it is rebuilt from the tasks'
 * bands and their current dates, which also makes a band follow its tasks when they move. The store
 * is taken out of undo/redo and its changes are accepted at once, so rebuilding it is never something
 * a person can undo and never part of a revision (revision-sync also drops it from outgoing ones).
 */
import { StringHelper } from '@bryntum/gantt';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { TaskBand } from '@collab/shared';

export interface BandRange {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  cls: string;
  /** The top task the band belongs to. */
  taskId: number | string;
  taskName: string;
  note?: string;
}

interface TreeTask {
  children?: TaskModel[] | boolean;
}

const childrenOf = (task: TaskModel): TaskModel[] => {
  const children = (task as unknown as TreeTask).children;
  return Array.isArray(children) ? children : [];
};

/** The task at a position under `top` (child indexes in plan order), or null. */
export function taskAtPath(top: TaskModel, path: readonly number[]): TaskModel | null {
  let current: TaskModel | null = top;
  for (const index of path) {
    const children: TaskModel[] = current ? [...childrenOf(current)].sort(byOrder) : [];
    current = children[index] ?? null;
    if (!current) return null;
  }
  return current;
}

const byOrder = (a: TaskModel, b: TaskModel) => orderOf(a) - orderOf(b);
const orderOf = (task: TaskModel) => {
  const record = task as TaskModel & { orderedParentIndex?: number; parentIndex?: number };
  return record.orderedParentIndex ?? record.parentIndex ?? 0;
};

const dateAt = (task: TaskModel | null, edge: 'start' | 'end'): Date | null => {
  const value = edge === 'start' ? task?.startDate : task?.endDate;
  return value instanceof Date ? value : null;
};

/** Every band in the plan with its dates now; bands whose tasks are gone are left out. */
export function bandRanges(project: ProjectModel): BandRange[] {
  const ranges: BandRange[] = [];
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    const raw = (task as TaskModel & { bands?: unknown }).bands;
    if (!Array.isArray(raw) || raw.length === 0) continue;
    raw.forEach((value, index) => {
      const band = TaskBand.safeParse(value);
      if (!band.success) return;
      const from = dateAt(taskAtPath(task, band.data.from.path), band.data.from.edge);
      const to = dateAt(taskAtPath(task, band.data.to.path), band.data.to.edge);
      if (!from || !to) return;
      const [startDate, endDate] = from <= to ? [from, to] : [to, from];
      if (endDate.getTime() === startDate.getTime()) return;
      ranges.push({
        id: `band:${String(task.id)}:${index}`,
        name: band.data.name,
        startDate,
        endDate,
        cls: `library-band library-band-${band.data.tone}`,
        taskId: task.id,
        taskName: task.name ?? '',
        ...(band.data.note ? { note: band.data.note } : {}),
      });
    });
  }
  return ranges;
}

/** A stretch a calendar marks to be drawn on the chart (`cls: 'look-calendar-band'`), such as an inspector away. */
export function calendarBands(project: ProjectModel): BandRange[] {
  const calendars = (project as unknown as { calendarManagerStore?: { allRecords: { id: unknown; intervalStore?: { allRecords: { name?: string; cls?: unknown; startDate?: Date | null; endDate?: Date | null }[] } }[] } }).calendarManagerStore?.allRecords ?? [];
  const ranges: BandRange[] = [];
  for (const calendar of calendars) {
    for (const interval of calendar.intervalStore?.allRecords ?? []) {
      if (!String(interval.cls ?? '').includes('look-calendar-band') || !(interval.startDate instanceof Date) || !(interval.endDate instanceof Date)) continue;
      const task = (project.taskStore.allRecords as TaskModel[]).find((each) => (each as unknown as { calendar?: { id?: unknown } | null }).calendar?.id === calendar.id);
      if (!task) continue;
      ranges.push({ id: `band:calendar:${String(calendar.id)}:${interval.startDate.getTime()}`, name: interval.name ?? '', startDate: interval.startDate, endDate: interval.endDate, cls: 'library-band library-band-amber', taskId: task.id, taskName: task.name ?? '' });
    }
  }
  return ranges;
}

interface RangeStore {
  records: { id: unknown; getData(field: string): unknown }[];
  add(records: unknown[]): unknown;
  remove(records: unknown[]): unknown;
  getById(id: string): { set(values: object): void } | undefined;
  acceptChanges(): void;
}

interface Stm {
  hasStore(store: unknown): boolean;
  removeStore(store: unknown): void;
}

/** Keeps the project's time range store equal to its bands; returns the function that stops. */
export function attachBands(project: ProjectModel): () => void {
  const store = (project as unknown as { timeRangeStore: RangeStore }).timeRangeStore;
  const stm = project.stm as unknown as Stm;
  if (stm.hasStore(store)) stm.removeStore(store);

  const refresh = () => {
    const wanted = [...bandRanges(project), ...calendarBands(project)];
    const ids = new Set(wanted.map((range) => range.id));
    const stale = store.records.filter((record) => typeof record.id === 'string' && record.id.startsWith('band:') && !ids.has(record.id));
    if (stale.length > 0) store.remove(stale);
    const added: BandRange[] = [];
    for (const range of wanted) {
      const existing = store.getById(range.id);
      if (existing) existing.set({ name: range.name, startDate: range.startDate, endDate: range.endDate, cls: range.cls });
      else added.push(range);
    }
    if (added.length > 0) store.add(added);
    // Bryntum builds each revision from the project's pending changes, this store's included: the view
    // is accepted at once so it never rides along in (or makes) a revision.
    store.acceptChanges();
  };
  refresh();
  const detach = project.on('dataReady', refresh) as (() => void) | undefined;
  return () => detach?.();
}

const tooltipDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** The hover card of a band: what it is, from when to when, and the work it belongs to. */
export function renderBandTooltip(range: { name?: string; startDate?: Date | string | null; endDate?: Date | string | null; getData?(field: string): unknown }): string {
  const read = (field: string) => (typeof range.getData === 'function' ? range.getData(field) : undefined);
  const day = (value: unknown) => (value instanceof Date ? tooltipDay.format(value) : '');
  const note = read('note');
  const owner = read('taskName');
  return [
    `<div class="library-band-tip"><strong>${StringHelper.encodeHtml(range.name ?? 'Time range')}</strong>`,
    `<span>${day(range.startDate)} – ${day(range.endDate)}</span>`,
    typeof owner === 'string' && owner ? `<span class="library-band-owner">From “${StringHelper.encodeHtml(owner)}”</span>` : '',
    typeof note === 'string' && note ? `<span>${StringHelper.encodeHtml(note)}</span>` : '',
    '</div>',
  ].join('');
}

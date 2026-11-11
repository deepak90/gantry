/**
 * The time axis' own marks, kept quiet: the project's first day says "Start" in a small chip, its last day
 * says nothing (the handover milestone already names it and its date), and today's day is filled in the
 * accent in the header, where a chip would cover the week's name or the day letters. Today is the plan's
 * (plan-clock.ts): on a build whose plan date is pinned, the today line is drawn from it too.
 */
import { DateHelper, type Gantt, type ProjectModel } from '@bryntum/gantt';
import { planClock } from '../plan-clock';

interface ProjectLinesFeature {
  renderRanges?(): void;
}

/** Names the project's start and end lines this app's way, for this chart only. */
export function nameProjectLines(gantt: Gantt): void {
  const feature = (gantt.features as unknown as { projectLines?: ProjectLinesFeature }).projectLines;
  if (!feature) return;
  let proto: object | null = Object.getPrototypeOf(feature);
  let base: (() => unknown) | undefined;
  while (proto && !base) {
    base = Object.getOwnPropertyDescriptor(proto, 'timeRanges')?.get;
    proto = Object.getPrototypeOf(proto);
  }
  if (!base) return;
  const ranges = base;
  Object.defineProperty(feature, 'timeRanges', {
    configurable: true,
    get(this: ProjectLinesFeature) {
      return (ranges.call(this) as { fillAlign?: string }[]).map((range) => ({ ...range, name: range.fillAlign === 'end' ? '' : 'Start' }));
    },
  });
  feature.renderRanges?.();
}

/** A day header that fills in today (the zoom levels with a row of days). */
export function dayHeader(format: string) {
  return (start: Date, _end: Date, cell: { headerCellCls?: string }) => {
    cell.headerCellCls = DateHelper.isEqual(DateHelper.clearTime(start, true), planClock.today()) ? 'look-today' : '';
    return DateHelper.format(start, format);
  };
}

/**
 * The time ranges feature's own current time line: Bryntum's, on the real clock; none when the plan's date is pinned,
 * where `showPlanToday` draws the line instead.
 */
export const CURRENT_TIME_LINE: false | { name: string } = planClock.pinned ? false : { name: 'Today' };

/** The pinned today line's record in the project's time range store. */
export const PLAN_TODAY_ID = 'plan-today';

interface RangeStore {
  getById(id: string): { set(values: object): void } | undefined;
  add(records: object[]): unknown;
  remove(records: unknown[]): unknown;
  acceptChanges(): void;
}

interface Stm {
  hasStore(store: unknown): boolean;
  removeStore(store: unknown): void;
}

/**
 * Today's line on a build whose plan date is pinned: a line in the project's time range store at the plan's now,
 * drawn as Bryntum draws its current time line (`b-sch-current-time`), moved on every minute. Like the library's
 * bands it is a view: accepted at once, so it never rides along in a revision, and the undo history never holds it.
 * On the real clock it does nothing (Bryntum's own line shows). Returns the function that takes it away.
 */
export function showPlanToday(project: ProjectModel, everyMs = 60_000): () => void {
  if (!planClock.pinned) return () => undefined;
  const store = (project as unknown as { timeRangeStore: RangeStore }).timeRangeStore;
  const stm = project.stm as unknown as Stm;
  if (stm.hasStore(store)) stm.removeStore(store);
  const place = (move: boolean) => {
    if (project.isDestroyed) return;
    const at = planClock.now();
    const line = store.getById(PLAN_TODAY_ID);
    if (!line) store.add([{ id: PLAN_TODAY_ID, name: 'Today', startDate: at, endDate: at, cls: 'b-sch-current-time' }]);
    else if (move) line.set({ startDate: at, endDate: at });
    else return;
    store.acceptChanges();
  };
  place(true);
  const timer = setInterval(() => place(true), everyMs);
  // A plan loaded again (a reset, a snapshot) starts with an empty store: the line comes back with the next data.
  const detach = project.on('dataReady', () => place(false)) as (() => void) | undefined;
  return () => {
    clearInterval(timer);
    detach?.();
    const line = project.isDestroyed ? undefined : store.getById(PLAN_TODAY_ID);
    if (!line) return;
    store.remove([line]);
    store.acceptChanges();
  };
}

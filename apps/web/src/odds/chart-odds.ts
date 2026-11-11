/**
 * The odds on the chart, with Bryntum's own features: a soft tail from each bar's end to its P80 finish (uncertain
 * work grows a long tail), a chip on the tasks that move the handover most, a whisker under the handover milestone
 * from its P10 to its P90 day, and a time range shading that window across the timeline. Drawn only while the odds
 * panel has results; nothing in the plan changes.
 *
 * The tails, chips and whisker are the Gantt's indicators (`oddsTail`, `oddsChip`, `oddsWhisker`, wired in
 * GanttWorkspace), as the late-payment outlines are (gantt/pay-late-preview.ts); there is one Gantt per page, so
 * what is drawn is kept here. The band is a record in the project's time range store, which is a view the workspace
 * keeps out of undo and out of every revision (library/bands.ts).
 */
import type { Gantt, ProjectModel, TaskModel } from '@bryntum/gantt';
import { original } from '../gantt/look';
import { dateOfDay, type Id } from '../gantt/monte-carlo';

export interface ChartOdds {
  /** P80 finish of each task (ms), from every run. */
  finishes: ReadonlyMap<Id, number>;
  /** The tasks that move the handover most: the chip's words and its hover text. */
  chips: ReadonlyMap<Id, { label: string; name: string }>;
  handoverId: Id;
  /** Handover days: P10, P50, P90. */
  p10: number;
  p50: number;
  p90: number;
  runs: number;
}

interface Indicator {
  startDate: Date;
  endDate?: Date;
  name: string;
  cls: string;
  iconCls: string;
  style?: string;
}

const BAND_ID = 'odds:window';
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

let shown: ChartOdds | null = null;
let ganttRef: Gantt | null = null;
let bandProject: ProjectModel | null = null;

interface RangeStore {
  getById(id: string): { set(values: object): void } | undefined;
  add(records: object[]): unknown;
  remove(records: unknown[]): unknown;
  acceptChanges(): void;
}

const rangesOf = (project: ProjectModel) => (project as unknown as { timeRangeStore?: RangeStore }).timeRangeStore ?? null;

/** The chart the odds are drawn on (GanttWorkspace sets it). */
export function drawOddsOn(gantt: Gantt | null): void {
  ganttRef = gantt;
}

function redraw(): void {
  if (ganttRef && !ganttRef.isDestroyed) ganttRef.refreshRows();
}

function setBand(project: ProjectModel, range: { name: string; startDate: Date; endDate: Date } | null): void {
  const store = rangesOf(project);
  if (!store || project.isDestroyed) return;
  const existing = store.getById(BAND_ID);
  if (!range) {
    if (existing) store.remove([existing]);
  } else if (existing) {
    existing.set({ ...range, cls: 'odds-window' });
  } else {
    store.add([{ id: BAND_ID, ...range, cls: 'odds-window' }]);
  }
  // A view, like the library's bands: accepted at once so it never rides along in a revision.
  store.acceptChanges();
}

export function showOddsOnChart(project: ProjectModel, odds: ChartOdds): void {
  shown = odds;
  bandProject = project;
  // The window of handover days as the milestone would be drawn on them: P10's day to P90's.
  const start = dateOfDay(odds.p10);
  const end = dateOfDay(Math.max(odds.p90, odds.p10 + 1));
  setBand(project, { name: '8 in 10 handovers', startDate: start, endDate: end });
  // The window is drawn only where the timeline reaches: the view (never the plan) is widened to take it in.
  const gantt = ganttRef as (Gantt & { timeAxis?: { startDate?: Date; endDate?: Date }; setTimeSpan?(start: Date, end: Date): unknown }) | null;
  const reach = dateOfDay(odds.p90 + 10);
  const axisStart = gantt?.timeAxis?.startDate;
  const axisEnd = gantt?.timeAxis?.endDate;
  if (gantt && !gantt.isDestroyed && axisStart instanceof Date && axisEnd instanceof Date && axisEnd < reach) gantt.setTimeSpan?.(axisStart, reach);
  redraw();
}

export function clearOddsOnChart(): void {
  if (bandProject) setBand(bandProject, null);
  bandProject = null;
  if (!shown) return;
  shown = null;
  redraw();
}

const recordOf = (task: TaskModel) => original(task);

/** From the bar's end to where eight runs in ten have finished it. */
export function oddsTailIndicator(taskRecord: TaskModel): Indicator | null {
  if (!shown) return null;
  const task = recordOf(taskRecord);
  if (task.isMilestone || !(task.endDate instanceof Date)) return null;
  const p80 = shown.finishes.get(task.id);
  if (p80 === undefined || p80 <= task.endDate.getTime() + 3_600_000) return null;
  return {
    startDate: task.endDate,
    endDate: new Date(p80),
    name: `8 in 10 runs finish it by ${DAY.format(new Date(p80 - 1))}`,
    cls: 'odds-tail',
    iconCls: '',
  };
}

interface TreeTask {
  parent: TaskModel | null;
  isRoot?: boolean;
  isLeaf: boolean;
  isExpanded?(store: unknown): boolean;
  contains(child: TaskModel): boolean;
}
const tree = (task: TaskModel) => task as unknown as TreeTask;

/** The row a task is drawn on: itself, or the nearest folded group it is hidden in. */
function shownRow(task: TaskModel): TaskModel {
  const store = ganttRef?.store;
  let row = task;
  for (let parent = tree(task).parent; parent && !tree(parent).isRoot; parent = tree(parent).parent) {
    if (store && tree(parent).isExpanded && !tree(parent).isExpanded!(store)) row = parent;
  }
  return row;
}

/**
 * A chip at the end of the tail of the tasks that move the handover most. A task folded away in its group is named
 * on the group's bar instead.
 */
export function oddsChipIndicator(taskRecord: TaskModel): Indicator | null {
  if (!shown || shown.chips.size === 0) return null;
  const task = recordOf(taskRecord);
  if (!(task.endDate instanceof Date)) return null;
  let chip = shown.chips.get(task.id);
  if (!chip && !tree(task).isLeaf) {
    // The strongest threat folded away under this row.
    const store = (task.project as unknown as ProjectModel | null)?.taskStore;
    for (const [id, candidate] of shown.chips) {
      const hidden = store?.getById(id) as TaskModel | undefined;
      if (hidden && hidden !== task && tree(task).contains(hidden) && shownRow(hidden) === task) {
        chip = { label: `${hidden.name}: ${candidate.label.toLowerCase()}`, name: candidate.name };
        break;
      }
    }
  }
  if (!chip) return null;
  const p80 = shown.finishes.get(task.id);
  const at = p80 !== undefined && p80 > task.endDate.getTime() ? new Date(p80) : task.endDate;
  return { startDate: at, name: chip.name, cls: 'odds-chip', iconCls: '', style: `--odds-chip:${JSON.stringify(chip.label)}` };
}

/** Under the handover milestone: its P10 to P90 days, with P50 marked. */
export function oddsWhiskerIndicator(taskRecord: TaskModel): Indicator | null {
  if (!shown) return null;
  const task = recordOf(taskRecord);
  if (task.id !== shown.handoverId) return null;
  const { p10, p50, p90 } = shown;
  const span = Math.max(1, p90 - p10);
  const mid = Math.round(((p50 - p10) / span) * 1000) / 10;
  return {
    startDate: dateOfDay(p10),
    endDate: dateOfDay(Math.max(p90, p10 + 1)),
    name: `Handover in ${shown.runs.toLocaleString('en-US')} runs: 8 in 10 between ${DAY.format(dateOfDay(p10))} and ${DAY.format(dateOfDay(p90))}, half by ${DAY.format(dateOfDay(p50))}`,
    // Under the milestone, where Bryntum puts its own date ranges, clear of the milestone's label.
    cls: 'b-bottom odds-whisker',
    iconCls: '',
    style: `--odds-p50:${mid}%`,
  };
}

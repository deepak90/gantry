/**
 * Where the hosted site's chart opens: on a payment hold not yet paid, the way the film opens. Work held until it is
 * paid for is what holds the plan up, so the groups the hold and the work it holds sit in are opened, the rows are
 * brought up from the work it pays for, and the timeline runs from a few days before that work to past the held work,
 * with room for the tag that says it is held ("Ground-floor slab held until paid"). The plan's today is in that
 * stretch, and so is any band that falls in it, whole: on Harbor, the week the city inspector is away.
 *
 * Only the view changes, for this person: opening a group is never a change to the plan. A plan with no hold waiting
 * opens as Bryntum opens it, at its start. The walkthroughs frame the chart themselves; a hosted build has none.
 */
import type { Gantt, ProjectModel, TaskModel } from '@bryntum/gantt';
import { bandRanges, calendarBands } from '../library/bands';
import { planClock } from '../plan-clock';
import { gateIndex, type Gate } from './pay-gates';

const DAY_MS = 86_400_000;
/** Days shown before the work the hold pays for, as in the film. */
export const LEAD_DAYS = 6;
/** Room after the held work, in pixels, for its tag. */
export const TAG_ROOM_PX = 260;

export interface OpeningView {
  /** The hold the chart opens on. */
  gate: Gate;
  /** Rows brought on show (the groups around them opened): the hold, the work it pays for, the work it holds. */
  reveal: TaskModel[];
  /** Groups opened themselves, so the tasks in them show as held. */
  open: TaskModel[];
  /** The row brought to the top: the first the hold pays for. */
  top: TaskModel;
  /** The stretch of days the timeline fits. */
  from: Date;
  to: Date;
}

const timeOf = (value: unknown): number | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : null);

const dayOf = (task: TaskModel) => timeOf(task.startDate) ?? Number.POSITIVE_INFINITY;

/** The first hold not yet paid, by its day; null when every hold is paid, or there is none. */
export function firstWaitingHold(project: ProjectModel): Gate | null {
  const waiting = [...gateIndex(project).gates.values()].filter((gate) => gate.holding);
  return waiting.sort((a, b) => dayOf(a.task) - dayOf(b.task))[0] ?? null;
}

/** What the chart opens on, worked out from the plan and the plan's today; null when no hold is waiting. */
export function openingView(project: ProjectModel, today: Date = planClock.today()): OpeningView | null {
  const gate = firstWaitingHold(project);
  if (!gate) return null;
  const paid = gate.pays.length > 0 ? gate.pays : [gate.task];
  const starts = [...paid, gate.task].map((task) => timeOf(task.startDate)).filter((time): time is number => time !== null);
  const ends = [...gate.holds, gate.task].map((task) => timeOf(task.endDate)).filter((time): time is number => time !== null);
  if (starts.length === 0 || ends.length === 0) return null;
  let from = Math.min(today.getTime(), ...starts) - LEAD_DAYS * DAY_MS;
  let to = Math.max(today.getTime(), ...ends);
  // A band the stretch cuts into is shown whole.
  for (const band of [...bandRanges(project), ...calendarBands(project)]) {
    const [start, end] = [band.startDate.getTime(), band.endDate.getTime()];
    if (start >= to || end <= from) continue;
    from = Math.min(from, start);
    to = Math.max(to, end);
  }
  return {
    gate,
    reveal: [gate.task, ...paid, ...gate.holds],
    open: gate.holds.filter((row) => !row.isLeaf),
    top: paid[0]!,
    from: new Date(from),
    to: new Date(to),
  };
}

/** What showing it needs of the chart: Bryntum's own expanding, scrolling and zooming. */
type Chart = Pick<Gantt, 'expandTo' | 'expand' | 'scrollRowIntoView' | 'zoomToSpan' | 'scrollToDate'> & { isDestroyed?: boolean };

/** Brings the opening view on screen; resolves to whether there was one to show. */
export async function showOpeningView(gantt: Chart, project: ProjectModel, today?: Date): Promise<boolean> {
  const view = openingView(project, today);
  if (!view || gantt.isDestroyed) return false;
  await gantt.expandTo(view.reveal, false);
  for (const group of view.open) await gantt.expand(group);
  await gantt.scrollRowIntoView(view.top, { block: 'start', animate: false });
  // Fitted, then scrolled so the stretch starts at the left edge (Bryntum centers a fitted span).
  gantt.zoomToSpan({ startDate: view.from, endDate: view.to, rightMargin: TAG_ROOM_PX });
  await gantt.scrollToDate(view.from, { block: 'start', animate: false });
  return true;
}

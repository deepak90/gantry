/**
 * The what-if of a late payment, drawn on the chart: while someone points at a pay day in a gate's card, a
 * dashed PayPal-blue outline shows where each task that would move lands (the engine's answer from a branch,
 * gantt/late-payment.ts). Nothing in the plan changes. One of the Gantt's indicators (`payLateIndicator`,
 * wired in GanttWorkspace); there is one Gantt per page, so the outlines are kept here by task id.
 */
import type { Gantt, TaskModel } from '@bryntum/gantt';

interface Outline {
  start: Date;
  end: Date;
}

const outlines = new Map<number | string, Outline>();
let label = '';
let ganttRef: Gantt | null = null;

/** The chart the outlines are drawn on (GanttWorkspace sets it). */
export function drawPayLateOn(gantt: Gantt | null): void {
  ganttRef = gantt;
}

export function showPayLatePreview(positions: ReadonlyMap<number | string, Outline>, words: string): void {
  outlines.clear();
  for (const [id, outline] of positions) outlines.set(id, outline);
  label = words;
  if (ganttRef && !ganttRef.isDestroyed) ganttRef.refreshRows();
}

/** The outline of a task, for the indicators feature. */
export function payLateIndicator(taskRecord: TaskModel): { startDate: Date; endDate: Date; name: string; cls: string; iconCls: string } | null {
  if (outlines.size === 0) return null;
  const record = ((taskRecord as TaskModel & { $original?: TaskModel }).$original ?? taskRecord) as TaskModel;
  const outline = outlines.get(record.id);
  if (!outline) return null;
  return { startDate: outline.start, endDate: outline.end, name: label, cls: 'pay-late-preview', iconCls: '' };
}

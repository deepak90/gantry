/**
 * "Was here": after a drop moves work already in the plan, a dashed outline stays for a few seconds
 * where each moved bar used to be, so the move can be seen while the bar slides to its new place. The
 * outline is one of the Gantt's indicators (`wasHereIndicator`, wired in GanttWorkspace); there is one
 * Gantt per page, so the outlines are kept here by task id.
 */
import type { Gantt, ProjectModel, TaskModel } from '@bryntum/gantt';
import { original } from '../gantt/look';

export interface TaskSpan {
  start: Date;
  end: Date;
  name: string;
}

const outlines = new Map<number, TaskSpan>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Where every scheduled task (not group) of the plan is now, by id. */
export function spansOf(project: ProjectModel): Map<number, TaskSpan> {
  const spans = new Map<number, TaskSpan>();
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    if (typeof task.id === 'number' && task.isLeaf && task.startDate instanceof Date && task.endDate instanceof Date) {
      spans.set(task.id, { start: task.startDate, end: task.endDate, name: task.name ?? '' });
    }
  }
  return spans;
}

/** The tasks of `before` that are somewhere else now, with how far their end moved (calendar days, + is later). */
export function movedSince(project: ProjectModel, before: ReadonlyMap<number, TaskSpan>): { id: number; name: string; days: number; was: TaskSpan }[] {
  const moved: { id: number; name: string; days: number; was: TaskSpan }[] = [];
  for (const [id, was] of before) {
    const task = project.taskStore.getById(id) as TaskModel | undefined;
    if (!(task?.startDate instanceof Date) || !(task.endDate instanceof Date)) continue;
    if (task.startDate.getTime() === was.start.getTime() && task.endDate.getTime() === was.end.getTime()) continue;
    moved.push({ id, name: was.name, days: Math.round((task.endDate.getTime() - was.end.getTime()) / 86_400_000), was });
  }
  return moved.sort((a, b) => Math.abs(b.days) - Math.abs(a.days));
}

/**
 * Outlines these tasks' old places for `ms` (replacing any outlines still showing). Set before a
 * change with `refresh` off, the outlines appear as the change redraws the moved rows.
 */
export function showWasHere(gantt: Gantt, moved: readonly { id: number; was: TaskSpan }[], ms = 6000, refresh = true): void {
  clearTimeout(timer);
  outlines.clear();
  for (const task of moved) outlines.set(task.id, task.was);
  if (gantt.isDestroyed) return;
  if (refresh) gantt.refreshRows();
  timer = setTimeout(() => {
    outlines.clear();
    if (!gantt.isDestroyed) gantt.refreshRows();
  }, ms);
}

/** The "was here" outline of a task, for the indicators feature. */
export function wasHereIndicator(taskRecord: TaskModel): { startDate: Date; endDate: Date; name: string; cls: string; iconCls: string } | null {
  if (outlines.size === 0) return null;
  const id = original(taskRecord).id;
  const was = typeof id === 'number' ? outlines.get(id) : undefined;
  if (!was) return null;
  return { startDate: was.start, endDate: was.end, name: 'Was here before the drop', cls: 'library-was-here', iconCls: '' };
}

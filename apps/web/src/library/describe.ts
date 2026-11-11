/**
 * Plain-English descriptions of a drop, for the hint that follows the pointer while dragging and for
 * the note the panel shows afterwards. Reads the project; changes nothing.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { anchorOf, tasksPushedBack, type DropMode, type DropZone, type Placement } from './insert';

const quoted = (task: TaskModel) => `“${task.name ?? 'Untitled task'}”`;

const isGroup = (task: TaskModel) => !task.isLeaf;

const isRoot = (task: TaskModel) => Boolean((task as TaskModel & { isRoot?: boolean }).isRoot);

/** Where the new work goes, e.g. `After “Hang, tape & finish drywall partitions”`. */
export function describePlace(placement: Placement): string {
  switch (placement.kind) {
    case 'after':
      return isGroup(placement.anchor) ? `After all of ${quoted(placement.anchor)}` : `After ${quoted(placement.anchor)}`;
    case 'inside':
      return `At the end of ${quoted(placement.parent)}`;
    case 'first':
      return isRoot(placement.parent) ? 'At the very start of the plan' : `At the start of ${quoted(placement.parent)}, before ${quoted(placement.before)}`;
  }
}

/** What happens when the work lands this way, in one line. */
export function describeEffect(placement: Placement, mode: DropMode): string {
  const anchor = anchorOf(placement);
  switch (mode) {
    case 'push': {
      const pushed = tasksPushedBack(placement, 'push');
      if (pushed.length === 0) return anchor ? `Starts after ${quoted(anchor)}; nothing waits for it` : 'Nothing in the plan waits for it';
      if (pushed.length === 1) return `${quoted(pushed[0]!)} and the work after it move later`;
      return `${pushed.length} later tasks wait for it and move later`;
    }
    case 'fit':
      return anchor ? `Starts after ${quoted(anchor)}; nothing else moves` : 'Nothing already in the plan moves';
    case 'alongside': {
      const partner = anchor ?? (placement.kind === 'first' ? placement.before : null);
      return partner ? `Starts when ${quoted(partner)} starts` : 'Starts with the work around it';
    }
    case 'unlinked':
      return anchor ? `Pinned to when ${quoted(anchor)} finishes, with no links` : 'Placed here with no links';
  }
}

/** Where the pointer is on a row: halves on a task row, top / middle / bottom on a group row. */
export function zoneFor(fraction: number, isLeaf: boolean, isExpanded: boolean): DropZone {
  if (isLeaf) return fraction < 0.5 ? 'before' : 'after';
  if (fraction < 0.25) return 'before';
  if (fraction > 0.75) return isExpanded ? 'first-child' : 'after';
  return 'inside';
}

/** The handover date the header shows: the latest milestone, or the end of the plan. */
export function handoverDate(project: ProjectModel): Date | null {
  let handover: Date | null = null;
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    if (task.isMilestone && task.startDate instanceof Date && (!handover || task.startDate > handover)) {
      handover = task.startDate;
    }
  }
  return handover ?? (project.endDate instanceof Date ? project.endDate : null);
}

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function formatDay(date: Date | null): string {
  return date ? dayFormat.format(date) : '—';
}

/** Calendar days between two dates, rounded (for "3 weeks later"). */
export function daysBetween(from: Date | null, to: Date | null): number {
  if (!from || !to) return 0;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

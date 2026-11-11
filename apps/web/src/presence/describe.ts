/**
 * What somebody is doing, in a few words for their pointer label, cell flag and avatar tooltip:
 * "editing Schedule", "filling 6 cells", "moving Pour spread footings".
 */
import { cellCount, type Activity } from './protocol';

export interface Names {
  task(taskId: number): string | null;
  column(columnId: string): string | null;
}

const shorten = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export const ACTIVITY_ICONS: Readonly<Record<Activity['kind'], string>> = {
  editing: 'pen',
  filling: 'fill-drip',
  clearing: 'eraser',
  moving: 'arrows-left-right',
  resizing: 'left-right',
  linking: 'link',
  panel: 'pen-to-square',
};

export function activityText(activity: Activity | null, names: Names): string | null {
  if (!activity) return null;
  const task = activity.taskId !== null ? names.task(activity.taskId) : null;
  const column = activity.column ? names.column(activity.column) : null;
  switch (activity.kind) {
    case 'editing':
      return column ? `editing ${column}` : 'editing';
    case 'filling': {
      const count = cellCount(activity.cells ?? []);
      return count > 0 ? `filling ${count} cell${count === 1 ? '' : 's'}` : 'filling';
    }
    case 'clearing':
      return 'clearing cells';
    case 'moving':
      return task ? `moving ${shorten(task)}` : 'moving a task';
    case 'resizing':
      return task ? `resizing ${shorten(task)}` : 'resizing a task';
    case 'linking':
      return task ? `linking from ${shorten(task)}` : 'drawing a link';
    case 'panel':
      return task ? `editing ${shorten(task)} in the panel` : 'editing in the panel';
  }
}

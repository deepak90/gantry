/**
 * The builder's view of a snippet's rows: plan order with outline numbers (for the band pickers), a
 * fresh draft, and the band edits. Row edits (add, indent, move, delete, links, crews) happen in the
 * builder's Gantt (SnippetGanttEditor). Pure: no Bryntum.
 */
import { allTasksOf, freshKey, isGroupTask, outlineNumbers, type SnippetDraft, type SnippetTask, type SnippetTimeRange } from '@collab/shared';

export interface OutlineRow {
  task: SnippetTask;
  depth: number;
  number: string;
  parentKey: string | null;
  isGroup: boolean;
}

export function outlineRows(tasks: readonly SnippetTask[]): OutlineRow[] {
  const numbers = outlineNumbers(tasks);
  const rows: OutlineRow[] = [];
  const walk = (list: readonly SnippetTask[], depth: number, parentKey: string | null) => {
    for (const task of list) {
      rows.push({ task, depth, number: numbers.get(task.key) ?? '', parentKey, isGroup: isGroupTask(task) });
      walk(task.children ?? [], depth + 1, task.key);
    }
  };
  walk(tasks, 0, null);
  return rows;
}

export function emptyDraft(): SnippetDraft {
  return {
    name: 'New piece of work',
    summary: '',
    icon: 'cubes',
    unit: { one: 'copy', many: 'copies' },
    children: [{ key: 'first', name: 'First task', duration: 1 }],
    links: [],
  };
}

export type NewRowKind = 'task' | 'group' | 'milestone';

export function setTimeRanges(draft: SnippetDraft, timeRanges: readonly SnippetTimeRange[]): SnippetDraft {
  if (timeRanges.length === 0) {
    const { timeRanges: _gone, ...rest } = draft;
    return rest;
  }
  return { ...draft, timeRanges: [...timeRanges] };
}

/** A new time range from the start of one task to the end of another (the same task by default). */
export function newTimeRange(draft: SnippetDraft, fromKey: string, toKey = fromKey): SnippetTimeRange {
  const taken = (draft.timeRanges ?? []).map((range) => range.key);
  const key = freshKey([], 'band', [...allTasksOf(draft.children).map((task) => task.key), ...taken]);
  return { key, name: 'New time range', from: { task: fromKey, edge: 'start' }, to: { task: toKey, edge: 'end' }, tone: 'amber' };
}

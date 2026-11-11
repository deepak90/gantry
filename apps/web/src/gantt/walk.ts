/**
 * Walking the plan's task tree for what the plan *is*, not what the chart shows: filtered-out rows included.
 *
 * Bryntum's `traverse` skips the rows a filter hides unless asked not to, so anything that adds up money, works the
 * engine, or tells Remy about the plan would change with a search in the chart ("Nothing due yet" on a payment hold
 * while a search was on). Every such walk goes through here.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';

interface Walkable {
  traverse(fn: (node: TaskModel) => void, skipSelf?: boolean, options?: { includeFilteredOutRecords?: boolean }): void;
}

/** Calls `fn` on `row` and every task under it, filtered out or not, parents before their children. */
export function walkTree(row: TaskModel, fn: (node: TaskModel) => void): void {
  (row as unknown as Walkable).traverse(fn, false, { includeFilteredOutRecords: true });
}

/** Calls `fn` on every task in the plan, filtered out or not, in plan order (the root itself is left out). */
export function walkPlan(project: ProjectModel, fn: (task: TaskModel) => void): void {
  const root = (project.taskStore as unknown as { rootNode: TaskModel }).rootNode;
  (root as unknown as Walkable).traverse(fn, true, { includeFilteredOutRecords: true });
}

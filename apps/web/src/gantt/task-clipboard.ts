/**
 * Copying and moving whole tasks from the task menu, with what is under them, the links between them
 * and their crews. Not Bryntum's own row paste: that pauses the project queue in a feature transaction
 * and races the revisions coming back. Alone it is fine; with two people writing, every long session
 * lost dates by its sixth round, and they rolled up through every group above. Here a paste is one
 * project transaction, like a library drop: one revision, and either all of it lands or none of it does.
 */
import type { DependencyModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import { runProjectTransaction } from '../scenario/publish';
import { withoutFilters } from './filters';
import { prepareCopiedTasks } from './project';
import { unpin } from '../library/insert';

interface TreeTask {
  id: unknown;
  parent: TreeTask;
  nextSibling: TreeTask | null;
  nextOrderedSibling: TreeTask | null;
  isRoot?: boolean;
  assignments: { resourceId?: unknown; units?: number; resource?: { id: unknown } | null }[];
  predecessors: DependencyModel[];
  traverse(fn: (node: TreeTask) => void, skipSelf?: boolean, includeFilteredOutRecords?: boolean): void;
  contains(child: TreeTask, skipSelf?: boolean): boolean;
  copy(): TreeTask & { set(values: Record<string, unknown>): void; name?: string };
  appendChild(child: unknown, silent?: boolean): unknown;
  insertChild(child: unknown, before?: unknown, silent?: boolean, options?: { orderedBeforeNode?: unknown }): unknown;
  sortOrderedChildren(deep: boolean, silent: boolean): void;
  refreshWbs(options: { deep: boolean; useOrderedTree: boolean }): void;
  isLeaf: boolean;
  name?: string;
  startDate?: unknown;
  duration?: unknown;
  durationUnit?: unknown;
}

const tree = (task: TaskModel) => task as unknown as TreeTask;

interface Held {
  tasks: TaskModel[];
  isCut: boolean;
}

const held = new WeakMap<object, Held>();

/** Keeps these tasks to paste: those not already under another of them. */
export function holdTasks(project: ProjectModel, tasks: readonly TaskModel[], isCut: boolean): void {
  held.set(project, { tasks: tasks.filter((task) => !tasks.some((other) => other !== task && tree(other).contains(tree(task), true))), isCut });
}

export const hasHeldTasks = (project: ProjectModel): boolean => held.has(project);

const inPlan = (project: ProjectModel, task: TaskModel) => project.taskStore.getById(task.id) === task;

/** Runs the steps as one change; a clash nobody resolved takes all of it back, and says so. */
async function transact(project: ProjectModel, title: string, steps: (() => void)[]): Promise<void> {
  let refused = false;
  let detach: (() => void) | undefined;
  const [first, ...rest] = steps;
  try {
    await runProjectTransaction(project, title, [
      () => {
        // Attached in the queued step, so only this change's commits are watched.
        detach = project.on('commitRejected', () => {
          refused = true;
        }) as unknown as () => void;
        first!();
      },
      ...rest,
    ]);
  } finally {
    detach?.();
  }
  if (refused) throw new Error('Not pasted: it clashes with a fixed date or a link in the plan. Nothing was changed.');
}

/** What `copyTasks` put in: the copies at the top, and the step that takes the pin off the copies their links now place. */
export interface CopiedTasks {
  tops: TaskModel[];
  /** Run once the rest of the change is scheduled (`unpin`). */
  settle(): void;
}

/**
 * Copies tasks (each with what is under it, the links between them and their crews) in after `target`, with nothing
 * of the originals' progress, spending or payments. No transaction of its own: the caller's change holds it (a paste,
 * or a change Remy drafted). `name` names the copy of a single task; otherwise each is the original's name with " - 2".
 */
export function copyTasks(project: ProjectModel, tasks: readonly TaskModel[], target: TaskModel, name?: string): CopiedTasks {
  const { tops, insert, settle } = prepareCopies(project, tasks, tree(target), name);
  insert();
  return { tops: tops as unknown as TaskModel[], settle };
}

function prepareCopies(project: ProjectModel, tasks: readonly TaskModel[], target: TreeTask, name?: string) {
  const all: TreeTask[] = [];
  for (const task of tasks) {
    tree(task).traverse(
      (node) => {
        if (!all.includes(node)) all.push(node);
      },
      false,
      true,
    );
  }
  const copies = new Map<unknown, ReturnType<TreeTask['copy']>>();
  const tops: ReturnType<TreeTask['copy']>[] = [];
  for (const node of all) {
    const copy = node.copy();
    // A task the engine has only just reshaped holds its dates in the engine alone, not in its data.
    if (node.isLeaf) copy.set({ startDate: node.startDate, duration: node.duration, durationUnit: node.durationUnit });
    copies.set(node.id, copy);
    const parent = copies.get(node.parent.id);
    if (parent) parent.appendChild(copy, true);
    else {
      copy.name = name && tasks.length === 1 ? name : `${node.name} - 2`;
      tops.push(copy);
    }
  }
  tops.forEach((top) => top.sortOrderedChildren(true, true));
  prepareCopiedTasks(tops as unknown as TaskModel[]);

  const idOf = (record: unknown) => (record != null && typeof record === 'object' ? (record as { id: unknown }).id : record);
  const links = all.flatMap((node) =>
    node.predecessors
      .filter((link) => copies.has(idOf(link.fromEvent)))
      .map((link) => ({ fromEvent: copies.get(idOf(link.fromEvent))!.id, toEvent: copies.get(node.id)!.id, type: link.type, lag: link.lag, lagUnit: link.lagUnit, active: link.active })),
  );
  const crews = all.flatMap((node) => node.assignments.map((assignment) => ({ event: copies.get(node.id)!.id, resource: assignment.resource?.id ?? assignment.resourceId, units: assignment.units ?? 100 })));
  const led = new Set(links.map((link) => link.toEvent));
  return {
    tops,
    insert: () => {
      target.parent.insertChild(tops, target.nextSibling, false, { orderedBeforeNode: target.nextOrderedSibling });
      target.parent.refreshWbs({ deep: true, useOrderedTree: true });
      if (links.length > 0) project.dependencyStore.add(links as never);
      if (crews.length > 0) project.assignmentStore.add(crews as never);
    },
    // A new row on screen is pinned where it starts as it is drawn: links place what they lead to (`unpin`).
    settle: () => unpin([...copies.values()].filter((copy) => led.has(copy.id)) as unknown as TaskModel[]),
  };
}

function pasteCopies(project: ProjectModel, tasks: readonly TaskModel[], target: TreeTask): Promise<void> {
  const { tops, insert, settle } = prepareCopies(project, tasks, target);
  return transact(project, `Paste ${tops.length === 1 ? tops[0]!.name : `${tops.length} tasks`}`, [insert, settle]);
}

function moveTasks(project: ProjectModel, tasks: readonly TaskModel[], target: TreeTask): Promise<void> {
  const from = new Set(tasks.map((task) => tree(task).parent));
  return transact(project, `Move ${tasks.length === 1 ? tasks[0]!.name : `${tasks.length} tasks`}`, [
    () => {
      target.parent.insertChild(tasks, target.nextSibling, false, { orderedBeforeNode: target.nextOrderedSibling });
      for (const parent of new Set([...from, target.parent])) parent.refreshWbs({ deep: true, useOrderedTree: true });
    },
  ]);
}

/**
 * Pastes what is held below `target`, whole, with a search or a filter out of the way. Someone else may
 * have removed the target or what was held in the meantime: then nothing happens, and it says why.
 */
export async function pasteHeldTasks(project: ProjectModel, target: TaskModel): Promise<void> {
  const clip = held.get(project);
  if (!clip) throw new Error('Nothing to paste: copy or cut a task first.');
  if (!inPlan(project, target)) throw new Error('Not pasted: someone has just removed that task.');
  const tasks = clip.tasks.filter((task) => inPlan(project, task));
  if (tasks.length < clip.tasks.length && (clip.isCut || tasks.length === 0)) {
    held.delete(project);
    throw new Error('Not pasted: someone has just removed what you were holding.');
  }
  if (clip.isCut && tasks.some((task) => tree(task).contains(tree(target)))) throw new Error('A task cannot go inside itself.');
  await withoutFilters(project, () => (clip.isCut ? moveTasks(project, tasks, tree(target)) : pasteCopies(project, tasks, tree(target))));
  // A move is done with; a copy can go in again.
  if (clip.isCut) held.delete(project);
}

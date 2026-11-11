/**
 * A piece of the live plan as a library snippet: a group with its tasks, a single task, or several
 * selected tasks, with their working days, crews, notes and the links between them, ready to save or
 * open in the builder. Links to work outside the piece are left out; so are dates, progress and money
 * (a snippet is a template, and a drop makes a copy that never follows the library).
 */
import type { AssignmentModel, DependencyModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import { TaskBand, linkTypeOfCode, snippetFromOutline, type OutlineLink, type OutlineRange, type OutlineTask, type SnippetDraft } from '@collab/shared';

interface TreeTask {
  parent?: TaskModel | null;
  isRoot?: boolean;
  children?: TaskModel[] | boolean;
  orderedParentIndex?: number;
  parentIndex?: number;
  assignments?: AssignmentModel[];
  /** The children a filter is hiding too. */
  unfilteredOrChildren?: TaskModel[] | boolean;
  traverse(fn: (node: TaskModel) => void, skipSelf?: boolean, includeFilteredOutRecords?: boolean): void;
}

const tree = (task: TaskModel) => task as unknown as TreeTask;

/** A task's children, those a filter on the plan is hiding too: a save takes the work, not the view of it. */
const childrenOf = (task: TaskModel): TaskModel[] => {
  const children = tree(task).unfilteredOrChildren;
  return Array.isArray(children) ? children : [];
};

const orderOf = (task: TaskModel) => tree(task).orderedParentIndex ?? tree(task).parentIndex ?? 0;

/** A duration or lag in working days, from Bryntum's value and unit. */
export function workingDays(value: unknown, unit: unknown, hoursPerDay = 8, daysPerWeek = 5): number {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  switch (String(unit ?? 'day').toLowerCase()) {
    case 'h':
    case 'hour':
    case 'hours':
      return amount / hoursPerDay;
    case 'w':
    case 'week':
    case 'weeks':
      return amount * daysPerWeek;
    case 'mo':
    case 'month':
    case 'months':
      return amount * daysPerWeek * 4;
    default:
      return amount;
  }
}

function outlineOf(task: TaskModel, hoursPerDay: number): OutlineTask {
  const children = [...childrenOf(task)].sort((a, b) => orderOf(a) - orderOf(b));
  const crews = (tree(task).assignments ?? [])
    .map((assignment) => ({ name: (assignment.resource as { name?: string } | null)?.name ?? '', units: typeof assignment.units === 'number' ? Math.round(assignment.units) : 100 }))
    .filter((crew) => crew.name);
  return {
    id: task.id as number | string,
    name: task.name ?? 'Untitled task',
    days: children.length > 0 ? 0 : Math.max(0, Math.round(workingDays(task.duration, task.durationUnit, hoursPerDay))),
    crews,
    note: typeof task.note === 'string' && task.note.trim() ? task.note.trim() : null,
    children: children.map((child) => outlineOf(child, hoursPerDay)),
  };
}

/** Compares outline numbers ("1.2.10" after "1.2.9"). */
function compareWbs(a: TaskModel, b: TaskModel): number {
  const parts = (task: TaskModel) => String((task as TaskModel & { wbsCode?: unknown }).wbsCode ?? '').split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const difference = (x[index] ?? -1) - (y[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The snippet several tasks of the plan make (each with everything under it), in plan order. A task
 * inside another selected one is part of it already. One task saves as itself; several are the
 * snippet's top rows, named after their group when they are all of it.
 */
export function snippetFromTasks(project: ProjectModel, picked: readonly TaskModel[]): SnippetDraft {
  const chosen = new Set(picked);
  const within = (task: TaskModel) => {
    for (let parent = tree(task).parent; parent; parent = tree(parent).parent ?? null) if (chosen.has(parent)) return true;
    return false;
  };
  const tasks = [...chosen].filter((task) => !within(task)).sort(compareWbs);
  if (tasks.length === 0) throw new Error('Nothing to save');
  const hoursPerDay = (project as ProjectModel & { hoursPerDay?: number }).hoursPerDay ?? 8;
  const inside = new Set<unknown>();
  for (const task of tasks) {
    tree(task).traverse(
      (node) => {
        inside.add(node.id);
      },
      false,
      true,
    );
  }
  const links: OutlineLink[] = [];
  for (const dependency of project.dependencyStore.allRecords as DependencyModel[]) {
    const from = (dependency.fromEvent as unknown as TaskModel | null)?.id;
    const to = (dependency.toEvent as unknown as TaskModel | null)?.id;
    if (!inside.has(from) || !inside.has(to) || dependency.active === false) continue;
    links.push({ from: from as number, to: to as number, type: linkTypeOfCode(dependency.type as number), lag: Math.round(workingDays(dependency.lag, dependency.lagUnit, hoursPerDay)) });
  }
  const ranges = tasks.flatMap(bandsOf);
  if (tasks.length === 1) return snippetFromOutline(outlineOf(tasks[0]!, hoursPerDay), links, ranges);
  const parent = tree(tasks[0]!).parent ?? null;
  const siblings = parent ? childrenOf(parent) : [];
  const wholeGroup = parent && !tree(parent).isRoot && siblings.length === tasks.length && siblings.every((task) => chosen.has(task));
  const name = wholeGroup ? (parent.name ?? 'Saved work') : tasks.length === 2 ? `${tasks[0]!.name} and ${tasks[1]!.name}` : `${tasks[0]!.name} to ${tasks.at(-1)!.name}`;
  return snippetFromOutline({ id: 'selection', name: name.slice(0, 120), days: 0, crews: [], note: null, children: tasks.map((task) => outlineOf(task, hoursPerDay)) }, links, ranges);
}

/** Bands this group brought from the library, as time ranges of the snippet (tied to task ids). */
function bandsOf(task: TaskModel): OutlineRange[] {
  const ranges: OutlineRange[] = [];
  const raw = (task as TaskModel & { bands?: unknown }).bands;
  if (!Array.isArray(raw)) return ranges;
  const at = (path: readonly number[]): TaskModel | null => {
    let current: TaskModel | null = task;
    for (const index of path) {
      const children: TaskModel[] = current ? [...childrenOf(current)].sort((a, b) => orderOf(a) - orderOf(b)) : [];
      current = children[index] ?? null;
    }
    return current;
  };
  for (const value of raw) {
    const band = TaskBand.safeParse(value);
    if (!band.success) continue;
    const from = at(band.data.from.path);
    const to = at(band.data.to.path);
    if (from && to) ranges.push({ name: band.data.name, tone: band.data.tone, from: { id: from.id as number, edge: band.data.from.edge }, to: { id: to.id as number, edge: band.data.to.edge } });
  }
  return ranges;
}

/**
 * What the plan's money comes to, for Remy's cost charts: every cost the chosen tasks carry, who is
 * paid, which floor it belongs to and when it falls due, read from the live plan so a chart always
 * agrees with the Gantt and with Pay.
 *
 * A task's cost lines are the costs where it has them (a library piece brings them). A task without
 * lines counts its budget, shared evenly by the crews on it, or "No firm" when nobody is. A line falls
 * due the way Pay reads it: on order at the task's start, otherwise on the task's last day. The floor
 * is the top-level group the task sits in. Pure: reads the project, writes nothing.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { TaskCostLine } from '@collab/shared';
import { walkPlan, walkTree } from '../gantt/walk';

export type CostBy = 'payee' | 'floor' | 'month';

/** One cost in the plan: a cost line, or a share of a task's budget. */
export interface CostPart {
  key: string;
  taskId: number;
  task: string;
  /** What it pays for: the cost line's label, or the task's name. */
  label: string;
  payee: string;
  /** The top-level group the task sits in, or NO_GROUP. */
  where: string;
  amountMinor: number;
  /** 'YYYY-MM-DD'; null for a task with no dates. */
  due: string | null;
}

export interface CostGroup {
  key: string;
  name: string;
  totalMinor: number;
  taskIds: number[];
  parts: CostPart[];
}

export interface CostBreakdown {
  /** Every cost, in plan order. */
  parts: CostPart[];
  totalMinor: number;
  /** Who is paid, largest first (that order also picks each one's color). */
  payees: CostGroup[];
  /** The top-level groups the costs sit in, in plan order. */
  floors: CostGroup[];
  /** The months costs fall due in, in order. */
  months: CostGroup[];
  /** Costs by the day they fall due, with the running total after each. */
  flow: { part: CostPart; runningMinor: number }[];
}

export const NO_FIRM = 'No firm';
export const NO_GROUP = 'Not in a group';

const pad = (value: number) => String(value).padStart(2, '0');
/** A date as the plan's day, in local time (the plan's dates are local midnights). */
export const isoDay = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function lastDay(end: Date): string {
  const day = new Date(end);
  day.setDate(day.getDate() - 1);
  return isoDay(day);
}

type CostTask = TaskModel & { costLines?: TaskCostLine[] | null; budgetMinor?: number };

/** The tasks of the plan in plan order (the order its rows are drawn in). */
function planOrder(project: ProjectModel): TaskModel[] {
  const tasks: TaskModel[] = [];
  walkPlan(project, (record) => {
    const task = record as TaskModel;
    if (!task.isRoot) tasks.push(task);
  });
  return tasks;
}

/** The top-level group a task sits in: the ancestor just under the plan's root. */
function topGroup(task: TaskModel): TaskModel | null {
  let at: TaskModel = task;
  let parent = at.parent as TaskModel | null;
  if (!parent || parent.isRoot) return null;
  while (parent && !parent.isRoot) {
    at = parent;
    parent = at.parent as TaskModel | null;
  }
  return at;
}

function crewsOn(task: TaskModel): string[] {
  const names = ((task.assignments ?? []) as { resource?: { name?: string } | null }[]).map((assignment) => assignment.resource?.name?.trim() ?? '').filter(Boolean);
  // By name, so the same task always splits the same way.
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function partsOf(task: CostTask, where: string): CostPart[] {
  const id = task.id as number;
  const start = task.startDate ? isoDay(new Date(task.startDate as Date)) : null;
  const done = task.endDate ? lastDay(new Date(task.endDate as Date)) : null;
  const lines = (task.costLines ?? []).filter((line) => line.amount_minor > 0);
  if (lines.length > 0) {
    return lines.map((line, index) => ({
      key: `${id}:${index}`,
      taskId: id,
      task: task.name,
      label: line.label,
      payee: line.payee.trim() || NO_FIRM,
      where,
      amountMinor: line.amount_minor,
      due: line.due === 'on_order' ? start : done,
    }));
  }
  const budget = Math.max(0, Math.round(task.budgetMinor ?? 0));
  if (budget === 0) return [];
  const crews = crewsOn(task);
  const payees = crews.length > 0 ? crews : [NO_FIRM];
  // Shared evenly; the cents that don't divide go to the first.
  const share = Math.floor(budget / payees.length);
  return payees.map((payee, index) => ({
    key: `${id}:${payee}`,
    taskId: id,
    task: task.name,
    label: task.name,
    payee,
    where,
    amountMinor: share + (index === 0 ? budget - share * payees.length : 0),
    due: done,
  }));
}

function group(parts: readonly CostPart[], keyOf: (part: CostPart) => string | null, nameOf: (key: string) => string): CostGroup[] {
  const groups = new Map<string, CostGroup>();
  for (const part of parts) {
    const key = keyOf(part);
    if (key === null) continue;
    const found = groups.get(key) ?? { key, name: nameOf(key), totalMinor: 0, taskIds: [], parts: [] };
    found.totalMinor += part.amountMinor;
    if (!found.taskIds.includes(part.taskId)) found.taskIds.push(part.taskId);
    found.parts.push(part);
    groups.set(key, found);
  }
  return [...groups.values()];
}

/**
 * The costs of `taskIds` (a group brings all its tasks), or of the whole plan when null: by payee, by
 * floor, by month, and in the order they fall due.
 */
export function costBreakdown(project: ProjectModel, taskIds: readonly number[] | null): CostBreakdown {
  const ordered = planOrder(project);
  const position = new Map(ordered.map((task, index) => [task, index]));
  let leaves: TaskModel[];
  if (taskIds === null) leaves = ordered.filter((task) => task.isLeaf);
  else {
    const chosen = new Set<TaskModel>();
    for (const id of taskIds) {
      const task = project.taskStore.getById(id) as TaskModel | undefined;
      if (!task) continue;
      if (task.isLeaf) chosen.add(task);
      else
        walkTree(task, (record) => {
          const child = record as TaskModel;
          if (child.isLeaf) chosen.add(child);
        });
    }
    leaves = [...chosen].sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  }
  const groupOrder = new Map<string, number>();
  const parts = leaves.flatMap((task) => {
    const top = topGroup(task);
    const where = top?.name?.trim() || NO_GROUP;
    if (!groupOrder.has(where)) groupOrder.set(where, top ? (position.get(top) ?? 0) : Number.MAX_SAFE_INTEGER);
    return partsOf(task as CostTask, where);
  });
  const totalMinor = parts.reduce((sum, part) => sum + part.amountMinor, 0);
  const payees = group(parts, (part) => part.payee, (key) => key).sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name));
  const floors = group(parts, (part) => part.where, (key) => key).sort((a, b) => (groupOrder.get(a.key) ?? 0) - (groupOrder.get(b.key) ?? 0));
  const dated = parts.filter((part) => part.due !== null);
  const years = new Set(dated.map((part) => part.due!.slice(0, 4)));
  const months = group(
    dated,
    (part) => part.due!.slice(0, 7),
    (key) => {
      const [year, month] = key.split('-').map(Number);
      const name = new Date(year!, month! - 1, 1).toLocaleDateString('en-US', { month: 'long' });
      return years.size > 1 ? `${name} ${year}` : name;
    },
  ).sort((a, b) => a.key.localeCompare(b.key));
  let running = 0;
  const flow = [...dated]
    .sort((a, b) => a.due!.localeCompare(b.due!) || parts.indexOf(a) - parts.indexOf(b))
    .map((part) => {
      running += part.amountMinor;
      return { part, runningMinor: running };
    });
  return { parts, totalMinor, payees, floors, months, flow };
}

/** A floor's mark as on a drawing: "Level 2 build-out" is L2, "Floor 3" is F3, anything else its first word. */
export function levelMark(name: string): string {
  const level = /\blevel\s*(\d+)/i.exec(name) ?? /\bl(\d+)\b/i.exec(name);
  if (level) return `L${level[1]}`;
  const floor = /\bfloor\s*(\d+)/i.exec(name) ?? /\b(\d+)(?:st|nd|rd|th)\s+floor/i.exec(name);
  if (floor) return `F${floor[1]}`;
  const word = name.trim().split(/\s+/)[0] ?? name;
  return word.length > 5 ? `${word.slice(0, 4)}.` : word;
}

/** The floor's number, for drawing the building with the top floor on top; null for a group that isn't a floor. */
export function levelNumber(name: string): number | null {
  const found = /\blevel\s*(\d+)/i.exec(name) ?? /\bfloor\s*(\d+)/i.exec(name) ?? /\b(\d+)(?:st|nd|rd|th)\s+floor/i.exec(name);
  return found ? Number(found[1]) : null;
}

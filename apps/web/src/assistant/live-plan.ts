/**
 * What the assistant's cards show about the plan, read from the live project in this browser (not
 * from the model), so a card always agrees with the Gantt next to it: a task's dates, crews, links
 * and slack; the crew workload by week; progress and money by phase. Pure reads; nothing changes.
 */
import type { AssignmentModel, DependencyModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { linkTypeOfCode, LINK_TYPE_WORDS } from '@collab/shared';
import { crewColor, engineCommitting, isCritical } from '../gantt/look';
import { workingDays } from '../library/from-plan';
import { planClock } from '../plan-clock';
import { walkTree } from '../gantt/walk';

export interface LiveCrew {
  name: string;
  color: string;
  units: number;
}

export interface LiveTask {
  id: number;
  name: string;
  /** Group names from the phase down, without the task itself. */
  path: string[];
  isGroup: boolean;
  isMilestone: boolean;
  start: Date | null;
  end: Date | null;
  days: number;
  percentDone: number;
  crews: LiveCrew[];
  critical: boolean;
  /** Working days it can slip without moving the handover; null when the engine has not said. */
  slackDays: number | null;
  note: string | null;
}

export interface LiveLink {
  taskId: number;
  name: string;
  words: string;
  lagDays: number;
}

const dateOf = (value: unknown): Date | null => (value instanceof Date ? value : null);

interface EngineTask {
  totalSlack?: number;
  slackUnit?: string;
  critical?: boolean;
  isRoot?: boolean;
  assignments?: AssignmentModel[];
  predecessors?: DependencyModel[];
  successors?: DependencyModel[];
}

const engine = (task: TaskModel) => task as unknown as EngineTask;

export function liveTask(project: ProjectModel, id: number): LiveTask | null {
  const task = project.taskStore.getById(id) as TaskModel | undefined;
  if (!task) return null;
  const path: string[] = [];
  for (let parent = task.parent as TaskModel | null; parent && !engine(parent).isRoot; parent = parent.parent as TaskModel | null) path.unshift(parent.name);
  const crews = (engine(task).assignments ?? [])
    .map((assignment) => {
      const resource = assignment.resource as ResourceModel | null;
      return resource ? { name: resource.name ?? '', color: crewColor(resource), units: Math.round(assignment.units ?? 100) } : null;
    })
    .filter((crew): crew is LiveCrew => crew !== null);
  const slack = engineCommitting(task.project) ? undefined : engine(task).totalSlack;
  return {
    id,
    name: task.name ?? 'Untitled task',
    path,
    isGroup: !task.isLeaf,
    isMilestone: Boolean(task.isMilestone),
    start: dateOf(task.startDate),
    end: dateOf(task.endDate),
    days: task.isLeaf ? Math.round(workingDays(task.duration, task.durationUnit)) : Math.round(workingDays(task.duration, task.durationUnit)),
    percentDone: Math.round(task.percentDone ?? 0),
    crews,
    critical: isCritical(task),
    slackDays: typeof slack === 'number' && Number.isFinite(slack) ? Math.round(workingDays(slack, engine(task).slackUnit ?? 'day')) : null,
    note: typeof task.note === 'string' && task.note.trim() ? task.note.trim() : null,
  };
}

function linkWords(link: DependencyModel): string {
  return LINK_TYPE_WORDS[linkTypeOfCode(link.type as number)].label;
}

/** What a task waits for, and what waits for it. */
export function liveLinks(project: ProjectModel, id: number): { waitsFor: LiveLink[]; waitedOnBy: LiveLink[] } {
  const task = project.taskStore.getById(id) as TaskModel | undefined;
  if (!task) return { waitsFor: [], waitedOnBy: [] };
  const row = (link: DependencyModel, other: unknown): LiveLink | null => {
    const end = other as TaskModel | null;
    if (!end || typeof end.id !== 'number') return null;
    return { taskId: end.id, name: end.name ?? '', words: linkWords(link), lagDays: Math.round(workingDays(link.lag, link.lagUnit)) };
  };
  return {
    waitsFor: (engine(task).predecessors ?? []).map((link) => row(link, link.fromEvent)).filter((link): link is LiveLink => link !== null),
    waitedOnBy: (engine(task).successors ?? []).map((link) => row(link, link.toEvent)).filter((link): link is LiveLink => link !== null),
  };
}

const MONDAY = (date: Date) => {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
};

export interface WorkloadGrid {
  weeks: Date[];
  crews: { name: string; color: string; cells: number[]; peak: number }[];
  max: number;
}

/**
 * Crew-days per week (a crew on a task at 50% for five weekdays is 2.5 crew-days), from the live
 * tasks' dates. Weekdays only: close enough for a picture of who is busy when.
 */
export function workloadGrid(project: ProjectModel, options: { crews?: readonly string[] | null; from?: Date | null; to?: Date | null; weeks?: number } = {}): WorkloadGrid {
  const wanted = options.crews?.length ? new Set(options.crews.map((name) => name.trim().toLowerCase())) : null;
  const assignments = (project.assignmentStore.allRecords as AssignmentModel[]).filter((assignment) => {
    const resource = assignment.resource as ResourceModel | null;
    return resource && (!wanted || wanted.has((resource.name ?? '').trim().toLowerCase()));
  });
  // Without a window: the rest of the plan, from the first work not yet finished to the last booked day.
  const open = assignments
    .map((assignment) => assignment.event as unknown as TaskModel)
    .filter((task) => task?.isLeaf && (task.percentDone ?? 0) < 100);
  const starts = open.map((task) => dateOf(task.startDate)).filter((date): date is Date => date !== null);
  const ends = open.map((task) => dateOf(task.endDate)).filter((date): date is Date => date !== null);
  const first = MONDAY(options.from ?? (starts.length ? new Date(Math.min(...starts.map((date) => date.getTime()))) : planClock.now()));
  const last = options.to ?? (ends.length ? new Date(Math.max(...ends.map((date) => date.getTime()))) : first);
  const count = Math.max(1, Math.min(options.weeks ?? 26, Math.ceil((last.getTime() - first.getTime()) / (7 * 86_400_000)) + 1));
  const weeks = Array.from({ length: count }, (_, index) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + index * 7));
  const rows = new Map<string, { name: string; color: string; cells: number[] }>();
  for (const assignment of assignments) {
    const task = assignment.event as unknown as TaskModel;
    const resource = assignment.resource as ResourceModel;
    const start = dateOf(task?.startDate);
    const end = dateOf(task?.endDate);
    if (!task?.isLeaf || !start || !end) continue;
    const row = rows.get(resource.name ?? '') ?? { name: resource.name ?? '', color: crewColor(resource), cells: weeks.map(() => 0) };
    for (let day = new Date(start); day < end; day.setDate(day.getDate() + 1)) {
      const weekday = day.getDay();
      if (weekday === 0 || weekday === 6) continue;
      const index = Math.floor((MONDAY(day).getTime() - first.getTime()) / (7 * 86_400_000));
      if (index >= 0 && index < count) row.cells[index]! += (assignment.units ?? 100) / 100;
    }
    rows.set(row.name, row);
  }
  const crews = [...rows.values()]
    .map((row) => ({ ...row, cells: row.cells.map((value) => Math.round(value * 10) / 10), peak: Math.max(...row.cells) }))
    .filter((row) => row.peak > 0)
    .sort((a, b) => b.peak - a.peak);
  return { weeks, crews, max: Math.max(1, ...crews.map((row) => row.peak)) };
}

export interface PhaseFigures {
  id: number;
  name: string;
  percentDone: number;
  budgetMinor: number;
  forecastMinor: number;
}

/** The top-level phases with progress and money summed over their tasks. */
export function phaseFigures(project: ProjectModel): PhaseFigures[] {
  const root = (project.taskStore as unknown as { rootNode: TaskModel }).rootNode;
  const phases = ((root.children as TaskModel[] | undefined) ?? []).filter((task) => !task.isLeaf);
  return phases.map((phase) => {
    let budget = 0;
    let forecast = 0;
    walkTree(phase, (node) => {
      if (!node.isLeaf) return;
      const record = node as TaskModel & { budgetMinor?: number; forecastMinor?: number };
      budget += record.budgetMinor ?? 0;
      forecast += record.forecastMinor ?? record.budgetMinor ?? 0;
    });
    return { id: phase.id as number, name: phase.name ?? '', percentDone: Math.round(phase.percentDone ?? 0), budgetMinor: budget, forecastMinor: forecast };
  });
}

/** Unfinished tasks with the least slack first (what can slip least). */
export function tightestTasks(project: ProjectModel, limit = 12): LiveTask[] {
  return (project.taskStore.allRecords as TaskModel[])
    .filter((task) => task.isLeaf && !task.isMilestone && (task.percentDone ?? 0) < 100 && typeof task.id === 'number')
    .map((task) => liveTask(project, task.id as number))
    .filter((task): task is LiveTask => task !== null && task.slackDays !== null)
    .sort((a, b) => a.slackDays! - b.slackDays! || (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0))
    .slice(0, limit);
}

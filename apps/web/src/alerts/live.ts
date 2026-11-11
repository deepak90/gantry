/**
 * The plan as the watch rules read it (packages/shared/src/watch.ts), taken from the live project in
 * this browser: each task's dates, slip against the baseline, slack, progress, money and crews; the
 * idle rentals the workflow already worked out (decorations); and the days a crew is booked on more
 * than it can do, from the assignments and each task's own working days.
 */
import type { AssignmentModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import type { WatchPlan, WatchTask } from '@collab/shared';
import { engineCommitting, original, taskMoney, type Decorations } from '../gantt/look';
import { workingDays } from '../library/from-plan';
import { planClock } from '../plan-clock';

const DAY_MS = 86_400_000;

/** A local date as `YYYY-MM-DD` (Bryntum dates are local midnights). */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier); daylight saving does not count. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY_MS);
}

interface EngineTask {
  totalSlack?: number;
  slackUnit?: string;
  assignments?: AssignmentModel[];
  baselines?: { first?: { startDate?: Date; endDate?: Date } };
  wbsCode?: unknown;
  effectiveCalendar?: { isWorkingTime?(start: Date, end: Date): boolean };
}

const engine = (task: TaskModel) => original(task) as unknown as TaskModel & EngineTask;

export function watchPlan(project: ProjectModel, decorations: Decorations): WatchPlan {
  const committing = engineCommitting(project);
  const tasks: WatchTask[] = [];
  const records = (project.taskStore.allRecords as TaskModel[]).filter((task) => !(task as unknown as { isRoot?: boolean }).isRoot);
  for (const record of records) {
    const task = engine(record);
    if (!(task.startDate instanceof Date) || !(task.endDate instanceof Date) || typeof task.id !== 'number') continue;
    const parent = task.parent as (TaskModel & { isRoot?: boolean }) | null;
    const baseline = task.baselines?.first;
    const money = taskMoney(task);
    const slack = committing ? undefined : task.totalSlack;
    const idle = decorations.get(task.id)?.idle;
    tasks.push({
      id: task.id,
      name: task.name ?? 'Untitled task',
      wbs: task.wbsCode == null ? null : String(task.wbsCode),
      parentId: parent && !parent.isRoot && typeof parent.id === 'number' ? parent.id : null,
      isLeaf: Boolean(task.isLeaf),
      isMilestone: Boolean(task.isMilestone),
      start: isoDay(task.startDate),
      end: isoDay(task.endDate),
      startSlipDays: baseline?.startDate instanceof Date ? daysBetween(baseline.startDate, task.startDate) : null,
      finishSlipDays: baseline?.endDate instanceof Date ? daysBetween(baseline.endDate, task.endDate) : null,
      slackDays: typeof slack === 'number' && Number.isFinite(slack) ? Math.round(workingDays(slack, task.slackUnit ?? 'day')) : null,
      percentDone: task.percentDone ?? 0,
      budgetMinor: money.budget,
      forecastMinor: money.expected,
      spentMinor: money.spent,
      crewIds: (task.assignments ?? []).map((assignment) => (assignment.resource as ResourceModel | null)?.id).filter((id): id is number => typeof id === 'number'),
      idle: idle ? { days: idle.days, costMinor: idle.costMinor, equipment: idle.equipment } : null,
    });
  }
  const crews = (project.resourceStore.records as ResourceModel[]).filter((crew) => typeof crew.id === 'number').map((crew) => ({ id: crew.id as number, name: crew.name ?? `Crew ${crew.id}`, equipment: (crew as ResourceModel & { kind?: string }).kind === 'equipment' }));
  return { today: isoDay(planClock.now()), tasks, crews, overbooked: overbookedDays(records) };
}

/**
 * Days each crew is booked on more than it can do (its units over 100% on a working day of the task),
 * as runs of consecutive days with the same tasks. Finished work no longer books anyone. A machine with
 * its own dates on a task is only needed there on the days they cover.
 */
export function overbookedDays(records: readonly TaskModel[]): WatchPlan['overbooked'] {
  const load = new Map<number, Map<string, { units: number; tasks: Set<number> }>>();
  const limits = new Map<number, number>();
  for (const record of records) {
    const task = engine(record);
    if (!task.isLeaf || task.isMilestone || (task.percentDone ?? 0) >= 100 || typeof task.id !== 'number') continue;
    if (!(task.startDate instanceof Date) || !(task.endDate instanceof Date)) continue;
    const calendar = task.effectiveCalendar;
    for (const assignment of task.assignments ?? []) {
      const crew = assignment.resource as (ResourceModel & { maxUnits?: number }) | null;
      if (!crew || typeof crew.id !== 'number') continue;
      limits.set(crew.id, crew.maxUnits ?? 100);
      const days = load.get(crew.id) ?? new Map<string, { units: number; tasks: Set<number> }>();
      load.set(crew.id, days);
      for (let day = new Date(task.startDate); day < task.endDate; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        if (calendar?.isWorkingTime && !calendar.isWorkingTime(day, next)) continue;
        const key = isoDay(day);
        const { rentalStart, rentalEnd } = assignment as AssignmentModel & { rentalStart?: string | null; rentalEnd?: string | null };
        if ((rentalStart && key < rentalStart) || (rentalEnd && key >= rentalEnd)) continue;
        const slot = days.get(key) ?? { units: 0, tasks: new Set<number>() };
        slot.units += assignment.units ?? 100;
        slot.tasks.add(task.id);
        days.set(key, slot);
      }
    }
  }
  const clashes: WatchPlan['overbooked'] = [];
  for (const [crewId, days] of load) {
    const limit = limits.get(crewId) ?? 100;
    let run: WatchPlan['overbooked'][number] | null = null;
    let last = '';
    for (const key of [...days.keys()].sort()) {
      const slot = days.get(key)!;
      if (slot.units <= limit || slot.tasks.size < 2) {
        run = null;
        continue;
      }
      const ids = [...slot.tasks].sort((a, b) => a - b);
      const consecutive = run && ids.join() === run.taskIds.join() && daysBetween(new Date(`${last}T00:00`), new Date(`${key}T00:00`)) <= 3;
      if (run && consecutive) run.days += 1;
      else {
        run = { crewId, firstDay: key, days: 1, taskIds: ids };
        clashes.push(run);
      }
      last = key;
    }
  }
  return clashes;
}

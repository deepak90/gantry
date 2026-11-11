/**
 * Scenario evaluation on an isolated project. Bryntum 7.3 has no public branching API, so a proposal is
 * evaluated in an independent headless ProjectModel loaded from the live project's data at a known
 * revision: the revised booking is applied there (the booked activity cannot start before the
 * equipment arrives), the engine reschedules, and the published and proposed plans are compared.
 * The live project is never touched; the copy is destroyed afterwards.
 */
import type { CalendarModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import {
  Evaluation,
  addDays,
  compareCosts,
  daysBetween,
  idleRentalDays,
  parseDateOnly,
  rentalDays,
  toCostComparisonRecord,
  toDateOnly,
  unresolvedAssumptionKeys,
  type CurrencyCode,
  type DateOnly,
  type OverAllocation,
  type ProjectInlineData,
  type ProposalAssumption,
  type ProposalInputs,
} from '@collab/shared';
import { createProjectModel, loadProjectInlineData, readProjectInlineData } from '../gantt/project';
import {
  ScenarioError,
  bookedResource,
  bookedTask,
  isWorkingDay,
  type ScenarioBooking } from './booking';

export interface EvaluationBooking extends ScenarioBooking {
  rentalRateMinor: number;
  currency: CurrencyCode;
}

export interface EvaluateScenarioOptions {
  /** The live project's data at `sourceRevision`. */
  data: ProjectInlineData;
  sourceRevision: number;
  handoverTaskId: number;
  booking: EvaluationBooking;
  inputs: ProposalInputs;
  assumptions: ProposalAssumption[];
  now?: () => Date;
}

/** The project's data and the server revision it reflects, read between two queue steps. */
export interface ProjectState {
  data: ProjectInlineData;
  revision: number;
}

/**
 * Reads the live project as of the last revision the server confirmed. Runs as a project-queue step
 * so no `applyRevisions()` is half done. Refuses while this browser still has local changes the
 * server has not accepted: an evaluation must describe a revision everyone can load.
 */
export function captureProjectState(project: ProjectModel): Promise<ProjectState> {
  const queued = project as unknown as { queue(step: () => unknown): Promise<unknown> };
  return new Promise<ProjectState>((resolve, reject) => {
    queued
      .queue(() => {
        const stm = project.stm as unknown as { lastCommittedRevisionId?: string; localRevisions?: unknown[] };
        if ((stm.localRevisions?.length ?? 0) > 0) {
          throw new ScenarioError('Your own changes are still being saved; evaluate again once the badge shows Synced');
        }
        const revision = Number(stm.lastCommittedRevisionId);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new ScenarioError('The project has not been loaded from the server yet');
        }
        resolve({ data: readProjectInlineData(project), revision });
      })
      .catch(reject);
  });
}

interface PlanDates {
  start: DateOnly;
  end: DateOnly;
}

function datesOf(task: TaskModel): PlanDates | null {
  return task.startDate instanceof Date && task.endDate instanceof Date
    ? { start: toDateOnly(task.startDate), end: toDateOnly(task.endDate) }
    : null;
}

/**
 * The stretches a task actually works: its pieces when it is split (the pauses between them are not
 * work, so they cannot double-book anything), else its whole span.
 */
function workSpans(task: TaskModel): PlanDates[] {
  const segments = (task as TaskModel & { segments?: { startDate?: Date; endDate?: Date }[] | null }).segments;
  if (Array.isArray(segments) && segments.length > 1) {
    return segments
      .filter((segment) => segment.startDate instanceof Date && segment.endDate instanceof Date)
      .map((segment) => ({ start: toDateOnly(segment.startDate as Date), end: toDateOnly(segment.endDate as Date) }));
  }
  const dates = datesOf(task);
  return dates ? [dates] : [];
}

/** Dates of every leaf task, in tree order. */
function leafPlan(project: ProjectModel): Map<number, PlanDates & { name: string }> {
  const plan = new Map<number, PlanDates & { name: string }>();
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    const dates = datesOf(task);
    if (task.isLeaf && typeof task.id === 'number' && dates) {
      plan.set(task.id, { ...dates, name: task.name });
    }
  }
  return plan;
}

/**
 * Days a resource is over-allocated: assigned units above 100% on a working day of the task's
 * calendar, or (for the booked equipment on its task) needed on a day outside its rental window. On other
 * tasks a machine with its own dates is only needed on the days they cover.
 */
function overAllocatedDays(project: ProjectModel, resourceId: number, rental: { taskId: number; window: PlanDates } | null): Set<DateOnly> {
  const resource = project.resourceStore.getById(resourceId) as unknown as {
    assignments: { event?: TaskModel | null; units: number; rentalStart?: DateOnly | null; rentalEnd?: DateOnly | null }[];
  } | undefined;
  const load = new Map<DateOnly, number>();
  const days = new Set<DateOnly>();
  for (const assignment of resource?.assignments ?? []) {
    const task = assignment.event;
    if (!task || task.isMilestone) {
      continue;
    }
    const calendar = task.effectiveCalendar as CalendarModel;
    const isRentalTask = rental !== null && task.id === rental.taskId;
    for (const span of workSpans(task)) {
      for (let day = span.start; day < span.end; day = addDays(day, 1)) {
        if (!isWorkingDay(calendar, day)) continue;
        if (isRentalTask) {
          if (day < rental.window.start || day >= rental.window.end) days.add(day);
        } else if ((assignment.rentalStart && day < assignment.rentalStart) || (assignment.rentalEnd && day >= assignment.rentalEnd)) {
          continue;
        }
        load.set(day, (load.get(day) ?? 0) + assignment.units);
      }
    }
  }
  for (const [day, units] of load) {
    if (units > 100) {
      days.add(day);
    }
  }
  return days;
}

/** Consecutive days as [start, end) intervals. */
function toIntervals(days: Iterable<DateOnly>): { start: DateOnly; end: DateOnly }[] {
  const sorted = [...days].sort();
  const intervals: { start: DateOnly; end: DateOnly }[] = [];
  for (const day of sorted) {
    const last = intervals[intervals.length - 1];
    if (last && last.end === day) {
      last.end = addDays(day, 1);
    } else {
      intervals.push({ start: day, end: addDays(day, 1) });
    }
  }
  return intervals;
}

function handoverEnd(project: ProjectModel, handoverTaskId: number): DateOnly {
  const handover = project.taskStore.getById(handoverTaskId) as TaskModel | undefined;
  const dates = handover ? datesOf(handover) : null;
  if (!dates) {
    throw new ScenarioError(`The handover milestone (task ${handoverTaskId}) is not scheduled in the project`);
  }
  return dates.end;
}

/**
 * Evaluates a revised booking: schedule impact (handover, affected activities, resource conflicts
 * the proposal introduces), the booking's billable days and the cost comparison. The result is
 * validated against the shared `Evaluation` schema before it is returned.
 */
export async function evaluateScenario(options: EvaluateScenarioOptions): Promise<Evaluation> {
  const { booking, inputs } = options;
  const scenario = createProjectModel();
  try {
    await loadProjectInlineData(scenario, structuredClone(options.data));

    const task = bookedTask(scenario, booking);
    bookedResource(scenario, booking);

    // The published plan, as the engine schedules it in the copy.
    const published = leafPlan(scenario);
    const publishedHandover = handoverEnd(scenario, options.handoverTaskId);
    const publishedWindow = { start: booking.billableStart, end: booking.billableEnd };
    // Conflicts that already exist in the published plan are not the proposal's doing.
    const publishedOverAllocations = new Map<number, Set<DateOnly>>();
    for (const resource of scenario.resourceStore.allRecords) {
      if (typeof resource.id === 'number') {
        const rental = resource.id === booking.resourceId ? { taskId: booking.taskId, window: publishedWindow } : null;
        publishedOverAllocations.set(resource.id, overAllocatedDays(scenario, resource.id, rental));
      }
    }

    // The revised booking: the equipment arrives on new_start, so the activity starts no earlier.
    task.constraintType = 'startnoearlierthan';
    task.constraintDate = parseDateOnly(inputs.new_start);
    await scenario.commitAsync();

    const proposed = leafPlan(scenario);
    const proposedHandover = handoverEnd(scenario, options.handoverTaskId);
    const proposedWindow = { start: inputs.new_start, end: inputs.new_end };

    const affected = [...proposed.entries()]
      .filter(([id, dates]) => {
        const before = published.get(id);
        return !before || before.start !== dates.start || before.end !== dates.end;
      })
      .map(([id, dates]) => {
        const before = published.get(id) ?? dates;
        return {
          task_id: id,
          name: dates.name,
          published_start: before.start,
          published_end: before.end,
          proposed_start: dates.start,
          proposed_end: dates.end,
        };
      });

    // Resources whose work moved, plus the equipment itself (its rental window moved).
    const resourceIds = new Set<number>([booking.resourceId]);
    for (const change of affected) {
      const changed = scenario.taskStore.getById(change.task_id) as unknown as { assignments: { resource?: { id: unknown } | null }[] };
      for (const assignment of changed.assignments) {
        if (typeof assignment.resource?.id === 'number') {
          resourceIds.add(assignment.resource.id);
        }
      }
    }
    const overAllocations: OverAllocation[] = [];
    for (const resourceId of [...resourceIds].sort((a, b) => a - b)) {
      const after = overAllocatedDays(scenario, resourceId, resourceId === booking.resourceId ? { taskId: booking.taskId, window: proposedWindow } : null);
      const before = publishedOverAllocations.get(resourceId);
      const introduced = [...after].filter((day) => !before?.has(day));
      if (introduced.length > 0) {
        overAllocations.push({ resource_id: resourceId, intervals: toIntervals(introduced) });
      }
    }

    const publishedBillableDays = rentalDays(publishedWindow.start, publishedWindow.end);
    const revisedBillableDays = rentalDays(proposedWindow.start, proposedWindow.end);
    const proposedTask = datesOf(task) ?? { start: inputs.new_start, end: inputs.new_end };
    const idleRevised = idleRentalDays(proposedWindow, proposedTask);
    const bookingDays = {
      published_billable_days: publishedBillableDays,
      revised_billable_days: revisedBillableDays,
      avoided_billable_days: Math.max(publishedBillableDays - revisedBillableDays, 0),
      revised_idle_days: idleRevised.before + idleRevised.after,
    };

    // Nothing is paid yet: the supplier is paid the revised rental.
    const costs = compareCosts({
      currency: booking.currency,
      rentalRateMinor: booking.rentalRateMinor,
      bookedDays: publishedBillableDays,
      revisedDays: revisedBillableDays,
    });

    return Evaluation.parse({
      source_revision: options.sourceRevision,
      inputs,
      assumptions: options.assumptions,
      schedule_impact: {
        handover: {
          published_end: publishedHandover,
          proposed_end: proposedHandover,
          delta_days: daysBetween(publishedHandover, proposedHandover),
        },
        affected_tasks: affected,
        over_allocations: overAllocations,
      },
      cost_comparison: toCostComparisonRecord(costs),
      booking_days: bookingDays,
      unresolved_assumptions: unresolvedAssumptionKeys(options.assumptions),
      evaluated_at: (options.now ?? (() => new Date()))().toISOString(),
    });
  } finally {
    scenario.destroy();
  }
}

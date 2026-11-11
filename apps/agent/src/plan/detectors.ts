/**
 * Deterministic issue finders over a PlanSnapshot. No model is involved: these run on every
 * trigger (cheaply), produce a stable fingerprint per issue, and say whether the issue is worth
 * raising. The model only decides how to phrase it and what to do next.
 *
 *   idle_equipment  equipment booked (not paid yet) for working days its activity cannot use it
 *   over_budget     forecast above budget, split into money already spent and money still open
 *   late_task       a task finishing after its baseline (and the handover with it)
 *   double_booked   a crew or machine needed above 100% on the same working day
 */
import { addDays, idleRentalDays, withinBuffer } from '@collab/shared';
import { countWorkingDays, isWorkingDay } from '@collab/shared/seed';
import { day, lastDay, plural, usd } from './format';
import { neededOn, resourceById, taskById, type PlanBooking, type PlanSnapshot, type PlanTask } from './snapshot';

export type IssueKind = 'idle_equipment' | 'over_budget' | 'late_task' | 'double_booked';

export interface Issue {
  /** Stable fingerprint: the same situation always yields the same id; a material change yields a new one. */
  id: string;
  kind: IssueKind;
  title: string;
  severity: 'high' | 'medium' | 'low';
  /** Money involved in the issue (minor units). */
  at_stake_minor: number;
  /** Money that can still be saved by acting now. */
  avoidable_minor: number;
  /** Whether a known fix exists (e.g. new rental dates). */
  remedy: string | null;
  /** Act before this day, or the chance is gone. */
  act_before: string | null;
  /** The code-level verdict: avoidable money above the threshold, a remedy, and still time. */
  worth_raising: boolean;
  why: string;
  task_ids: number[];
  booking_id: string | null;
  /** Another issue that already explains this one (raised instead of it). */
  explained_by: string | null;
  facts: Record<string, string | number | boolean | null>;
}

/** Money still avoidable below which an issue is not raised. */
export const RAISE_THRESHOLD_MINOR = 50000;

function drivingPredecessor(plan: PlanSnapshot, task: PlanTask): PlanTask | null {
  const predecessors = plan.dependencies
    .filter((dependency) => dependency.to === task.id)
    .map((dependency) => plan.tasks.find((candidate) => candidate.id === dependency.from))
    .filter((candidate): candidate is PlanTask => candidate !== undefined);
  return predecessors.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))[0] ?? null;
}

export function idleEquipment(plan: PlanSnapshot, booking: PlanBooking): Issue | null {
  const task = taskById(plan, booking.taskId);
  const resource = resourceById(plan, booking.resourceId);
  const { before, after } = idleRentalDays({ start: booking.billableStart, end: booking.billableEnd }, task);
  const idleDays = before + after;
  // Up to two working days of cover either side is how a machine should be booked: nothing to raise.
  if (idleDays === 0 || withinBuffer({ start: booking.billableStart, end: booking.billableEnd }, task, (date) => isWorkingDay(date, resource.calendar))) return null;
  const idleCost = idleDays * booking.rentalRateMinor;
  // Nothing is paid until the rental is confirmed: before it starts, every idle day can still be dropped.
  const stillTime = plan.statusDate < booking.billableStart;
  const avoidable = stillTime ? idleCost : 0;
  const worth = stillTime && avoidable >= RAISE_THRESHOLD_MINOR;
  const driver = drivingPredecessor(plan, task);
  return {
    id: `idle_equipment:${booking.id}:${booking.billableStart}:${booking.billableEnd}:${task.start}:${booking.rentalRateMinor}`,
    kind: 'idle_equipment',
    title: `${resource.name} booked but idle for ${plural(idleDays, 'day')}`,
    severity: idleCost >= 200000 ? 'high' : 'medium',
    at_stake_minor: idleCost,
    avoidable_minor: avoidable,
    remedy: stillTime ? `Cut the rental to the work and a sensible cover around it; nothing is paid yet, so ${booking.supplierName} is paid only for the days kept.` : null,
    act_before: booking.billableStart,
    worth_raising: worth,
    why: worth
      ? `Nothing is paid yet and the rental only starts on ${day(booking.billableStart)}, so new dates save the ${usd(avoidable)} of idle rental.`
      : !stillTime
        ? 'The rental has already started; the idle days are spent.'
        : 'The idle rental is too small to raise.',
    task_ids: [task.id],
    booking_id: booking.id,
    explained_by: null,
    facts: {
      equipment: resource.name,
      supplier: booking.supplierName,
      activity: task.name,
      activity_task_id: task.id,
      rental_rate_minor: booking.rentalRateMinor,
      rental_from: booking.billableStart,
      rental_to_last_day: lastDay(booking.billableEnd),
      activity_starts: task.start,
      activity_last_day: lastDay(task.end),
      idle_days_before_start: before,
      idle_days_after_finish: after,
      idle_cost_minor: idleCost,
      held_up_by: driver ? `${driver.name} (finishes ${day(lastDay(driver.end))})` : null,
    },
  };
}

export function overBudget(plan: PlanSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const task of plan.tasks) {
    if (!task.isLeaf || task.forecastMinor <= task.budgetMinor) continue;
    const overrun = task.forecastMinor - task.budgetMinor;
    const spent = Math.min(overrun, Math.max(0, task.incurredMinor - task.budgetMinor));
    const open = task.percentDone >= 100 ? 0 : overrun - spent;
    issues.push({
      id: `over_budget:${task.id}:${task.budgetMinor}:${task.forecastMinor}`,
      kind: 'over_budget',
      title: `${task.name} forecast ${usd(overrun)} over budget`,
      severity: overrun >= 500000 ? 'medium' : 'low',
      at_stake_minor: overrun,
      avoidable_minor: 0,
      remedy: null,
      act_before: null,
      worth_raising: false,
      why: task.percentDone >= 100 || open === 0 ? 'The work is done and the money is spent.' : 'No known way to recover it; keep an eye on it.',
      task_ids: [task.id],
      booking_id: null,
      explained_by: null,
      facts: {
        task: task.name,
        phase: task.phase,
        budget_minor: task.budgetMinor,
        forecast_minor: task.forecastMinor,
        overrun_minor: overrun,
        already_spent_minor: spent,
        still_open_minor: open,
        percent_done: task.percentDone,
      },
    });
  }
  return issues;
}

export function lateTasks(plan: PlanSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const task of plan.tasks) {
    if (!task.isLeaf || !task.baselineEnd || task.end <= task.baselineEnd) continue;
    const slip = countWorkingDays(task.baselineEnd, task.end, task.calendar);
    if (slip === 0) continue;
    const isHandover = task.id === plan.handoverTaskId;
    issues.push({
      id: `late_task:${task.id}:${task.baselineEnd}:${task.end}`,
      kind: 'late_task',
      title: `${task.name} finishes ${plural(slip, 'working day')} late`,
      severity: isHandover ? 'high' : 'low',
      at_stake_minor: 0,
      avoidable_minor: 0,
      remedy: null,
      act_before: null,
      worth_raising: isHandover,
      why: `${isHandover ? 'The handover' : 'It'} now lands on ${day(task.isMilestone ? task.start : lastDay(task.end))} instead of ${day(task.isMilestone ? (task.baselineStart ?? task.baselineEnd) : lastDay(task.baselineEnd))}.`,
      task_ids: [task.id],
      booking_id: null,
      explained_by: null,
      facts: { task: task.name, planned_last_day: lastDay(task.baselineEnd), now_last_day: lastDay(task.end), slip_working_days: slip },
    });
  }
  return issues;
}

function workDays(task: PlanTask): string[] {
  const spans = task.segments ?? [{ start: task.start, end: task.end }];
  const days: string[] = [];
  for (const span of spans) {
    for (let date = span.start; date < span.end; date = addDays(date, 1)) {
      if (isWorkingDay(date, task.calendar)) days.push(date);
    }
  }
  return days;
}

export function doubleBooked(plan: PlanSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const resource of plan.resources) {
    const load = new Map<string, { units: number; tasks: number[] }>();
    for (const assignment of plan.assignments.filter((candidate) => candidate.resourceId === resource.id)) {
      const task = plan.tasks.find((candidate) => candidate.id === assignment.taskId);
      if (!task || task.isMilestone) continue;
      for (const date of workDays(task).filter((candidate) => neededOn(assignment, candidate))) {
        const entry = load.get(date) ?? { units: 0, tasks: [] };
        entry.units += assignment.units;
        entry.tasks.push(task.id);
        load.set(date, entry);
      }
    }
    const clashes = [...load.entries()].filter(([, entry]) => entry.units > 100).sort(([a], [b]) => (a < b ? -1 : 1));
    if (clashes.length === 0) continue;
    const taskIds = [...new Set(clashes.flatMap(([, entry]) => entry.tasks))];
    issues.push({
      id: `double_booked:${resource.id}:${clashes.map(([date]) => date).join(',')}`,
      kind: 'double_booked',
      title: `${resource.name} needed twice on ${plural(clashes.length, 'day')}`,
      severity: 'medium',
      at_stake_minor: 0,
      avoidable_minor: 0,
      remedy: null,
      act_before: clashes[0]?.[0] ?? null,
      worth_raising: true,
      why:
        resource.kind === 'equipment'
          ? 'The same machine cannot be in two places. Move one of the tasks, change the dates of the machine on one of them, or rent a second machine.'
          : 'The same crew cannot be in two places; one of the tasks will slip.',
      task_ids: taskIds,
      booking_id: null,
      explained_by: null,
      facts: { resource: resource.name, first_clash: clashes[0]?.[0] ?? null, clash_days: clashes.length, tasks: taskIds.join(', ') },
    });
  }
  return issues;
}

/** Every issue, the ones worth raising first, then by money that can still be saved. */
export function findIssues(plan: PlanSnapshot, kinds?: IssueKind[]): Issue[] {
  const idle = plan.bookings.map((booking) => idleEquipment(plan, booking)).filter((issue): issue is Issue => issue !== null);
  const all = [...idle, ...overBudget(plan), ...lateTasks(plan), ...doubleBooked(plan)];
  // An overrun on the booked activity that equals the idle rental is the same money: point at the idle issue.
  for (const issue of all) {
    if (issue.kind !== 'over_budget') continue;
    const explained = idle.find((candidate) => candidate.task_ids.includes(issue.task_ids[0] ?? -1) && candidate.at_stake_minor === issue.at_stake_minor);
    if (explained) {
      issue.explained_by = explained.id;
      issue.why = 'This overrun is the idle crane rental; fixing the booking removes it.';
    }
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return all
    .filter((issue) => !kinds || kinds.includes(issue.kind))
    .sort(
      (a, b) =>
        Number(b.worth_raising) - Number(a.worth_raising) ||
        b.avoidable_minor - a.avoidable_minor ||
        rank[a.severity] - rank[b.severity] ||
        b.at_stake_minor - a.at_stake_minor ||
        (a.id < b.id ? -1 : 1),
    );
}

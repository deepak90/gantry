/**
 * What a watch rule found about rented equipment, one row per rental, read from the live plan each
 * time it changes: the problem, what to do about it and where the rental stands. The answer is worked out here
 * so the numbers are always the plan's own:
 *
 *   booked twice  the work moves to when the machine is free, for the same number of working days
 *   idle          the rental is cut to the work and a sensible cover around it (suggestRental)
 *
 * Accepting one is an ordinary change to the plan, which Undo takes back. Moving work moves whatever waits for it, so
 * accepting one changes what the next row says. That is the point of drawing the rows live rather than from what the
 * rule saw when it fired. Nothing here is a step on the way to paying: paying pays the dates as they stand.
 */
import type { CalendarModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import { addDays, daysBetween, evaluateWatch, rentalDays, shortDay, suggestRental, toDateOnly, type CurrencyCode, type EquipmentBookingRow, type RentalOption, type WatchAlert, type WatchDismissalRow, type WatchPlan, type WatchRuleRow } from '@collab/shared';
import { type BookingFacts, endAfterWorkingDays, equipmentCalendar, firstWorkingDay, isWorkingDay, readBookingFacts, workingDays } from '../scenario/booking';
import type { WorkflowSnapshot } from './api';
import { rentalStanding, type RentalStanding } from './rental';

export type RentalRowState = 'open' | 'declined' | 'accepted' | 'paying' | 'paid' | 'failed';

/** One way of changing a rental: its dates, and for a machine booked twice, the day its work moves to. */
export interface RentalFix {
  label: string;
  start: string;
  /** Exclusive. */
  end: string;
  days: number;
  costMinor: number;
  /** Against the rental as it stands now; negative when this one is longer. */
  savingMinor: number;
  /** The work waits until this day. */
  moveWorkTo: string | null;
}

export interface RentalRow {
  booking: EquipmentBookingRow;
  equipment: string;
  taskName: string;
  /** What to show in the plan for this row. */
  taskIds: number[];
  problem: 'twice' | 'idle' | null;
  title: string;
  detail: string;
  /** Rental days with no work planned, before the work or after it, right now. */
  idleDays: number;
  idleCostMinor: number;
  /** What to do about it (null once there is nothing left to fix). */
  fix: RentalFix | null;
  /** The other way worth weighing. */
  alternative: RentalFix | null;
  /** What the rule raised about this rental, to dismiss when it is declined. */
  alert: WatchAlert | null;
  state: RentalRowState;
  standing: RentalStanding;
}

/** What is wrong with the rental's dates, on whichever side of the work it is. */
function idleDetail(booking: EquipmentBookingRow, facts: BookingFacts): string {
  const lastRented = shortDay(addDays(booking.billable_end, -1));
  const lastWorked = shortDay(addDays(facts.taskEnd, -1));
  if (facts.idleAfter === 0) return `On rent from ${shortDay(booking.billable_start)}, but ${facts.taskName} starts ${shortDay(facts.taskStart)}.`;
  if (facts.idleBefore === 0) return `On rent until ${lastRented}, but ${facts.taskName} ends ${lastWorked}.`;
  return `On rent ${shortDay(booking.billable_start)} to ${lastRented}, but ${facts.taskName} runs ${shortDay(facts.taskStart)} to ${lastWorked}.`;
}

export interface RentalReview {
  rows: RentalRow[];
  /** What the changed rentals save against their quotes (negative: they got longer). */
  savedMinor: number;
  /** How far the handover has moved from the baseline, in calendar days. */
  handoverDays: number;
  /** Rentals with new dates that nobody has paid yet. */
  payable: RentalRow[];
  paidMinor: number;
  paidCount: number;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function taskName(project: ProjectModel, id: number): string {
  return (project.taskStore.getById(id) as TaskModel | undefined)?.name ?? `task ${id}`;
}

function endOf(project: ProjectModel, id: number): string | null {
  const end = (project.taskStore.getById(id) as TaskModel | undefined)?.endDate;
  return end instanceof Date ? toDateOnly(end) : null;
}

function bookingFacts(project: ProjectModel, booking: EquipmentBookingRow) {
  return readBookingFacts(project, { taskId: booking.task_id, resourceId: booking.resource_id, billableStart: booking.billable_start, billableEnd: booking.billable_end });
}

const asFix = (option: RentalOption): RentalFix => ({ label: option.label, start: option.start, end: option.end, days: option.days, costMinor: option.costMinor, savingMinor: option.savingMinor, moveWorkTo: null });

/** The fix for a machine booked twice: this work waits until the other work is done, with the machine for the same working days. */
function twiceFix(project: ProjectModel, booking: EquipmentBookingRow, calendar: CalendarModel, alert: WatchAlert): RentalFix | null {
  const others = alert.taskIds.filter((id) => id !== booking.task_id);
  const ends = others.map((id) => endOf(project, id)).filter((end): end is string => end !== null).sort();
  const free = ends.at(-1);
  if (!free) return null;
  const start = firstWorkingDay(calendar, free);
  const working = workingDays(project, calendar, booking.billable_start, booking.billable_end);
  const end = endAfterWorkingDays(calendar, start, Math.max(1, working));
  const days = rentalDays(start, end);
  const costMinor = days * booking.rental_rate_minor;
  return { label: 'Move the work', start, end, days, costMinor, savingMinor: rentalDays(booking.billable_start, booking.billable_end) * booking.rental_rate_minor - costMinor, moveWorkTo: start };
}

/** Days the last milestone has moved from where the baseline had it. */
function handoverSlip(project: ProjectModel): number {
  let last: (TaskModel & { baselines?: { first?: { startDate?: Date } } }) | null = null;
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    if (task.isMilestone && task.startDate instanceof Date && (!last || task.startDate > (last.startDate as Date))) last = task;
  }
  const baseline = last?.baselines?.first?.startDate;
  return last && baseline instanceof Date ? daysBetween(toDateOnly(baseline), toDateOnly(last.startDate as Date)) : 0;
}

export interface ReviewInput {
  snapshot: WorkflowSnapshot;
  project: ProjectModel;
  rule: WatchRuleRow;
  plan: WatchPlan;
  dismissals: readonly WatchDismissalRow[];
  currency: CurrencyCode;
}

export function rentalReview({ snapshot, project, rule, plan, dismissals, currency }: ReviewInput): RentalReview {
  const raised = evaluateWatch([rule], plan, { canViewCosts: true, currency });
  const declined = new Set(dismissals.filter((row) => row.rule_id === rule.id).map((row) => row.fingerprint));
  const rows: RentalRow[] = [];
  for (const booking of [...snapshot.bookings].sort((a, b) => a.billable_start.localeCompare(b.billable_start))) {
    let facts: ReturnType<typeof bookingFacts>;
    try {
      facts = bookingFacts(project, booking);
    } catch {
      continue; // The booked task or machine is gone from the plan.
    }
    const about = raised.filter((alert) => alert.taskIds.includes(booking.task_id));
    const twice = about.find((alert) => alert.condition === 'crew_overbooked') ?? null;
    const idle = about.find((alert) => alert.condition === 'idle_rental') ?? null;
    const alert = twice ?? idle;
    const standing = rentalStanding(snapshot, booking);
    if (!alert && !standing.changed && standing.pay === 'unpaid') continue;

    const isDeclined = alert !== null && declined.has(alert.fingerprint);
    const state: RentalRowState =
      standing.pay === 'paid' ? 'paid' : standing.pay === 'paying' ? 'paying' : standing.pay === 'failed' ? 'failed' : alert && !isDeclined ? 'open' : isDeclined ? 'declined' : 'accepted';

    let title = `${facts.resourceName}: fixed`;
    let detail = `On rent for the days ${facts.taskName} needs.`;
    let fix: RentalFix | null = null;
    let alternative: RentalFix | null = null;
    if (twice) {
      fix = twiceFix(project, booking, equipmentCalendar(project, { taskId: booking.task_id, resourceId: booking.resource_id, billableStart: booking.billable_start, billableEnd: booking.billable_end }), twice);
      const others = twice.taskIds.filter((id) => id !== booking.task_id).map((id) => taskName(project, id));
      title = `${facts.resourceName} booked twice`;
      detail = `${facts.taskName} overlaps ${others.join(' and ')}. ${fix ? `Move it to ${shortDay(fix.start)}, when the ${facts.resourceName.toLowerCase()} is free.` : ''}`.trim();
    } else if (idle) {
      const calendar = equipmentCalendar(project, { taskId: booking.task_id, resourceId: booking.resource_id, billableStart: booking.billable_start, billableEnd: booking.billable_end });
      const choice = suggestRental({
        rental: { start: booking.billable_start, end: booking.billable_end },
        work: { start: facts.taskStart, end: facts.taskEnd },
        rateMinor: booking.rental_rate_minor,
        isWorkingDay: (day) => isWorkingDay(calendar, day),
      });
      fix = choice.recommended && asFix(choice.recommended);
      const other = choice.alternatives.find((option) => option.key === 'just_the_work') ?? choice.alternatives.find((option) => option.key === 'either_side') ?? null;
      alternative = other && asFix(other);
      title = `${facts.resourceName} idle ${plural(facts.idleDays, 'day')}`;
      detail = idleDetail(booking, facts);
    }
    rows.push({
      booking,
      equipment: facts.resourceName,
      taskName: facts.taskName,
      taskIds: twice ? twice.taskIds : [booking.task_id],
      problem: twice ? 'twice' : idle ? 'idle' : null,
      title,
      detail,
      idleDays: facts.idleDays,
      idleCostMinor: facts.idleDays * booking.rental_rate_minor,
      fix,
      alternative,
      alert,
      state,
      standing,
    });
  }

  const changed = rows.filter((row) => row.state !== 'open' && row.state !== 'declined');
  return {
    rows,
    savedMinor: changed.reduce((sum, row) => sum + row.standing.savedMinor, 0),
    handoverDays: changed.length > 0 ? handoverSlip(project) : 0,
    payable: rows.filter((row) => row.state === 'accepted' || row.state === 'failed'),
    paidMinor: rows.filter((row) => row.state === 'paid').reduce((sum, row) => sum + (row.standing.payment?.amount_minor ?? 0), 0),
    paidCount: rows.filter((row) => row.state === 'paid').length,
  };
}

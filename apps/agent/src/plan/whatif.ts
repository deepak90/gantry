/**
 * What a rental could be, for the assistant: the ways of renting a machine around its work, each worked out on the
 * machine's own calendar and priced by the day, so nobody retypes a date or does a sum. The model turns what someone says
 * ("a day either side", "two days before") into the numbers it passes here; the dates and the money come from here.
 * Nothing live changes: an option carries the plan edit that would put it in, for a person to apply.
 */
import { addDays, paddedRental, rentalDays, rentalOption, suggestRental, type PlanEditOp, type RentalChoiceInput, type RentalOption, type RentalSpan } from '@collab/shared';
import { isWorkingDay } from '@collab/shared/seed';
import { scheduleFloat } from './analysis';
import { day, lastDay, usd } from './format';
import { bookingById, resourceById, taskById, type PlanBooking, type PlanSnapshot } from './snapshot';

export interface RentalAsk {
  bookingId?: string | undefined;
  /** Days of cover before the work and after it, counted as `padIn` says (working days unless said otherwise). */
  padBefore?: number | undefined;
  padAfter?: number | undefined;
  /** How the cover was asked for: calendar days ("a day either side", weekends included) or working days. */
  padIn?: 'working' | 'calendar' | undefined;
  /** Dates someone named; the last day is included. */
  firstDay?: string | undefined;
  lastDay?: string | undefined;
}

export interface DescribedOption {
  label: string;
  first_day: string;
  last_day: string;
  days: number;
  cost_minor: number;
  /** Against the rental as it stands now; negative when longer. */
  saving_minor: number;
  idle_days_before: number;
  idle_days_after: number;
  /** Weekend or shutdown days paid for only because the cover runs over them. */
  days_off_paid_for_cover: number;
  /** Whether the rental still covers every day of the work. */
  covers_the_work: boolean;
  /** Pass this to draft_plan_edit as it is. */
  op: Extract<PlanEditOp, { op: 'set_rental' }>;
  text: { from: string; last_day: string; cost: string; change: string };
}

export interface RentalChoices {
  booking_id: string;
  equipment: string;
  supplier: string;
  activity: { task_id: number; name: string; first_day: string; last_day: string; slack_days: number | null; held_up_by: string | null };
  now: { first_day: string; last_day: string; days: number; cost_minor: number; idle_days_before: number; idle_days_after: number; text: { from: string; last_day: string; cost: string } };
  /** What was asked for, worked out; null when they asked for nothing in particular. */
  asked: DescribedOption | null;
  recommended: DescribedOption | null;
  alternatives: DescribedOption[];
  how_days_count: string;
}

function drivingPredecessor(plan: PlanSnapshot, taskId: number): { name: string; end: string } | null {
  const before = plan.dependencies.filter((dependency) => dependency.to === taskId).map((dependency) => plan.tasks.find((task) => task.id === dependency.from));
  const latest = before.filter((task) => task !== undefined).sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))[0];
  return latest ? { name: latest.name, end: latest.end } : null;
}

export function bookingChoiceInput(plan: PlanSnapshot, booking: PlanBooking): RentalChoiceInput {
  const task = taskById(plan, booking.taskId);
  const resource = resourceById(plan, booking.resourceId);
  return {
    rental: { start: booking.billableStart, end: booking.billableEnd },
    work: { start: task.start, end: task.end },
    rateMinor: booking.rentalRateMinor,
    isWorkingDay: (date) => isWorkingDay(date, resource.calendar),
  };
}

export function rentalChoices(plan: PlanSnapshot, ask: RentalAsk = {}): RentalChoices {
  const booking = bookingById(plan, ask.bookingId);
  const task = taskById(plan, booking.taskId);
  const resource = resourceById(plan, booking.resourceId);
  const input = bookingChoiceInput(plan, booking);
  const describe = (option: RentalOption): DescribedOption => ({
    label: option.label,
    first_day: option.start,
    last_day: lastDay(option.end),
    days: option.days,
    cost_minor: option.costMinor,
    saving_minor: option.savingMinor,
    idle_days_before: option.idle.before,
    idle_days_after: option.idle.after,
    days_off_paid_for_cover: option.offDaysInCover,
    covers_the_work: option.start <= task.start && option.end >= task.end,
    op: { op: 'set_rental', task: task.id, machine: resource.name, first_day: option.start, last_day: lastDay(option.end) },
    text: {
      from: day(option.start),
      last_day: day(lastDay(option.end)),
      cost: usd(option.costMinor),
      change: option.savingMinor > 0 ? `saves ${usd(option.savingMinor)}` : option.savingMinor < 0 ? `costs ${usd(-option.savingMinor)} more` : 'costs the same',
    },
  });

  let asked: RentalOption | null = null;
  if (ask.firstDay || ask.lastDay) {
    const span: RentalSpan = { start: ask.firstDay ?? booking.billableStart, end: ask.lastDay ? addDays(ask.lastDay, 1) : booking.billableEnd };
    asked = rentalOption('as_asked', 'As asked', span, input);
  } else if (ask.padBefore != null || ask.padAfter != null) {
    const counts = ask.padIn === 'calendar' ? () => true : input.isWorkingDay;
    asked = rentalOption('as_asked', 'As asked', paddedRental(input.work, { before: ask.padBefore ?? 0, after: ask.padAfter ?? 0 }, counts), input);
  }
  const choice = suggestRental(input);
  const driver = drivingPredecessor(plan, task.id);
  const idleNow = rentalOption('as_asked', 'Now', input.rental, input);
  return {
    booking_id: booking.id,
    equipment: resource.name,
    supplier: booking.supplierName,
    activity: {
      task_id: task.id,
      name: task.name,
      first_day: task.start,
      last_day: lastDay(task.end),
      slack_days: scheduleFloat(plan)[task.id]?.float_days ?? null,
      held_up_by: driver ? `${driver.name} (finishes ${day(lastDay(driver.end))})` : null,
    },
    now: {
      first_day: booking.billableStart,
      last_day: lastDay(booking.billableEnd),
      days: rentalDays(booking.billableStart, booking.billableEnd),
      cost_minor: idleNow.costMinor,
      idle_days_before: idleNow.idle.before,
      idle_days_after: idleNow.idle.after,
      text: { from: day(booking.billableStart), last_day: day(lastDay(booking.billableEnd)), cost: usd(idleNow.costMinor) },
    },
    asked: asked && describe(asked),
    recommended: choice.recommended && describe(choice.recommended),
    alternatives: choice.alternatives.map(describe),
    how_days_count: 'A rental is paid for every calendar day on rent, weekends included. Cover is counted in working days of the machine, so a day before a Monday start is the Friday, and the weekend is paid too.',
  };
}

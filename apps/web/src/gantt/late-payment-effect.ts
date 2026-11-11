/**
 * What waiting for the Friday pay run would do, for the assistant (`late_payment_effect`): the engine's answer from a
 * branch (gantt/late-payment.ts), drawn on the chart while it is said (gantt/pay-late-preview.ts). Nothing in the plan
 * changes. A task that has to wait out something on its own calendar, such as an inspector who is away, is named.
 * The pay run is the first Friday the money can go: on or after the day it falls due, and never before the plan's
 * today (plan-clock.ts), as the odds have it.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { LatePaymentEffect } from '@collab/shared';
import { dueDay, forecastLatePayment, latePaymentPositions } from './late-payment';
import { gateIndex } from './pay-gates';
import { showPayLatePreview } from './pay-late-preview';
import { planClock } from '../plan-clock';

const DAY_MS = 86_400_000;
const label = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function iso(date: Date | null | undefined): string | null {
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The Friday on or after a day: the weekly pay run. */
function payRun(due: Date): Date {
  const day = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  day.setDate(day.getDate() + ((5 - day.getDay() + 7) % 7));
  return day;
}

interface CalendarInterval {
  name?: string;
  cls?: string | { toString(): string };
  isWorking?: boolean;
  startDate?: Date | null;
  endDate?: Date | null;
}

/** The first task that moves across a stretch its own calendar marks as a band, with the stretch. */
export function waitsFor(project: ProjectModel, positions: ReadonlyMap<number | string, { start: Date; end: Date }>): LatePaymentEffect['waits_for'] {
  for (const [id, position] of positions) {
    const task = project.taskStore.getById(id) as TaskModel | undefined;
    if (!task || !(task.startDate instanceof Date)) continue;
    const calendar = (task as unknown as { calendar?: { intervalStore?: { allRecords: CalendarInterval[] } } | null }).calendar;
    const interval = calendar?.intervalStore?.allRecords.find(
      (each) => String(each.cls ?? '').includes('look-calendar-band') && each.startDate instanceof Date && each.endDate instanceof Date && each.startDate >= task.startDate! && each.endDate <= position.start,
    );
    if (!interval?.startDate || !interval.endDate) continue;
    return { task: task.name ?? '', why: interval.name ?? 'Unavailable', from: iso(interval.startDate)!, until: iso(new Date(interval.endDate.getTime() - DAY_MS))!, now_on: iso(position.start)! };
  }
  return null;
}

/**
 * Works out what the pay run would do to the first payment still holding work, and draws it. `today` is the plan's
 * today unless given: a payment can't go before it.
 */
export async function latePaymentEffect(project: ProjectModel, options: { today?: Date } = {}): Promise<LatePaymentEffect | null> {
  const gate = [...gateIndex(project).gates.values()].find((each) => each.holding) ?? null;
  const due = gate ? dueDay(gate) : null;
  if (!gate || !due) return null;
  const today = options.today ?? planClock.today();
  const paidOn = payRun(today > due ? today : due);
  const forecast = await forecastLatePayment(project, gate, [Math.round((paidOn.getTime() - due.getTime()) / DAY_MS)]);
  const late = forecast?.cases[0];
  if (!forecast || !late) return null;
  const positions = await latePaymentPositions(project, gate, paidOn);
  showPayLatePreview(positions, `Paid ${label.format(paidOn)}`);
  const effect: LatePaymentEffect = {
    held: gate.holds.map((row) => row.name).join(', '),
    due: iso(due)!,
    paid_on: iso(paidOn)!,
    starts_on_time: iso(forecast.onTime.heldStart),
    starts_if_late: iso(late.heldStart),
    handover_on_time: iso(forecast.onTime.handover),
    handover_if_late: iso(late.handover),
    slip_days: late.handoverSlip,
    working_days_lost: late.workingDaysLost,
    holidays: late.holidays,
    waits_for: waitsFor(project, positions),
  };
  window.dispatchEvent(new CustomEvent('late-payment-effect', { detail: effect }));
  return effect;
}

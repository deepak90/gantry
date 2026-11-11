/**
 * Which dates a machine on a task goes by, for the Equipment cell, the outline on the Gantt and the
 * cell's editor. Every machine on a task draws its own dates there, double booked or not; what that means
 * is for the assistant or the viewer to work out. With no dates of its own it goes by the rental booked
 * on that task, else by the task's days. A rental belongs to one machine on one task: other tasks using
 * the machine have their own dates and pay nobody.
 * Pure: reads a snapshot and a ProjectModel, writes nothing. The database enforces the same locks
 * (supabase/migrations/20261102040000_rental_dates_per_task.sql).
 */
import type { AssignmentModel, CalendarModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { addDays, idleRentalDays, rentalDays, toDateOnly, withinBuffer, type CurrencyCode, type DateOnly, type EquipmentBookingRow, type PaymentAuthorizationRow } from '@collab/shared';
import { equipmentOf, lastWorkingDay, original, type RentalSpan } from '../gantt/look';
import { MONEY_MOVING } from '../gantt/payment-lock';
import type { CollabAssignment } from '../gantt/project';
import { equipmentCalendar, isWorkingDay } from '../scenario/booking';
import type { WorkflowSnapshot } from './api';

/** New dates for a machine on a task; a date left out stays as it is. The end is exclusive. */
export interface RentalDates {
  rentalStart?: DateOnly;
  rentalEnd?: DateOnly;
}

export interface RentalEdit {
  /** The machine on this task, which holds the dates. */
  assignmentId: number | string;
  /** The rental booked for it on this task; null when nothing is booked, so the dates pay nobody. */
  bookingId: string | null;
  resourceId: number;
  equipment: string;
  supplier: string;
  start: DateOnly;
  /** Exclusive. */
  end: DateOnly;
  /** Per calendar day; null without a rental, or for viewers who may not see costs. */
  rateMinor: number | null;
  currency: CurrencyCode;
  taskName: string;
  taskStart: DateOnly;
  /** Exclusive. */
  taskEnd: DateOnly;
  /** Why the dates cannot change right now, in words for the editor. */
  locked: string | null;
  /** Every calendar day of [start, end): a rental is paid by the day, weekends too. */
  rentalDays(start: DateOnly, end: DateOnly): number;
  /** Days of [start, end) with no work planned, on each side of the task's days. */
  idleDays(start: DateOnly, end: DateOnly): { before: number; after: number };
  /** Those days come to no more than a working day of cover either side: a sensible rental, not a problem. */
  isBuffer(start: DateOnly, end: DateOnly): boolean;
  /** Days of [start, end) inside the task's days that its crews are off: paid, and no dates would take them away. */
  offDays(start: DateOnly, end: DateOnly): number;
}

/** Why money depends on the rental's dates as they stand, or null. */
function lockReason(snapshot: WorkflowSnapshot, booking: EquipmentBookingRow): string | null {
  const proposals = new Set(snapshot.proposals.filter((proposal) => proposal.booking_id === booking.id).map((proposal) => proposal.id));
  const versions = new Set(snapshot.versions.filter((version) => proposals.has(version.proposal_id)).map((version) => version.id));
  if (snapshot.payments.some((payment) => versions.has(payment.proposal_version_id) && MONEY_MOVING.has(payment.status))) {
    return `PayPal is paying ${booking.supplier_name} for this rental. The dates unlock as soon as PayPal confirms.`;
  }
  return null;
}

/** The days a task covers, the end exclusive; null for a task with no dates. */
function daysOf(task: TaskModel): { start: DateOnly; end: DateOnly } | null {
  const last = lastWorkingDay(task);
  if (!(task.startDate instanceof Date) || Number.isNaN(last.getTime())) return null;
  return { start: toDateOnly(task.startDate), end: addDays(toDateOnly(last), 1) };
}

const companyOf = (machine: ResourceModel) => (machine as ResourceModel & { company?: string }).company ?? '';

/** Why these dates cannot change right now (the undo of an earlier change included), or null: only a rental's own task has money behind it. */
export function rentalLockOf(snapshot: WorkflowSnapshot, taskId: number, resourceId: number): string | null {
  const booking = snapshot.bookings.find((candidate) => candidate.task_id === taskId && candidate.resource_id === resourceId);
  return booking ? lockReason(snapshot, booking) : null;
}

interface MachineOnTask {
  machine: ResourceModel;
  assignment: CollabAssignment;
  booking: EquipmentBookingRow | null;
}

/** Every machine on a task, each with what holds its dates and its rental there, if it has one. */
function machinesOnTask(snapshot: WorkflowSnapshot | null, task: TaskModel): MachineOnTask[] {
  const record = original(task);
  const assignments = (record.assignments ?? []) as AssignmentModel[];
  return equipmentOf(record).flatMap((machine) => {
    const assignment = assignments.find((candidate) => (candidate.resource as ResourceModel | null)?.id === machine.id);
    if (!assignment) return [];
    const booking = snapshot?.bookings.find((candidate) => candidate.task_id === record.id && candidate.resource_id === machine.id) ?? null;
    return [{ machine, assignment: assignment as CollabAssignment, booking }];
  });
}

/** The machine a task's cell stands for: the one with a rental booked on the task, else the first. */
function machineOnTask(snapshot: WorkflowSnapshot, task: TaskModel): MachineOnTask | null {
  const machines = machinesOnTask(snapshot, task);
  return machines.find((candidate) => candidate.booking) ?? machines[0] ?? null;
}

function spanOf({ machine, assignment, booking }: MachineOnTask, task: TaskModel): RentalSpan | null {
  const days = daysOf(original(task));
  const start = assignment.rentalStart ?? booking?.billable_start ?? days?.start;
  const end = assignment.rentalEnd ?? booking?.billable_end ?? days?.end;
  if (!start || !end) return null;
  return { start, end, equipment: machine.name, supplier: booking?.supplier_name ?? companyOf(machine), booked: booking !== null };
}

/** What the cell and the outline show for a task: null only when no machine is on it (or nothing dates it). */
export function rentalSpanOf(snapshot: WorkflowSnapshot, task: TaskModel): RentalSpan | null {
  const found = machineOnTask(snapshot, task);
  return found ? spanOf(found, task) : null;
}

/** The days of [start, end) inside the task's days when its calendar has no work. */
function daysOffWithin(task: TaskModel, work: { start: DateOnly; end: DateOnly }, start: DateOnly, end: DateOnly): number {
  const calendar = task.effectiveCalendar as CalendarModel;
  const [from, to] = [start > work.start ? start : work.start, end < work.end ? end : work.end];
  let count = 0;
  for (let day = from; day < to; day = addDays(day, 1)) if (!isWorkingDay(calendar, day)) count += 1;
  return count;
}

function editOf(snapshot: WorkflowSnapshot | null, project: ProjectModel, task: TaskModel, found: MachineOnTask, canViewCosts: boolean): RentalEdit | null {
  const span = spanOf(found, task);
  if (!span) return null;
  const { machine, assignment, booking } = found;
  const days = daysOf(task) ?? { start: span.start, end: span.end };
  const resourceId = machine.id as number;
  return {
    assignmentId: assignment.id as number | string,
    bookingId: booking?.id ?? null,
    resourceId,
    equipment: span.equipment,
    supplier: span.supplier,
    start: span.start,
    end: span.end,
    rateMinor: booking && canViewCosts ? booking.rental_rate_minor : null,
    currency: booking?.currency ?? 'USD',
    taskName: task.name,
    taskStart: days.start,
    taskEnd: days.end,
    locked: booking && snapshot ? lockReason(snapshot, booking) : null,
    rentalDays,
    idleDays: (start, end) => idleRentalDays({ start, end }, days),
    offDays: (start, end) => daysOffWithin(task, days, start, end),
    isBuffer: (start, end) => {
      const calendar = equipmentCalendar(project, { taskId: task.id as number, resourceId, billableStart: start, billableEnd: end });
      return withinBuffer({ start, end }, days, (day) => isWorkingDay(calendar, day));
    },
  };
}

/** What a task's Equipment cell opens, or null when no machine is on the task. */
export function rentalEditFor(snapshot: WorkflowSnapshot, project: ProjectModel, taskId: number, canViewCosts: boolean): RentalEdit | null {
  const task = project.taskStore.getById(taskId) as TaskModel | undefined;
  const found = task ? machineOnTask(snapshot, task) : null;
  return task && found ? editOf(snapshot, project, task, found, canViewCosts) : null;
}

/** Every machine on a task, for the task panel, where each can be edited; it works before the workflow has loaded. */
export function rentalEditsFor(snapshot: WorkflowSnapshot | null, project: ProjectModel, taskId: number, canViewCosts: boolean): RentalEdit[] {
  const task = project.taskStore.getById(taskId) as TaskModel | undefined;
  if (!task) return [];
  return machinesOnTask(snapshot, task).flatMap((found) => editOf(snapshot, project, task, found, canViewCosts) ?? []);
}

export type RentalPayState = 'unpaid' | 'paying' | 'failed' | 'paid';

/** Codes of refusals made before anything reached PayPal: the payment is recorded failed with the reason, and nothing was sent. */
export const REFUSED_BEFORE_PAYPAL: ReadonlySet<string> = new Set(['PAYMENTS_OFF', 'PAYEE_REFUSED', 'QUOTA_REACHED']);

/**
 * The payment a press of Send payout made, once it has gone to PayPal: not one that was there before the press
 * (`before`), not one approved and still unsent (its send failed before PayPal, so pressing again sends that same one),
 * and not one refused before PayPal (`failure` says so by its code).
 */
export function paymentSent(payment: PaymentAuthorizationRow | null, before: string | null, failure: { code?: string | null } | null): PaymentAuthorizationRow | null {
  if (!payment || payment.id === before || payment.status === 'authorized') return null;
  if (payment.status === 'failed' && !payment.paypal_batch_id && REFUSED_BEFORE_PAYPAL.has(failure?.code ?? '')) return null;
  return payment;
}

/** What a press of Send payout follows: the payment showing now, unless it is approved and still unsent (that one is sent). */
export const paymentBefore = (payment: PaymentAuthorizationRow | null): string | null => (payment && payment.status !== 'authorized' ? payment.id : null);

/** Where a rental stands: what its dates come to, against what was first quoted, and whether it is paid. */
export interface RentalStanding {
  booking: EquipmentBookingRow;
  days: number;
  costMinor: number;
  quotedCostMinor: number;
  /** What the change of dates saved against the quote; negative when the rental got longer. */
  savedMinor: number;
  changed: boolean;
  pay: RentalPayState;
  /** The payment that counts: the live or finished one, else the latest failed one. */
  payment: PaymentAuthorizationRow | null;
}

export function rentalStanding(snapshot: WorkflowSnapshot, booking: EquipmentBookingRow): RentalStanding {
  const proposals = new Set(snapshot.proposals.filter((proposal) => proposal.booking_id === booking.id).map((proposal) => proposal.id));
  const versions = new Set(snapshot.versions.filter((version) => proposals.has(version.proposal_id)).map((version) => version.id));
  const payments = snapshot.payments.filter((payment) => versions.has(payment.proposal_version_id));
  const payment = payments.find((candidate) => candidate.status !== 'failed') ?? payments[payments.length - 1] ?? null;
  const quoted = { start: booking.quoted_start ?? booking.billable_start, end: booking.quoted_end ?? booking.billable_end };
  const days = rentalDays(booking.billable_start, booking.billable_end);
  const quotedDays = rentalDays(quoted.start, quoted.end);
  return {
    booking,
    days,
    costMinor: days * booking.rental_rate_minor,
    quotedCostMinor: quotedDays * booking.rental_rate_minor,
    savedMinor: (quotedDays - days) * booking.rental_rate_minor,
    changed: quoted.start !== booking.billable_start || quoted.end !== booking.billable_end,
    // Approved and not sent yet (its send failed before PayPal) is not paying: pressing Send payout again sends it.
    pay: payment === null || payment.status === 'authorized' ? 'unpaid' : payment.status === 'succeeded' ? 'paid' : payment.status === 'failed' ? 'failed' : 'paying',
    payment,
  };
}

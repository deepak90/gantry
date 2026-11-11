/**
 * What the Gantt draws for the workflow: on every task with a machine on it, when the machine is on
 * site for it (plain facts, no verdict); and per booked task, the stretch of the rental paid for with no
 * work planned once it is more than a sensible cover, and where its payment stands.
 * Pure: reads a snapshot and a ProjectModel, writes nothing.
 */
import type { CurrencyCode } from '@collab/shared';
import { trackerBadge, type Decorations, type TaskDecoration, type Tracker, type TrackerStep, type TrackerTone } from '../gantt/look';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { readBookingFacts, type BookingFacts } from '../scenario/booking';
import type { WorkflowSnapshot } from './api';
import { receiptFor } from './model';
import { rentalSpanOf, rentalStanding, type RentalStanding } from './rental';

const STATUS: Readonly<Record<RentalStanding['pay'], { status: string; state: TrackerStep['state']; tone: TrackerTone; headline: string }>> = {
  unpaid: { status: 'Pending payment', state: 'current', tone: 'warn', headline: 'New dates in the plan, not paid yet' },
  paying: { status: 'Processing', state: 'current', tone: 'busy', headline: 'PayPal is processing the payment' },
  failed: { status: 'Payment failed', state: 'failed', tone: 'alert', headline: 'PayPal could not make the payment' },
  paid: { status: 'Paid', state: 'done', tone: 'ok', headline: 'Paid' },
};

/** A rental's payment, for the pill beside the task bar and its hover card; null for one nobody has touched. */
export function buildTracker(standing: RentalStanding, options: { canViewCosts: boolean; currency: CurrencyCode; receiptFiled: boolean }): Tracker | null {
  if (!standing.changed && standing.pay === 'unpaid') return null;
  const { payment, pay } = standing;
  const { status, state, tone, headline } = STATUS[pay];
  const step = (key: TrackerStep['key'], label: string, icon: string, part: Pick<TrackerStep, 'status' | 'state'>, paypal = false): TrackerStep => ({ key, label, icon, paypal, who: null, at: null, detail: null, ...part });
  return {
    steps: [
      step('plan', 'New dates', 'fa fa-diagram-project', { status: 'In the plan', state: 'done' }),
      { ...step('paid', 'Paid', 'fa-brands fa-paypal', { status, state }, true), who: pay === 'paid' ? 'PayPal' : null, at: payment?.updated_at ?? null },
      step('receipt', 'Receipt filed', 'fa fa-file-invoice-dollar', options.receiptFiled ? { status: 'Filed', state: 'done' } : { status: pay === 'paid' ? 'Filing' : 'After payment', state: pay === 'paid' ? 'current' : 'todo' }),
    ],
    focus: 'paid',
    headline,
    tone,
    complete: pay === 'paid',
    dropped: false,
    paying: pay === 'paying',
    amountMinor: options.canViewCosts ? (payment?.amount_minor ?? standing.costMinor) : null,
    feeMinor: options.canViewCosts ? (payment?.fee_minor ?? null) : null,
    currency: payment?.currency ?? options.currency,
  };
}

export function buildDecorations(
  snapshot: WorkflowSnapshot | null,
  project: ProjectModel,
  canViewCosts: boolean,
  currency: CurrencyCode,
): Decorations {
  const decorations = new Map<number, TaskDecoration>();
  if (!snapshot) return decorations;
  for (const booking of snapshot.bookings) {
    let facts: BookingFacts;
    try {
      facts = readBookingFacts(project, {
        taskId: booking.task_id,
        resourceId: booking.resource_id,
        billableStart: booking.billable_start,
        billableEnd: booking.billable_end,
      });
    } catch {
      continue; // The booked task or equipment is gone from the plan; the editor explains why.
    }
    const standing = rentalStanding(snapshot, booking);
    const tracker = buildTracker(standing, { canViewCosts, currency, receiptFiled: receiptFor(snapshot.documents, standing.payment?.id) !== null });
    decorations.set(booking.task_id, {
      rental: null,
      idle:
        facts.idleDays > 0 && !facts.buffered
          ? {
              start: booking.billable_start,
              end: booking.billable_end,
              days: facts.idleDays,
              costMinor: canViewCosts ? booking.rental_rate_minor * facts.idleDays : null,
              equipment: facts.resourceName,
            }
          : null,
      ...(canViewCosts ? { rentalRateMinor: booking.rental_rate_minor } : {}),
      tracker,
      badges: tracker ? [trackerBadge(tracker)] : [],
    });
  }
  // The outline goes with the machine on a task, booked or not: every task it is on draws its own.
  for (const task of project.taskStore.leaves as TaskModel[]) {
    const rental = rentalSpanOf(snapshot, task);
    if (!rental) continue;
    const decoration = decorations.get(task.id as number);
    if (decoration) decoration.rental = rental;
    else decorations.set(task.id as number, { rental, idle: null, tracker: null, badges: [] });
  }
  return decorations;
}

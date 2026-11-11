/**
 * What the workflow knows about one task, for the task panel's Costs tab: the equipment rented for
 * it, the fix proposed for its idle days, and every PayPal payment made for it (with its receipt).
 * Pure: reads a workflow snapshot, writes nothing. Amounts are shown only to cost viewers (the tab
 * itself is theirs).
 */
import type { PaymentStatus, ProposalState } from '@collab/shared';
import type { WorkflowSnapshot } from '../../workflow/api';
import { bookingForTask, formatDay, proposalForBooking } from '../../workflow/model';

export type Tone = 'ok' | 'busy' | 'warn' | 'alert' | 'neutral';

export const PAYMENT_STATES: Readonly<Record<PaymentStatus, { label: string; tone: Tone }>> = {
  authorized: { label: 'Approved, not sent yet', tone: 'warn' },
  submitted: { label: 'Sent to PayPal', tone: 'busy' },
  pending: { label: 'PayPal is processing it', tone: 'busy' },
  succeeded: { label: 'Paid', tone: 'ok' },
  failed: { label: 'Payment failed', tone: 'alert' },
  unknown: { label: 'Checking with PayPal', tone: 'warn' },
};

export interface TaskPaymentFacts {
  rental: {
    supplier: string;
    rateMinor: number;
    /** `Mon, Dec 7, 2026`. */
    from: string;
    /** Last billable day (the booking's end is exclusive). */
    until: string;
    /** Paid-for days with no work planned, before the task or after it, as the booking was made. */
    idleDaysBooked: number;
  };
  payment: {
    status: PaymentStatus;
    label: string;
    tone: Tone;
    amountMinor: number;
    feeMinor: number | null;
    recipient: string;
    reference: string | null;
    message: string | null;
  } | null;
  /** Every payment for this rental's fixes, newest first. */
  ledger: PaymentLine[];
}

export interface PaymentLine {
  id: string;
  /** When it was paid, or last changed. */
  at: string;
  status: PaymentStatus;
  label: string;
  tone: Tone;
  amountMinor: number;
  feeMinor: number | null;
  payee: string;
  recipient: string;
  /** PayPal's item id (or batch id until the item is known). */
  reference: string | null;
  message: string | null;
  /** Which version of the fix it paid for. */
  versionNo: number | null;
  /** The receipt filed for it, once PayPal confirmed the payment. */
  receiptId: string | null;
}


function previousDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return previous.toISOString().slice(0, 10);
}

/** The rental and payments of a task, or null when nothing in the workflow concerns it. */
export function taskPaymentFacts(snapshot: WorkflowSnapshot | null | undefined, taskId: number | null): TaskPaymentFacts | null {
  if (!snapshot || taskId === null) return null;
  const booking = bookingForTask(snapshot, taskId);
  if (!booking) return null;
  const view = proposalForBooking(snapshot, booking.id);
  const proposals = new Set(snapshot.proposals.filter((proposal) => proposal.booking_id === booking.id).map((proposal) => proposal.id));
  const versions = new Map(snapshot.versions.filter((version) => proposals.has(version.proposal_id)).map((version) => [version.id, version.version_no]));
  const documents = snapshot.documents.filter((document) => document.kind === 'receipt');
  const ledger: PaymentLine[] = snapshot.payments
    .filter((payment) => versions.has(payment.proposal_version_id))
    .map((payment) => ({
      id: payment.id,
      at: payment.updated_at,
      status: payment.status,
      ...PAYMENT_STATES[payment.status],
      amountMinor: payment.amount_minor,
      feeMinor: payment.fee_minor,
      payee: booking.supplier_name,
      recipient: payment.recipient_email,
      reference: payment.paypal_item_id ?? payment.paypal_batch_id,
      message: payment.message,
      versionNo: versions.get(payment.proposal_version_id) ?? null,
      receiptId: documents.find((document) => document.payment_authorization_id === payment.id)?.id ?? null,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  return {
    rental: {
      supplier: booking.supplier_name,
      rateMinor: booking.rental_rate_minor,
      from: formatDay(booking.billable_start),
      until: formatDay(previousDay(booking.billable_end)),
      idleDaysBooked: booking.idle_days,
    },
    payment: view?.payment
      ? {
          status: view.payment.status,
          ...PAYMENT_STATES[view.payment.status],
          amountMinor: view.payment.amount_minor,
          feeMinor: view.payment.fee_minor,
          recipient: view.payment.recipient_email,
          reference: view.payment.paypal_batch_id,
          message: view.payment.message,
        }
      : null,
    ledger,
  };
}

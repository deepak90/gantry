/**
 * The proposal workflow as the database has it (rows validated with the shared schemas), and pure
 * views over it: the fix on the table, its current version, the approvals that count, the payment,
 * the receipt, and the approval chain in the app's order (apps/web/src/workflow/chain.ts):
 *
 *   Fix proposed -> Fix approved -> Plan updated -> Paid with PayPal -> Receipt filed
 *
 * One role for everyone: anyone on the project who sees costs approves the fix with one click (the
 * new dates and the payment together, within their approval limit; enforced in SQL), and anyone who
 * sees costs pays. The database still records that click as two approvals (scope schedule, then
 * payment, same person, same moment); these views report them as one.
 */
import type {
  ApprovalRow,
  InvoiceRow,
  PaymentAuthorizationRow,
  ProjectDocumentRow,
  ProposalRow,
  ProposalVersionRow,
  PublicationRow,
  ReviewRow,
  SupplierConfirmationRow,
} from '@collab/shared';
import { rentalDays } from '@collab/shared';
import { lastDay, usd } from '../plan/format';
import { approversFor, eitherOf, firstName, memberById, type PlanSnapshot } from '../plan/snapshot';

export interface WorkflowRows {
  proposals: ProposalRow[];
  versions: ProposalVersionRow[];
  reviews: ReviewRow[];
  approvals: ApprovalRow[];
  payments: PaymentAuthorizationRow[];
  publications: PublicationRow[];
  confirmations: SupplierConfirmationRow[];
  documents: ProjectDocumentRow[];
  /** What the project billed its client through PayPal Invoicing (a change's invoice is recorded on its first task). */
  invoices?: InvoiceRow[];
}

export const EMPTY_WORKFLOW: WorkflowRows = {
  proposals: [],
  versions: [],
  reviews: [],
  approvals: [],
  payments: [],
  publications: [],
  confirmations: [],
  documents: [],
  invoices: [],
};

const OPEN = new Set(['draft', 'evaluated', 'in_review', 'approved']);

/** The proposal still open for the booking (or any booking), else null. */
export function openProposal(rows: WorkflowRows, bookingId?: string): ProposalRow | null {
  return (
    [...rows.proposals]
      .filter((proposal) => (!bookingId || proposal.booking_id === bookingId) && OPEN.has(proposal.state))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null
  );
}

/** The open proposal, else the most recent one (a finished fix still has a status to report). */
export function latestProposal(rows: WorkflowRows): ProposalRow | null {
  return openProposal(rows) ?? [...rows.proposals].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;
}

export function versionsOf(rows: WorkflowRows, proposal: ProposalRow): ProposalVersionRow[] {
  return rows.versions.filter((version) => version.proposal_id === proposal.id).sort((a, b) => a.version_no - b.version_no);
}

export function currentVersion(rows: WorkflowRows, proposal: ProposalRow): ProposalVersionRow | null {
  return versionsOf(rows, proposal).find((version) => version.version_no === proposal.current_version_no) ?? null;
}

export function activeApprovals(rows: WorkflowRows, version: ProposalVersionRow): Partial<Record<'schedule' | 'payment', ApprovalRow>> {
  const active: Partial<Record<'schedule' | 'payment', ApprovalRow>> = {};
  for (const approval of rows.approvals) {
    if (approval.proposal_version_id === version.id && approval.status === 'active') active[approval.scope] = approval;
  }
  return active;
}

/** The payment operation that counts for the proposal: the live one, else the latest failed one. */
export function paymentFor(rows: WorkflowRows, proposal: ProposalRow): PaymentAuthorizationRow | null {
  const ids = new Set(versionsOf(rows, proposal).map((version) => version.id));
  const payments = rows.payments.filter((payment) => ids.has(payment.proposal_version_id)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return payments.find((payment) => payment.status !== 'failed') ?? payments.at(-1) ?? null;
}

export function publicationFor(rows: WorkflowRows, version: ProposalVersionRow): PublicationRow | null {
  const publications = rows.publications.filter((publication) => publication.proposal_version_id === version.id);
  return publications.find((publication) => publication.status !== 'failed') ?? publications.at(-1) ?? null;
}

export function receiptFor(rows: WorkflowRows, payment: PaymentAuthorizationRow | null): ProjectDocumentRow | null {
  if (!payment) return null;
  return rows.documents.find((document) => document.kind === 'receipt' && document.payment_authorization_id === payment.id) ?? null;
}

/** Two approvals this close together, by the same person on the same version, are one "Approve the fix". */
export const ONE_CLICK_MS = 2 * 60_000;

/** What an approval covered, in the app's terms: the fix (the dates and the payment together), or one part alone. */
export type ApprovalKind = 'fix' | 'dates' | 'payment';

export interface ApprovalGroup {
  what: ApprovalKind;
  approverId: string | null;
  versionId: string;
  /** The payment approved (null when only the dates were). */
  amountMinor: number | null;
  at: string;
  rows: ApprovalRow[];
}

/**
 * Approval rows as people made them: a schedule and a payment approval of the same version by the
 * same person within ONE_CLICK_MS are one "Approve the fix" (approve_fix writes both at once). A
 * dates-only approval (made one scope at a time, or cut short) stays on its own.
 */
export function groupApprovals(approvals: readonly ApprovalRow[]): ApprovalGroup[] {
  const ordered = [...approvals].sort((a, b) => (a.created_at === b.created_at ? (a.scope === 'schedule' ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  const groups: ApprovalGroup[] = [];
  for (const approval of ordered) {
    const what: ApprovalKind = approval.scope === 'schedule' ? 'dates' : 'payment';
    const partner = groups.find(
      (group) =>
        group.what !== 'fix' &&
        group.what !== what &&
        group.versionId === approval.proposal_version_id &&
        group.approverId === approval.approver_id &&
        Math.abs(Date.parse(approval.created_at) - Date.parse(group.at)) <= ONE_CLICK_MS,
    );
    if (partner) {
      partner.what = 'fix';
      partner.rows.push(approval);
      partner.amountMinor ??= approval.amount_minor;
      continue;
    }
    groups.push({ what, approverId: approval.approver_id, versionId: approval.proposal_version_id, amountMinor: approval.amount_minor, at: approval.created_at, rows: [approval] });
  }
  return groups;
}

/** "the fix", "the dates", "the payment". */
export function approvalWords(what: ApprovalKind): 'the fix' | 'the dates' | 'the payment' {
  return what === 'fix' ? 'the fix' : what === 'dates' ? 'the dates' : 'the payment';
}

export type StepStatus = 'done' | 'current' | 'todo' | 'reset' | 'failed';

export interface ChainStep {
  key: 'proposed' | 'approved' | 'in_plan' | 'paid' | 'receipt';
  label: string;
  who: string;
  status: StepStatus;
  note: string | null;
}

export interface FixStatus {
  proposal_id: string;
  state: ProposalRow['state'];
  booking_id: string;
  version: number;
  version_id: string;
  created_via: 'human' | 'agent';
  checked: boolean;
  inputs: ProposalVersionRow['inputs'];
  assumptions: ProposalVersionRow['assumptions'];
  /** The rental as booked (null until the version is checked). */
  booked_rental_minor: number | null;
  /** The rental as revised: what the supplier is paid. */
  supplier_payment_minor: number | null;
  /** Rental as booked minus rental as revised; negative is an extra cost (the rental gets longer). */
  saving_minor: number | null;
  handover_moves_days: number | null;
  /** The fix approved: one approval of the new dates and the payment together (null until then). */
  approved: { by: string; amount_minor: number | null; at: string } | null;
  /** Only the new dates are approved so far (a partial approval): the payment still needs approving. */
  dates_approved_only: { by: string; at: string } | null;
  /** Who can approve the fix now: the members who see costs and whose approval limit covers the payment. */
  approvers: string[];
  /** Approvals that stopped counting because the fix changed: one entry per approval a person made. */
  reset_approvals: { what: 'the fix' | 'the dates' | 'the payment'; by: string; reason: string | null }[];
  in_plan: { change_no: number | null } | null;
  payment: { status: PaymentAuthorizationRow['status']; amount_minor: number; fee_minor: number | null; message: string | null } | null;
  receipt: { name: string; summary: string | null } | null;
  chain: ChainStep[];
  next: string;
}

function nameOf(plan: PlanSnapshot, userId: string | null): string {
  return memberById(plan, userId)?.name ?? 'someone';
}

export function fixStatus(plan: PlanSnapshot, rows: WorkflowRows, proposal: ProposalRow): FixStatus | null {
  const version = currentVersion(rows, proposal);
  if (!version) return null;
  const active = activeApprovals(rows, version);
  const payment = paymentFor(rows, proposal);
  const publication = publicationFor(rows, version);
  const receipt = receiptFor(rows, payment);
  const ids = new Set(versionsOf(rows, proposal).map((candidate) => candidate.id));
  const resets = groupApprovals(rows.approvals.filter((approval) => approval.status === 'invalidated' && ids.has(approval.proposal_version_id)));
  const checked = version.evaluation !== null && !version.stale;
  const amount = version.evaluation?.cost_comparison.supplier_payment_minor ?? null;
  const supplier = plan.bookings.find((booking) => booking.id === proposal.booking_id)?.supplierName ?? 'the supplier';
  const approvers = approversFor(plan.members, amount);
  const payers = approversFor(plan.members, payment?.amount_minor ?? active.payment?.amount_minor ?? amount);
  // The fix counts as approved once the payment is: the database only takes it after the dates.
  const approval = active.payment ?? null;
  const datesOnly = !approval && active.schedule ? active.schedule : null;
  const published = proposal.state === 'published' || publication?.status === 'published';
  const paid = payment?.status === 'succeeded';
  const cancelled = proposal.state === 'cancelled';
  const who = (members: typeof approvers) => (members.length > 0 ? eitherOf(members) : 'Someone with a high enough approval limit');
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

  type RawStep = Omit<ChainStep, 'status'> & { done: boolean; failed?: boolean };
  const raw: RawStep[] = [
    { key: 'proposed', label: 'Fix proposed', who: version.created_via === 'agent' ? 'Assistant' : nameOf(plan, version.created_by), note: `Version ${version.version_no}`, done: checked },
    {
      key: 'approved',
      label: 'Fix approved',
      who: approval ? nameOf(plan, approval.approver_id) : capital(who(approvers)),
      note: approval
        ? `The new dates and ${amount !== null ? `${usd(approval.amount_minor ?? amount)} to ${supplier}` : 'the payment'}, in one approval`
        : datesOnly
          ? `Dates approved by ${nameOf(plan, datesOnly.approver_id)}; the payment still needs approving`
          : `One click approves the new dates and the ${amount !== null ? `${usd(amount)} ` : ''}payment together`,
      done: Boolean(approval),
    },
    { key: 'in_plan', label: 'Plan updated', who: 'Automatic', note: publication?.published_revision ? `Change #${publication.published_revision}` : null, done: published, failed: publication?.status === 'failed' },
    {
      key: 'paid',
      label: 'Paid with PayPal',
      who: payment?.authorized_by ? nameOf(plan, payment.authorized_by) : capital(who(payers)),
      note: payment?.fee_minor != null && paid ? `PayPal fee ${usd(payment.fee_minor)}` : null,
      done: paid,
      failed: payment?.status === 'failed',
    },
    { key: 'receipt', label: 'Receipt filed', who: 'Automatic', note: receipt?.name ?? null, done: receipt !== null },
  ];
  let currentSet = false;
  const chain: ChainStep[] = raw.map((step) => {
    let status: StepStatus;
    if (step.done) status = 'done';
    else if (step.failed) status = 'failed';
    else if (!currentSet && !cancelled) {
      currentSet = true;
      status = step.key === 'approved' && resets.length > 0 ? 'reset' : 'current';
    } else status = 'todo';
    const { done: _done, failed: _failed, ...rest } = step;
    return { ...rest, status };
  });

  // No amounts in `next`: it goes into every audience's event as it is (the figures are in the fields).
  let next: string;
  if (cancelled) next = 'The fix was dropped.';
  else if (!checked) next = 'The fix is being checked on the scheduling engine.';
  else if (version.evaluation && version.evaluation.unresolved_assumptions.length > 0) next = `Open questions first: ${version.evaluation.unresolved_assumptions.join(', ')}.`;
  else if (!approval && approvers.length === 0) next = 'The payment is above everyone’s approval limit: someone with a higher limit has to approve the fix.';
  else if (datesOnly) next = `${firstName(nameOf(plan, datesOnly.approver_id))} approved the new dates; the payment still needs approving (${who(approvers)}).`;
  else if (!approval) next = `${capital(who(approvers))} approves the fix with one click: the new dates and the payment together.`;
  else if (!published) next = 'The change is being applied to everyone’s plan.';
  else if (!payment) next = `${capital(who(payers))} sends the payment to ${supplier} with PayPal.`;
  else if (payment.status === 'failed') next = `PayPal could not make the payment${payment.message ? `: ${payment.message}` : ''}.`;
  else if (!paid) next = 'Waiting for PayPal to confirm the payment.';
  else if (!receipt) next = 'Paid; the receipt is being filed.';
  else next = 'Done: the change is in the plan, the supplier is paid and the receipt is filed.';

  return {
    proposal_id: proposal.id,
    state: proposal.state,
    booking_id: proposal.booking_id,
    version: version.version_no,
    version_id: version.id,
    created_via: version.created_via,
    checked,
    inputs: version.inputs,
    assumptions: version.assumptions,
    booked_rental_minor: version.evaluation?.cost_comparison.booked_rental_minor ?? null,
    supplier_payment_minor: amount,
    saving_minor: version.evaluation?.cost_comparison.saving_minor ?? null,
    handover_moves_days: version.evaluation?.schedule_impact.handover.delta_days ?? null,
    approved: approval ? { by: nameOf(plan, approval.approver_id), amount_minor: approval.amount_minor, at: approval.created_at } : null,
    dates_approved_only: datesOnly ? { by: nameOf(plan, datesOnly.approver_id), at: datesOnly.created_at } : null,
    approvers: approvers.map((member) => member.name),
    reset_approvals: resets.map((group) => ({ what: approvalWords(group.what), by: nameOf(plan, group.approverId), reason: group.rows[0]!.invalidated_reason })),
    in_plan: published ? { change_no: publication?.published_revision ?? null } : null,
    payment: payment ? { status: payment.status, amount_minor: payment.amount_minor, fee_minor: payment.fee_minor, message: payment.message } : null,
    receipt: receipt ? { name: receipt.name, summary: receipt.summary } : null,
    chain,
    next,
  };
}

export interface RentalStatus {
  booking_id: string;
  task_id: number;
  first_day: string;
  last_day: string;
  days: number;
  cost_minor: number;
  supplier: string;
  /** not paid: nobody has pressed Pay; the rest are PayPal's answer. */
  payment: 'not paid' | 'processing' | 'failed' | 'paid';
  paid_minor: number | null;
  fee_minor: number | null;
  receipt: string | null;
  text: { cost: string };
}

/** Where each rental stands: what its dates come to and whether it is paid. */
export function rentalStatuses(plan: PlanSnapshot, rows: WorkflowRows): RentalStatus[] {
  return plan.bookings.map((booking) => {
    const proposals = new Set(rows.proposals.filter((proposal) => proposal.booking_id === booking.id).map((proposal) => proposal.id));
    const versions = new Set(rows.versions.filter((version) => proposals.has(version.proposal_id)).map((version) => version.id));
    const payments = rows.payments.filter((payment) => versions.has(payment.proposal_version_id));
    const payment = payments.find((candidate) => candidate.status !== 'failed') ?? payments[payments.length - 1] ?? null;
    const days = rentalDays(booking.billableStart, booking.billableEnd);
    const costMinor = days * booking.rentalRateMinor;
    return {
      booking_id: booking.id,
      task_id: booking.taskId,
      first_day: booking.billableStart,
      last_day: lastDay(booking.billableEnd),
      days,
      cost_minor: costMinor,
      supplier: booking.supplierName,
      payment: payment === null ? 'not paid' : payment.status === 'succeeded' ? 'paid' : payment.status === 'failed' ? 'failed' : 'processing',
      paid_minor: payment?.status === 'succeeded' ? payment.amount_minor : null,
      fee_minor: payment?.fee_minor ?? null,
      receipt: payment?.receipt_filed_at ? 'filed on the task' : null,
      text: { cost: usd(costMinor) },
    };
  });
}

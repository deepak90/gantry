/**
 * Pure views over a `WorkflowSnapshot`: which proposal belongs to a booking, its current and
 * previous versions, the approvals and payment that count now, the three independent outcomes, and
 * a readable trail of what happened. No I/O; the editor renders from these.
 */
import {
  format,
  isPaymentInFlight,
  money,
  type ApprovalRow,
  type ApprovalScope,
  type CurrencyCode,
  type EquipmentBookingRow,
  type PaymentAuthorizationRow,
  type ProposalRow,
  type ProposalVersionRow,
  type PublicationRow,
  type ReviewRow,
  type SupplierConfirmationRow,
} from '@collab/shared';
import type { WorkflowSnapshot } from './api';
import { ASSISTANT_NAME } from '../assistant/identity';

export interface ProposalView {
  proposal: ProposalRow;
  booking: EquipmentBookingRow;
  /** Ascending by version_no. */
  versions: ProposalVersionRow[];
  current: ProposalVersionRow;
  /** The latest earlier version that was evaluated: the "initial" column of the cost comparison. */
  previousEvaluated: ProposalVersionRow | null;
  reviews: ReviewRow[];
  /** Every approval of every version, oldest first. */
  approvals: ApprovalRow[];
  /** Active approvals of the current version by scope. */
  active: Partial<Record<ApprovalScope, ApprovalRow>>;
  /** The payment operation that counts: the live one, else the latest failed one. */
  payment: PaymentAuthorizationRow | null;
  /** The publication of the current version that counts: published or pending, else the latest failed. */
  publication: PublicationRow | null;
  confirmation: SupplierConfirmationRow | null;
  isOpen: boolean;
}

export function bookingForTask(snapshot: WorkflowSnapshot, taskId: number | null): EquipmentBookingRow | null {
  return taskId === null ? null : snapshot.bookings.find((booking) => booking.task_id === taskId) ?? null;
}

const OPEN_STATES = new Set(['draft', 'evaluated', 'in_review', 'approved']);

/** The booking's open proposal, else its most recent one. */
export function proposalForBooking(snapshot: WorkflowSnapshot, bookingId: string): ProposalView | null {
  const proposals = snapshot.proposals.filter((proposal) => proposal.booking_id === bookingId);
  const chosen = proposals.find((proposal) => OPEN_STATES.has(proposal.state)) ?? proposals[proposals.length - 1];
  return chosen ? proposalView(snapshot, chosen) : null;
}

export function proposalView(snapshot: WorkflowSnapshot, proposal: ProposalRow): ProposalView | null {
  const booking = snapshot.bookings.find((candidate) => candidate.id === proposal.booking_id);
  const versions = snapshot.versions
    .filter((version) => version.proposal_id === proposal.id)
    .sort((a, b) => a.version_no - b.version_no);
  const current = versions.find((version) => version.version_no === proposal.current_version_no);
  if (!booking || !current) {
    return null;
  }
  const versionIds = new Set(versions.map((version) => version.id));
  const approvals = snapshot.approvals.filter((approval) => versionIds.has(approval.proposal_version_id));
  const active: Partial<Record<ApprovalScope, ApprovalRow>> = {};
  for (const approval of approvals) {
    if (approval.proposal_version_id === current.id && approval.status === 'active') {
      active[approval.scope] = approval;
    }
  }
  const payments = snapshot.payments.filter((payment) => versionIds.has(payment.proposal_version_id));
  const publications = snapshot.publications.filter((publication) => publication.proposal_version_id === current.id);
  return {
    proposal,
    booking,
    versions,
    current,
    previousEvaluated:
      [...versions].reverse().find((version) => version.version_no < current.version_no && version.evaluation !== null) ?? null,
    reviews: snapshot.reviews.filter((review) => versionIds.has(review.proposal_version_id)),
    approvals,
    active,
    payment: payments.find((payment) => payment.status !== 'failed') ?? payments[payments.length - 1] ?? null,
    publication:
      publications.find((publication) => publication.status !== 'failed') ?? publications[publications.length - 1] ?? null,
    confirmation: snapshot.confirmations.find((confirmation) => confirmation.proposal_id === proposal.id) ?? null,
    isOpen: OPEN_STATES.has(proposal.state),
  };
}

/** The current version has a fresh evaluation with every assumption answered. */
export function isReadyForApproval(view: ProposalView): boolean {
  const { evaluation } = view.current;
  return evaluation !== null && !view.current.stale && evaluation.unresolved_assumptions.length === 0;
}

export function paymentsInFlight(snapshot: WorkflowSnapshot): PaymentAuthorizationRow[] {
  return snapshot.payments.filter((payment) => isPaymentInFlight(payment.status));
}

/** Checked fixes waiting for the approval of this scope (the project manager approves the schedule, the cost manager the payment). */
export function awaitingApproval(snapshot: WorkflowSnapshot | null, scope: ApprovalScope): ProposalView[] {
  if (!snapshot) return [];
  return snapshot.proposals
    .map((proposal) => proposalView(snapshot, proposal))
    .filter((view): view is ProposalView => view !== null && view.isOpen && view.proposal.state !== 'published' && isReadyForApproval(view) && !view.active[scope]);
}

// -----------------------------------------------------------------------------------------
// Text
// -----------------------------------------------------------------------------------------

export const PROPOSAL_STATE_LABELS: Readonly<Record<ProposalRow['state'], string>> = {
  draft: 'Draft',
  evaluated: 'Checked',
  in_review: 'Waiting for approval',
  approved: 'Approved',
  published: 'In the plan',
  cancelled: 'Dropped',
};

export const INPUT_LABELS: Readonly<Record<string, string>> = {
  new_start: 'Rental starts',
  new_end: 'Off rent',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-12-11` → `Fri, Dec 11, 2026` (calendar dates carry no timezone). */
export function formatDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) {
    return date;
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Money for viewers who may see it; a mask for everyone else. */
export function formatMoney(minor: number | null | undefined, currency: CurrencyCode, canViewCosts: boolean): string {
  if (!canViewCosts) {
    return '•••';
  }
  return typeof minor === 'number' && Number.isSafeInteger(minor) ? format(money(minor, currency)) : '—';
}

export function describeInputValue(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatDay(value);
  }
  return String(value);
}

export type TrailKind = 'version' | 'evaluation' | 'correction' | 'comment' | 'approval' | 'invalidation' | 'publication' | 'payment' | 'supplier';

export interface TrailEntry {
  at: string;
  kind: TrailKind;
  text: string;
  actor: string | null;
}

export interface TrailOptions {
  currency: CurrencyCode;
  canViewCosts: boolean;
  nameOf: (userId: string | null) => string | null;
}

const SCOPE_LABELS: Readonly<Record<ApprovalScope, string>> = { schedule: 'schedule change', payment: 'payment' };

/** One approval as people gave it: "Approve the fix" writes the dates and the payment rows together. */
export interface GroupedApproval {
  approver_id: string | null;
  proposal_version_id: string;
  created_at: string;
  scopes: ApprovalScope[];
  amount_minor: number | null;
  status: ApprovalRow['status'];
  invalidated_at: string | null;
  invalidated_reason: string | null;
}

/** Rows by the same person on the same version within this long are one approval. */
const SAME_APPROVAL_MS = 2 * 60_000;

/** The approval rows grouped the way people gave them, oldest first. */
export function groupApprovals(approvals: readonly ApprovalRow[]): GroupedApproval[] {
  const groups: GroupedApproval[] = [];
  for (const row of [...approvals].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const same = groups.find(
      (group) =>
        group.approver_id === row.approver_id &&
        group.proposal_version_id === row.proposal_version_id &&
        !group.scopes.includes(row.scope) &&
        Math.abs(Date.parse(row.created_at) - Date.parse(group.created_at)) <= SAME_APPROVAL_MS,
    );
    if (same) {
      same.scopes.push(row.scope);
      same.amount_minor = row.amount_minor ?? same.amount_minor;
      if (row.status === 'invalidated') {
        same.status = 'invalidated';
        same.invalidated_at = row.invalidated_at ?? same.invalidated_at;
        same.invalidated_reason = row.invalidated_reason ?? same.invalidated_reason;
      }
      continue;
    }
    groups.push({
      approver_id: row.approver_id,
      proposal_version_id: row.proposal_version_id,
      created_at: row.created_at,
      scopes: [row.scope],
      amount_minor: row.amount_minor,
      status: row.status,
      invalidated_at: row.invalidated_at,
      invalidated_reason: row.invalidated_reason,
    });
  }
  return groups;
}

/** "1 earlier approval no longer counts." from the rows the server invalidated (two per approved fix). */
export function invalidatedWords(rows: number): string {
  if (rows <= 0) return '';
  const approvals = Math.max(1, Math.round(rows / 2));
  return `${approvals} earlier approval${approvals === 1 ? ' no longer counts' : 's no longer count'}.`;
}

/** What happened to the proposal, oldest first. */
export function proposalTrail(view: ProposalView, { currency, canViewCosts, nameOf }: TrailOptions): TrailEntry[] {
  const entries: TrailEntry[] = [];
  const versionNo = new Map(view.versions.map((version) => [version.id, version.version_no]));
  for (const version of view.versions) {
    if (version.version_no === 1) {
      entries.push({
        at: version.created_at,
        kind: 'version',
        text: `Proposed the fix${version.created_via === 'agent' ? ` (prepared by ${ASSISTANT_NAME})` : ''}`,
        actor: nameOf(version.created_by),
      });
    }
    if (version.evaluation) {
      const { handover } = version.evaluation.schedule_impact;
      const outcome = handover.delta_days === 0 ? 'handover date kept' : `handover moves ${handover.delta_days} day(s)`;
      entries.push({
        at: version.evaluation.evaluated_at,
        kind: 'evaluation',
        text: `Checked version ${version.version_no}: ${outcome}`,
        actor: nameOf(version.evaluated_by),
      });
    }
  }
  for (const review of view.reviews) {
    const payload = review.payload as { changes?: Record<string, { from: unknown; to: unknown }>; reason?: string; text?: string; next_version_no?: number };
    if (review.kind === 'comment') {
      entries.push({ at: review.created_at, kind: 'comment', text: `Commented: ${payload.text ?? ''}`, actor: nameOf(review.reviewer_id) });
      continue;
    }
    const changes = Object.entries(payload.changes ?? {}).map(
      ([field, change]) =>
        `${INPUT_LABELS[field] ?? field} ${describeInputValue(change.from)} → ${describeInputValue(change.to)}`,
    );
    entries.push({
      at: review.created_at,
      kind: 'correction',
      text: `Changed version ${versionNo.get(review.proposal_version_id) ?? '?'} into version ${payload.next_version_no ?? '?'}: ${
        changes.length > 0 ? changes.join(', ') : 'answered open questions'
      }. ${payload.reason ?? ''}`.trim(),
      actor: nameOf(review.reviewer_id),
    });
  }
  for (const approval of groupApprovals(view.approvals)) {
    const amount = approval.amount_minor !== null ? formatMoney(approval.amount_minor, currency, canViewCosts) : null;
    const version = `version ${versionNo.get(approval.proposal_version_id) ?? '?'}`;
    const whole = approval.scopes.length === 2;
    const scope = approval.scopes[0]!;
    entries.push({
      at: approval.created_at,
      kind: 'approval',
      text: whole ? `Approved the fix${amount ? `: ${amount}` : ''} (${version})` : `Approved the ${SCOPE_LABELS[scope]}${amount ? ` of ${amount}` : ''} (${version})`,
      actor: nameOf(approval.approver_id),
    });
    if (approval.status === 'invalidated' && approval.invalidated_at) {
      const what = whole ? 'The approval' : `${SCOPE_LABELS[scope][0]?.toUpperCase()}${SCOPE_LABELS[scope].slice(1)} approval`;
      entries.push({
        at: approval.invalidated_at,
        kind: 'invalidation',
        text: `${what} no longer counts: ${approval.invalidated_reason ?? ''}`,
        actor: null,
      });
    }
  }
  if (view.publication?.published_at && view.publication.published_revision !== null) {
    entries.push({
      at: view.publication.published_at,
      kind: 'publication',
      text: `Applied the change to everyone’s plan (change #${view.publication.published_revision})`,
      actor: nameOf(view.publication.claimed_by),
    });
  }
  if (view.payment) {
    entries.push({
      at: view.payment.created_at,
      kind: 'payment',
      text: `Sent the supplier’s payment${canViewCosts ? ` of ${formatMoney(view.payment.amount_minor, currency, true)} to ${view.payment.recipient_email}` : ''}`,
      actor: nameOf(view.payment.authorized_by),
    });
  }
  if (view.confirmation?.status === 'confirmed' && view.confirmation.confirmed_at) {
    entries.push({ at: view.confirmation.confirmed_at, kind: 'supplier', text: 'Recorded that the supplier confirmed', actor: nameOf(view.confirmation.confirmed_by) });
  }
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The receipt filed for a payment, if any. */
export function receiptFor<Document extends { kind: string; payment_authorization_id: string | null }>(documents: readonly Document[] | undefined, paymentId: string | null | undefined): Document | null {
  if (!paymentId || !documents) return null;
  return documents.find((document) => document.kind === 'receipt' && document.payment_authorization_id === paymentId) ?? null;
}

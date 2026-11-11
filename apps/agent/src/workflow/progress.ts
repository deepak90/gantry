/**
 * What changed in the workflow between two reads, in plain events the agent may comment on. The
 * agent's own bookkeeping is left out: a proposal or version it created through a command, the
 * evaluation the browser recorded for it, and the approvals that the agent's correction reset (its
 * own turn already says so). One "Approve the fix" (approve_fix: the dates and the payment, same
 * person, same moment) is one event, not two. Pure: tested with fixture rows.
 */
import { usd } from '../plan/format';
import { memberById, type PlanSnapshot } from '../plan/snapshot';
import { approvalWords, groupApprovals, type ApprovalKind, type WorkflowRows } from './state';

export type ProgressChange =
  /** `fix`: the dates and the payment in one approval; `dates` or `payment` alone otherwise (a partial or older approval). */
  | { type: 'approved'; what: ApprovalKind; by: string; versionNo: number; amountMinor: number | null; supplier: string | null }
  | { type: 'corrected'; by: string; versionNo: number; reason: string; reset: { what: ApprovalKind; by: string }[] }
  | { type: 'proposed_by_person'; by: string }
  | { type: 'published'; changeNo: number | null }
  | { type: 'payment_settled'; status: 'succeeded' | 'failed'; amountMinor: number; feeMinor: number | null; message: string | null }
  | { type: 'receipt_filed'; name: string; summary: string | null }
  | { type: 'cancelled'; reason: string | null };

export function diffWorkflow(plan: PlanSnapshot, before: WorkflowRows, after: WorkflowRows): ProgressChange[] {
  const changes: ProgressChange[] = [];
  const nameOf = (userId: string | null) => memberById(plan, userId)?.name ?? 'Someone';
  const versionNo = (versionId: string) => after.versions.find((version) => version.id === versionId)?.version_no ?? 0;
  const known = <T extends { id: string }>(rows: T[]) => new Set(rows.map((row) => row.id));

  const oldProposals = known(before.proposals);
  for (const proposal of after.proposals) {
    if (oldProposals.has(proposal.id)) continue;
    const first = after.versions.find((version) => version.proposal_id === proposal.id && version.version_no === 1);
    if (first && first.created_via === 'human') changes.push({ type: 'proposed_by_person', by: nameOf(first.created_by) });
  }

  const oldVersions = known(before.versions);
  for (const version of after.versions) {
    // A version the agent wrote (through a person's browser) is reported by the agent's own turn.
    if (oldVersions.has(version.id) || version.version_no === 1 || version.created_via === 'agent') continue;
    const previous = after.versions.find((candidate) => candidate.proposal_id === version.proposal_id && candidate.version_no === version.version_no - 1);
    const review = previous
      ? [...after.reviews].reverse().find((candidate) => candidate.proposal_version_id === previous.id && candidate.kind === 'correction')
      : undefined;
    const reset = groupApprovals(after.approvals.filter((approval) => previous && approval.proposal_version_id === previous.id && approval.status === 'invalidated')).map(
      (group) => ({ what: group.what, by: nameOf(group.approverId) }),
    );
    changes.push({
      type: 'corrected',
      by: nameOf(version.created_by),
      versionNo: version.version_no,
      reason: typeof review?.payload.reason === 'string' ? review.payload.reason : 'the fix changed',
      reset,
    });
  }

  const oldApprovals = known(before.approvals);
  const supplierOf = (versionId: string) => {
    const version = after.versions.find((candidate) => candidate.id === versionId);
    const proposal = version ? after.proposals.find((candidate) => candidate.id === version.proposal_id) : undefined;
    return plan.bookings.find((booking) => booking.id === proposal?.booking_id)?.supplierName ?? null;
  };
  for (const group of groupApprovals(after.approvals.filter((approval) => !oldApprovals.has(approval.id) && approval.status === 'active'))) {
    changes.push({
      type: 'approved',
      what: group.what,
      by: nameOf(group.approverId),
      versionNo: versionNo(group.versionId),
      amountMinor: group.amountMinor,
      supplier: supplierOf(group.versionId),
    });
  }

  for (const publication of after.publications) {
    const old = before.publications.find((candidate) => candidate.id === publication.id);
    if (publication.status === 'published' && old?.status !== 'published') changes.push({ type: 'published', changeNo: publication.published_revision });
  }

  for (const payment of after.payments) {
    const old = before.payments.find((candidate) => candidate.id === payment.id);
    if ((payment.status === 'succeeded' || payment.status === 'failed') && old?.status !== payment.status) {
      changes.push({ type: 'payment_settled', status: payment.status, amountMinor: payment.amount_minor, feeMinor: payment.fee_minor, message: payment.message });
    }
  }

  const oldDocuments = known(before.documents);
  for (const document of after.documents) {
    if (!oldDocuments.has(document.id) && document.kind === 'receipt') changes.push({ type: 'receipt_filed', name: document.name, summary: document.summary });
  }

  for (const proposal of after.proposals) {
    const old = before.proposals.find((candidate) => candidate.id === proposal.id);
    if (proposal.state === 'cancelled' && old && old.state !== 'cancelled') changes.push({ type: 'cancelled', reason: null });
  }

  return changes;
}

/**
 * One line per change, for the `<app_event>` the model reads. `money: false` (someone reading the
 * thread may not see costs) leaves the amounts out, so even the words the model echoes carry none.
 */
export function describeChange(change: ProgressChange, options: { money?: boolean } = {}): string {
  const money = options.money ?? true;
  switch (change.type) {
    case 'approved': {
      const paid = money && change.amountMinor !== null ? `${usd(change.amountMinor)} to ${change.supplier ?? 'the supplier'}` : null;
      if (change.what === 'fix') return `${change.by} approved the fix${paid ? `: ${paid}` : ': the new dates and the payment'} (version ${change.versionNo}).`;
      if (change.what === 'dates') return `${change.by} approved the new dates (version ${change.versionNo}); the payment still needs approving.`;
      return `${change.by} approved the payment${paid ? ` of ${paid}` : ''} (version ${change.versionNo}): the fix is approved.`;
    }
    case 'corrected':
      return `${change.by} changed the fix: version ${change.versionNo} (${change.reason}).${change.reset.length ? ` ${change.reset.length === 1 ? 'Approval' : 'Approvals'} reset: ${change.reset.map((reset) => `${reset.by} (${approvalWords(reset.what)})`).join(', ')}.` : ''}`;
    case 'proposed_by_person':
      return `${change.by} put a fix on the table.`;
    case 'published':
      return `The change is in everyone's plan${change.changeNo ? ` (change #${change.changeNo})` : ''}.`;
    case 'payment_settled':
      if (!money) return change.status === 'succeeded' ? 'PayPal confirmed the payment.' : `PayPal could not make the payment${change.message ? `: ${change.message}` : ''}.`;
      return change.status === 'succeeded'
        ? `PayPal confirmed the payment of ${usd(change.amountMinor)}${change.feeMinor !== null ? ` (PayPal fee ${usd(change.feeMinor)})` : ''}.`
        : `PayPal could not make the payment of ${usd(change.amountMinor)}${change.message ? `: ${change.message}` : ''}.`;
    case 'receipt_filed':
      return `The receipt was filed: ${money ? (change.summary ?? change.name) : change.name}.`;
    case 'cancelled':
      return 'The fix was declined and taken off the table.';
  }
}

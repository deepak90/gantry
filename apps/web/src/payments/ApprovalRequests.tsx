/**
 * The second person's side of a large payout (payments/pay-approvals.ts): when someone requests their approval of a
 * progress payout, the request comes up in the middle of their screen, live, with the same details the payer reviewed:
 * each trade partner, its scope, % complete, scheduled value, retainage and the amount due; the total with PayPal's
 * fee; the funding source; what it releases on the plan. Approve or Decline is their own press, checked again by the
 * database (someone else who sees costs, within their approval limit); the payer's window hears it at once.
 */
import type { ProjectModel } from '@bryntum/gantt';
import type { CurrencyCode } from '@collab/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { gateIndex } from '../gantt/pay-gates';
import { APPROVAL_FRESH_MS, decidePayGateApproval, type PayGateApprovalRow } from './pay-approvals';
import { nameOf, usePayApprovals } from './pay-approvals-context';
import { linesFromApproval, PaymentDetails, releaseOf, useCheckout } from './PayModal';
import { balanceOwner, counted, checkoutFeeMinor, payoutFee } from './payout-sheet';
import '../styles/pay-modal.css';

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** Requests waiting for this person: asked by someone else, for an amount this person may approve. */
export function requestsFor(rows: readonly PayGateApprovalRow[] | null, userId: string, mayApprove: (amountMinor: number) => boolean): PayGateApprovalRow[] {
  return (rows ?? []).filter((row) => row.status === 'requested' && row.requested_by !== userId && mayApprove(row.amount_minor));
}

export function ApprovalRequests({ project, currency }: { project: ProjectModel; currency: CurrencyCode }) {
  const session = usePayApprovals();
  const onPayPal = useCheckout()?.live === true;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [deciding, setDeciding] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const me = session?.people.find((person) => person.userId === session.userId) ?? null;
  const waiting = useMemo(() => (session && me?.canViewCosts ? requestsFor(session.approvals, session.userId, (amount) => me.approvalLimitMinor >= amount) : []), [session, me]);
  const request = waiting.filter((row) => !dismissed.has(row.id)).at(-1) ?? null;
  useEffect(() => {
    setError(null);
    if (request) heading.current?.focus({ preventScroll: true });
  }, [request?.id]);
  if (!session || !request) return null;

  const gate = gateIndex(project).gates.get(request.gate_id) ?? null;
  const lines = linesFromApproval(request);
  const fee = onPayPal ? { minor: lines.reduce((sum, line) => sum + checkoutFeeMinor(line.amountMinor), 0), reported: false } : payoutFee(lines.length, null);
  const asker = nameOf(session.people, request.requested_by);
  const pays = gate ? gate.pays.map((row) => row.name).join(', ') : request.gate_name;
  const decide = async (approve: boolean) => {
    setDeciding(approve ? 'approve' : 'decline');
    setError(null);
    try {
      await decidePayGateApproval(session.client, request.id, approve);
      session.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeciding(null);
    }
  };

  return createPortal(
    <div className="pay-modal-scrim">
      <section className="pay-modal is-request" role="dialog" aria-modal="true" aria-labelledby="pay-approval-title" data-testid="pay-approval-request" data-approval={request.id}>
        <header className="pay-modal-head">
          <div>
            <p className="pay-modal-kicker">Approval request · {onPayPal ? 'PayPal' : 'PayPal Payouts'}</p>
            <h2 ref={heading} id="pay-approval-title" className="pay-modal-title" tabIndex={-1}>
              {onPayPal ? 'Approve payment' : 'Approve payout'}
            </h2>
            <p className="pay-modal-sub">
              Progress payment · {pays} · {counted(lines.length, 'trade partner')}
            </p>
            <p className="pay-modal-sub" data-testid="pay-approval-requested">
              Requested by {asker} · {TIME.format(new Date(request.created_at))}
            </p>
          </div>
          <button type="button" className="button is-quiet is-icon" aria-label="Not now" title="Not now" onClick={() => setDismissed((before) => new Set([...before, request.id]))} data-testid="pay-approval-later">
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </header>
        <div className="pay-modal-body">
          <PaymentDetails lines={lines} currency={currency} retainagePercent={retainageOf(lines)} feeMinor={fee.minor} feeReported={false} checkout={onPayPal} owner={balanceOwner(project)} release={gate ? releaseOf(gate) : null} testId="pay-approval" />
          <p className="pay-approval-terms">
            Second approval · {onPayPal ? 'payments' : 'payouts'} over {wholeDollars(request.over_minor)}
            <small>
              Valid {Math.round(APPROVAL_FRESH_MS / 60_000)} minutes, for these amounts only · sent by {asker}
            </small>
          </p>
          {error && (
            <p className="note is-danger is-sm">
              <i className="fa fa-triangle-exclamation" aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
        </div>
        <footer className="pay-modal-actions">
          <button type="button" className="button is-quiet" onClick={() => void decide(false)} disabled={deciding !== null} data-testid="pay-approval-decline">
            Decline
          </button>
          <button type="button" className="button is-primary" onClick={() => void decide(true)} disabled={deciding !== null} data-testid="pay-approval-approve">
            <i className="fa fa-check" aria-hidden="true" /> Approve
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

const wholeDollars = (minor: number) => `$${Math.round(minor / 100).toLocaleString('en-US')}`;

/** The share kept back, from the lines (what is kept back over what the work done is worth), as a whole percent. */
function retainageOf(lines: readonly { valueMinor: number; retainedMinor: number; percentDone: number }[]): number {
  const earned = lines.reduce((sum, line) => sum + Math.round((line.valueMinor * line.percentDone) / 100), 0);
  const kept = lines.reduce((sum, line) => sum + line.retainedMinor, 0);
  return earned > 0 ? Math.round((kept / earned) * 100) : 0;
}

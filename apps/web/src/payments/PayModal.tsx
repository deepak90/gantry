/**
 * The payment window: a progress payment reviewed and sent from the middle of the screen, with what a careful payer
 * wants to see before money moves, in a pay application's terms: each trade partner, its scope, % complete, scheduled
 * value, retainage and the amount due; the total with PayPal's fee; the funding source (the PayPal balance: Payouts pay
 * from it alone); what paying releases on the plan; and, over the project's threshold, the second approval it needs
 * first (payments/pay-approvals.ts).
 *
 * Opening it requests that approval (the approver's screen shows it, ApprovalRequests.tsx); the answer arrives live, and
 * Send payout stays locked until they have approved exactly these amounts. Once sent, three steps follow PayPal's own
 * statuses for the batch and for each payment: submitted to PayPal, processing, paid.
 *
 * With PayPal live on this machine the payment is made on PayPal's own pages: PayPal's button appears once the approval
 * is in, the payer signs in and chooses how to pay in PayPal's window, and PayPal's fee comes out of what each firm
 * receives. The hosted site sends the payout (its paypal-progress-payout function): a visitor has no PayPal sandbox
 * login to pay with.
 *
 * The press is the person's own; the assistant never presses it. "PayPal" is plain text here, apart from PayPal's own
 * button and PayPal's mark beside what PayPal has paid.
 */
import type { ProjectModel } from '@bryntum/gantt';
import { format, money, type CurrencyCode, type FirmProgress } from '@collab/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { coverChart } from '../gantt/hold-look';
import { forecastLatePayment } from '../gantt/late-payment';
import { wholeMoney } from '../gantt/look';
import { batchReport, captureGateOrder, checkoutConfig, createGateOrder, onBatchReport, payGateNow, PayoutRefused, type BatchStatus, type CheckoutConfig } from '../gantt/pay-gate-payment';
import { gateIndex, paymentOf, scheduledPayDay, type Gate } from '../gantt/pay-gates';
import { APPROVAL_FRESH_MS, requestPayGateApproval, sameLines, withdrawPayGateApproval, payoutRule, type PayGateApprovalLine, type PayGateApprovalRow } from './pay-approvals';
import { nameAndTitle, nameOf, usePayApprovals, type PayPerson } from './pay-approvals-context';
import { payoutItems, payoutPhase, payoutSteps, type StepState } from './pay-progress';
import { HOSTED } from '../hosted';
import { loadPayPalSdk, PayPalButton } from './PayPalButton';
import { PAYOUT_RATE_MINOR, balanceOwner, balanceWords, checkoutFeeMinor, counted, payoutFee } from './payout-sheet';
import '../styles/pay-modal.css';

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const SECONDS = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// ---------------------------------------------------------------------------------------------
// Pieces shared with the approver's window
// ---------------------------------------------------------------------------------------------

/** Whether payments are made on PayPal's own pages here; null until the dev route has said. */
export function useCheckout(): CheckoutConfig | null {
  const [config, setConfig] = useState<CheckoutConfig | null>(null);
  useEffect(() => {
    let live = true;
    void checkoutConfig().then((found) => {
      if (live) setConfig(found);
    });
    return () => {
      live = false;
    };
  }, []);
  return config;
}

/** A circular status mark: an empty ring, a ring PayPal is still working on (it turns), a check, or a warning. */
export function ProgressRing({ state, size = 28, label }: { state: StepState; size?: number; label?: string }) {
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  return (
    <span className={`pay-ring is-${state}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle className="pay-ring-track" cx={size / 2} cy={size / 2} r={r} />
        {state === 'active' && <circle className="pay-ring-arc" cx={size / 2} cy={size / 2} r={r} strokeDasharray={`${(c * 0.28).toFixed(2)} ${c.toFixed(2)}`} />}
        {state === 'done' && <circle className="pay-ring-fill" cx={size / 2} cy={size / 2} r={r + 1} />}
        {state === 'failed' && <circle className="pay-ring-fill" cx={size / 2} cy={size / 2} r={r + 1} />}
      </svg>
      {state === 'done' && <i className="fa fa-check" aria-hidden="true" />}
      {state === 'failed' && <i className="fa fa-exclamation" aria-hidden="true" />}
    </span>
  );
}

/** One firm's line as reviewed: who, what for, how much is done, the value, what is kept back, the amount. */
export interface PayLine {
  firm: string;
  for: string;
  percentDone: number;
  valueMinor: number;
  retainedMinor: number;
  amountMinor: number;
}

export function linesOf(firms: readonly FirmProgress[]): PayLine[] {
  return firms
    .filter((firm) => firm.dueMinor > 0)
    .map((firm) => ({ firm: firm.firm, for: firm.items.map((item) => item.taskName).join(' · '), percentDone: Math.round(firm.percentDone), valueMinor: firm.valueMinor, retainedMinor: firm.retainedMinor, amountMinor: firm.dueMinor }));
}

export function approvalLines(lines: readonly PayLine[]): PayGateApprovalLine[] {
  return lines.map((line) => ({ firm: line.firm, amount_minor: line.amountMinor, for: line.for, percent_done: line.percentDone, value_minor: line.valueMinor, retained_minor: line.retainedMinor }));
}

export function linesFromApproval(row: PayGateApprovalRow): PayLine[] {
  return row.lines.map((line) => ({ firm: line.firm, for: line.for ?? '', percentDone: line.percent_done ?? 0, valueMinor: line.value_minor ?? 0, retainedMinor: line.retained_minor ?? 0, amountMinor: line.amount_minor }));
}

/** What paying releases on the plan: the held work, and when it can start once the money is in. */
export interface Release {
  names: string;
  start: Date | null;
}

export function releaseOf(gate: Gate): Release {
  const starts = gate.holds.map((row) => row.startDate).filter((date): date is Date => date instanceof Date);
  return { names: gate.holds.map((row) => row.name).join(' and '), start: starts.length > 0 ? new Date(Math.min(...starts.map((date) => date.getTime()))) : null };
}

/** The payment's lines, total and facts, as both the payer and the approver see them. */
export function PaymentDetails({
  lines,
  currency,
  retainagePercent,
  feeMinor,
  feeReported,
  owner,
  release,
  items,
  checkout = false,
  testId,
}: {
  lines: readonly PayLine[];
  currency: CurrencyCode;
  retainagePercent: number;
  feeMinor: number;
  feeReported: boolean;
  owner: string | null;
  release: Release | null;
  /** Once sent: each firm's payment as PayPal reports it, by firm. */
  items?: ReadonlyMap<string, ReactNode>;
  /** Paid on PayPal's own pages: the payer picks the funding there, and PayPal's fee comes out of what each firm receives. */
  checkout?: boolean;
  testId: string;
}) {
  const whole = (minor: number) => wholeMoney(minor, currency);
  const exact = (minor: number) => format(money(minor, currency));
  const toFirms = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  return (
    <>
      <table className="pay-lines">
        <thead>
          <tr>
            <th scope="col">Trade partner</th>
            <th scope="col">% complete</th>
            <th scope="col">Scheduled value</th>
            <th scope="col">Retainage</th>
            <th scope="col">Amount due</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.firm} data-testid={`${testId}-line`}>
              <th scope="row">
                <span className="pay-line-firm">{line.firm}</span>
                {line.for && <span className="pay-line-for">Scope: {line.for}</span>}
                {items?.get(line.firm)}
              </th>
              <td>{line.percentDone}%</td>
              <td>{whole(line.valueMinor)}</td>
              <td>{whole(line.retainedMinor)}</td>
              <td className="pay-line-amount">{whole(line.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={4}>
              Due this period
              <small>
                {counted(lines.length, 'trade partner')} · net of {retainagePercent}% retainage
              </small>
            </th>
            <td>{whole(toFirms)}</td>
          </tr>
          <tr>
            <th scope="row" colSpan={4}>
              PayPal fee
              <small>{checkout ? `${feeReported ? 'As reported by PayPal' : '3.49% + $0.49 each'} · deducted from what each firm receives` : feeReported ? 'As reported by PayPal' : `${exact(PAYOUT_RATE_MINOR)} per payment · PayPal US Payouts rate`}</small>
            </th>
            <td>{checkout ? `(${exact(feeMinor)})` : exact(feeMinor)}</td>
          </tr>
          {checkout && (
            <tr data-testid={`${testId}-net`}>
              <th scope="row" colSpan={4}>
                Net to trade partners
              </th>
              <td>{exact(toFirms - feeMinor)}</td>
            </tr>
          )}
          <tr className="pay-lines-total">
            <th scope="row" colSpan={4}>
              {checkout ? 'Total charged' : 'Total'}
            </th>
            <td data-testid={`${testId}-total`}>{exact(checkout ? toFirms : toFirms + feeMinor)}</td>
          </tr>
        </tfoot>
      </table>
      <dl className="pay-facts">
        <div>
          <dt>Funding source</dt>
          <dd data-testid={`${testId}-from`}>
            {checkout ? 'Chosen at PayPal' : balanceWords(owner)}
            <small>{checkout ? 'Balance, bank or card, in PayPal’s own window' : 'Payouts are funded from the PayPal balance only · no fee to payees'}</small>
          </dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd>{checkout ? `PayPal Checkout · 1 approval, ${counted(lines.length, 'payment')}` : `PayPal Payouts · 1 batch, ${counted(lines.length, 'payment')}`}</dd>
        </div>
        {release && release.names && (
          <div>
            <dt>Releases</dt>
            <dd data-testid={`${testId}-releases`}>
              <strong>{release.names}</strong>
              {release.start ? ` · can start ${DAY.format(release.start)}` : ' · held until paid'}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The payer's window
// ---------------------------------------------------------------------------------------------

type ApprovalState = 'not-needed' | 'unavailable' | 'nobody' | 'asking' | 'requested' | 'approved' | 'declined' | 'withdrawn' | 'stale' | 'changed' | 'error';

export interface PayModalProps {
  project: ProjectModel;
  gate: Gate;
  currency: CurrencyCode;
  /** The plan's data version: amounts are worked out again when it changes. */
  dataVersion: unknown;
  /** Opened on a payout PayPal already has: its batch and the firms as sent. */
  watching?: { batchId: string; sent: { firm: string; amountMinor: number }[] } | null;
  onClose(): void;
}

export function PayModal({ project, gate, currency, dataVersion, watching = null, onClose }: PayModalProps) {
  const session = usePayApprovals();
  const heading = useRef<HTMLHeadingElement>(null);
  const payment = useMemo(() => paymentOf(gate), [gate, dataVersion]);
  const lines = useMemo(() => linesOf(payment.firms), [payment]);
  const asLines = useMemo(() => approvalLines(lines), [lines]);
  const [asked, setAsked] = useState<PayGateApprovalRow | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [atPayPal, setAtPayPal] = useState(false);
  const [sent, setSent] = useState<{ firm: string; amountMinor: number }[] | null>(watching?.sent ?? null);
  // The lines as sent: once PayPal pays, the plan counts them as paid, and nothing would be due any more.
  const [sentLines, setSentLines] = useState<PayLine[] | null>(() => (watching ? linesOf(paymentOf(gate).firms) : null));
  const [batchId, setBatchId] = useState<string | null>(watching?.batchId ?? null);
  const [times, setTimes] = useState<{ sent?: number; processed?: number; paid?: number }>({});
  const [releaseStart, setReleaseStart] = useState<Date | null | undefined>(undefined);
  const status: BatchStatus | null = useSyncExternalStore(onBatchReport, () => batchReport(batchId));
  const owner = balanceOwner(project);
  const checkout = useCheckout();
  const onPayPal = checkout?.live === true && Boolean(checkout.clientId);
  useEffect(() => {
    if (onPayPal) void loadPayPalSdk().catch(() => {});
  }, [onPayPal]);

  // The chart behind waits for this window to close before it shows a released hold.
  useEffect(() => {
    coverChart(true);
    return () => coverChart(false);
  }, []);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);

  // Paid on a later day than it falls due, the held work moves up once paid: the engine says to when (on a branch).
  useEffect(() => {
    if (!scheduledPayDay(gate)) return;
    let live = true;
    void forecastLatePayment(project, gate, []).then((forecast) => {
      if (live) setReleaseStart(forecast?.onTime.heldStart ?? null);
    });
    return () => {
      live = false;
    };
  }, [project, gate]);

  const rule = useMemo(() => payoutRule(payment.dueMinor, session?.overMinor, session?.people ?? [], session?.userId ?? ''), [payment.dueMinor, session?.overMinor, session?.people, session?.userId]);
  // The live row: the snapshot's (broadcast) once it is at least as new as what the call answered.
  const live = session?.approvals?.find((row) => row.id === asked?.id) ?? null;
  const approval = live && (!asked || Date.parse(live.updated_at) >= Date.parse(asked.updated_at)) ? live : asked;
  const fresh = approval?.decided_at ? Date.now() - Date.parse(approval.decided_at) < APPROVAL_FRESH_MS : false;
  const matches = approval ? approval.amount_minor === payment.dueMinor && sameLines(approval.lines, asLines) : false;
  const started = sent !== null;

  // Opening the review asks the second person, once for each set of amounts (asking again returns the open request).
  const askKey = rule.needed ? JSON.stringify(asLines.map((line) => [line.firm, line.amount_minor])) : null;
  useEffect(() => {
    if (!session || !askKey || started || session.approvals === null || rule.signers.length === 0 || typeof gate.id !== 'number') return;
    let live = true;
    setAsking(true);
    setAskError(null);
    requestPayGateApproval(session.client, { projectId: session.projectId, gateId: gate.id, gateName: gate.task.name ?? 'Payment', amountMinor: payment.dueMinor, currency, lines: asLines })
      .then((row) => {
        if (!live) return;
        setAsked(row);
        session.reload();
      })
      .catch((error: unknown) => live && setAskError(error instanceof Error ? error.message : String(error)))
      .finally(() => live && setAsking(false));
    return () => {
      live = false;
    };
    // Asked again only when the amounts change (askKey), not on every snapshot.
  }, [askKey, session?.approvals === null, rule.signers.length]);

  // When each step first came true, as PayPal's answers arrived here.
  const steps = payoutSteps({ sending, batchId, status, error: sendError, sent: sent ?? [], checkout: onPayPal });
  const phase = payoutPhase(steps, started);
  useEffect(() => {
    const now = Date.now();
    setTimes((before) => ({
      sent: before.sent ?? (steps[0]!.state === 'done' ? now : undefined),
      processed: before.processed ?? (steps[1]!.state === 'done' ? now : undefined),
      paid: before.paid ?? (steps[2]!.state === 'done' ? now : undefined),
    }));
  }, [steps[0]!.state, steps[1]!.state, steps[2]!.state]);

  const approvalState: ApprovalState = !rule.needed
    ? 'not-needed'
    : !session || session.approvals === null
      ? 'unavailable'
      : rule.signers.length === 0
        ? 'nobody'
        : askError
          ? 'error'
          : !approval
            ? 'asking'
            : !matches
              ? 'changed'
              : approval.status === 'approved'
                ? fresh
                  ? 'approved'
                  : 'stale'
                : approval.status === 'requested'
                  ? 'requested'
                  : approval.status === 'declined'
                    ? 'declined'
                    : approval.status === 'used'
                      ? 'approved'
                      : 'withdrawn';
  const canSend = !started && !sending && payment.dueMinor > 0 && gate.payGate.state !== 'paying' && gate.payGate.state !== 'paid' && (approvalState === 'not-needed' || approvalState === 'approved');

  const askAgain = () => {
    if (!session || typeof gate.id !== 'number') return;
    setAsking(true);
    setAskError(null);
    requestPayGateApproval(session.client, { projectId: session.projectId, gateId: gate.id, gateName: gate.task.name ?? 'Payment', amountMinor: payment.dueMinor, currency, lines: asLines })
      .then((row) => {
        setAsked(row);
        session.reload();
      })
      .catch((error: unknown) => setAskError(error instanceof Error ? error.message : String(error)))
      .finally(() => setAsking(false));
  };

  /** Closed without sending: an open request is taken back, so the other person's screen lets it go. */
  const close = () => {
    if (!started && session && approval && (approval.status === 'requested' || approval.status === 'approved') && approval.requested_by === session.userId) {
      void withdrawPayGateApproval(session.client, approval.id)
        .then(() => session.reload())
        .catch(() => {});
    }
    onClose();
  };

  const send = async () => {
    if (!canSend || !session) return;
    const now = paymentOf(gate);
    if (now.dueMinor !== payment.dueMinor) {
      setSendError('Amounts changed during review. Review them again before sending.');
      return;
    }
    const firms = lines.map((line) => ({ firm: line.firm, amountMinor: line.amountMinor }));
    setSendError(null);
    setSending(true);
    setSentLines(lines);
    setSent(firms);
    let tookIt = false;
    try {
      const { data } = await session.client.auth.getSession();
      const outcome = await payGateNow(project, gate, currency, {
        auth: { projectId: session.projectId, token: data.session?.access_token ?? null, approvalId: approvalState === 'approved' ? (approval?.id ?? null) : null },
        // How it stands is asked as this person, with their login as it is then.
        reader: { projectId: session.projectId, token: async () => (await session.client.auth.getSession()).data.session?.access_token ?? null },
        onSent: (id) => {
          tookIt = true;
          setBatchId(id);
          setSending(false);
        },
      });
      // PayPal turned it down before there was a batch (not enough money in the account, say): the hold says it
      // failed, so this window does too, with PayPal's words, and goes back to the review for another try.
      if (outcome === 'failed' && !tookIt) {
        const latest = gateIndex(project).gates.get(gate.id);
        setSendError(latest?.payGate.error ?? 'PayPal did not take the payout. Nothing was paid.');
        setSent((open) => (open === firms ? null : open));
        setSentLines(null);
        session.reload();
      }
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
      // Nothing reached PayPal (refused by the database, or PayPal didn't take it): back to the review, with the reason.
      if (reason instanceof PayoutRefused || !tookIt) {
        setSent((open) => (open === firms ? null : open));
        setSentLines(null);
      }
      session.reload();
    } finally {
      setSending(false);
    }
  };

  /** PayPal's button was pressed: makes the order its window approves (the database's check is made here). */
  const createOrder = () => {
    setSendError(null);
    setAtPayPal(true);
    return (async () => {
      if (!session) throw new Error('Sign in again: the payment needs your login.');
      if (paymentOf(gate).dueMinor !== payment.dueMinor) throw new Error('Amounts changed during review. Review them again before paying.');
      const { data } = await session.client.auth.getSession();
      const orderId = await createGateOrder(project, gate, currency, { projectId: session.projectId, token: data.session?.access_token ?? null, approvalId: approvalState === 'approved' ? (approval?.id ?? null) : null });
      return { orderId };
    })();
  };

  /** The payer approved in PayPal's window: the money is taken and PayPal's answer written to the plan. */
  const approvedAtPayPal = async (orderId: string) => {
    setAtPayPal(false);
    setSendError(null);
    setSending(true);
    setSentLines(lines);
    setSent(lines.map((line) => ({ firm: line.firm, amountMinor: line.amountMinor })));
    setBatchId(orderId);
    try {
      await captureGateOrder(project, gate, orderId);
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
      session?.reload();
    }
  };

  const shown = started && sentLines ? sentLines : lines;
  const paypalFee = reportedFee(status);
  const fee = onPayPal ? { minor: paypalFee ?? shown.reduce((sum, line) => sum + checkoutFeeMinor(line.amountMinor), 0), reported: paypalFee !== null } : payoutFee(shown.length, paypalFee);
  const items = started ? payoutItems({ status, sent: sent ?? [] }) : [];
  // Each payment's status, and PayPal's transaction ID on a line of its own under it (they run 17 characters).
  const itemMarks = new Map<string, ReactNode>(
    items.map((item) => [
      item.firm,
      <span key={item.firm} className="pay-line-item">
        <span className={`pay-line-status is-${item.tone}`} data-testid="pay-modal-item" data-status={item.tone}>
          <ProgressRing state={item.tone === 'paid' ? 'done' : item.tone === 'failed' || item.tone === 'held' ? 'failed' : 'active'} size={16} />
          <span>
            {item.word ? `PayPal: ${item.word}` : 'Submitting to PayPal…'}
            {item.note && item.tone !== 'paid' && <span className="pay-line-note"> · {item.note}</span>}
          </span>
        </span>
        {item.transactionId && <span className="pay-line-tx">Transaction ID {item.transactionId}</span>}
      </span>,
    ]),
  );
  const release = releaseOf(gate);
  const shownRelease: Release = { names: release.names, start: releaseStart === undefined ? release.start : releaseStart };
  // The approvers by name ("Chris Hale"), for the approver line and the status line.
  const people: readonly PayPerson[] = session?.people ?? [];
  const approvers = rule.signers.map((signer) => nameAndTitle(people.find((person) => person.userId === signer.userId) ?? signer));
  const signers = rule.signers.map((signer) => signer.name).join(' or ');
  const approver = approval?.decided_by ? nameOf(people, approval.decided_by) : null;

  return createPortal(
    <div
      className="pay-modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !started) close();
      }}
    >
      <section
        className={`pay-modal is-${phase}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-modal-title"
        data-testid="pay-modal"
        data-phase={phase}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (!sending) (started ? onClose : close)();
        }}
      >
        <header className="pay-modal-head">
          <div>
            <p className="pay-modal-kicker">{onPayPal ? 'PayPal' : 'PayPal Payouts'}</p>
            <h2 ref={heading} id="pay-modal-title" className="pay-modal-title" tabIndex={-1}>
              {phase === 'paid' ? 'Paid' : phase === 'failed' ? 'Payment not completed' : started ? 'Payment processing' : 'Review your payment'}
            </h2>
            <p className="pay-modal-sub">
              Progress payment · {gate.pays.map((row) => row.name).join(', ')} · {counted(shown.length, 'trade partner')}
            </p>
          </div>
          <button type="button" className="button is-quiet is-icon" aria-label="Close" onClick={started ? onClose : close} disabled={sending && !batchId} data-testid="pay-modal-close">
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </header>

        <div className="pay-modal-body">
          <PaymentDetails lines={shown} currency={currency} retainagePercent={Math.round(payment.retainage * 100)} feeMinor={fee.minor} feeReported={fee.reported} owner={owner} release={shownRelease} items={started ? itemMarks : undefined} checkout={onPayPal} testId="pay-modal" />

          {started ? (
            <div className="pay-progress" data-testid="pay-progress" aria-live="polite">
              <ol className="pay-steps">
                {steps.map((step) => {
                  const at = step.key === 'sent' ? times.sent : step.key === 'processing' ? times.processed : times.paid;
                  return (
                    <li key={step.key} className={`pay-step is-${step.state}`} data-testid={`pay-progress-${step.key}`} data-state={step.state}>
                      <ProgressRing state={step.state} />
                      <span className="pay-step-text">
                        <span className="pay-step-label">
                          {step.key === 'paid' && step.state === 'done' && <img className="paypal-mark" src="/paypal/paypal-mark.svg" alt="" aria-hidden="true" />}
                          {step.label}
                        </span>
                        <span className="pay-step-detail">
                          {step.detail}
                          {at && step.state === 'done' ? ` · ${SECONDS.format(at)}` : ''}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              {batchId && (
                <p className="pay-modal-batch" data-testid="pay-modal-batch">
                  PayPal {onPayPal ? 'order' : 'batch'} ID <strong>{batchId}</strong>
                </p>
              )}
              {phase === 'paid' && shownRelease.names && (
                <p className="pay-modal-released" data-testid="pay-modal-released">
                  <i className="fa fa-lock-open" aria-hidden="true" /> {shownRelease.names} released{shownRelease.start ? ` · can start ${DAY.format(shownRelease.start)}` : ''}
                </p>
              )}
              {sendError && (
                <p className="note is-danger is-sm">
                  <i className="fa fa-triangle-exclamation" aria-hidden="true" />
                  <span>{sendError}</span>
                </p>
              )}
            </div>
          ) : (
            rule.needed && (
              <div className={`pay-approval is-${approvalState}`} data-testid="pay-approval">
                <p className="pay-approval-title">
                  <i className="fa fa-user-check" aria-hidden="true" /> Second approval required
                  <span className="pay-approval-threshold">{` · ${onPayPal ? 'payments' : 'payouts'} over ${wholeMoney(rule.overMinor, currency)}`}</span>
                </p>
                {approvers.length > 0 && (
                  <p className="pay-approval-rule" data-testid="pay-approval-approver">
                    {approvers.length === 1 ? `Approver: ${approvers[0]}` : `Approvers (any one): ${approvers.join(' · ')}`}
                  </p>
                )}
                <p className="pay-approval-status" data-testid="pay-approval-status" data-state={approvalState} aria-live="polite">
                  <ApprovalLine state={approvalState} signers={signers} approver={approver} approval={approval} error={askError} />
                </p>
                {(approvalState === 'declined' || approvalState === 'withdrawn' || approvalState === 'stale' || approvalState === 'changed' || approvalState === 'error') && (
                  <button type="button" className="button is-sm" onClick={askAgain} disabled={asking} data-testid="pay-approval-ask">
                    Request approval again
                  </button>
                )}
              </div>
            )
          )}
          {!started && atPayPal && (
            <p className="note is-sm" data-testid="pay-modal-at-paypal">
              <i className="fa fa-arrow-up-right-from-square" aria-hidden="true" />
              <span>Finish in PayPal’s window.</span>
            </p>
          )}
          {!started && sendError && (
            <p className="note is-danger is-sm">
              <i className="fa fa-triangle-exclamation" aria-hidden="true" />
              <span>{sendError}</span>
            </p>
          )}
        </div>

        <footer className="pay-modal-actions">
          {started ? (
            <button type="button" className={phase === 'paid' ? 'button is-primary' : 'button'} onClick={onClose} data-testid="pay-modal-done">
              {phase === 'paid' ? 'Done' : 'Close'}
            </button>
          ) : (
            <>
              <button type="button" className="button is-quiet" onClick={close} data-testid="pay-modal-cancel">
                Cancel
              </button>
              {!HOSTED && onPayPal && canSend && checkout?.clientId ? (
                <PayPalButton
                  clientId={checkout.clientId}
                  createOrder={createOrder}
                  onApprove={(orderId) => void approvedAtPayPal(orderId)}
                  onCancel={() => {
                    setAtPayPal(false);
                    setSendError(null);
                  }}
                  onError={(message) => {
                    setAtPayPal(false);
                    setSendError(message);
                    session?.reload();
                  }}
                  testId="pay-modal-send"
                />
              ) : (
                <button type="button" className="button is-primary" disabled={!canSend} onClick={() => void send()} data-testid="pay-modal-send" title={canSend ? undefined : rule.needed ? 'Awaiting second approval' : undefined}>
                  <i className={`fa ${canSend ? 'fa-paper-plane' : 'fa-lock'}`} aria-hidden="true" /> {onPayPal ? 'Pay with PayPal' : 'Send payout'}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** The approval's status as a label: "Pending · requested 10:40 AM", then "Approved by Chris Hale · 10:42 AM". */
function ApprovalLine({ state, signers, approver, approval, error }: { state: ApprovalState; signers: string; approver: string | null; approval: PayGateApprovalRow | null; error: string | null }) {
  const askedAt = approval ? TIME.format(new Date(approval.created_at)) : null;
  const decidedAt = approval?.decided_at ? TIME.format(new Date(approval.decided_at)) : null;
  switch (state) {
    case 'asking':
      return (
        <>
          <ProgressRing state="active" size={18} /> <span>Requesting approval…</span>
        </>
      );
    case 'requested':
      return (
        <>
          <ProgressRing state="active" size={18} /> <span>Pending{askedAt ? ` · requested ${askedAt}` : ''}</span>
        </>
      );
    case 'approved':
      return (
        <>
          <ProgressRing state="done" size={18} /> <span>Approved by {approver ?? signers}{decidedAt ? ` · ${decidedAt}` : ''}</span>
        </>
      );
    case 'declined':
      return (
        <>
          <ProgressRing state="failed" size={18} /> <span>Declined by {approver ?? signers}{decidedAt ? ` · ${decidedAt}` : ''}</span>
        </>
      );
    case 'stale':
      return <span>Approval expired · valid for 30 minutes</span>;
    case 'changed':
      return <span>Amounts changed after the request · approval needed again</span>;
    case 'withdrawn':
      return <span>Request withdrawn</span>;
    case 'nobody':
      return <span>No eligible approver · no other cost viewer's approval limit covers this amount</span>;
    case 'unavailable':
      return <span>Second approval not set up for this project · payout can't be sent</span>;
    case 'error':
      return <span>Approval request failed · {error}</span>;
    default:
      return null;
  }
}

/** The fee PayPal reports, once it has settled the batch: the batch's fee, else the sum of each payment's. */
function reportedFee(status: BatchStatus | null): number | null {
  if (status?.status !== 'SUCCESS') return null;
  if (status.feeMinor !== null && status.feeMinor !== undefined) return status.feeMinor;
  const fees = status.items.map((item) => item.feeMinor);
  return fees.length > 0 && fees.every((fee) => typeof fee === 'number') ? fees.reduce<number>((sum, fee) => sum + (fee ?? 0), 0) : null;
}

// ---------------------------------------------------------------------------------------------
// Open page-wide
// ---------------------------------------------------------------------------------------------

/**
 * Which gate's payment window is open. Page-wide, not the card's: the side panel moves on while PayPal pays (Remy's
 * answer brings her panel forward), and the window has to stay with the payment until the person closes it.
 */
type PayWindow = { gateId: number | string; watching: { batchId: string; sent: { firm: string; amountMinor: number }[] } | null };
let window_: PayWindow | null = null;
const windowListeners = new Set<() => void>();
const announce = () => {
  for (const listener of [...windowListeners]) listener();
};

/** Opens the payment window on a gate (to review it, or to follow a payout PayPal already has). */
export function openPayWindow(gateId: number | string, watching: PayWindow['watching'] = null): void {
  window_ = { gateId, watching };
  announce();
}

export function closePayWindow(): void {
  window_ = null;
  announce();
}

const subscribeWindow = (listener: () => void) => {
  windowListeners.add(listener);
  return () => {
    windowListeners.delete(listener);
  };
};

/** The open payment window, wherever the side panel is (app/Workspace.tsx renders it for people who see costs). */
export function PayWindowHost({ project, currency, dataVersion }: { project: ProjectModel; currency: CurrencyCode; dataVersion: unknown }) {
  const open = useSyncExternalStore(subscribeWindow, () => window_);
  const gate = open ? (gateIndex(project).gates.get(open.gateId) ?? null) : null;
  if (!open || !gate) return null;
  return <PayModal key={String(open.gateId)} project={project} gate={gate} currency={currency} dataVersion={dataVersion} watching={open.watching} onClose={closePayWindow} />;
}

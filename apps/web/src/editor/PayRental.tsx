/**
 * Paying a rental: the amount its dates come to, to the firm, with PayPal Payouts. Review payment opens the payout
 * sheet (the firm, PayPal's fee, the PayPal balance it comes from, the total); Send payout sends it, and the sheet
 * follows the payment as PayPal reports it. Changing the dates needs nothing from here, and paying needs nothing but
 * the dates: the record of what was approved and paid is written for the dates as they stand when it is sent.
 */
import { format, money, type CurrencyCode, type PaymentAuthorizationRow, type ProjectDocumentRow } from '@collab/shared';
import { useEffect, useState } from 'react';
import { PayoutSheet } from '../payments/PayoutSheet';
import { receiptTransactionId, rentalPaymentStatus } from '../payments/payout-sheet';
import type { WorkflowController, WorkflowViewState } from '../workflow/controller';
import { paymentBefore, paymentSent, type RentalStanding } from '../workflow/rental';
import { receiptFor } from '../workflow/model';
import '../styles/fix-flow.css';
import '../styles/rule-cards.css';

/** PayPal's own mark (public/paypal): beside "Paid", never on a button. */
export const PAYPAL_MARK = '/paypal/paypal-mark.svg';

export interface RentalPayEnv {
  controller: WorkflowController | null;
  state: WorkflowViewState;
  currency: CurrencyCode;
  onOpenDocument?: ((documentId: string) => void) | undefined;
  /** The general contractor, whose PayPal balance pays (payments/payout-sheet.ts); without one, "Your PayPal balance". */
  owner?: string | null;
}

/** The sheet: closed, under review, or sent (with the payment shown before, which is not the one sent). */
type Sheet = null | 'review' | { before: string | null };


/** How the payment came out, under the sheet or on its own: paid (with its receipt), held by PayPal, or refused. */
function Outcome({ payment, standing, env, testId, receipt, withBatch }: { payment: PaymentAuthorizationRow | null; standing: RentalStanding; env: RentalPayEnv; testId: string; receipt: ProjectDocumentRow | null; withBatch: boolean }) {
  const amount = (minor: number) => format(money(minor, env.currency));
  const paid = amount(payment?.amount_minor ?? standing.costMinor);
  const firm = standing.booking.supplier_name;
  if (payment?.status === 'succeeded') {
    return (
      <p className="review-row-note is-paid" data-testid={`${testId}-paid`}>
        <img className="paypal-mark" src={PAYPAL_MARK} alt="" aria-hidden="true" /> Paid {paid} to {firm}
        {withBatch && <span className="rental-pay-batch"> · PayPal Payouts{payment.paypal_batch_id ? ` · Batch ID ${payment.paypal_batch_id}` : ''}</span>}{' '}
        {receipt && env.onOpenDocument && (
          <button type="button" className="button is-link" onClick={() => env.onOpenDocument?.(receipt.id)} data-testid={`${testId}-receipt`}>
            Receipt
          </button>
        )}
      </p>
    );
  }
  if (payment?.status === 'failed') return <p className="review-row-note is-error" data-testid={`${testId}-failed`}>{payment.message ?? 'PayPal could not make this payment.'}</p>;
  // PayPal has the money but holds it (no account at that address, or a review): said as PayPal says it, not spun.
  if (payment?.message) {
    return (
      <p className="review-row-note" data-testid={`${testId}-processing`} data-held="true">
        <i className="fa fa-hourglass-half" aria-hidden="true" /> Sent {paid} to {firm} · Pending at PayPal: {payment.message}
      </p>
    );
  }
  return null;
}

export function PayRental({ standing, env, testId = 'rental-pay' }: { standing: RentalStanding; env: RentalPayEnv; testId?: string }) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const { booking, pay, payment, days, costMinor } = standing;
  const amount = (minor: number) => format(money(minor, env.currency));
  const busy = env.state.busy !== null;
  // A refusal of paying this rental (not another one paid at the same time).
  const failed = env.state.failure?.action === 'pay' && (!env.state.failure.bookingIds || env.state.failure.bookingIds.includes(booking.id)) ? env.state.failure : null;
  const failure = failed?.message ?? null;
  const receipt = env.state.snapshot ? receiptFor(env.state.snapshot.documents, payment?.id) : null;
  /** The payment Send payout made, once it has gone to PayPal (a refusal before PayPal is not one). */
  const sent = sheet !== null && sheet !== 'review' ? paymentSent(payment, sheet.before, failed) : null;

  // Refused before any payment was made (nothing reached PayPal): back to the review, with the reason over it.
  useEffect(() => {
    if (sheet !== null && sheet !== 'review' && !sent && !busy && failure) setSheet('review');
  }, [sheet, sent, busy, failure]);

  const summary = (
    <span>
      {days} {days === 1 ? 'day' : 'days'} · <strong>{amount(costMinor)}</strong>
    </span>
  );

  if (sheet !== null) {
    const phase = sheet === 'review' ? 'review' : sent ? 'sent' : 'sending';
    const said = rentalPaymentStatus(sent);
    const paid = sent?.status === 'succeeded';
    return (
      <div className="rental-pay">
        {phase === 'review' && failure && <p className="review-row-note is-error" data-testid={`${testId}-error`}>{failure}</p>}
        <div className="review-pay">{summary}</div>
        <PayoutSheet
          lines={[
            {
              key: booking.id,
              firm: booking.supplier_name,
              amountMinor: sent?.amount_minor ?? costMinor,
              paypalStatus: said.paypalStatus,
              transactionId: paid ? receiptTransactionId(receipt?.text_content) : null,
              // A held or refused payment says why once, under the sheet.
              note: sent?.status === 'unknown' ? said.note : null,
            },
          ]}
          currency={env.currency}
          owner={env.owner ?? null}
          phase={phase}
          batchIds={sent?.paypal_batch_id ? [sent.paypal_batch_id] : []}
          reportedFeeMinor={paid ? sent.fee_minor : null}
          disabled={busy || !env.controller}
          onSend={() => {
            setSheet({ before: paymentBefore(payment) });
            void env.controller?.payRentals([booking]);
          }}
          onClose={() => setSheet(null)}
          testId={testId}
          terms={`Confirms the rental dates with ${booking.supplier_name} · receipt filed to this task`}
        >
          <Outcome payment={sent} standing={standing} env={env} testId={testId} receipt={receipt} withBatch={false} />
          {!busy && failure && <p className="review-row-note is-error" data-testid={`${testId}-error`}>{failure}</p>}
        </PayoutSheet>
      </div>
    );
  }

  if (pay === 'paid' || (pay === 'paying' && payment?.message)) return <Outcome payment={payment} standing={standing} env={env} testId={testId} receipt={receipt} withBatch />;
  if (pay === 'paying') {
    return (
      <p className="review-row-note" data-testid={`${testId}-processing`}>
        <i className="fa fa-spinner fa-spin-pulse" aria-hidden="true" /> Processing {amount(payment?.amount_minor ?? costMinor)} with PayPal…
      </p>
    );
  }
  return (
    <div className="rental-pay">
      {pay === 'failed' && <p className="review-row-note is-error" data-testid={`${testId}-failed`}>{payment?.message ?? 'PayPal could not make this payment.'}</p>}
      {failure && !(pay === 'failed' && failure === payment?.message) && <p className="review-row-note is-error" data-testid={`${testId}-error`}>{failure}</p>}
      <div className="review-pay">
        {summary}
        <button
          type="button"
          className="button is-primary"
          disabled={busy || !env.controller}
          onClick={() => setSheet('review')}
          data-testid={testId}
          title={`${amount(costMinor)} to ${booking.supplier_name} · PayPal Payouts`}
        >
          Review payment
        </button>
      </div>
    </div>
  );
}

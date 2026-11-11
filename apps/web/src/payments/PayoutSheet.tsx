/**
 * The payout review sheet: our own look, PayPal's Payouts steps in PayPal's words. First "Review your payment
 * details": one line per payee, to their PayPal account; PayPal's fee; the funding source (the PayPal balance); the
 * total; and Send payout or Cancel. Once submitted, each payment as PayPal reports it ("PayPal: Pending", then "Paid",
 * with PayPal's transaction ID), the fee PayPal reports, and the batch ID.
 *
 * It carries no PayPal logo and no PayPal gold: "PayPal" is plain text. Send payout is the person's own press; the
 * assistant may open the sheet and talk it through, but never sends it.
 */
import { format, money, type CurrencyCode } from '@collab/shared';
import { useEffect, useRef, type ReactNode } from 'react';
import { PAYOUT_RATE_MINOR, balanceWords, lineTone, payoutFee, paypalWord, type PayoutLine, type PayoutLineTone } from './payout-sheet';
import '../styles/payout-sheet.css';

export type PayoutPhase = 'review' | 'sending' | 'sent';

export interface PayoutSheetProps {
  lines: readonly PayoutLine[];
  currency: CurrencyCode;
  /** The general contractor, whose PayPal balance pays; null reads "Your PayPal balance". */
  owner: string | null;
  /** Under review; on its way to PayPal (no batch yet); or sent, each line then saying what PayPal reports. */
  phase: PayoutPhase;
  /** PayPal's batches, once PayPal has taken the payout. */
  batchIds?: readonly string[];
  /** The fee PayPal reports once the payout has settled; until then the sheet shows PayPal's published rate. */
  reportedFeeMinor?: number | null;
  /** Send payout can't be pressed now (another step is running). */
  disabled?: boolean;
  onSend(): void;
  onClose(): void;
  /** `<testId>-confirm` is the sheet, `<testId>-confirmed` Send payout, `<testId>-cancel` Cancel. */
  testId: string;
  /** What sending means here beyond the money, said under review ("Paying confirms these dates with …"). */
  terms?: string;
  /** What else the sent payout shows, under the total: the paid note and its receipt. */
  children?: ReactNode;
}

const ICONS: Partial<Record<PayoutLineTone, string>> = {
  sending: 'fa fa-circle-notch fa-spin',
  pending: 'fa fa-circle-notch fa-spin',
  paid: 'fa fa-circle-check',
  held: 'fa fa-hourglass-half',
  failed: 'fa fa-triangle-exclamation',
};

const HEADINGS: Record<PayoutPhase, string> = {
  review: 'Review your payment details',
  sending: 'Submitting to PayPal…',
  sent: 'Submitted to PayPal Payouts',
};

function lineState(line: PayoutLine, tone: PayoutLineTone): ReactNode {
  if (tone === 'review') return 'to their PayPal account';
  if (tone === 'unsent') return 'Not sent';
  const icon = ICONS[tone];
  return (
    <>
      {icon && <i className={icon} aria-hidden="true" />}
      {tone === 'sending' ? (
        <span>{line.note ?? 'Submitting to PayPal…'}</span>
      ) : (
        <span>
          PayPal: {paypalWord(line.paypalStatus!)}
          {line.transactionId && <span className="payout-sheet-tx"> · Transaction ID {line.transactionId}</span>}
        </span>
      )}
    </>
  );
}

export function PayoutSheet({ lines, currency, owner, phase, batchIds = [], reportedFeeMinor = null, disabled = false, onSend, onClose, testId, terms, children }: PayoutSheetProps) {
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const amount = (minor: number) => format(money(minor, currency));
  const sent = phase !== 'review';
  const fee = payoutFee(lines.length, reportedFeeMinor);
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0) + fee.minor;

  // Opened: in view, and read from its heading (Send payout is never focused for the person).
  useEffect(() => {
    root.current?.scrollIntoView?.({ block: 'nearest' });
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      ref={root}
      className={`payout-sheet is-${phase}`}
      aria-labelledby={`${testId}-title`}
      data-testid={`${testId}-confirm`}
      data-phase={phase}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || phase !== 'review') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="payout-sheet-head">
        <p className="payout-sheet-kicker">PayPal Payouts</p>
        <h4 ref={heading} id={`${testId}-title`} className="payout-sheet-title" tabIndex={-1}>
          {HEADINGS[phase]}
        </h4>
        {sent && batchIds.length > 0 && (
          <p className="payout-sheet-batch" data-testid={`${testId}-batch`}>
            {batchIds.length === 1 ? 'Batch ID' : 'Batch IDs'} {batchIds.join(', ')}
          </p>
        )}
      </header>
      <ul className="payout-sheet-lines" aria-live={sent ? 'polite' : undefined}>
        {lines.map((line) => {
          const tone = lineTone(line, sent);
          return (
            <li key={line.key} className={`payout-sheet-line is-${tone}`} data-testid={`${testId}-line`} data-status={tone}>
              <span className="payout-sheet-firm">{line.firm}</span>
              <span className="payout-sheet-amount">{amount(line.amountMinor)}</span>
              <span className="payout-sheet-state">{lineState(line, tone)}</span>
              {line.note && tone !== 'sending' && tone !== 'paid' && tone !== 'unsent' && <span className="payout-sheet-note">{line.note}</span>}
            </li>
          );
        })}
      </ul>
      <dl className="payout-sheet-facts">
        <div>
          <dt>PayPal fee</dt>
          <dd data-testid={`${testId}-fee`} data-reported={fee.reported ? 'true' : 'false'}>
            {amount(fee.minor)}
            <small>{fee.reported ? 'As reported by PayPal' : `${amount(PAYOUT_RATE_MINOR)} per payment · PayPal US Payouts API rate`}</small>
          </dd>
        </div>
        <div>
          <dt>Funding source</dt>
          <dd data-testid={`${testId}-from`}>{balanceWords(owner)}</dd>
        </div>
        <div className="payout-sheet-total">
          <dt>Total</dt>
          <dd data-testid={`${testId}-total`}>{amount(total)}</dd>
        </div>
      </dl>
      {sent && children}
      <div className="payout-sheet-actions">
        {phase === 'review' ? (
          <>
            <button type="button" className="button is-primary" disabled={disabled || lines.length === 0} onClick={onSend} data-testid={`${testId}-confirmed`}>
              Send payout
            </button>
            <button type="button" className="button is-quiet" onClick={onClose} data-testid={`${testId}-cancel`}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="button is-sm" onClick={onClose} data-testid={`${testId}-close`}>
            Close
          </button>
        )}
      </div>
      {!sent && terms && <p className="payout-sheet-fine">{terms}</p>}
      <p className="payout-sheet-fine">Funded from the PayPal balance only · no fee to payees</p>
    </section>
  );
}

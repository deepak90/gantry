/**
 * The invoice window: a change order billed through PayPal Invoicing, reviewed in the middle of the screen before it
 * goes to the tenant, the way a payment is (PayModal.tsx), and the record of it once it has.
 *
 * It shows who the invoice is from, who it bills, every line, the total, the terms and the invoice number, and asks
 * plainly: "Send this invoice to <tenant>?", answered Confirm and send or Cancel. Nothing is recorded or billed before
 * Confirm and send (assistant/change-invoice-card.tsx does that, under the viewer's own login).
 *
 * The window follows the invoice's record, which reaches everyone who sees costs live through the workflow snapshot:
 * two people can have it open, and when either confirms, both windows turn to Sent, with the invoice number, who sent
 * it and when, and PayPal's page for it. A sent invoice can be canceled here after its own "Are you sure?": PayPal
 * cancels it and tells the tenant, and the record stays, status cancelled.
 */
import { format, money, type CurrencyCode, type InvoiceRow } from '@collab/shared';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoiceSeller, projectClient, type WorkflowClient } from '../workflow/api';
import '../styles/pay-modal.css';
import '../styles/invoice-modal.css';

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** "$105,000" (no cents unless they matter). */
export const usd = (minor: number, currency: CurrencyCode) => format(money(minor, currency)).replace(/\.00$/, '');

/** The invoice as a person sees it: `unsent` until someone confirms and it is recorded. */
export type InvoiceShownStatus = InvoiceRow['status'] | 'unsent';

/** Each status as the card and the window name it (US spelling; the stored value stays `cancelled`). */
export const INVOICE_STATUS: Record<InvoiceShownStatus, { label: string; tone: string }> = {
  unsent: { label: 'Draft', tone: 'is-label' },
  draft: { label: 'Draft', tone: 'is-label' },
  sent: { label: 'Sent', tone: 'is-info' },
  paid: { label: 'Paid', tone: 'is-success' },
  failed: { label: 'Not sent', tone: 'is-danger' },
  cancelled: { label: 'Canceled', tone: 'is-label' },
};

/** "Sent by Chris Hale · 5:05 AM": without a name for one sent before the sender was recorded. */
export function sentWords(sentBy: string | null, sentAt: string): string {
  return `Sent${sentBy ? ` by ${sentBy}` : ''} · ${TIME.format(new Date(sentAt))}`;
}

export interface InvoiceModalProps {
  /** The change billed, in a few words ("New light fixtures, levels 1 to 3"). */
  change: string;
  /** Who it bills: the project's client, the tenant. */
  recipient: string;
  lines: readonly { label: string; amount_minor: number; detail?: string | null }[];
  totalMinor: number;
  currency: CurrencyCode;
  dueDays: number;
  /** The day it falls due, once sent ("Mon, Dec 7"). */
  due: string | null;
  partialPayments: boolean;
  /** The invoice as recorded, live through the workflow snapshot; null until someone confirms. */
  record: InvoiceRow | null;
  status: InvoiceShownStatus;
  /** The name of whoever sent it, from `record.sent_by`. */
  sentBy: string | null;
  /** The plan's costs moved since this draft: it is redrafted, not sent. */
  stale: boolean;
  /** This viewer may cancel a sent invoice (sees costs; the function checks again). */
  canRevoke: boolean;
  client: WorkflowClient;
  projectId: string;
  /** `revoke` opens on the "Are you sure?" of canceling a sent invoice (the card's own Cancel invoice). */
  opensOn: 'review' | 'revoke';
  onConfirm(): Promise<void>;
  onRevoke(): Promise<void>;
  onClose(): void;
}

export function InvoiceModal({ change, recipient, lines, totalMinor, currency, dueDays, due, partialPayments, record, status, sentBy, stale, canRevoke, client, projectId, opensOn, onConfirm, onRevoke, onClose }: InvoiceModalProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState<'send' | 'revoke' | null>(null);
  const [asking, setAsking] = useState(opensOn === 'revoke');
  const [error, setError] = useState<string | null>(null);
  // Who it comes from (undefined until the function has said) and the address PayPal delivers it to.
  const [seller, setSeller] = useState<string | null | undefined>(undefined);
  const [billedEmail, setBilledEmail] = useState<string | null>(null);
  // On the hosted demo every invoice bills the tenant's sandbox account, whatever the project says (the function's answer).
  const [billTo, setBillTo] = useState<string | null>(null);

  useEffect(() => heading.current?.focus({ preventScroll: true }), []);

  useEffect(() => {
    let live = true;
    invoiceSeller(client, projectId)
      .then((said) => {
        if (!live) return;
        setSeller(said.seller);
        setBillTo(said.billTo);
      })
      .catch(() => live && setSeller(null));
    projectClient(client, projectId)
      .then((billed) => live && setBilledEmail(billed?.email ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, projectId]);

  const working = busy !== null;
  const sendable = status === 'unsent' || status === 'draft' || status === 'failed';
  // Asked only of an invoice still out: it may have been paid, or canceled by the other person, in the meantime.
  const revoking = asking && status === 'sent';
  const words = INVOICE_STATUS[status];
  const email = record?.client_email ?? billTo ?? billedEmail;
  const number = record?.paypal_number ?? null;
  const sentLine = record?.sent_at ? sentWords(sentBy, record.sent_at) : null;
  // Only while the question is still open: once it has gone out (or the other person sent it), a stale failure is noise.
  const shownError = sendable || revoking ? (error ?? (status === 'failed' ? (record?.message ?? null) : null)) : null;
  const title = revoking ? 'Cancel this invoice?' : status === 'sent' ? 'Invoice sent' : status === 'paid' ? 'Invoice paid' : status === 'cancelled' ? 'Invoice canceled' : `Send this invoice to ${recipient}?`;

  /** A press that has to reach PayPal: its failure stays in the window, where the person is looking. */
  const run = async (what: 'send' | 'revoke', action: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
      setAsking(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  /** Keep invoice: back to the sent invoice in this window; opened from the card, back to the card. */
  const keep = () => (opensOn === 'revoke' ? onClose() : setAsking(false));

  return createPortal(
    <div
      className="pay-modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !working && sendable) onClose();
      }}
    >
      <section
        className={`pay-modal invoice-modal is-${status}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-modal-title"
        data-testid="invoice-modal"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (working) return;
          if (revoking) keep();
          else onClose();
        }}
      >
        <header className="pay-modal-head">
          <div>
            <p className="pay-modal-kicker">PayPal Invoicing</p>
            <h2 ref={heading} id="invoice-modal-title" className="pay-modal-title" tabIndex={-1}>
              {title}
            </h2>
            <p className="pay-modal-sub">Change order: {change}</p>
          </div>
          <div className="invoice-modal-head-end">
            <span className={`pill is-sm ${words.tone}`} data-testid="invoice-modal-status" data-status={status}>
              {words.label}
            </span>
            <button type="button" className="button is-quiet is-icon" aria-label="Close" onClick={onClose} disabled={working} data-testid="invoice-modal-close">
              <i className="fa fa-xmark" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="pay-modal-body">
          {!revoking && (status === 'sent' || status === 'paid') && (
            <div className={`invoice-outcome is-${status}`} aria-live="polite">
              <i className="fa fa-circle-check invoice-outcome-mark" aria-hidden="true" />
              <div className="invoice-outcome-text">
                <p className="invoice-outcome-title">
                  Invoice{number ? ` ${number}` : ''} {status === 'paid' ? `paid by ${recipient}` : `sent to ${recipient}`}
                </p>
                {sentLine && (
                  <p className="invoice-outcome-by" data-testid="invoice-modal-sent-by">
                    {sentLine}
                  </p>
                )}
              </div>
              {record?.payer_url && (
                <a className="button is-link" href={record.payer_url} target="_blank" rel="noreferrer" data-testid="invoice-modal-view">
                  View in PayPal
                </a>
              )}
            </div>
          )}
          {status === 'cancelled' && (
            <div className="invoice-outcome is-cancelled" aria-live="polite">
              <i className="fa fa-ban invoice-outcome-mark" aria-hidden="true" />
              <div className="invoice-outcome-text">
                <p className="invoice-outcome-title">Invoice{number ? ` ${number}` : ''} canceled</p>
                {record && <p className="invoice-outcome-by">Canceled · {TIME.format(new Date(record.updated_at))}</p>}
              </div>
            </div>
          )}

          <dl className="invoice-parties">
            <div>
              <dt>From</dt>
              <dd data-testid="invoice-modal-from">{seller === undefined ? '…' : (seller ?? 'PayPal business account')}</dd>
            </div>
            <div>
              <dt>Bill to</dt>
              <dd data-testid="invoice-modal-to">
                {recipient}
                {email && <small>{email}</small>}
              </dd>
            </div>
          </dl>

          <table className="pay-lines invoice-lines">
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={`${line.label}:${index}`} data-testid="invoice-modal-line">
                  <th scope="row">
                    <span className="pay-line-firm">{line.label}</span>
                    {line.detail && <span className="pay-line-for">{line.detail}</span>}
                  </th>
                  <td className="pay-line-amount">{usd(line.amount_minor, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="pay-lines-total">
                <th scope="row">Total</th>
                <td data-testid="invoice-modal-total">{usd(totalMinor, currency)}</td>
              </tr>
            </tfoot>
          </table>

          <dl className="pay-facts">
            <div>
              <dt>Terms</dt>
              <dd>
                Net {dueDays}
                {due ? ` · due ${due}` : ''}
              </dd>
            </div>
            <div>
              <dt>Invoice no.</dt>
              <dd data-testid="invoice-modal-number">{number ?? 'Assigned on sending'}</dd>
            </div>
            {partialPayments && (
              <div>
                <dt>Payment</dt>
                <dd>Partial payments allowed · payer limits apply</dd>
              </div>
            )}
          </dl>

          {revoking && (
            <p className="note is-danger" data-testid="invoice-modal-revoke-ask">
              <i className="fa fa-triangle-exclamation" aria-hidden="true" />
              <span>Are you sure? PayPal cancels this invoice and notifies {recipient}. A canceled invoice cannot be reinstated; a corrected one is issued as a new invoice.</span>
            </p>
          )}
          {sendable && stale && (
            <p className="note is-warning" data-testid="invoice-modal-stale">
              <i className="fa fa-triangle-exclamation" aria-hidden="true" />
              <span>Out of date: plan costs changed since this draft. Redraft before sending.</span>
            </p>
          )}
          {sendable && !stale && <p className="invoice-modal-consequence">Confirming delivers this invoice to {recipient} through PayPal.</p>}
          {shownError && (
            <p className="note is-danger is-sm" data-testid="invoice-modal-error">
              <i className="fa fa-triangle-exclamation" aria-hidden="true" />
              <span>{shownError}</span>
            </p>
          )}
        </div>

        <footer className="pay-modal-actions">
          {revoking ? (
            <>
              <button type="button" className="button is-quiet" disabled={working} onClick={keep} data-testid="invoice-modal-revoke-keep">
                Keep invoice
              </button>
              <button type="button" className="button is-danger is-primary" disabled={working} onClick={() => void run('revoke', onRevoke)} data-testid="invoice-modal-revoke-confirm">
                <i className={`fa fa-${busy === 'revoke' ? 'spinner fa-spin' : 'ban'}`} aria-hidden="true" /> {busy === 'revoke' ? 'Canceling…' : 'Cancel invoice'}
              </button>
            </>
          ) : sendable ? (
            <>
              <button type="button" className="button is-quiet" disabled={working} onClick={onClose} data-testid="invoice-modal-cancel">
                Cancel
              </button>
              <button type="button" className="button is-primary" disabled={working || stale} onClick={() => void run('send', onConfirm)} data-testid="invoice-modal-send">
                <i className={`fa fa-${busy === 'send' ? 'spinner fa-spin' : 'paper-plane'}`} aria-hidden="true" /> {busy === 'send' ? 'Sending…' : 'Confirm and send'}
              </button>
            </>
          ) : (
            <>
              {status === 'sent' && canRevoke && (
                <button type="button" className="button is-quiet is-danger invoice-modal-revoke" onClick={() => setAsking(true)} data-testid="change-invoice-revoke">
                  Cancel invoice
                </button>
              )}
              <button type="button" className="button is-primary" onClick={onClose} data-testid="invoice-modal-done">
                Done
              </button>
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

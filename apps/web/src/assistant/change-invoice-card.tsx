/**
 * The PayPal invoice Remy drafts for a change to the plan (a change order): its lines priced from the
 * plan's own costs (what is bought once for every floor, then each floor's own work with its tasks under
 * it), the total, who it bills and when it falls due. The agent service worked out every figure; the
 * model only named the draft.
 *
 * Nothing is billed from the card. Review invoice opens the window (payments/InvoiceModal.tsx), and only
 * Confirm and send there, by a person who sees costs, whatever their approval mode, bills anyone: their
 * browser records the invoice on the change's first task (prepare_invoice, as the floor invoices do),
 * then the paypal-invoice function creates it in PayPal and sends it, recording who did. From then on
 * the card and any open window follow that record for everyone who sees costs: Sent, by whom and when,
 * with PayPal's invoice number and a link to PayPal's own page for the tenant, later Paid (asked of
 * PayPal now and then while it is the newest invoice card), or Canceled after its own "Are you sure?".
 */
import { addDays, PAYPAL_PAYMENT_LIMIT_MINOR, type ChangeInvoiceCard as ChangeInvoiceCardProps, type InvoiceRow } from '@collab/shared';
import { useEffect, useRef, useState } from 'react';
import { INVOICE_STATUS, InvoiceModal, sentWords, usd, type InvoiceShownStatus } from '../payments/InvoiceModal';
import { invoiceAction, prepareInvoice, type WorkflowClient } from '../workflow/api';
import type { WorkflowController, WorkflowViewState } from '../workflow/controller';
import { formatDay } from '../workflow/model';
import { CardShell, type CardEnv } from './cards';
import '../styles/change-invoice.css';

export interface ChangeInvoiceEnv extends CardEnv {
  client: WorkflowClient;
  projectId: string;
  /** The invoices the viewer may see (cost viewers only, under RLS) arrive with the workflow. */
  workflow: WorkflowViewState;
  controller: WorkflowController | null;
  showTasks(ids: readonly number[]): void;
  /** The viewer sees costs, so may send it (the database checks again). */
  canSend: boolean;
  /** The newest invoice card in the thread: it asks PayPal now and then whether the tenant has paid. */
  watching: boolean;
  /** What these tasks cost in the plan now (null when one is gone): a draft whose lines no longer match is not sent. */
  liveCost?(taskIds: readonly number[]): number | null;
  /** When the thread drew this card (`created_at` of its message): a canceled invoice counts only if canceled since. */
  drawnAt?: string;
}

const POLL_MS = 20_000;

/** Each card's Review invoice, by its button, for Remy's cursor (remy-ui.ts): it opens the card's own window. */
const reviewOpeners = new WeakMap<HTMLElement, () => void>();

/** The cards whose invoice window is open, each with the way to close it (as its Cancel does). */
const openWindows = new Set<() => void>();

/** Closes the invoice windows that are open, as their Cancel does; false when none is. */
export function closeInvoiceReview(): boolean {
  if (openWindows.size === 0) return false;
  for (const close of [...openWindows]) close();
  return true;
}

/** Whether an invoice window is open. */
export const invoiceReviewOpen = (): boolean => openWindows.size > 0;

/** Opens the review of the card whose Review invoice button this is, as pressing it does. False when it has none. */
export function openInvoiceReview(button: HTMLElement): boolean {
  const open = reviewOpeners.get(button);
  if (!open || (button as HTMLButtonElement).disabled) return false;
  open();
  return true;
}

/** The calendar day of an instant where the viewer is (`2026-11-07`). */
function localDay(instant: string): string {
  const at = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
const shortDay = (iso: string) => formatDay(iso).replace(/, \d{4}$/, '');

/**
 * The invoice a card follows: the change's live one; failing that, the one canceled since this card was drawn (the
 * card it went out from keeps saying Canceled, while a card Remy draws after that is a new draft).
 */
function recordOf(invoices: readonly InvoiceRow[], taskId: number, drawnAt: string | undefined): InvoiceRow | null {
  const onTask = invoices.filter((invoice) => invoice.group_task_id === taskId);
  const live = onTask.find((invoice) => invoice.status !== 'cancelled');
  if (live) return live;
  if (drawnAt === undefined) return null;
  const drawn = Date.parse(drawnAt);
  return onTask.filter((invoice) => Date.parse(invoice.updated_at) >= drawn).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))[0] ?? null;
}

export function ChangeInvoiceCardView({ card, env }: { card: Partial<ChangeInvoiceCardProps>; env: ChangeInvoiceEnv }) {
  // The window, once opened: on the review, or on the "Are you sure?" of canceling a sent invoice.
  const [open, setOpen] = useState<'review' | 'revoke' | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  // While its window is open, Remy can close it as Cancel does.
  useEffect(() => {
    if (open === null) return undefined;
    const close = () => setOpen(null);
    openWindows.add(close);
    return () => {
      openWindows.delete(close);
    };
  }, [open]);
  useEffect(() => {
    const button = reviewButton.current;
    if (!button) return undefined;
    reviewOpeners.set(button, () => setOpen('review'));
    return () => {
      reviewOpeners.delete(button);
    };
  });
  // What the function last answered this browser: the window need not wait for the workflow's own read to catch up.
  const [answer, setAnswer] = useState<InvoiceRow | null>(null);
  const invoices: readonly InvoiceRow[] = env.workflow.snapshot?.invoices ?? [];
  // The invoice recorded on the change, once someone confirmed it: what PayPal bills from then on.
  const followed = card.record_task_id === undefined ? null : recordOf(invoices, card.record_task_id, env.drawnAt);
  const record = answer && (!followed || Date.parse(answer.updated_at) > Date.parse(followed.updated_at)) ? answer : followed;
  const status: InvoiceShownStatus = record?.status ?? 'unsent';

  // Whether the tenant has paid, asked of PayPal now and then while this is the newest invoice card.
  const sentId = record?.status === 'sent' ? record.id : null;
  useEffect(() => {
    if (!sentId || !env.watching) return undefined;
    const timer = setInterval(() => void invoiceAction(env.client, sentId, 'refresh').catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [sentId, env.watching, env.client]);

  if (!card.lines || card.total_minor === undefined || !card.recipient) {
    return (
      <CardShell kind="change-invoice" icon="file-invoice-dollar" kicker="PayPal invoice" env={env} testId="assistant-change-invoice">
        <h4 className="ac-title">{card.change ? `Change order: ${card.change}` : <span className="ac-skeleton" />}</h4>
        <p className="ac-muted">Pricing it from the plan…</p>
      </CardShell>
    );
  }

  const lines = record ? record.lines : card.lines;
  const total = record?.amount_minor ?? card.total_minor;
  const recipient = record?.client_name ?? card.recipient;
  const dueDays = card.due_days ?? 30;
  // Payment terms as the trade writes them ("Net 30"); the due date itself once PayPal has sent it.
  const due = record?.sent_at ? shortDay(addDays(localDay(record.sent_at), dueDays)) : null;
  const sendable = status === 'unsent' || status === 'draft' || status === 'failed';
  // Before it is recorded, the lines must still be what the plan says the work costs.
  const stale = !record && sendable && env.liveCost !== undefined && card.lines.some((line) => env.liveCost!(line.task_ids) !== line.amount_minor);
  const words = INVOICE_STATUS[status];
  const partial = card.partial_payments ?? total > PAYPAL_PAYMENT_LIMIT_MINOR;
  const sentBy = (record?.sent_by && env.workflow.snapshot?.profiles?.find((profile) => profile.user_id === record.sent_by)?.display_name) || null;

  /** Confirm and send, from the window: a failure stays in the window, and the workflow's read follows either way. */
  const confirm = async () => {
    if (!card.lines || card.record_task_id === undefined || !card.title) return;
    try {
      const billed = card.lines.map(({ label, amount_minor, detail }) => (detail ? { label, amount_minor, detail } : { label, amount_minor }));
      const prepared = await prepareInvoice(env.client, { projectId: env.projectId, groupTaskId: card.record_task_id, ruleId: null, title: card.title, lines: billed });
      setAnswer(await invoiceAction(env.client, prepared.id, 'send'));
    } finally {
      await env.controller?.reload().catch(() => undefined);
    }
  };

  /** Cancels the sent invoice on PayPal, after the window's "Are you sure?". */
  const revoke = async () => {
    if (!record) return;
    try {
      setAnswer(await invoiceAction(env.client, record.id, 'cancel'));
    } finally {
      await env.controller?.reload().catch(() => undefined);
    }
  };

  return (
    <CardShell kind="change-invoice" icon="file-invoice-dollar" kicker="PayPal invoice" env={env} testId="assistant-change-invoice">
      <header className="ci-head">
        <h4 className="ac-title">
          {card.task_ids && card.task_ids.length > 0 ? (
            <button type="button" className="ac-title-link" title="Show the change in the plan" onClick={() => env.showTasks(card.task_ids!)}>
              Change order: {card.change}
            </button>
          ) : (
            `Change order: ${card.change}`
          )}
        </h4>
        <span className={`pill is-sm ${words.tone}`} data-testid="change-invoice-status" data-status={status}>
          {words.label}
        </span>
      </header>
      <dl className="ci-facts">
        <div>
          <dt>Bill to</dt>
          <dd data-testid="change-invoice-to">{recipient}</dd>
        </div>
        <div>
          <dt>Terms</dt>
          <dd>Net {dueDays}</dd>
        </div>
        {due && (
          <div>
            <dt>Due</dt>
            <dd>{due}</dd>
          </div>
        )}
        {record?.paypal_number && (
          <div>
            <dt>Invoice no.</dt>
            <dd data-testid="change-invoice-number">{record.paypal_number}</dd>
          </div>
        )}
      </dl>
      <ul className="ci-lines">
        {lines.map((line, index) => (
          <li key={`${line.label}:${index}`} data-testid="change-invoice-line">
            <span className="ci-line-label">
              {line.label}
              {line.detail && <small className="ci-line-detail">{line.detail}</small>}
            </span>
            <span className="ci-line-amount">{usd(line.amount_minor, env.currency)}</span>
          </li>
        ))}
      </ul>
      <p className="ci-total">
        <span>Total</span>
        <strong data-testid="change-invoice-total">{usd(total, env.currency)}</strong>
      </p>
      {partial && (
        <p className="ac-muted" data-testid="change-invoice-parts">
          Partial payments allowed · payer limits apply
        </p>
      )}
      {status === 'failed' && record?.message && <p className="pc-warning is-error">{record.message}</p>}
      {stale && (
        <p className="pc-warning" data-testid="change-invoice-stale">
          <i className="fa fa-triangle-exclamation" aria-hidden="true" /> Out of date: plan costs changed since this draft. Redraft before sending.
        </p>
      )}
      {sendable && !env.partial && (
        <div className="ac-actions ci-send">
          <button type="button" ref={reviewButton} className="button is-primary" disabled={!env.canSend || stale} onClick={() => setOpen('review')} data-testid="change-invoice-review">
            <i className="fa fa-file-invoice-dollar" aria-hidden="true" /> Review invoice
          </button>
          {!env.canSend && <span className="ac-muted">Requires cost access</span>}
        </div>
      )}
      {status === 'sent' && (
        <p className="ci-outcome" data-testid="change-invoice-sent">
          <i className="fa fa-paper-plane" aria-hidden="true" />
          <span>Sent{record?.sent_at ? ` ${shortDay(localDay(record.sent_at))}` : ''} · Awaiting payment</span>
          {record?.payer_url && (
            <a className="button is-link" href={record.payer_url} target="_blank" rel="noreferrer" data-testid="change-invoice-view">
              View in PayPal
            </a>
          )}
        </p>
      )}
      {status === 'paid' && (
        <p className="ci-outcome is-paid" data-testid="change-invoice-paid">
          <i className="fa fa-circle-check" aria-hidden="true" />
          <span>
            Paid by {recipient}
            {record?.paid_at ? ` · ${shortDay(localDay(record.paid_at))}` : ''}
          </span>
        </p>
      )}
      {status === 'cancelled' && (
        <p className="ci-outcome" data-testid="change-invoice-canceled">
          <i className="fa fa-ban" aria-hidden="true" />
          <span>Canceled{record ? ` ${shortDay(localDay(record.updated_at))}` : ''}</span>
        </p>
      )}
      {record?.sent_at && (
        <p className="ci-sent-by" data-testid="change-invoice-sent-by">
          {sentWords(sentBy, record.sent_at)}
        </p>
      )}
      {/* While the window is open it has its own, and only one is on the screen. */}
      {status === 'sent' && env.canSend && open === null && (
        <div className="ac-actions">
          <button type="button" className="button is-quiet is-danger is-sm" onClick={() => setOpen('revoke')} data-testid="change-invoice-revoke">
            Cancel invoice
          </button>
        </div>
      )}
      <p className="ci-fine">Delivered and paid through PayPal Invoicing · PayPal sandbox</p>
      {open && (
        <InvoiceModal
          change={card.change ?? ''}
          recipient={recipient}
          lines={lines}
          totalMinor={total}
          currency={env.currency}
          dueDays={dueDays}
          due={due}
          partialPayments={partial}
          record={record}
          status={status}
          sentBy={sentBy}
          stale={stale}
          canRevoke={env.canSend}
          client={env.client}
          projectId={env.projectId}
          opensOn={open}
          onConfirm={confirm}
          onRevoke={revoke}
          onClose={() => setOpen(null)}
        />
      )}
    </CardShell>
  );
}

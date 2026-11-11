/**
 * The payment receipt, filed automatically when a payout succeeds: a one-page PDF in the documents
 * bucket plus a project_documents row (kind receipt, cost-sensitive, linked to the booked task and
 * the payment), with the same facts as plain text for the AI agent.
 *
 *   receipt_facts (service-role RPC)   everything the receipt states, and the receipt already filed
 *   render + upload                    `{project}/{new uuid}/payment-receipt.pdf`
 *   file_receipt (service-role RPC)    the row, under the payment's row lock
 *
 * Idempotent: an operation that already has a receipt gets nothing new. Two filers racing (a webhook
 * and a status refresh) both upload, one row wins, and the loser removes its own upload. Every
 * caller (execute, reconcile, webhook) files only for a succeeded payout and logs a failure instead
 * of failing the payout response; the next status check of the payout files it then.
 */
import { formatMoney } from './amounts.ts';
import { asObject, isObject, isUuid, text, type JsonObject } from './json.ts';
import { renderDocumentPdf, type AmountLine, type DocumentSpec, type LabeledValue, type PdfLib } from './pdf.ts';
import type { PayPalMode } from './paypal.ts';

export const DOCUMENTS_BUCKET = 'documents';
export const RECEIPT_OBJECT_NAME = 'payment-receipt.pdf';

export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptError';
  }
}

export interface Approval {
  by: string;
  at: string;
}

/** What a receipt states, read from receipt_facts and the PayPal answer stored with the payment. */
export interface ReceiptFacts {
  authorizationId: string;
  projectId: string;
  projectName: string;
  taskId: number | null;
  /** The task's name in the plan, or 'Task {id}'. */
  taskName: string;
  supplierName: string;
  recipientEmail: string;
  currency: string;
  amountMinor: number;
  /** PayPal's fee for the item; null when PayPal has not reported one. */
  feeMinor: number | null;
  batchId: string | null;
  itemId: string | null;
  transactionId: string | null;
  /** When PayPal processed the item, or when the receipt was made if PayPal gave no time. */
  paidAt: string;
  versionNo: number | null;
  /** The rental rate per billable day; null when receipt_facts gives neither it nor the days. */
  rentalRateMinor: number | null;
  /** Billable days of the rental as revised (the days paid for); null as for the rate. */
  billableDays: number | null;
  newStart: string | null;
  newEnd: string | null;
  datesApproval: Approval | null;
  paymentApproval: Approval | null;
  sentBy: Approval | null;
  mode: PayPalMode;
}

export interface ReceiptFactsResult {
  existingReceiptId: string | null;
  status: string;
  facts: ReceiptFacts;
}

const safeInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const isoInstant = (value: unknown): string | null => {
  const candidate = text(value);
  if (candidate === null) return null;
  const time = Date.parse(candidate);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

const isoDate = (value: unknown): string | null => {
  const candidate = text(value);
  return candidate !== null && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
};

function approvalOf(value: unknown): Approval | null {
  if (!isObject(value)) return null;
  const at = isoInstant(value.approved_at);
  return at === null ? null : { by: text(value.approver_name) ?? 'Unknown member', at };
}

/**
 * The PayPal item behind the stored answer: the batch read (`items[]`, ours by sender_item_id, or
 * the only one) or the item a webhook delivered. Its time_processed and transaction_id.
 */
export function paypalItemDetails(raw: unknown, authorizationId: string): { transactionId: string | null; processedAt: string | null } {
  const o = asObject(raw);
  const items = Array.isArray(o.items) ? (o.items as unknown[]) : null;
  let item: JsonObject = o;
  if (items !== null) {
    const ours = items.find((candidate) => text(asObject(asObject(candidate).payout_item).sender_item_id) === authorizationId);
    item = asObject(ours ?? (items.length === 1 ? items[0] : null));
  }
  return {
    transactionId: text(item.transaction_id),
    processedAt: isoInstant(item.time_processed) ?? isoInstant(asObject(o.batch_header).time_completed),
  };
}

/**
 * The day rate and billable days the payment covers. The supplier is paid the rental as revised
 * (rate x revised billable days), so either one follows from the amount and the other; both are
 * dropped when they do not multiply to the amount paid.
 */
function rentalOf(amountMinor: number, rate: number | null, days: number | null): { rentalRateMinor: number | null; billableDays: number | null } {
  if (rate !== null && rate > 0 && days === null && amountMinor % rate === 0) days = amountMinor / rate;
  if (days !== null && days > 0 && rate === null && amountMinor % days === 0) rate = amountMinor / days;
  return rate !== null && days !== null && rate * days === amountMinor
    ? { rentalRateMinor: rate, billableDays: days }
    : { rentalRateMinor: null, billableDays: null };
}

/** receipt_facts' answer as ReceiptFacts; throws ReceiptError when a required fact is missing. */
export function readReceiptFacts(value: unknown, mode: PayPalMode, now: Date): ReceiptFactsResult {
  const o = asObject(value);
  const authorization = asObject(o.authorization);
  const project = asObject(o.project);
  const task = asObject(o.task);
  const proposal = asObject(o.proposal);
  const inputs = asObject(proposal.inputs);
  const bookingDays = asObject(proposal.booking_days);

  const authorizationId = text(authorization.id);
  const projectId = text(project.id);
  const amountMinor = safeInt(authorization.amount_minor);
  const currency = text(authorization.currency);
  const status = text(authorization.status);
  if (!isUuid(authorizationId) || !isUuid(projectId) || amountMinor === null || currency === null || status === null) {
    throw new ReceiptError('receipt_facts returned no payment, project, amount or currency');
  }
  const existing = o.existing_receipt_id;
  const taskId = safeInt(task.id);
  const paypal = paypalItemDetails(authorization.raw, authorizationId);

  return {
    existingReceiptId: isUuid(existing) ? existing : null,
    status,
    facts: {
      authorizationId,
      projectId,
      projectName: text(project.name) ?? 'Project',
      taskId,
      taskName: text(task.name) ?? (taskId === null ? 'No task' : `Task ${taskId}`),
      supplierName: text(o.supplier_name) ?? 'Supplier',
      recipientEmail: text(authorization.recipient_email) ?? '',
      currency,
      amountMinor,
      feeMinor: safeInt(authorization.fee_minor),
      batchId: text(authorization.paypal_batch_id),
      itemId: text(authorization.paypal_item_id),
      transactionId: paypal.transactionId,
      paidAt: paypal.processedAt ?? now.toISOString(),
      versionNo: safeInt(proposal.version_no),
      ...rentalOf(amountMinor, safeInt(o.rental_rate_minor), safeInt(bookingDays.revised_billable_days)),
      newStart: isoDate(inputs.new_start),
      newEnd: isoDate(inputs.new_end),
      datesApproval: approvalOf(o.schedule_approval),
      paymentApproval: approvalOf(o.payment_approval),
      sentBy: (() => {
        const at = isoInstant(authorization.created_at);
        const by = text(o.authorized_by_name);
        return at === null || by === null ? null : { by, at };
      })(),
      mode,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** '2026-12-11' → 'Fri, Dec 11, 2026'. */
export function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** An instant as 'Mon, Nov 2, 2026, 9:00 AM UTC'. */
export function formatInstant(iso: string): string {
  const d = new Date(iso);
  const hours = d.getUTCHours();
  return `${formatDay(d.toISOString().slice(0, 10))}, ${hours % 12 === 0 ? 12 : hours % 12}:${pad(d.getUTCMinutes())} ${hours < 12 ? 'AM' : 'PM'} UTC`;
}

export const SANDBOX_LINE = 'PayPal sandbox — no real money moved.';

/** 'PR-20261102-0000005BB': the paid day and the end of the operation id. */
export function receiptNumber(facts: ReceiptFacts): string {
  return `PR-${facts.paidAt.slice(0, 10).replaceAll('-', '')}-${facts.authorizationId.replaceAll('-', '').slice(-8).toUpperCase()}`;
}

export function receiptSummary(facts: ReceiptFacts): string {
  return `PayPal payment of ${formatMoney(facts.amountMinor, facts.currency)} to ${facts.supplierName}`;
}

/** The document's name in the repository (the stored object is always payment-receipt.pdf). */
export function receiptFileName(facts: ReceiptFacts): string {
  const supplier = facts.supplierName.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `Payment receipt - ${supplier} - ${facts.paidAt.slice(0, 10)}.pdf`;
}

interface ReceiptLines {
  amounts: AmountLine[];
  rental: AmountLine[];
  approvals: LabeledValue[];
  references: LabeledValue[];
}

function receiptLines(facts: ReceiptFacts): ReceiptLines {
  const money = (minor: number) => formatMoney(minor, facts.currency);
  const fee = facts.feeMinor;
  const amounts: ReceiptLines['amounts'] = [
    { label: 'Payment to the supplier', amount: money(facts.amountMinor) },
    {
      label: 'PayPal fee',
      detail: fee === null ? 'not reported by PayPal' : 'paid by the project, on top of the payment',
      amount: fee === null ? '-' : money(fee),
    },
    {
      label: 'Total cost to the project',
      amount: money(facts.amountMinor + (fee ?? 0)),
      strong: true,
      ruleAbove: true,
    },
    { label: 'Net received by the supplier', amount: money(facts.amountMinor) },
  ];

  // The rental as revised: billable days x day rate = the amount paid.
  const { rentalRateMinor: rate, billableDays: days } = facts;
  const rental: ReceiptLines['rental'] =
    rate === null || days === null
      ? []
      : [
          { label: 'Day rate', amount: money(rate) },
          { label: 'Billable days', amount: String(days) },
          {
            label: 'Rental paid',
            detail: `${days} billable ${days === 1 ? 'day' : 'days'} at ${money(rate)} a day`,
            amount: money(facts.amountMinor),
            strong: true,
            ruleAbove: true,
          },
        ];

  const person = (approval: Approval | null, role: string) => (approval === null ? 'Not recorded' : `${approval.by}, ${role}`);
  const approvals: ReceiptLines['approvals'] = [
    {
      label: 'Dates approved by',
      value: person(facts.datesApproval, 'project manager'),
      ...(facts.datesApproval ? { aside: formatInstant(facts.datesApproval.at) } : {}),
    },
    {
      label: 'Payment approved by',
      value: person(facts.paymentApproval, 'cost manager'),
      ...(facts.paymentApproval ? { aside: formatInstant(facts.paymentApproval.at) } : {}),
    },
    {
      label: 'Payout sent by',
      value: person(facts.sentBy, 'cost manager'),
      ...(facts.sentBy ? { aside: formatInstant(facts.sentBy.at) } : {}),
    },
  ];

  const references: LabeledValue[] = [
    { label: 'PayPal payout batch ID', value: facts.batchId ?? 'Not reported' },
    { label: 'PayPal payout item ID', value: facts.itemId ?? 'Not reported' },
    { label: 'PayPal transaction ID', value: facts.transactionId ?? 'Not reported by PayPal' },
    { label: 'Our payment reference', value: `${facts.authorizationId} (PayPal sender batch and item ID)` },
  ];
  return { amounts, rental, approvals, references };
}

function rentalDescription(facts: ReceiptFacts): string {
  const version = facts.versionNo === null ? 'the approved rental dates' : `version ${facts.versionNo} of the approved rental dates`;
  const dates =
    facts.newStart !== null && facts.newEnd !== null
      ? `: on rent ${formatDay(facts.newStart)}, off rent ${formatDay(facts.newEnd)}`
      : '';
  return `Equipment rental for ${facts.taskName}, ${version}${dates}.`;
}

function modeLine(facts: ReceiptFacts): string {
  return facts.mode === 'mock'
    ? 'Processed by the built-in mock PayPal (PAYPAL_MODE=mock): no PayPal account was contacted.'
    : 'Paid through the PayPal sandbox (api-m.sandbox.paypal.com): test accounts and test money only.';
}

/** The receipt as plain text: the same facts as the PDF, for the AI agent and for search. */
export function receiptText(facts: ReceiptFacts): string {
  const lines = receiptLines(facts);
  const row = (label: string, value: string, detail?: string) => `${label}${detail ? ` (${detail})` : ''}: ${value}`;
  return [
    'PAYMENT RECEIPT',
    SANDBOX_LINE,
    modeLine(facts),
    '',
    `Receipt number: ${receiptNumber(facts)}`,
    `Date paid: ${formatInstant(facts.paidAt)}`,
    `Project: ${facts.projectName}`,
    `Task: ${facts.taskName}${facts.taskId === null ? '' : ` (task ${facts.taskId})`}`,
    `Paid to: ${facts.supplierName}, PayPal account ${facts.recipientEmail}`,
    `Paid by: ${facts.projectName}, through PayPal Payouts`,
    '',
    `Amounts (${facts.currency})`,
    ...lines.amounts.map((line) => row(line.label, line.amount, line.detail)),
    '',
    'The rental',
    rentalDescription(facts),
    ...lines.rental.map((line) => row(line.label, line.amount, line.detail)),
    '',
    'Approvals',
    ...lines.approvals.map((line) => row(line.label, line.aside ? `${line.value}, ${line.aside}` : line.value)),
    '',
    'PayPal references',
    ...lines.references.map((line) => row(line.label, line.value)),
    '',
    'PayPal Payouts sends money and issues no invoice; the supplier\'s invoice, if any, is filed as its own document.',
  ].join('\n');
}

export function receiptDocument(facts: ReceiptFacts, createdAt: Date): DocumentSpec {
  const lines = receiptLines(facts);
  const money = formatMoney(facts.amountMinor, facts.currency);
  return {
    title: `Payment receipt ${receiptNumber(facts)}: ${money} to ${facts.supplierName}`,
    eyebrow: 'PAYMENT RECEIPT',
    heading: `${money} paid to ${facts.supplierName}`,
    subheading: `${facts.projectName} · ${facts.taskName}`,
    references: [
      { label: 'Receipt no.', value: receiptNumber(facts) },
      { label: 'Date paid', value: formatInstant(facts.paidAt) },
      { label: 'Status', value: 'Paid' },
    ],
    notice: { title: SANDBOX_LINE, text: modeLine(facts) },
    parties: [
      { label: 'Paid by', lines: [facts.projectName, 'Through PayPal Payouts', `Sent by ${facts.sentBy?.by ?? 'the cost manager'}`] },
      { label: 'Paid to', lines: [facts.supplierName, `PayPal account ${facts.recipientEmail}`] },
    ],
    sections: [
      { kind: 'amounts', title: 'Amounts', lines: lines.amounts, note: `All amounts in ${facts.currency}.` },
      ...(lines.rental.length > 0
        ? [{ kind: 'amounts' as const, title: 'What was paid for', lines: lines.rental, note: rentalDescription(facts) }]
        : [{ kind: 'text' as const, title: 'What was paid for', paragraphs: [rentalDescription(facts)] }]),
      { kind: 'fields', title: 'Approvals', fields: lines.approvals },
      { kind: 'fields', title: 'PayPal references', fields: lines.references },
    ],
    footer: [
      `${SANDBOX_LINE} Filed automatically in the project documents when PayPal confirmed the payout.`,
      'PayPal Payouts sends money and issues no invoice; the supplier\'s own invoice is filed as a separate document.',
    ],
    author: `${facts.projectName} cost review`,
    createdAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------------------------

export interface FiledReceipt {
  documentId: string;
  /** Null when the receipt was already filed (receipt_facts names only its id). */
  storagePath: string | null;
  /** False when the operation already had a receipt. */
  created: boolean;
}

export interface FileReceiptRequest {
  authorizationId: string;
  storagePath: string;
  name: string;
  sizeBytes: number;
  textContent: string;
  summary: string;
}

/** The database and Storage calls the filer makes; the Supabase implementation is below. */
export interface ReceiptStore {
  facts(authorizationId: string): Promise<unknown>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  file(request: FileReceiptRequest): Promise<{ created: boolean; documentId: string; storagePath: string }>;
  remove(path: string): Promise<void>;
}

export interface ReceiptFiler {
  /** Files the receipt of a succeeded payout once; null when the payout has not succeeded. */
  file(authorizationId: string, mode: PayPalMode): Promise<FiledReceipt | null>;
}

export interface ReceiptFilerDeps {
  store: ReceiptStore;
  pdf: PdfLib;
  now?: () => Date;
  newId?: () => string;
}

export function createReceiptFiler(deps: ReceiptFilerDeps): ReceiptFiler {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  return {
    async file(authorizationId, mode) {
      const madeAt = now();
      const { existingReceiptId, status, facts } = readReceiptFacts(await deps.store.facts(authorizationId), mode, madeAt);
      if (existingReceiptId !== null) {
        return { documentId: existingReceiptId, storagePath: null, created: false };
      }
      if (status !== 'succeeded') {
        return null;
      }
      const bytes = await renderDocumentPdf(deps.pdf, receiptDocument(facts, madeAt));
      const storagePath = `${facts.projectId}/${newId()}/${RECEIPT_OBJECT_NAME}`;
      await deps.store.upload(storagePath, bytes);
      let filed: { created: boolean; documentId: string; storagePath: string };
      try {
        filed = await deps.store.file({
          authorizationId,
          storagePath,
          name: receiptFileName(facts),
          sizeBytes: bytes.byteLength,
          textContent: receiptText(facts),
          summary: receiptSummary(facts),
        });
      } catch (error) {
        await deps.store.remove(storagePath).catch(() => undefined);
        throw error;
      }
      if (!filed.created) {
        // Another filer won the race; its file is the receipt, ours is a stray copy.
        await deps.store.remove(storagePath).catch(() => undefined);
      }
      return { documentId: filed.documentId, storagePath: filed.storagePath, created: filed.created };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Supabase implementation (service role)
// ---------------------------------------------------------------------------------------------

interface ErrorLike {
  message: string;
  code?: string | null;
}

/** The slice of a service-role SupabaseClient the receipt store uses. */
export interface ReceiptClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: ErrorLike | null }>;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: { contentType: string; upsert: boolean; cacheControl?: string },
      ): PromiseLike<{ error: ErrorLike | null }>;
      remove(paths: string[]): PromiseLike<{ error: ErrorLike | null }>;
    };
  };
}

export function createSupabaseReceiptStore(client: ReceiptClient): ReceiptStore {
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(fn, args);
    if (error !== null) {
      throw new ReceiptError(`${fn} failed: ${error.message}`);
    }
    return data;
  };
  const bucket = () => client.storage.from(DOCUMENTS_BUCKET);
  return {
    facts: (authorizationId) => call('receipt_facts', { p_authorization: authorizationId }),
    async upload(path, bytes) {
      const { error } = await bucket().upload(path, bytes, { contentType: 'application/pdf', upsert: false });
      if (error !== null) {
        throw new ReceiptError(`Uploading the receipt to ${path} failed: ${error.message}`);
      }
    },
    async file(request) {
      const data = asObject(
        await call('file_receipt', {
          p_authorization: request.authorizationId,
          p_storage_path: request.storagePath,
          p_name: request.name,
          p_size: request.sizeBytes,
          p_text_content: request.textContent,
          p_summary: request.summary,
        }),
      );
      const document = asObject(data.document);
      const documentId = document.id;
      const storagePath = text(document.storage_path);
      if (typeof data.created !== 'boolean' || !isUuid(documentId) || storagePath === null) {
        throw new ReceiptError('file_receipt returned no document');
      }
      return { created: data.created, documentId, storagePath };
    },
    async remove(path) {
      const { error } = await bucket().remove([path]);
      if (error !== null) {
        throw new ReceiptError(`Removing ${path} failed: ${error.message}`);
      }
    },
  };
}

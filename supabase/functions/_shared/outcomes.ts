/**
 * What PayPal's answers mean for a payment_authorizations row. Pure: PayPal JSON in, the status,
 * identifiers, fee and message that `payout_record` stores out.
 *
 * Item `transaction_status`: SUCCESS settles the payout; FAILED, RETURNED, BLOCKED, REFUNDED,
 * REVERSED, CANCELED and DENIED fail it; PENDING, UNCLAIMED, ONHOLD, NEW and anything PayPal adds
 * later keep it pending, so an unfamiliar status can delay a payout but never misreport one.
 */
import { feeMinor } from './amounts.ts';
import { asObject, text } from './json.ts';

/** The `payment_authorizations.status` vocabulary (PaymentStatus in packages/shared). */
export type PaymentStatus = 'authorized' | 'submitted' | 'pending' | 'succeeded' | 'failed' | 'unknown';

/** The statuses a PayPal batch or item report can put an operation in. */
export type ReportedStatus = Extract<PaymentStatus, 'pending' | 'succeeded' | 'failed'>;

const FAILED_ITEM_STATUSES: ReadonlySet<string> = new Set([
  'FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'CANCELED', 'DENIED',
]);
const FAILED_BATCH_STATUSES: ReadonlySet<string> = new Set(['DENIED', 'CANCELED']);

export const UNCLAIMED_MESSAGE =
  'The recipient email has no confirmed PayPal account; PayPal returns unclaimed payouts after 30 days.';
export const ONHOLD_MESSAGE = 'PayPal is holding the payout for review; it settles or fails when the review ends.';

export function statusOfItem(transactionStatus: unknown): ReportedStatus {
  if (transactionStatus === 'SUCCESS') {
    return 'succeeded';
  }
  return typeof transactionStatus === 'string' && FAILED_ITEM_STATUSES.has(transactionStatus) ? 'failed' : 'pending';
}

export interface PayoutOutcome {
  status: ReportedStatus;
  batchId: string | null;
  itemId: string | null;
  feeMinor: number | null;
  message: string | null;
}

/**
 * A payout item as `GET /v1/payments/payouts/{batch}` lists it and `PAYMENT.PAYOUTS-ITEM.*` events
 * carry it. `fallbackStatus` stands in for a missing `transaction_status` (the event type's).
 */
export function itemOutcome(item: unknown, fallbackStatus: string | null = null): PayoutOutcome {
  const o = asObject(item);
  const transactionStatus = text(o.transaction_status) ?? fallbackStatus;
  const status = statusOfItem(transactionStatus);
  const currency = text(asObject(asObject(o.payout_item).amount).currency);
  return {
    status,
    batchId: text(o.payout_batch_id),
    itemId: text(o.payout_item_id),
    feeMinor: feeMinor(o.payout_item_fee, currency),
    message: itemMessage(status, transactionStatus, o.errors),
  };
}

function itemMessage(status: ReportedStatus, transactionStatus: string | null, errors: unknown): string | null {
  if (status === 'failed') {
    const e = asObject(errors);
    return text(e.message) ?? text(e.name) ?? `PayPal reports the payout as ${transactionStatus ?? 'failed'}.`;
  }
  if (transactionStatus === 'UNCLAIMED') {
    return UNCLAIMED_MESSAGE;
  }
  if (transactionStatus === 'ONHOLD') {
    return ONHOLD_MESSAGE;
  }
  return null;
}

/**
 * A `GET /v1/payments/payouts/{batch}` body. The operation's item is the one whose sender_item_id is
 * the authorization id (a single item without one is taken as ours); with no item yet, only a
 * denied or canceled batch says anything final.
 */
export function batchOutcome(batch: unknown, authorizationId: string): PayoutOutcome {
  const o = asObject(batch);
  const header = asObject(o.batch_header);
  const batchId = text(header.payout_batch_id);
  const items = Array.isArray(o.items) ? (o.items as unknown[]) : [];
  const senderItemId = (item: unknown) => text(asObject(asObject(item).payout_item).sender_item_id);
  const item =
    items.find((candidate) => senderItemId(candidate) === authorizationId) ??
    (items.length === 1 && senderItemId(items[0]) === null ? items[0] : undefined);
  if (item !== undefined) {
    const outcome = itemOutcome(item);
    return { ...outcome, batchId: batchId ?? outcome.batchId };
  }
  return batchStatusOutcome(batchId, header.batch_status);
}

/** What a batch status alone (a PAYMENT.PAYOUTSBATCH.* event, or a batch without items) tells. */
export function batchStatusOutcome(batchId: string | null, batchStatus: unknown): PayoutOutcome {
  const failed = typeof batchStatus === 'string' && FAILED_BATCH_STATUSES.has(batchStatus);
  return {
    status: failed ? 'failed' : 'pending',
    batchId,
    itemId: null,
    feeMinor: null,
    message: failed ? `PayPal ${batchStatus === 'DENIED' ? 'denied' : 'canceled'} the payout batch.` : null,
  };
}

/**
 * PayPal's error body as one line: 'NAME: message (ISSUE: description; ...)'. OAuth errors use
 * { error, error_description } instead and read the same way.
 */
export function describePayPalError(status: number, body: unknown): string {
  const o = asObject(body);
  const name = text(o.name) ?? text(o.error);
  const message = text(o.message) ?? text(o.error_description);
  const head = name !== null && message !== null ? `${name}: ${message}` : (name ?? message ?? `HTTP ${status}`);
  const details = detailIssues(o).map(({ issue, description }) =>
    issue !== null && description !== null ? `${issue}: ${description}` : (issue ?? description));
  return details.length > 0 ? `${head} (${details.join('; ')})` : head;
}

function detailIssues(o: Readonly<Record<string, unknown>>): { issue: string | null; description: string | null }[] {
  const details = Array.isArray(o.details) ? (o.details as unknown[]) : [];
  return details
    .map((detail) => ({ issue: text(asObject(detail).issue), description: text(asObject(detail).description) }))
    .filter(({ issue, description }) => issue !== null || description !== null);
}

/** Details about the sender_batch_id, which PayPal rejects when a batch with that id already exists. */
function senderBatchIdDetails(o: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>[] {
  const details = Array.isArray(o.details) ? (o.details as unknown[]) : [];
  return details.map(asObject).filter((detail) => text(detail.field)?.toUpperCase() === 'SENDER_BATCH_ID');
}

/**
 * A rejection that says PayPal may already hold this operation (a reused sender_batch_id or
 * request id, a conflicting concurrent request). Its outcome is unknown, never failed: recording
 * failed would let the approval be paid again under a new id.
 *
 * The sandbox does not replay the first answer for a repeated PayPal-Request-Id: a resent payout
 * is refused with USER_BUSINESS_ERROR, field SENDER_BATCH_ID, "Batch with given sender_batch_id
 * already exists" (observed 2026-10-22), so that shape counts as well.
 */
export function mayAlreadyExist(status: number, body: unknown): boolean {
  if (status === 409) {
    return true;
  }
  const o = asObject(body);
  const names = [text(o.name), ...detailIssues(o).map(({ issue }) => issue)];
  return (
    names.some((name) => name !== null && /DUPLICATE|ALREADY_USED|already exists/i.test(name)) ||
    senderBatchIdDetails(o).length > 0
  );
}

const PAYOUT_BATCH_HREF = /\/v1\/payments\/payouts\/([A-Za-z0-9]+)$/;

/**
 * The batch an "already exists" rejection links to (details[].link[].href ending in
 * /v1/payments/payouts/{payout_batch_id}), so a resend whose first answer was lost can still learn
 * which batch holds the payout. Null when the rejection carries no such link.
 */
export function existingBatchId(body: unknown): string | null {
  for (const detail of senderBatchIdDetails(asObject(body))) {
    const links = Array.isArray(detail.link) ? detail.link : Array.isArray(detail.links) ? detail.links : [];
    for (const link of links as unknown[]) {
      const match = PAYOUT_BATCH_HREF.exec(text(asObject(link).href) ?? '');
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return null;
}

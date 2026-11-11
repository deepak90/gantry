/**
 * Carries out what `payout_begin` / `payout_resume` decided and records PayPal's answer.
 *
 *   submit  POST the payout with the authorization id as PayPal-Request-Id, sender_batch_id and
 *           sender_item_id, so every attempt is the same request and PayPal pays it at most once.
 *           Accepted: pending with the batch id, then the batch is read at once for the item status
 *           and fee. Refused because the batch already exists (a resend after a lost answer): the
 *           batch PayPal links is recorded and read. Rejected otherwise: failed with PayPal's
 *           reason, unless the rejection says PayPal may already hold the operation. No answer, 5xx, 401, 408 or 429: unknown, and the next
 *           execute or reconcile re-sends the same request once the 20-second window has passed.
 *   check   GET the batch and record the item.
 *   wait, none   nothing to do.
 */
import { AmountError, minorToDecimal } from './amounts.ts';
import { asObject, text } from './json.ts';
import { batchOutcome, describePayPalError, existingBatchId, mayAlreadyExist } from './outcomes.ts';
import type { PayPalSession } from './paypal.ts';
import type { PaymentAuthorization, PayoutStep, PayoutStore } from './store.ts';

export interface PayoutProgress {
  /** The row after this call (as recorded, or as the step returned it when nothing was recorded). */
  authorization: PaymentAuthorization;
  /** Why a status check said nothing new (PayPal unreachable); the stored row is unchanged. */
  notice: string | null;
}

/** Rejections of a payout POST that say nothing about the payout itself: retry the same request later. */
const TRANSIENT_REJECTIONS: ReadonlySet<number> = new Set([401, 408, 429]);

const RESEND_NOTE = 'Refreshing re-sends the same request, which PayPal never pays twice.';

export async function advancePayout(step: PayoutStep, paypal: PayPalSession, store: PayoutStore): Promise<PayoutProgress> {
  switch (step.action) {
    case 'submit':
      return submit(step.authorization, paypal, store);
    case 'check':
      return check(step.authorization, paypal, store);
    case 'wait':
    case 'none':
      return { authorization: step.authorization, notice: null };
  }
}

async function submit(row: PaymentAuthorization, paypal: PayPalSession, store: PayoutStore): Promise<PayoutProgress> {
  const recorded = async (status: 'failed' | 'unknown', message: string, raw?: unknown): Promise<PayoutProgress> => ({
    authorization: await store.record({ authorizationId: row.id, status, message, raw }),
    notice: null,
  });

  try {
    minorToDecimal(row.amount_minor);
  } catch (error) {
    if (error instanceof AmountError) {
      return recorded('failed', `The payout cannot be sent: ${error.message}.`);
    }
    throw error;
  }

  const reply = await paypal.createPayout({
    authorizationId: row.id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    recipientEmail: row.recipient_email,
  });
  if (reply.kind === 'unreachable') {
    return recorded('unknown', `PayPal did not answer (${reply.message}), so the outcome is unknown. ${RESEND_NOTE}`);
  }

  const { status, body } = reply;
  if (status >= 200 && status < 300) {
    const batchId = text(asObject(asObject(body).batch_header).payout_batch_id);
    if (batchId === null) {
      return recorded('unknown', `PayPal accepted the payout (HTTP ${status}) without a batch id. ${RESEND_NOTE}`, body);
    }
    const accepted = await store.record({ authorizationId: row.id, status: 'pending', batchId, raw: body });
    return check(accepted, paypal, store);
  }

  // A resend of an operation PayPal already holds (the first answer was lost): PayPal refuses it and
  // links the existing batch. Record that batch and read its real status.
  const existing = existingBatchId(body);
  if (existing !== null) {
    const recovered = await store.record({ authorizationId: row.id, status: 'pending', batchId: existing, raw: body });
    return check(recovered, paypal, store);
  }

  const reason = describePayPalError(status, body);
  if (mayAlreadyExist(status, body)) {
    return recorded(
      'unknown',
      `PayPal reports this payout as already submitted (${reason}) but returned no batch id. Check the sandbox ` +
        'account activity before authorizing the payment again.',
      body,
    );
  }
  if (status >= 500 || TRANSIENT_REJECTIONS.has(status)) {
    return recorded('unknown', `PayPal could not take the payout now (HTTP ${status}, ${reason}). ${RESEND_NOTE}`, body);
  }
  return recorded('failed', reason, body);
}

async function check(row: PaymentAuthorization, paypal: PayPalSession, store: PayoutStore): Promise<PayoutProgress> {
  const batchId = row.paypal_batch_id;
  if (batchId === null) {
    return { authorization: row, notice: null };
  }
  const reply = await paypal.getPayoutBatch(batchId);
  if (reply.kind === 'unreachable' || reply.status < 200 || reply.status >= 300) {
    const reason = reply.kind === 'unreachable' ? reply.message : describePayPalError(reply.status, reply.body);
    return {
      authorization: row,
      notice: `Could not read PayPal batch ${batchId} (${reason}); the status shown is the last one recorded.`,
    };
  }
  const outcome = batchOutcome(reply.body, row.id);
  const authorization = await store.record({
    authorizationId: row.id,
    status: outcome.status,
    batchId: outcome.batchId ?? batchId,
    itemId: outcome.itemId,
    feeMinor: outcome.feeMinor,
    message: outcome.message,
    raw: reply.body,
  });
  return { authorization, notice: null };
}

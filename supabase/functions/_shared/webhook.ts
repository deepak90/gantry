/**
 * PayPal webhook deliveries for payouts. A delivery is believed only after PayPal has verified its
 * signature, and it counts once: `payout_record_event` dedupes on the event id before any status is
 * recorded, so a retried or replayed delivery changes nothing.
 *
 *   PAYMENT.PAYOUTS-ITEM.*   the resource is the item; its sender_item_id is the authorization id
 *   PAYMENT.PAYOUTSBATCH.*   the resource is the batch; its sender_batch_id is the authorization id.
 *                            Batch events carry no item, so the batch is read back for the item
 *                            status and fee (falling back to the batch status alone)
 *
 * Other event types and ids that are not ours are acknowledged and ignored, so PayPal stops retrying
 * them. In mock mode the mock verifies every signature, and events are stored as unverified.
 */
import type { PayPalConfig } from './config.ts';
import { HttpError } from './http.ts';
import { asObject, isObject, isUuid, text, type JsonObject } from './json.ts';
import { batchOutcome, batchStatusOutcome, itemOutcome, type PayoutOutcome } from './outcomes.ts';
import type { PayPalApi, PayPalSession, WebhookTransmission } from './paypal.ts';
import { StoreError, type PaymentAuthorization, type PayoutStore } from './store.ts';

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
  /** The operation as recorded, when the delivery recorded a status. */
  authorization?: PaymentAuthorization;
}

const ITEM_EVENT = 'PAYMENT.PAYOUTS-ITEM.';
const BATCH_EVENT = 'PAYMENT.PAYOUTSBATCH.';

/** Item event suffixes that are not spelled like the transaction status they report. */
const ITEM_EVENT_STATUS: Readonly<Record<string, string>> = { SUCCEEDED: 'SUCCESS', HELD: 'ONHOLD' };

export type WebhookTarget =
  | { kind: 'item'; eventType: string; authorizationId: string | null; resource: JsonObject }
  | {
      kind: 'batch';
      eventType: string;
      authorizationId: string | null;
      batchId: string | null;
      batchStatus: unknown;
      resource: JsonObject;
    };

/** Which operation a payout event is about, or null for any other event type. */
export function webhookTarget(event: JsonObject): WebhookTarget | null {
  const eventType = text(event.event_type);
  const resource = asObject(event.resource);
  if (eventType?.startsWith(ITEM_EVENT)) {
    const authorizationId = text(asObject(resource.payout_item).sender_item_id) ?? text(resource.sender_batch_id);
    return { kind: 'item', eventType, authorizationId, resource };
  }
  if (eventType?.startsWith(BATCH_EVENT)) {
    const header = asObject(resource.batch_header);
    return {
      kind: 'batch',
      eventType,
      authorizationId: text(asObject(header.sender_batch_header).sender_batch_id),
      batchId: text(header.payout_batch_id),
      batchStatus: header.batch_status,
      resource,
    };
  }
  return null;
}

export interface WebhookInput {
  rawBody: string;
  headers: Headers;
  config: PayPalConfig;
  paypal: PayPalApi;
  store: PayoutStore;
}

export async function processWebhook({ rawBody, headers, config, paypal, store }: WebhookInput): Promise<WebhookResult> {
  const webhookId = config.webhookId;
  if (webhookId === null) {
    throw new HttpError(
      503,
      'WEBHOOK_NOT_CONFIGURED',
      'PAYPAL_WEBHOOK_ID is not set, so PayPal deliveries cannot be verified and are refused. Register a webhook ' +
        'for this function URL in the PayPal Developer Dashboard, put its id in .env.local and restart ' +
        '`pnpm functions:serve`. Until then paypal-reconcile keeps payouts up to date.',
    );
  }
  let event: unknown;
  try {
    event = JSON.parse(rawBody) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'The webhook body is not JSON.');
  }
  if (!isObject(event)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'The webhook body is not a JSON object.');
  }

  const transmission = readTransmission(headers);
  if (config.mode === 'live' && Object.values(transmission).some((value) => value === '')) {
    throw new HttpError(401, 'WEBHOOK_SIGNATURE_INVALID', 'The PayPal transmission headers (paypal-*) are missing.');
  }
  const session = await paypal.connect();
  const verification = await session.verifyWebhookSignature(transmission, webhookId, rawBody);
  if (verification.kind === 'unreachable' || verification.status >= 500) {
    throw new HttpError(503, 'PAYPAL_UNAVAILABLE', 'PayPal could not verify the delivery now; it will be retried.');
  }
  if (verification.status !== 200 || asObject(verification.body).verification_status !== 'SUCCESS') {
    throw new HttpError(401, 'WEBHOOK_SIGNATURE_INVALID', 'PayPal did not verify this delivery; nothing was recorded.');
  }

  const eventId = text(event.id);
  if (eventId === null) {
    throw new HttpError(400, 'INVALID_REQUEST', 'The webhook event has no id.');
  }
  const target = webhookTarget(event);
  if (target === null) {
    return ignored(eventId, 'not a payout event');
  }
  const authorizationId = target.authorizationId;
  if (!isUuid(authorizationId)) {
    return ignored(eventId, 'not a payout sent by this app');
  }

  let fresh: boolean;
  try {
    fresh = await store.recordEvent({
      authorizationId,
      eventId,
      eventType: target.eventType,
      verified: config.mode === 'live',
      payload: event,
    });
  } catch (error) {
    if (error instanceof StoreError && error.sqlstate === 'P0002') {
      return ignored(eventId, 'no such payment authorization');
    }
    throw error;
  }
  if (!fresh) {
    return { status: 200, body: { duplicate: true, event_id: eventId } };
  }

  const outcome =
    target.kind === 'item'
      ? itemOutcome(target.resource, itemEventStatus(target.eventType))
      : await batchEventOutcome(target.batchId, target.batchStatus, authorizationId, session);
  const row = await store.record({
    authorizationId,
    status: outcome.status,
    batchId: outcome.batchId,
    itemId: outcome.itemId,
    feeMinor: outcome.feeMinor,
    message: outcome.message,
    raw: target.resource,
  });
  return {
    status: 200,
    body: { recorded: true, event_id: eventId, authorization_id: authorizationId, status: row.status },
    authorization: row,
  };
}

function ignored(eventId: string, reason: string): WebhookResult {
  return { status: 200, body: { ignored: true, event_id: eventId, reason } };
}

function itemEventStatus(eventType: string): string {
  const suffix = eventType.slice(ITEM_EVENT.length);
  return ITEM_EVENT_STATUS[suffix] ?? suffix;
}

async function batchEventOutcome(
  batchId: string | null,
  batchStatus: unknown,
  authorizationId: string,
  session: PayPalSession,
): Promise<PayoutOutcome> {
  if (batchId !== null) {
    const reply = await session.getPayoutBatch(batchId);
    if (reply.kind === 'reply' && reply.status >= 200 && reply.status < 300) {
      const outcome = batchOutcome(reply.body, authorizationId);
      return { ...outcome, batchId: outcome.batchId ?? batchId };
    }
  }
  return batchStatusOutcome(batchId, batchStatus);
}

/** The `paypal-*` delivery headers; a missing one reads as ''. */
function readTransmission(headers: Headers): WebhookTransmission {
  const get = (name: string) => headers.get(name) ?? '';
  return {
    authAlgo: get('paypal-auth-algo'),
    certUrl: get('paypal-cert-url'),
    transmissionId: get('paypal-transmission-id'),
    transmissionSig: get('paypal-transmission-sig'),
    transmissionTime: get('paypal-transmission-time'),
  };
}

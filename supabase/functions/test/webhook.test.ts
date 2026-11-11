import { describe, expect, it } from 'vitest';
import { webhookTarget } from '../_shared/webhook.ts';
import {
  AUTH_ID,
  batchBody,
  FakePayPal,
  FakeStore,
  jsonResponse,
  LIVE_ENV,
  readJson,
  webhookHandler,
  webhookRequest,
} from './fakes.ts';

function itemEvent(fields: { id?: string; type?: string; status?: string; senderItemId?: string; errors?: unknown } = {}) {
  return {
    id: fields.id ?? 'WH-1',
    event_type: fields.type ?? 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    resource_type: 'payouts_item',
    resource: {
      payout_item_id: 'ITEM-1',
      transaction_id: 'TX-1',
      transaction_status: fields.status ?? 'SUCCESS',
      payout_item_fee: { currency: 'USD', value: '0.25' },
      payout_batch_id: 'BATCH-1',
      payout_item: {
        recipient_type: 'EMAIL',
        amount: { currency: 'USD', value: '1200.00' },
        receiver: 'supplier@test.local',
        sender_item_id: fields.senderItemId ?? AUTH_ID,
      },
      ...(fields.errors === undefined ? {} : { errors: fields.errors }),
    },
  };
}

function batchEvent(type = 'PAYMENT.PAYOUTSBATCH.SUCCESS', batchStatus = 'SUCCESS') {
  return {
    id: 'WH-B-1',
    event_type: type,
    resource_type: 'payouts',
    resource: {
      batch_header: {
        payout_batch_id: 'BATCH-1',
        batch_status: batchStatus,
        sender_batch_header: { sender_batch_id: AUTH_ID },
      },
    },
  };
}

function setup(env = LIVE_ENV) {
  const store = new FakeStore();
  store.add({ status: 'pending', paypal_batch_id: 'BATCH-1', attempts: 1 });
  const paypal = new FakePayPal();
  return { store, paypal, webhook: webhookHandler(store, paypal, env) };
}

describe('paypal-webhook: verification', () => {
  it('verifies the delivery with PayPal, sending the raw body verbatim', async () => {
    const { paypal, webhook } = setup();
    // Spacing and a float that JSON.stringify would rewrite: only a verbatim copy keeps the signature valid.
    const raw = `{ "id": "WH-1", "event_type": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "x": 1.0, "resource": ${JSON.stringify(itemEvent().resource)} }`;
    const response = await webhook(webhookRequest(raw));
    expect(response.status).toBe(200);
    const verify = paypal.calls.find((call) => call.path === '/v1/notifications/verify-webhook-signature');
    expect(verify?.body).toContain(`"webhook_event":${raw}}`);
    expect(JSON.parse(verify?.body ?? 'null')).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1',
      transmission_id: 'TX-1',
      transmission_sig: 'SIG-1',
      transmission_time: '2026-11-02T09:00:00Z',
      webhook_id: 'WH-ID-1',
      webhook_event: { id: 'WH-1' },
    });
  });

  it('an invalid signature is a 401 and records nothing', async () => {
    const { store, paypal, webhook } = setup();
    paypal.verify = () => jsonResponse(200, { verification_status: 'FAILURE' });
    const response = await webhook(webhookRequest(JSON.stringify(itemEvent())));
    expect(response.status).toBe(401);
    expect((await readJson(response)).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(store.calls).toHaveLength(0);
    expect(store.row().status).toBe('pending');
  });

  it('missing transmission headers are a 401 without asking PayPal', async () => {
    const { store, paypal, webhook } = setup();
    const response = await webhook(webhookRequest(JSON.stringify(itemEvent()), {}));
    expect(response.status).toBe(401);
    expect(paypal.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it('live mode without PAYPAL_WEBHOOK_ID is a 503 that says what to do', async () => {
    const { PAYPAL_WEBHOOK_ID: _, ...env } = LIVE_ENV;
    const { store, paypal, webhook } = setup(env);
    const response = await webhook(webhookRequest(JSON.stringify(itemEvent())));
    expect(response.status).toBe(503);
    const result = await readJson(response);
    expect(result.code).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(result.error).toContain('PAYPAL_WEBHOOK_ID');
    expect(paypal.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it('PayPal unable to verify is a 503 (PayPal retries the delivery)', async () => {
    const { store, paypal, webhook } = setup();
    paypal.verify = () => jsonResponse(503, { name: 'SERVICE_UNAVAILABLE' });
    const response = await webhook(webhookRequest(JSON.stringify(itemEvent())));
    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe('PAYPAL_UNAVAILABLE');
    expect(store.calls).toHaveLength(0);
  });

  it('400 for a body that is not a JSON object, 405 for GET', async () => {
    const { webhook } = setup();
    expect((await webhook(webhookRequest('nope'))).status).toBe(400);
    expect((await webhook(webhookRequest('[1]'))).status).toBe(400);
    expect((await webhook(new Request('http://localhost/x'))).status).toBe(405);
  });
});

describe('paypal-webhook: events', () => {
  it('an item event records its status, item id and fee', async () => {
    const { store, webhook } = setup();
    const response = await webhook(webhookRequest(JSON.stringify(itemEvent())));
    expect(await readJson(response)).toEqual({ recorded: true, event_id: 'WH-1', authorization_id: AUTH_ID, status: 'succeeded' });
    expect(store.row()).toMatchObject({ status: 'succeeded', paypal_item_id: 'ITEM-1', fee_minor: 25 });
    expect(store.events.get('WH-1')).toMatchObject({ eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', verified: true });
  });

  it('a failed item records PayPal errors.message', async () => {
    const { store, webhook } = setup();
    await webhook(
      webhookRequest(
        JSON.stringify(
          itemEvent({ type: 'PAYMENT.PAYOUTS-ITEM.FAILED', status: 'FAILED', errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' } }),
        ),
      ),
    );
    expect(store.row()).toMatchObject({ status: 'failed', message: 'Receiver is unregistered' });
  });

  it('a replayed event is a duplicate and changes nothing', async () => {
    const { store, webhook } = setup();
    await webhook(webhookRequest(JSON.stringify(itemEvent({ type: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED', status: 'UNCLAIMED' }))));
    const before = { ...store.row() };
    const replay = await webhook(
      webhookRequest(JSON.stringify(itemEvent({ type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', status: 'SUCCESS' }))),
    );
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toEqual({ duplicate: true, event_id: 'WH-1' });
    expect(store.row()).toEqual(before);
    expect(store.calls.filter((call) => call.startsWith('record:'))).toHaveLength(1);
  });

  it('a batch event reads the batch back for the item status and fee', async () => {
    const { store, paypal, webhook } = setup();
    paypal.batch = () => jsonResponse(200, batchBody({ transactionStatus: 'SUCCESS' }));
    const response = await webhook(webhookRequest(JSON.stringify(batchEvent())));
    expect(await readJson(response)).toMatchObject({ recorded: true, status: 'succeeded' });
    expect(paypal.paths()).toContain('GET /v1/payments/payouts/BATCH-1');
    expect(store.row()).toMatchObject({ status: 'succeeded', paypal_item_id: 'ITEM-1', fee_minor: 25 });
  });

  it('a denied batch fails even when the batch cannot be read back', async () => {
    const { store, paypal, webhook } = setup();
    paypal.batch = () => jsonResponse(404, { name: 'RESOURCE_NOT_FOUND' });
    await webhook(webhookRequest(JSON.stringify(batchEvent('PAYMENT.PAYOUTSBATCH.DENIED', 'DENIED'))));
    expect(store.row()).toMatchObject({ status: 'failed', message: 'PayPal denied the payout batch.' });
  });

  it('an item event without transaction_status uses the event type', async () => {
    const { store, webhook } = setup();
    const event = itemEvent({ type: 'PAYMENT.PAYOUTS-ITEM.HELD' });
    delete (event.resource as { transaction_status?: string }).transaction_status;
    await webhook(webhookRequest(JSON.stringify(event)));
    expect(store.row()).toMatchObject({ status: 'pending', message: expect.stringContaining('holding') });
  });

  it.each([
    ['another product', { id: 'WH-9', event_type: 'CHECKOUT.ORDER.APPROVED', resource: {} }],
    ['an id that is not a uuid', itemEvent({ senderItemId: 'check-1729500000-1' })],
    ['a uuid that is not ours', itemEvent({ senderItemId: '00000000-0000-4000-8000-00000000dead' })],
  ])('ignores %s with a 200', async (_, event) => {
    const { store, webhook } = setup();
    const response = await webhook(webhookRequest(JSON.stringify(event)));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ ignored: true });
    expect(store.events.size).toBe(0);
    expect(store.calls.filter((call) => call.startsWith('record:'))).toHaveLength(0);
    expect(store.row().status).toBe('pending');
  });
});

describe('webhookTarget', () => {
  it('names the operation of item and batch events', () => {
    expect(webhookTarget(itemEvent())).toMatchObject({ kind: 'item', authorizationId: AUTH_ID });
    expect(webhookTarget(batchEvent())).toMatchObject({ kind: 'batch', authorizationId: AUTH_ID, batchId: 'BATCH-1' });
    expect(webhookTarget({ event_type: 'PAYMENT.CAPTURE.COMPLETED' })).toBeNull();
  });
});

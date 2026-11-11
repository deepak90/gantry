import { describe, expect, it } from 'vitest';
import { batchOutcome } from '../_shared/outcomes.ts';
import { MOCK_ACCESS_TOKEN, MOCK_INVALID_SIGNATURE, mockOutcomeFor, mockPayPalFetch } from '../_shared/paypal-mock.ts';
import { createPayPalApi, payoutRequestBody, PAYPAL_SANDBOX_API } from '../_shared/paypal.ts';
import { AUTH_ID, FakePayPal, FakeStore, payoutHandler, payoutRequest, readJson, webhookHandler, webhookRequest } from './fakes.ts';

const MOCK_ENV = { PAYPAL_MODE: 'mock' };

async function connect() {
  return createPayPalApi({ mode: 'mock', clientId: 'mock', clientSecret: 'mock', fetch: mockPayPalFetch }).connect();
}

async function payOut(recipientEmail: string, amountMinor = 120000) {
  const session = await connect();
  const created = await session.createPayout({ authorizationId: AUTH_ID, amountMinor, currency: 'USD', recipientEmail });
  if (created.kind !== 'reply') throw new Error('unreachable');
  const batchId = (created.body as { batch_header: { payout_batch_id: string } }).batch_header.payout_batch_id;
  const batch = await session.getPayoutBatch(batchId);
  if (batch.kind !== 'reply') throw new Error('unreachable');
  return { created, batchId, batch, outcome: batchOutcome(batch.body, AUTH_ID) };
}

describe('mock PayPal outcomes', () => {
  it('pays any ordinary recipient with the documented fee', async () => {
    const { created, batchId, outcome } = await payOut('payee@test.local');
    expect(created.status).toBe(201);
    expect(batchId).toBe(`MOCK-B-S-USD-120000-${AUTH_ID}`);
    expect(outcome).toEqual({
      status: 'succeeded',
      batchId,
      itemId: `MOCK-I-S-USD-120000-${AUTH_ID}`,
      feeMinor: 25,
      message: null,
    });
  });

  it('+fail@ fails with a RECEIVER_UNREGISTERED message and no fee', async () => {
    const { outcome } = await payOut('payee+fail@test.local');
    expect(outcome).toMatchObject({ status: 'failed', message: 'Receiver is unregistered', feeMinor: 0 });
  });

  it('+unclaimed@ stays pending with the unclaimed explanation', async () => {
    const { outcome } = await payOut('payee+unclaimed@test.local');
    expect(outcome.status).toBe('pending');
    expect(outcome.message).toContain('no confirmed PayPal account');
  });

  it('+pending@ stays pending', async () => {
    const { outcome } = await payOut('payee+pending@test.local');
    expect(outcome).toMatchObject({ status: 'pending', message: null });
  });

  it('echoes the amount exactly, including small ones', async () => {
    const { batch } = await payOut('payee@test.local', 5);
    expect(batch.kind === 'reply' && (batch.body as { items: { payout_item: { amount: unknown } }[] }).items[0]?.payout_item.amount).toEqual({
      value: '0.05',
      currency: 'USD',
    });
  });

  it('chooses the outcome from the recipient', () => {
    expect(['a@x', 'a+fail@x', 'a+unclaimed@x', 'a+pending@x'].map(mockOutcomeFor)).toEqual(['S', 'F', 'U', 'P']);
  });
});

describe('mock PayPal idempotency and statelessness', () => {
  it('the same request gets the same answer', async () => {
    const first = await payOut('payee@test.local');
    const second = await payOut('payee@test.local');
    expect(second.created).toEqual(first.created);
    expect(second.batch).toEqual(first.batch);
  });

  it('answers a batch read from the id alone, with no memory of the POST', async () => {
    const session = await connect();
    const batch = await session.getPayoutBatch(`MOCK-B-U-USD-990-${AUTH_ID}`);
    expect(batch.kind === 'reply' && batch.status).toBe(200);
    expect(batchOutcome(batch.kind === 'reply' ? batch.body : null, AUTH_ID)).toMatchObject({ status: 'pending', feeMinor: 25 });
  });

  it('does not know foreign batch ids', async () => {
    const session = await connect();
    const batch = await session.getPayoutBatch('5UXD2E8A7EBQJ');
    expect(batch.kind === 'reply' && batch.status).toBe(404);
  });
});

describe('mock PayPal checks requests like PayPal', () => {
  const post = (headers: Record<string, string>, body: unknown) =>
    mockPayPalFetch(`${PAYPAL_SANDBOX_API}/v1/payments/payouts`, { method: 'POST', headers, body: JSON.stringify(body) });
  const valid = payoutRequestBody({ authorizationId: AUTH_ID, amountMinor: 100, currency: 'USD', recipientEmail: 'a@b.c' });
  const auth = { Authorization: `Bearer ${MOCK_ACCESS_TOKEN}`, 'PayPal-Request-Id': AUTH_ID };

  it('accepts the body the functions build', async () => {
    expect((await post(auth, valid)).status).toBe(201);
  });

  it('requires a bearer token, an idempotency key and an exact amount', async () => {
    expect((await post({ 'PayPal-Request-Id': AUTH_ID }, valid)).status).toBe(401);
    expect((await post({ Authorization: `Bearer ${MOCK_ACCESS_TOKEN}` }, valid)).status).toBe(400);
    const badAmount = { ...valid, items: [{ ...valid.items[0], amount: { value: '1.5', currency: 'USD' } }] };
    expect((await post(auth, badAmount)).status).toBe(400);
  });

  it('never reaches anything but the sandbox base URL', async () => {
    const response = await mockPayPalFetch('https://api-m.paypal.com/v1/oauth2/token', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

describe('mock PayPal invoices', () => {
  const auth = { Authorization: `Bearer ${MOCK_ACCESS_TOKEN}` };
  const invoice = (rest: string, init: RequestInit) => mockPayPalFetch(`${PAYPAL_SANDBOX_API}/v2/invoicing/invoices/MOCK-INV-1${rest}`, { headers: auth, ...init });

  it('cancels with no content, as PayPal does, and being stateless still reads as unpaid afterward', async () => {
    const canceled = await invoice('/cancel', { method: 'POST', body: JSON.stringify({ send_to_recipient: true, send_to_invoicer: false }) });
    expect(canceled.status).toBe(204);
    expect(await canceled.text()).toBe('');
    expect(((await (await invoice('', { method: 'GET' })).json()) as { status: string }).status).toBe('UNPAID');
  });

  it('still needs a bearer token for it', async () => {
    const response = await mockPayPalFetch(`${PAYPAL_SANDBOX_API}/v2/invoicing/invoices/MOCK-INV-1/cancel`, { method: 'POST' });
    expect(response.status).toBe(401);
  });
});

describe('mock mode end to end through the handlers', () => {
  it('execute pays and records the fee, with no network fetch', async () => {
    const store = new FakeStore();
    store.add();
    const network = new FakePayPal();
    const result = await readJson(await payoutHandler('execute', store, network, MOCK_ENV)(payoutRequest({ authorization_id: AUTH_ID })));
    expect(result).toMatchObject({
      action: 'submit',
      mode: 'mock',
      authorization: { status: 'succeeded', fee_minor: 25, paypal_batch_id: `MOCK-B-S-USD-120000-${AUTH_ID}` },
    });
    expect(network.calls).toHaveLength(0);
  });

  it('a +fail@ recipient fails with the PayPal message', async () => {
    const store = new FakeStore();
    store.add({ recipient_email: 'supplier+fail@test.local' });
    const result = await readJson(
      await payoutHandler('execute', store, new FakePayPal(), MOCK_ENV)(payoutRequest({ authorization_id: AUTH_ID })),
    );
    expect(result.authorization).toMatchObject({ status: 'failed', message: 'Receiver is unregistered' });
  });

  it('webhooks verify without headers, are stored unverified, and dedupe', async () => {
    const store = new FakeStore();
    store.add({ status: 'pending', paypal_batch_id: `MOCK-B-S-USD-120000-${AUTH_ID}` });
    const webhook = webhookHandler(store, new FakePayPal(), MOCK_ENV);
    const event = JSON.stringify({
      id: 'WH-MOCK-1',
      event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
      resource: { batch_header: { payout_batch_id: `MOCK-B-S-USD-120000-${AUTH_ID}`, sender_batch_header: { sender_batch_id: AUTH_ID } } },
    });
    expect(await readJson(await webhook(webhookRequest(event, {})))).toMatchObject({ recorded: true, status: 'succeeded' });
    expect(store.events.get('WH-MOCK-1')?.verified).toBe(false);
    expect(await readJson(await webhook(webhookRequest(event, {})))).toEqual({ duplicate: true, event_id: 'WH-MOCK-1' });
  });

  it(`a ${MOCK_INVALID_SIGNATURE} signature is refused`, async () => {
    const store = new FakeStore();
    store.add();
    const response = await webhookHandler(store, new FakePayPal(), MOCK_ENV)(
      webhookRequest(JSON.stringify({ id: 'WH-X', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: {} }), {
        'paypal-transmission-sig': MOCK_INVALID_SIGNATURE,
      }),
    );
    expect(response.status).toBe(401);
    expect(store.calls).toHaveLength(0);
  });
});

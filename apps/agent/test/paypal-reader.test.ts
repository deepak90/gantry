/**
 * Reading PayPal for check_with_paypal, with a fake toolkit and a fake fetch: an invoice through the toolkit's
 * get_invoice and nothing else, a payout batch with one GET (and the order a local build paid the crews with, when
 * PayPal has no batch by that id), PayPal's answers turned into small figures, and failures said rather than thrown.
 */
import { describe, expect, it } from 'vitest';
import { createPayPalReader, invoiceOf, orderOf, payoutOf, type ToolkitLike } from '../src/paypal/reader';

const ACCESS = { clientId: 'test-id', clientSecret: 'test-secret' };
const SANDBOX = 'https://api-m.sandbox.paypal.com';
const INVOICE = 'INV2-AAAA-BBBB-CCCC-DDDD';
const BATCH = '5UXD2E8A7EBQJ';
const ORDER = '5O190127TN364715T';

/** A toolkit that lists `tools` and answers each call with `answer`, logging what it was asked. */
function fakeToolkit(answer: (name: string, args: Record<string, unknown>) => unknown, tools = ['get_invoice']) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let made = 0;
  const make = async (): Promise<ToolkitLike> => {
    made += 1;
    return {
      getTools: () => tools.map((name) => ({ function: { name } })),
      handleToolCall: async (call) => {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        calls.push({ name: call.function.name, args });
        return { content: JSON.stringify(answer(call.function.name, args)) };
      },
    };
  };
  return { make, calls, made: () => made };
}

/** A fetch that answers PayPal's paths from `routes` ("METHOD path" → status and body), logging every request it saw. */
function fakeFetch(routes: Record<string, [number, unknown]>) {
  const seen: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.replace(SANDBOX, '')}`;
    seen.push(key);
    const [status, body] = routes[key] ?? [404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' }];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, seen };
}

const SIGNED_IN: Record<string, [number, unknown]> = { 'POST /v1/oauth2/token': [200, { access_token: 'token', expires_in: 32_400 }] };

const SENT_INVOICE = {
  id: INVOICE,
  status: 'SENT',
  detail: { invoice_number: 'CO-1A2B3C4D', payment_term: { term_type: 'NET_30', due_date: '2026-12-10' } },
  amount: { currency_code: 'USD', value: '125400.00' },
  due_amount: { currency_code: 'USD', value: '125400.00' },
};

const PAID_BATCH = {
  batch_header: { payout_batch_id: BATCH, batch_status: 'SUCCESS', time_completed: '2026-11-10T15:04:31Z', amount: { currency: 'USD', value: '37800.00' }, fees: { currency: 'USD', value: '0.50' } },
  items: [
    { transaction_status: 'SUCCESS', payout_item: { amount: { currency: 'USD', value: '31320.00' } } },
    { transaction_status: 'SUCCESS', payout_item: { amount: { currency: 'USD', value: '6480.00' } } },
  ],
};

const CAPTURED_ORDER = {
  id: ORDER,
  status: 'COMPLETED',
  purchase_units: [
    { reference_id: 'PG-25-1', payments: { captures: [{ status: 'COMPLETED', amount: { currency_code: 'USD', value: '31320.00' }, seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '1093.56' } }, create_time: '2026-11-10T15:04:31Z' }] } },
    { reference_id: 'PG-25-2', payments: { captures: [{ status: 'COMPLETED', amount: { currency_code: 'USD', value: '6480.00' }, seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '226.64' } }, create_time: '2026-11-10T15:04:32Z' }] } },
  ],
};

describe('reading an invoice through the toolkit', () => {
  it('calls get_invoice with the invoice’s id and nothing else, and reads PayPal’s answer', async () => {
    const toolkit = fakeToolkit(() => SENT_INVOICE);
    const reader = createPayPalReader(ACCESS, { toolkit: toolkit.make, fetch: fakeFetch({}).fetch });
    expect(await reader.invoice(INVOICE)).toEqual({
      kind: 'found',
      value: { id: INVOICE, status: 'SENT', number: 'CO-1A2B3C4D', amount_minor: 12_540_000, paid_minor: null, due_minor: 12_540_000, due_on: '2026-12-10', paid_on: null },
    });
    expect(toolkit.calls).toEqual([{ name: 'get_invoice', args: { invoice_id: INVOICE } }]);
  });

  it('says PayPal has no such invoice on its 404, and what went wrong otherwise, signing in again after', async () => {
    const toolkit = fakeToolkit((_name, args) =>
      args.invoice_id === INVOICE ? { ok: false, status: 404, code: 'PAYPAL_API_HTTP_ERROR', message: 'Resource not found' } : { error: { message: 'Failed to fetch access token: invalid_client', type: 'paypal_error' } },
    );
    const reader = createPayPalReader(ACCESS, { toolkit: toolkit.make, fetch: fakeFetch({}).fetch });
    expect(await reader.invoice(INVOICE)).toEqual({ kind: 'not_found' });
    expect(await reader.invoice('INV2-EEEE-FFFF-GGGG-HHHH')).toEqual({ kind: 'failed', message: 'Failed to fetch access token: invalid_client' });
    await reader.invoice(INVOICE);
    expect(toolkit.made()).toBe(2);
  });

  it('never uses a toolkit that lists more than reading an invoice', async () => {
    const toolkit = fakeToolkit(() => SENT_INVOICE, ['get_invoice', 'send_invoice']);
    const answer = await createPayPalReader(ACCESS, { toolkit: toolkit.make, fetch: fakeFetch({}).fetch }).invoice(INVOICE);
    expect(answer).toEqual({ kind: 'failed', message: 'The PayPal toolkit lists get_invoice, send_invoice, not only get_invoice, so it is not used.' });
    expect(toolkit.calls).toEqual([]);
  });

  it('asks nothing about an id PayPal never gave, and stops waiting at the deadline', async () => {
    const toolkit = fakeToolkit(() => SENT_INVOICE);
    const reader = createPayPalReader(ACCESS, { toolkit: toolkit.make, fetch: fakeFetch({}).fetch });
    expect(await reader.invoice('MOCK-INV-0001')).toMatchObject({ kind: 'failed' });
    expect(await reader.invoice('../v1/reporting/transactions')).toMatchObject({ kind: 'failed' });
    expect(toolkit.calls).toEqual([]);
    const silent = createPayPalReader(ACCESS, {
      toolkit: async () => ({ getTools: () => [{ function: { name: 'get_invoice' } }], handleToolCall: () => new Promise(() => undefined) }),
      fetch: fakeFetch({}).fetch,
      timeoutMs: 20,
    });
    expect(await silent.invoice(INVOICE)).toEqual({ kind: 'failed', message: 'PayPal gave no answer within 0.02 s' });
  });
});

describe('reading a payout', () => {
  it('reads the batch with one GET after signing in', async () => {
    const { fetch, seen } = fakeFetch({ ...SIGNED_IN, [`GET /v1/payments/payouts/${BATCH}`]: [200, PAID_BATCH] });
    const answer = await createPayPalReader(ACCESS, { fetch, toolkit: fakeToolkit(() => ({})).make }).payout(BATCH);
    expect(answer).toEqual({
      kind: 'found',
      value: {
        via: 'payouts',
        id: BATCH,
        status: 'SUCCESS',
        amount_minor: 3_780_000,
        fee_minor: 50,
        completed_on: '2026-11-10',
        payments: [
          { status: 'SUCCESS', amount_minor: 3_132_000, error: null },
          { status: 'SUCCESS', amount_minor: 648_000, error: null },
        ],
      },
    });
    expect(seen).toEqual(['POST /v1/oauth2/token', `GET /v1/payments/payouts/${BATCH}`]);
  });

  it('reads the order a local build paid the crews with when PayPal has no batch by that id', async () => {
    const { fetch, seen } = fakeFetch({ ...SIGNED_IN, [`GET /v2/checkout/orders/${ORDER}`]: [200, CAPTURED_ORDER] });
    const reader = createPayPalReader(ACCESS, { fetch, toolkit: fakeToolkit(() => ({})).make });
    expect(await reader.payout(ORDER)).toEqual({
      kind: 'found',
      value: {
        via: 'order',
        id: ORDER,
        status: 'COMPLETED',
        amount_minor: 3_780_000,
        fee_minor: 132_020,
        completed_on: '2026-11-10',
        payments: [
          { status: 'COMPLETED', amount_minor: 3_132_000, error: null },
          { status: 'COMPLETED', amount_minor: 648_000, error: null },
        ],
      },
    });
    expect(seen).toEqual(['POST /v1/oauth2/token', `GET /v1/payments/payouts/${ORDER}`, `GET /v2/checkout/orders/${ORDER}`]);
    // Neither: PayPal has no record of it.
    expect(await reader.payout('ABCDEFGHIJKLM')).toEqual({ kind: 'not_found' });
  });

  it('says why when PayPal turns the key down or answers with an error, and signs in again next time', async () => {
    const refused = fakeFetch({ 'POST /v1/oauth2/token': [401, { error: 'invalid_client', error_description: 'Client Authentication failed' }] });
    const reader = createPayPalReader(ACCESS, { fetch: refused.fetch, toolkit: fakeToolkit(() => ({})).make });
    expect(await reader.payout(BATCH)).toEqual({ kind: 'failed', message: 'PayPal did not accept the assistant’s sandbox key.' });
    await reader.payout(BATCH);
    expect(refused.seen).toEqual(['POST /v1/oauth2/token', 'POST /v1/oauth2/token']);

    const broken = fakeFetch({ ...SIGNED_IN, [`GET /v1/payments/payouts/${BATCH}`]: [500, { name: 'INTERNAL_SERVICE_ERROR', message: 'An internal service error has occurred.' }] });
    expect(await createPayPalReader(ACCESS, { fetch: broken.fetch, toolkit: fakeToolkit(() => ({})).make }).payout(BATCH)).toEqual({
      kind: 'failed',
      message: 'INTERNAL_SERVICE_ERROR: An internal service error has occurred.',
    });
  });
});

describe('PayPal’s answers, read', () => {
  it('takes an invoice’s last payment day and what is paid and due', () => {
    expect(
      invoiceOf({
        id: INVOICE,
        status: 'PARTIALLY_PAID',
        detail: { invoice_number: 'CO-1A2B3C4D', payment_term: { due_date: '2026-12-10' } },
        amount: { currency_code: 'USD', value: '125400.00' },
        due_amount: { currency_code: 'USD', value: '65400.00' },
        payments: { paid_amount: { currency_code: 'USD', value: '60000.00' }, transactions: [{ payment_date: '2026-11-12' }, { payment_date: '2026-11-11' }] },
      }),
    ).toEqual({ id: INVOICE, status: 'PARTIALLY_PAID', number: 'CO-1A2B3C4D', amount_minor: 12_540_000, paid_minor: 6_000_000, due_minor: 6_540_000, due_on: '2026-12-10', paid_on: '2026-11-12' });
  });

  it('keeps a payment PayPal refused, with its reason, and leaves out what it can’t read', () => {
    expect(
      payoutOf({
        batch_header: { payout_batch_id: BATCH, batch_status: 'SUCCESS', amount: { currency: 'EUR', value: '10.00' } },
        items: [{ transaction_status: 'UNCLAIMED', payout_item: { amount: { currency: 'USD', value: '6480.00' } }, errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' } }],
      }),
    ).toEqual({ via: 'payouts', id: BATCH, status: 'SUCCESS', amount_minor: null, fee_minor: null, completed_on: null, payments: [{ status: 'UNCLAIMED', amount_minor: 648_000, error: 'Receiver is unregistered' }] });
    expect(orderOf({ id: ORDER, status: 'APPROVED', purchase_units: [{ amount: { currency_code: 'USD', value: '6480.00' } }] })).toEqual({
      via: 'order',
      id: ORDER,
      status: 'APPROVED',
      amount_minor: 648_000,
      fee_minor: null,
      completed_on: null,
      payments: [{ status: null, amount_minor: 648_000, error: null }],
    });
  });
});

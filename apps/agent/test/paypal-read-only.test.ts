/**
 * The assistant's PayPal access is read-only in code, since the sandbox REST key isn't read-only on PayPal's side. The
 * allowlist lets through signing in and a GET of one object by its id on PayPal's sandbox (an invoice for the toolkit, a
 * payout batch or an order for the shared client), and nothing else. PayPal's real Agent Toolkit, guarded and given a
 * stand-in HTTP adapter so nothing leaves the machine, gets through only to sign in and read the invoice it was asked
 * for: every other tool it has (sends, deletes, payments, refunds, listing the whole account) is refused before it is
 * sent, though the toolkit's own handler runs any tool it is asked for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_READS, readOnlyFetch, readOnlyInterceptor, readOnlyRequest, ReadOnlyRefusal, TOOLKIT_READS, toolkitAxios, type AxiosLike } from '../src/paypal/read-only';
import { createPayPalReader, loadToolkit } from '../src/paypal/reader';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const TOOLKIT_HOST = 'https://api.sandbox.paypal.com';
const INVOICE = 'INV2-AAAA-BBBB-CCCC-DDDD';
const BATCH = '5UXD2E8A7EBQJ';
const ORDER = '5O190127TN364715T';
const SIGN_IN = { method: 'POST', body: 'grant_type=client_credentials' };
const EVERY_READ = ['invoice', 'payout', 'order'] as const;

describe('the read-only allowlist', () => {
  it.each([
    ['signing in', { ...SIGN_IN, url: `${SANDBOX}/v1/oauth2/token` }],
    ['signing in on the toolkit’s host', { ...SIGN_IN, url: `${TOOLKIT_HOST}/v1/oauth2/token` }],
    ['one invoice', { method: 'GET', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}` }],
    ['one payout batch', { method: 'get', url: `${SANDBOX}/v1/payments/payouts/${BATCH}` }],
    ['one order', { method: 'GET', url: `${SANDBOX}/v2/checkout/orders/${ORDER}` }],
  ])('lets through %s', (_what, request) => {
    expect(readOnlyRequest(request, EVERY_READ)).toEqual({ ok: true });
  });

  it.each([
    ['production', { method: 'GET', url: `https://api-m.paypal.com/v2/invoicing/invoices/${INVOICE}` }],
    ['production’s other host', { method: 'GET', url: `https://api.paypal.com/v1/payments/payouts/${BATCH}` }],
    ['plain http', { method: 'GET', url: `http://api-m.sandbox.paypal.com/v1/payments/payouts/${BATCH}` }],
    ['another port', { method: 'GET', url: `https://api-m.sandbox.paypal.com:8443/v1/payments/payouts/${BATCH}` }],
    ['a look-alike host', { method: 'GET', url: `https://api-m.sandbox.paypal.com.example.com/v1/payments/payouts/${BATCH}` }],
    ['creating an invoice', { method: 'POST', url: `${TOOLKIT_HOST}/v2/invoicing/invoices` }],
    ['sending an invoice', { method: 'POST', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}/send` }],
    ['a reminder', { method: 'POST', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}/remind` }],
    ['canceling an invoice', { method: 'POST', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}/cancel` }],
    ['changing an invoice', { method: 'PUT', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}` }],
    ['deleting an invoice', { method: 'DELETE', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}` }],
    ['recording a payment on it', { method: 'POST', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}/payments` }],
    ['listing every invoice', { method: 'GET', url: `${TOOLKIT_HOST}/v2/invoicing/invoices` }],
    ['a page of them', { method: 'GET', url: `${TOOLKIT_HOST}/v2/invoicing/invoices?page=1&page_size=100` }],
    ['searching them', { method: 'POST', url: `${TOOLKIT_HOST}/v2/invoicing/search-invoices` }],
    ['a read with a query', { method: 'GET', url: `${SANDBOX}/v1/payments/payouts/${BATCH}?page_size=1000` }],
    ['sending a payout', { method: 'POST', url: `${SANDBOX}/v1/payments/payouts` }],
    ['canceling a payout item', { method: 'POST', url: `${SANDBOX}/v1/payments/payouts-item/${BATCH}/cancel` }],
    ['capturing an order', { method: 'POST', url: `${SANDBOX}/v2/checkout/orders/${ORDER}/capture` }],
    ['changing an order', { method: 'PATCH', url: `${SANDBOX}/v2/checkout/orders/${ORDER}` }],
    ['listing transactions', { method: 'GET', url: `${SANDBOX}/v1/reporting/transactions` }],
    ['a path around a read', { method: 'GET', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/..%2F..%2Fv1%2Fpayments%2Fpayouts` }],
    ['a path walked back', { method: 'GET', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/../../v1/reporting/transactions` }],
    ['an id PayPal never gave', { method: 'GET', url: `${SANDBOX}/v1/payments/payouts/MOCK-B-S-USD-100-PG-1` }],
    ['signing in another way', { method: 'POST', url: `${SANDBOX}/v1/oauth2/token`, body: 'grant_type=password&username=a&password=b' }],
    ['a GET of the sign-in', { method: 'GET', url: `${SANDBOX}/v1/oauth2/token` }],
  ])('refuses %s', (_what, request) => {
    expect(readOnlyRequest(request, EVERY_READ).ok).toBe(false);
  });

  it('lets the toolkit read an invoice only, and the shared client a payout batch or an order only', () => {
    const get = (url: string) => ({ method: 'GET', url });
    expect(readOnlyRequest(get(`${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}`), TOOLKIT_READS).ok).toBe(true);
    expect(readOnlyRequest(get(`${TOOLKIT_HOST}/v2/checkout/orders/${ORDER}`), TOOLKIT_READS).ok).toBe(false);
    expect(readOnlyRequest(get(`${TOOLKIT_HOST}/v1/payments/payouts/${BATCH}`), TOOLKIT_READS).ok).toBe(false);
    expect(readOnlyRequest(get(`${SANDBOX}/v2/invoicing/invoices/${INVOICE}`), CLIENT_READS).ok).toBe(false);
    expect(readOnlyRequest(get(`${SANDBOX}/v1/payments/payouts/${BATCH}`), CLIENT_READS).ok).toBe(true);
    expect(readOnlyRequest(get(`${SANDBOX}/v2/checkout/orders/${ORDER}`), CLIENT_READS).ok).toBe(true);
  });

  it('checks an axios request the same way, its params and base URL included', () => {
    const check = readOnlyInterceptor(TOOLKIT_READS);
    expect(check({ method: 'get', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}` })).toMatchObject({ method: 'get' });
    expect(check({ method: 'get', baseURL: TOOLKIT_HOST, url: `/v2/invoicing/invoices/${INVOICE}` })).toMatchObject({ method: 'get' });
    expect(() => check({ method: 'get', url: `${TOOLKIT_HOST}/v2/invoicing/invoices`, params: { page: 1, page_size: 100 } })).toThrow(ReadOnlyRefusal);
    expect(() => check({ method: 'get', url: `${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}`, params: new URLSearchParams('fields=all') })).toThrow(ReadOnlyRefusal);
    expect(() => check({ method: 'post', baseURL: TOOLKIT_HOST, url: `/v2/invoicing/invoices/${INVOICE}/send` })).toThrow(/is not a read/);
  });
});

describe('the shared client’s fetch', () => {
  it('sends only the sign-in and the reads, and refuses anything else before it is sent', async () => {
    const sent: string[] = [];
    const fetch = readOnlyFetch(async (url, init) => {
      sent.push(`${init.method} ${url}`);
      return new Response('{}');
    }, CLIENT_READS);
    await fetch(`${SANDBOX}/v1/oauth2/token`, SIGN_IN);
    await fetch(`${SANDBOX}/v1/payments/payouts/${BATCH}`, { method: 'GET' });
    await expect(fetch(`${SANDBOX}/v1/payments/payouts`, { method: 'POST', body: '{}' })).rejects.toThrow(ReadOnlyRefusal);
    await expect(fetch(`${SANDBOX}/v2/checkout/orders/${ORDER}/capture`, { method: 'POST', body: '{}' })).rejects.toThrow(/is not a read/);
    await expect(fetch(`${SANDBOX}/v2/invoicing/invoices/${INVOICE}`, { method: 'GET' })).rejects.toThrow(ReadOnlyRefusal);
    expect(sent).toEqual([`POST ${SANDBOX}/v1/oauth2/token`, `GET ${SANDBOX}/v1/payments/payouts/${BATCH}`]);
  });
});

describe('PayPal’s Agent Toolkit, guarded', () => {
  // A stand-in for the toolkit's HTTP adapter: nothing leaves the machine, and each request that got past the guard is logged.
  const sent: string[] = [];
  const axios = toolkitAxios() as AxiosLike & { defaults: { adapter?: unknown } };
  let adapter: unknown;
  beforeAll(() => {
    adapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config: { method?: string; url?: string }) => {
      sent.push(`${config.method?.toUpperCase()} ${config.url}`);
      const body = config.url?.endsWith('/v1/oauth2/token')
        ? { access_token: 'stand-in', expires_in: 32_400 }
        : { id: INVOICE, status: 'SENT', detail: { invoice_number: 'CO-1A2B3C4D', payment_term: { term_type: 'NET_30', due_date: '2026-12-10' } }, amount: { currency_code: 'USD', value: '125400.00' } };
      return { data: body, status: 200, statusText: 'OK', headers: {}, config };
    };
  });
  afterAll(() => {
    axios.defaults.adapter = adapter;
  });

  it('lists only reading an invoice, and reads one with a sign-in and a single GET', async () => {
    const toolkit = await loadToolkit({ clientId: 'test-id', clientSecret: 'test-secret' });
    expect(toolkit.getTools().map((tool) => tool.function.name)).toEqual(['get_invoice']);
    sent.length = 0;
    const answer = await createPayPalReader({ clientId: 'test-id', clientSecret: 'test-secret' }).invoice(INVOICE);
    expect(answer).toEqual({ kind: 'found', value: expect.objectContaining({ status: 'SENT', number: 'CO-1A2B3C4D', amount_minor: 12_540_000, due_on: '2026-12-10' }) });
    expect(sent).toEqual([`POST ${TOOLKIT_HOST}/v1/oauth2/token`, `GET ${TOOLKIT_HOST}/v2/invoicing/invoices/${INVOICE}`]);
  });

  it('refuses every other tool the toolkit has before it is sent, though its handler runs whatever it is asked', async () => {
    const { ALL_TOOLS_ENABLED, PayPalAgentToolkit } = await import('@paypal/agent-toolkit/openai');
    const every = new PayPalAgentToolkit({ clientId: 'test-id', clientSecret: 'test-secret', configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: true } } })
      .getTools()
      .map((tool) => tool.function.name);
    expect(every).toEqual(expect.arrayContaining(['send_invoice', 'cancel_sent_invoice', 'delete_invoice', 'list_invoices', 'search_invoicing', 'create_order', 'pay_order', 'create_refund', 'list_transactions']));
    const toolkit = await loadToolkit({ clientId: 'test-id', clientSecret: 'test-secret' });
    // Ids that would pass for real ones, so a tool is turned away by what it does, not by a malformed id.
    const args = { invoice_id: INVOICE, id: ORDER, order_id: ORDER, capture_id: ORDER, refund_id: ORDER, recurring_series_id: 'RS-AAAA-BBBB-CCCC', product_id: 'PROD-AAAABBBBCCCC', plan_id: 'P-AAAABBBBCCCC', subscription_id: 'I-AAAABBBBCCCC', dispute_id: 'PP-D-12345', transaction_id: ORDER };
    sent.length = 0;
    const answers = new Map<string, string>();
    for (const name of every.filter((tool) => tool !== 'get_invoice')) {
      const reply = await toolkit.handleToolCall({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      answers.set(name, String(reply.content));
    }
    // Only signing in got through: no write, no other read, no listing.
    expect(sent.filter((line) => line !== `POST ${TOOLKIT_HOST}/v1/oauth2/token`)).toEqual([]);
    // The toolkit did try: its handler is not limited by the actions it lists.
    expect(answers.get('send_invoice')).toMatch(/Refused by the read-only PayPal guard: POST \/v2\/invoicing\/invoices\/INV2-AAAA-BBBB-CCCC-DDDD\/send is not a read/);
    expect(answers.get('list_invoices')).toMatch(/Refused by the read-only PayPal guard: a query/);
    expect(answers.get('get_order')).toMatch(/Refused by the read-only PayPal guard: GET \/v2\/checkout\/orders/);
  });
});

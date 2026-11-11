import { describe, expect, it } from 'vitest';
import { ConfigError } from '../_shared/config.ts';
import { createInvoiceHandler, invoiceBody, invoiceRecipient, ONE_PAYMENT_LIMIT_MINOR, statusOf, type InvoiceRecord, type InvoiceStore } from '../_shared/invoices.ts';
import { sandboxAccounts } from '../_shared/accounts.ts';
import type { PaymentLimits } from '../_shared/hosted.ts';

const ID = '00000000-0000-4000-8000-0000000009a1';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000012';
const OTHER = '00000000-0000-4000-8000-000000000013';

const draft = (): InvoiceRecord => ({
  id: ID,
  project_id: PROJECT,
  title: 'Level 2 build-out: finished work',
  client_name: 'Harbor Street Properties',
  client_email: 'client@example.com',
  lines: [
    { label: 'Install light fixtures', amount_minor: 620000 },
    { label: 'Test light fixtures', amount_minor: 140000 },
  ],
  currency: 'USD',
  status: 'draft',
  paypal_invoice_id: null,
});

function store(row: InvoiceRecord | null, canBill = true): InvoiceStore & { row: InvoiceRecord | null; updates: Record<string, unknown>[] } {
  const state = {
    row,
    updates: [] as Record<string, unknown>[],
    async read() {
      return state.row;
    },
    async update(_id: string, patch: Record<string, unknown>) {
      state.updates.push(patch);
      state.row = { ...state.row!, ...patch } as InvoiceRecord;
      return state.row;
    },
    // One statement in the real store: only a row nobody has signed, never one already paid or canceled.
    async markSent(_id: string, stamp: { sent_by: string; sent_at: string }) {
      if ((state.row!.sent_by === null || state.row!.sent_by === undefined) && ['draft', 'failed', 'sent'].includes(state.row!.status)) {
        const patch = { ...stamp, status: 'sent', message: null };
        state.updates.push(patch);
        state.row = { ...state.row!, ...patch } as InvoiceRecord;
      }
      return state.row!;
    },
    async canBill() {
      return canBill;
    },
  };
  return state;
}

const post = (body: unknown, token: string | null = 'token') =>
  new Request('http://local/paypal-invoice', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

const handler = (invoices: InvoiceStore, user = USER) =>
  createInvoiceHandler({ env: { get: (name) => (name === 'PAYPAL_MODE' ? 'mock' : undefined) }, fetch: () => Promise.reject(new Error('mock mode never fetches')), store: invoices, resolveUser: async () => user });

/** The invoice as PayPal answers it to a GET. */
const onPayPal = (status: string) => new Response(JSON.stringify({ id: 'INV2-TEST', status, detail: { invoice_number: 'CO-0044', metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST' } } }), { status: 200 });

/** Live mode against a scripted PayPal: `answer` decides each call after sign-in; every call is kept in `seen`. */
function livePayPal(invoices: InvoiceStore, answer: (path: string, method: string) => Response, user = USER, seller?: string) {
  const seen: { path: string; method: string; body: unknown }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
    seen.push({ path, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
    return answer(path, String(init.method));
  };
  const env: Record<string, string | undefined> = { PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_INVOICER_NAME: seller };
  return { seen, handle: createInvoiceHandler({ env: { get: (name) => env[name] }, fetch, store: invoices, resolveUser: async () => user }) };
}

const sentRow = (extra: Partial<InvoiceRecord> = {}): InvoiceRecord => ({ ...draft(), status: 'sent', paypal_invoice_id: 'INV2-TEST', sent_by: OTHER, sent_at: '2026-11-09T05:05:00.000Z', ...extra });

describe('paypal-invoice', () => {
  it('names the seller when one is set, and leaves it to PayPal when not', () => {
    expect(invoiceBody(draft(), 'Aldermere Construction').invoicer).toEqual({ business_name: 'Aldermere Construction' });
    expect('invoicer' in invoiceBody(draft(), null)).toBe(false);
  });

  it('bills one item per line, in two decimals, to the client', () => {
    const body = invoiceBody(draft());
    expect(body.items.map((item) => item.unit_amount.value)).toEqual(['6200.00', '1400.00']);
    expect(body.primary_recipients[0]!.billing_info.email_address).toBe('client@example.com');
    expect(body.primary_recipients[0]!.billing_info.business_name).toBe('Harbor Street Properties');
    expect(body.configuration.partial_payment.allow_partial_payment).toBe(false);
  });

  it('bills a change order over $60,000 in parts, with its reference and what each floor’s line is made of', () => {
    const change: InvoiceRecord = {
      ...draft(),
      title: 'Harbor Street Offices · Change order: New light fixtures, levels 1 to 3',
      lines: [
        { label: 'Order light fixtures, levels 1 to 3', amount_minor: 10_500_000 },
        { label: 'Deliver, install and test light fixtures, level 1', amount_minor: 850_000, detail: 'Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400' },
      ],
    };
    const body = invoiceBody(change);
    // One PayPal payment carries at most $60,000: above it the tenant pays in parts, or not at all.
    expect(ONE_PAYMENT_LIMIT_MINOR).toBe(6_000_000);
    expect(body.configuration.partial_payment.allow_partial_payment).toBe(true);
    expect(body.detail.reference).toBe('Harbor Street Offices · Change order: New light fixtures, levels 1 to 3');
    expect(body.detail.invoice_number).toMatch(/^CO-[0-9A-F]{8}$/);
    expect(body.detail.payment_term.term_type).toBe('NET_30');
    expect(body.items.map((item) => [item.name, item.unit_amount.value, 'description' in item ? item.description : null])).toEqual([
      ['Order light fixtures, levels 1 to 3', '105000.00', null],
      ['Deliver, install and test light fixtures, level 1', '8500.00', 'Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400'],
    ]);
    // Exactly $60,000 still goes in one payment; PayPal's reference field takes 120 characters.
    const atLimit = invoiceBody({ ...change, title: 'x'.repeat(150), lines: [{ label: 'One payment', amount_minor: ONE_PAYMENT_LIMIT_MINOR }] });
    expect(atLimit.configuration.partial_payment.allow_partial_payment).toBe(false);
    expect(atLimit.detail.reference).toHaveLength(120);
  });

  it('only counts an invoice as paid when PayPal says all of it is', () => {
    expect(statusOf('PAID')).toBe('paid');
    expect(statusOf('MARKED_AS_PAID')).toBe('paid');
    expect(statusOf('PARTIALLY_PAID')).toBe('sent');
    expect(statusOf('PAYMENT_PENDING')).toBe('sent');
    expect(statusOf('CANCELLED')).toBe('cancelled');
    expect(statusOf('SOMETHING_NEW')).toBeNull();
  });

  it('creates the draft, sends it and keeps the number and the payer link', async () => {
    const invoices = store(draft());
    const response = await handler(invoices)(post({ invoice_id: ID, action: 'send' }));
    expect(response.status).toBe(200);
    const { invoice } = (await response.json()) as { invoice: InvoiceRecord };
    expect(invoice.status).toBe('sent');
    expect(invoice.paypal_invoice_id).toBe(`MOCK-INV-${ID}`);
    expect(invoice.paypal_number).toBeTruthy();
    expect(invoice.payer_url).toContain('/invoice/p/');
  });

  it('sends the PayPal request id of the row, so a retry after a lost answer is the same invoice', async () => {
    const seen: { path: string; requestId: string | null; body: unknown }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const headers = new Headers(init.headers);
      seen.push({ path, requestId: headers.get('PayPal-Request-Id'), body: headers.get('Content-Type') === 'application/json' && init.body ? JSON.parse(String(init.body)) : null });
      if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
      if (path === '/v2/invoicing/invoices') return new Response(JSON.stringify({ id: 'INV2-TEST' }), { status: 201 });
      if (path.endsWith('/send')) return new Response(JSON.stringify({ href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST' }), { status: 200 });
      return new Response(JSON.stringify({ id: 'INV2-TEST', status: 'UNPAID', detail: { invoice_number: '0044', metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST' } } }), { status: 200 });
    };
    const live = (invoices: InvoiceStore) =>
      createInvoiceHandler({ env: { get: (name) => ({ PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' })[name] }, fetch, store: invoices, resolveUser: async () => USER });
    const big = store({ ...draft(), lines: [{ label: 'Order light fixtures, levels 1 to 3', amount_minor: 10_500_000 }] });
    const response = await live(big)(post({ invoice_id: ID, action: 'send' }));
    expect(response.status).toBe(200);
    const created = seen.find((call) => call.path === '/v2/invoicing/invoices')!;
    expect(created.requestId).toBe(ID);
    expect((created.body as ReturnType<typeof invoiceBody>).configuration.partial_payment.allow_partial_payment).toBe(true);
    expect(seen.find((call) => call.path.endsWith('/send'))!.requestId).toBe(`${ID}-send`);
    expect(big.row).toMatchObject({ status: 'sent', paypal_invoice_id: 'INV2-TEST', paypal_number: '0044', payer_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST' });
  });

  it('does not create a second PayPal invoice when sending is repeated', async () => {
    const invoices = store({ ...draft(), paypal_invoice_id: `MOCK-INV-${ID}` });
    await handler(invoices)(post({ invoice_id: ID, action: 'send' }));
    expect(invoices.updates.some((patch) => 'paypal_invoice_id' in patch)).toBe(false);
    expect(invoices.row!.status).toBe('sent');
  });

  it('refuses someone who may not see costs, a stranger, and a missing invoice', async () => {
    expect((await handler(store(draft(), false))(post({ invoice_id: ID }))).status).toBe(403);
    expect((await handler(store(draft()))(post({ invoice_id: ID }, null))).status).toBe(401);
    expect((await handler(store(null))(post({ invoice_id: ID }))).status).toBe(404);
    expect((await handler(store(draft()))(post({ invoice_id: 'nonsense' }))).status).toBe(400);
  });

  describe('who sent it', () => {
    it('records the person who confirmed, from their own login, with the time', async () => {
      const invoices = store(draft());
      const response = await handler(invoices)(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(200);
      const { invoice } = (await response.json()) as { invoice: InvoiceRecord };
      expect(invoice.sent_by).toBe(USER);
      expect(typeof invoice.sent_at).toBe('string');
      expect(Date.parse(String(invoice.sent_at))).not.toBeNaN();
    });

    it('asks PayPal for nothing when it is already out: who sent it and when stay as recorded', async () => {
      const invoices = store(sentRow());
      const { handle, seen } = livePayPal(invoices, () => new Response(null, { status: 500 }));
      const response = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(200);
      expect(seen).toEqual([]);
      expect(invoices.updates).toEqual([]);
      expect(invoices.row).toMatchObject({ sent_by: OTHER, sent_at: '2026-11-09T05:05:00.000Z', status: 'sent' });
    });

    it('two people confirming at the same moment are one send and one sender: the first recorded stays', async () => {
      const invoices = store(draft());
      const answer = (path: string) => (path.endsWith('/send') ? new Response(JSON.stringify({ href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST' }), { status: 200 }) : path === '/v2/invoicing/invoices' ? new Response(JSON.stringify({ id: 'INV2-TEST' }), { status: 201 }) : onPayPal('UNPAID'));
      const first = livePayPal(invoices, answer, USER);
      const second = livePayPal(invoices, answer, OTHER);
      const replies = await Promise.all([first.handle(post({ invoice_id: ID, action: 'send' })), second.handle(post({ invoice_id: ID, action: 'send' }))]);
      for (const response of replies) expect(response.status).toBe(200);
      expect(invoices.row).toMatchObject({ status: 'sent', sent_by: USER });
      // Whoever came second is told how it stands, with the first person's name on it.
      const bodies = (await Promise.all(replies.map((response) => response.json()))) as { invoice: InvoiceRecord }[];
      expect(bodies.map((body) => body.invoice.sent_by)).toEqual([USER, USER]);
    });

    it('a second try after a lost answer, where PayPal says it is already sent, still records who sent it', async () => {
      const invoices = store({ ...draft(), paypal_invoice_id: 'INV2-TEST' });
      const { handle } = livePayPal(invoices, (path) => (path.endsWith('/send') ? new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'already sent' }), { status: 422 }) : onPayPal('UNPAID')));
      const response = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(200);
      expect(invoices.row).toMatchObject({ status: 'sent', sent_by: USER });
      expect(invoices.row!.sent_at).toEqual(expect.any(String));
    });

    it('does not send an invoice that was canceled', async () => {
      const invoices = store(sentRow({ status: 'cancelled' }));
      const { handle, seen } = livePayPal(invoices, () => new Response(null, { status: 500 }));
      const response = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe('INVOICE_STATE_CONFLICT');
      expect(seen).toEqual([]);
      expect(invoices.row!.status).toBe('cancelled');
    });
  });

  describe('canceling a sent invoice', () => {
    const canceled = () => new Response(null, { status: 204 });

    it('cancels it on PayPal, telling the tenant, and leaves the record canceled', async () => {
      const invoices = store(sentRow());
      const { handle, seen } = livePayPal(invoices, canceled);
      const response = await handle(post({ invoice_id: ID, action: 'cancel' }));
      expect(response.status).toBe(200);
      expect(seen).toEqual([{ path: '/v2/invoicing/invoices/INV2-TEST/cancel', method: 'POST', body: { send_to_recipient: true, send_to_invoicer: false } }]);
      expect(invoices.row).toMatchObject({ status: 'cancelled', sent_by: OTHER });
      expect(((await response.json()) as { invoice: InvoiceRecord }).invoice.status).toBe('cancelled');
    });

    it('asks PayPal nothing when it is canceled already: the second person’s press', async () => {
      const invoices = store(sentRow({ status: 'cancelled' }));
      const { handle, seen } = livePayPal(invoices, () => new Response(null, { status: 500 }));
      expect((await handle(post({ invoice_id: ID, action: 'cancel' }))).status).toBe(200);
      expect(seen).toEqual([]);
      expect(invoices.updates).toEqual([]);
    });

    it('refuses what was never sent, and what has been paid', async () => {
      for (const row of [draft(), { ...draft(), status: 'failed' as const }, sentRow({ status: 'paid' })]) {
        const invoices = store(row);
        const { handle, seen } = livePayPal(invoices, canceled);
        const response = await handle(post({ invoice_id: ID, action: 'cancel' }));
        expect(response.status).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe('INVOICE_STATE_CONFLICT');
        expect(seen).toEqual([]);
        expect(invoices.row!.status).toBe(row.status);
      }
    });

    it('says why when PayPal refuses, and the invoice stays sent', async () => {
      const invoices = store(sentRow());
      const { handle } = livePayPal(invoices, (path) => (path.endsWith('/cancel') ? new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', details: [{ issue: 'CANNOT_CANCEL', description: 'Partially paid invoices cannot be canceled.' }] }), { status: 422 }) : onPayPal('PARTIALLY_PAID')));
      const response = await handle(post({ invoice_id: ID, action: 'cancel' }));
      expect(response.status).toBe(502);
      expect(((await response.json()) as { error: string }).error).toContain('PayPal could not cancel the invoice');
      expect(invoices.row!.status).toBe('sent');
    });

    it('settles to canceled when PayPal refuses because it is canceled already', async () => {
      const invoices = store(sentRow());
      const { handle } = livePayPal(invoices, (path) => (path.endsWith('/cancel') ? new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'already cancelled' }), { status: 422 }) : onPayPal('CANCELLED')));
      expect((await handle(post({ invoice_id: ID, action: 'cancel' }))).status).toBe(200);
      expect(invoices.row!.status).toBe('cancelled');
    });

    it('in mock mode too, and a later refresh leaves it canceled (the mock remembers nothing)', async () => {
      const invoices = store(sentRow({ paypal_invoice_id: `MOCK-INV-${ID}` }));
      expect((await handler(invoices)(post({ invoice_id: ID, action: 'cancel' }))).status).toBe(200);
      expect(invoices.row!.status).toBe('cancelled');
      expect((await handler(invoices)(post({ invoice_id: ID, action: 'refresh' }))).status).toBe(200);
      expect(invoices.row!.status).toBe('cancelled');
    });

    it('is only for someone who sees costs', async () => {
      const invoices = store(sentRow(), false);
      expect((await handler(invoices)(post({ invoice_id: ID, action: 'cancel' }))).status).toBe(403);
      expect(invoices.row!.status).toBe('sent');
    });
  });

  describe('on the hosted demo', () => {
    const TENANT = 'tenant-sandbox@business.example.com';
    const env = (extra: Record<string, string | undefined>) => ({ get: (name: string) => extra[name] });
    /** The site's switch and caps: on, and room for `room` more invoices; every use is kept in `used`. */
    const limits = (on = true, room = 5) => {
      const used: { kind: string; projectId: string }[] = [];
      const fake: PaymentLimits & { used: typeof used } = {
        used,
        paymentsOn: async () => on,
        use: async (kind, projectId) => {
          if (used.length >= room) return false;
          used.push({ kind, projectId });
          return true;
        },
      };
      return fake;
    };
    /** Live mode against a scripted PayPal that creates and sends; the hosted settings on top. */
    const hosted = (invoices: InvoiceStore, extra: Record<string, string | undefined>, caps: PaymentLimits = limits()) => {
      const seen: { path: string; body: unknown }[] = [];
      const fetch = async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
        seen.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
        if (path === '/v2/invoicing/invoices') return new Response(JSON.stringify({ id: 'INV2-TEST' }), { status: 201 });
        if (path.endsWith('/send')) return new Response(JSON.stringify({ href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST' }), { status: 200 });
        return onPayPal('UNPAID');
      };
      const settings = { PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', ...extra };
      return { seen, handle: createInvoiceHandler({ env: env(settings), fetch, store: invoices, resolveUser: async () => USER, accounts: sandboxAccounts(settings), limits: caps }) };
    };
    const billed = (seen: { path: string; body: unknown }[]) =>
      (seen.find((call) => call.path === '/v2/invoicing/invoices')?.body as ReturnType<typeof invoiceBody> | undefined)?.primary_recipients[0]!.billing_info.email_address;

    it('bills the tenant’s sandbox account whatever the invoice says, and only when GANTRY_HOSTED is 1', () => {
      const row = { client_email: 'anyone@example.com' };
      expect(invoiceRecipient(row, env({ GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: ` ${TENANT} ` }))).toBe(TENANT);
      expect(invoiceRecipient(row, env({ PAYPAL_SANDBOX_TENANT_EMAIL: TENANT }))).toBe('anyone@example.com');
      expect(invoiceRecipient(row, env({ GANTRY_HOSTED: 'true', PAYPAL_SANDBOX_TENANT_EMAIL: TENANT }))).toBe('anyone@example.com');
      expect(invoiceBody(draft(), null, TENANT).primary_recipients[0]!.billing_info).toMatchObject({ email_address: TENANT, business_name: 'Harbor Street Properties' });
    });

    it('refuses to bill anyone when hosted without a tenant address', () => {
      for (const tenant of [undefined, '', 'not an address']) {
        expect(() => invoiceRecipient({ client_email: 'anyone@example.com' }, env({ GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: tenant }))).toThrow(ConfigError);
      }
    });

    it('sends the invoice to the tenant’s sandbox account, and the row records who was billed', async () => {
      const invoices = store({ ...draft(), client_email: 'someone-else@example.com' });
      const { handle, seen } = hosted(invoices, { GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: TENANT });
      const response = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(200);
      expect(billed(seen)).toBe(TENANT);
      expect(invoices.row).toMatchObject({ client_email: TENANT, status: 'sent', paypal_invoice_id: 'INV2-TEST' });
    });

    it('asks PayPal nothing when hosted without a tenant address', async () => {
      const invoices = store(draft());
      const { handle, seen } = hosted(invoices, { GANTRY_HOSTED: '1' });
      const response = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe('PAYPAL_NOT_CONFIGURED');
      expect(seen).toEqual([]);
      expect(invoices.updates).toEqual([]);
    });

    it('names whom it bills for the review window, before anything is sent', async () => {
      const { handle, seen } = hosted(store(null), { GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: ` ${TENANT} ` });
      const response = await handle(post({ project_id: PROJECT, action: 'seller' }));
      expect(await response.json()).toEqual({ seller: null, bill_to: TENANT });
      expect(seen).toEqual([]);
      expect(await (await hosted(store(null), { GANTRY_HOSTED: '1' }).handle(post({ project_id: PROJECT, action: 'seller' }))).json()).toEqual({ seller: null, bill_to: null });
    });

    it('bills the project’s client, as recorded, anywhere else', async () => {
      const invoices = store(draft());
      const { handle, seen } = hosted(invoices, { PAYPAL_SANDBOX_TENANT_EMAIL: TENANT });
      expect((await handle(post({ invoice_id: ID, action: 'send' }))).status).toBe(200);
      expect(billed(seen)).toBe('client@example.com');
      expect(invoices.updates.some((patch) => 'client_email' in patch)).toBe(false);
    });

    it('sends nothing while the site has payments switched off', async () => {
      const invoices = store(draft());
      const { handle, seen } = hosted(invoices, { GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: TENANT }, limits(false));
      const response = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe('PAYMENTS_OFF');
      expect(seen).toEqual([]);
      expect(invoices.row!.status).toBe('draft');
    });

    it('counts an invoice made at PayPal against the copy, and makes none once the cap is reached', async () => {
      const caps = limits(true, 1);
      const first = store(draft());
      expect((await hosted(first, { GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: TENANT }, caps).handle(post({ invoice_id: ID, action: 'send' }))).status).toBe(200);
      expect(caps.used).toEqual([{ kind: 'invoice', projectId: PROJECT }]);
      const second = store(draft());
      const { handle, seen } = hosted(second, { GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: TENANT }, caps);
      const refused = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { code: string }).code).toBe('QUOTA_REACHED');
      expect(seen).toEqual([]);
      expect(second.row!.status).toBe('draft');
    });

    it('does not count sending again an invoice PayPal already has', async () => {
      const caps = limits(true, 0);
      const invoices = store({ ...draft(), status: 'failed', paypal_invoice_id: 'INV2-TEST' });
      const response = await hosted(invoices, { GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: TENANT }, caps).handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(200);
      expect(caps.used).toEqual([]);
    });

    it('refuses to bill a tenant account that is a crew’s too, and asks PayPal nothing', async () => {
      const invoices = store(draft());
      const { handle, seen } = hosted(invoices, { GANTRY_HOSTED: '1', PAYPAL_SANDBOX_TENANT_EMAIL: TENANT, PAYPAL_SANDBOX_GRANITE_EMAIL: TENANT.toUpperCase() });
      const response = await handle(post({ invoice_id: ID, action: 'send' }));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe('PAYEE_REFUSED');
      expect(seen).toEqual([]);
    });
  });

  describe('whose invoice it is, for the review window', () => {
    const asked = (project: unknown) => post({ project_id: project, action: 'seller' });

    it('names the business PayPal will put on it, and asks PayPal nothing', async () => {
      const { handle, seen } = livePayPal(store(null), () => new Response(null, { status: 500 }), USER, ' Aldermere Construction ');
      const response = await handle(asked(PROJECT));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ seller: 'Aldermere Construction', bill_to: null });
      expect(seen).toEqual([]);
    });

    it('says nothing when PayPal uses the account’s own name', async () => {
      const response = await livePayPal(store(null), () => new Response(null, { status: 500 })).handle(asked(PROJECT));
      expect(await response.json()).toEqual({ seller: null, bill_to: null });
    });

    it('needs a real project, and someone who sees costs on it', async () => {
      expect((await handler(store(null))(asked('nonsense'))).status).toBe(400);
      expect((await handler(store(null), USER)(post({ project_id: PROJECT, action: 'seller' }, null))).status).toBe(401);
      expect((await handler(store(null, false))(asked(PROJECT))).status).toBe(403);
    });
  });
});

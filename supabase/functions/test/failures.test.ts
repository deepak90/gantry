/**
 * What a browser is told when something fails: a plain sentence, a request id for a 500, and never the database's,
 * the settings' or the files' own names; the detail goes to the log under the same id.
 */
import { describe, expect, it } from 'vitest';
import { sandboxAccounts } from '../_shared/accounts.ts';
import { ConfigError } from '../_shared/config.ts';
import { internalError, publicError, setupError } from '../_shared/failures.ts';
import { HttpError } from '../_shared/http.ts';
import { createInvoiceHandler, type InvoiceRecord } from '../_shared/invoices.ts';
import { PayPalAuthError } from '../_shared/paypal.ts';
import { createProgressPayoutHandler } from '../_shared/progress-payouts.ts';
import { AUTH_ID, envOf, FakePayPal, FakeStore, jsonResponse, LIVE_ENV, payoutHandler, payoutRequest, PROJECT } from './fakes.ts';

/** Names a browser must never read: files, settings, tables, RPCs, SQL. */
const INTERNAL = /\.env|functions:serve|PAYPAL_CLIENT|PAYPAL_SANDBOX|SUPABASE_|public\.|payment_authorizations|project_members|invoices|claim_pay_gate_payout|rate_gate|relation|schema cache|kong|rest\/v1/;

type Logged = { message: string; error?: unknown }[];
const logger = (logged: Logged) => (message: string, error?: unknown) => void logged.push({ message, error });

describe('the pieces', () => {
  it('a 500 is one plain sentence and a short id, and the log has the failure under that id', () => {
    const logged: Logged = [];
    const failure = internalError(new Error('relation "public.invoices" does not exist'), logger(logged));
    expect(failure).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(failure.requestId).toMatch(/^[0-9a-f]{12}$/);
    expect(failure.message).toContain(failure.requestId!);
    expect(failure.message).not.toMatch(INTERNAL);
    expect(logged).toEqual([{ message: `unexpected failure, request id ${failure.requestId}`, error: expect.any(Error) }]);
  });

  it('two failures get two ids', () => {
    expect(internalError(new Error('a'), undefined).requestId).not.toBe(internalError(new Error('b'), undefined).requestId);
  });

  it('on the hosted site a setup problem is plain, and its own message goes to the log', () => {
    const logged: Logged = [];
    const hosted = envOf({ GANTRY_HOSTED: '1' });
    const config = setupError(new ConfigError('PayPal is not configured: set them in .env.local and restart `pnpm functions:serve`'), hosted, logger(logged));
    expect(config).toMatchObject({ status: 503, code: 'PAYPAL_NOT_CONFIGURED', message: 'Payments with PayPal aren’t set up on this site right now. Nothing was sent.' });
    const auth = setupError(new PayPalAuthError('PAYPAL_AUTH_FAILED', 'Put the Sandbox PAYPAL_CLIENT_ID … in .env.local'), hosted, logger(logged));
    expect(auth.message).not.toMatch(INTERNAL);
    expect(auth.requestId).toMatch(/^[0-9a-f]{12}$/);
    expect(logged.map((line) => line.message).join('\n')).toContain('.env.local');
  });

  it('on this machine a setup problem keeps its message, which tells the developer what to fix', () => {
    const local = setupError(new ConfigError('Set them in .env.local and restart `pnpm functions:serve`.'), envOf({}), undefined);
    expect(local.message).toContain('.env.local');
    expect(local.requestId).toBeNull();
  });

  it('a refusal stays as it is', () => {
    const refusal = new HttpError(409, 'PAYEE_REFUSED', 'That account is someone else’s.');
    expect(publicError(refusal, envOf({ GANTRY_HOSTED: '1' }), undefined)).toBe(refusal);
  });
});

describe('the functions on the hosted site', () => {
  const HOSTED_LIVE = { ...LIVE_ENV, GANTRY_HOSTED: '1' };

  it('paypal-execute-payout: missing credentials say nothing of .env.local', async () => {
    const store = new FakeStore();
    store.add();
    const handle = payoutHandler('execute', store, new FakePayPal(), { PAYPAL_MODE: 'live', GANTRY_HOSTED: '1' });
    const response = await handle(payoutRequest({ authorization_id: AUTH_ID }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'PAYPAL_NOT_CONFIGURED', request_id: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(INTERNAL);
  });

  it('paypal-execute-payout: PayPal refusing the credentials says nothing of the settings', async () => {
    const store = new FakeStore();
    store.add();
    const paypal = new FakePayPal();
    paypal.token = () => jsonResponse(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    const response = await payoutHandler('execute', store, paypal, HOSTED_LIVE)(payoutRequest({ authorization_id: AUTH_ID }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(INTERNAL);
  });

  it('paypal-invoice: a database failure is a 500 with a request id, its message in the log only', async () => {
    const logged: Logged = [];
    const row: InvoiceRecord = { id: '00000000-0000-4000-8000-0000000009a1', project_id: PROJECT, title: 'T', client_name: 'C', client_email: 'c@example.com', lines: [], currency: 'USD', status: 'draft', paypal_invoice_id: null };
    const handle = createInvoiceHandler({
      env: envOf({ PAYPAL_MODE: 'mock', GANTRY_HOSTED: '1' }),
      fetch: () => Promise.reject(new Error('never')),
      store: {
        read: async () => Promise.reject(new Error('permission denied for table invoices')),
        update: async () => row,
        markSent: async () => row,
        canBill: async () => true,
      },
      resolveUser: async () => '00000000-0000-4000-8000-000000000012',
      log: logger(logged),
    });
    const response = await handle(new Request('http://local/x', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify({ invoice_id: row.id, action: 'refresh' }) }));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; code: string; request_id: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toMatch(INTERNAL);
    expect(logged[0]!.message).toContain(body.request_id);
    expect(String(logged[0]!.error)).toContain('permission denied for table invoices');
  });

  describe('paypal-progress-payout', () => {
    const GRANITE = 'granite@personal.example.com';
    const env = { ...HOSTED_LIVE, PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE };
    const payment = {
      batchId: 'PG-25-abc123',
      currency: 'USD',
      items: [{ itemId: 'PG-25-abc123-1', firm: 'Granite Ridge Concrete', amountMinor: 100_000, note: 'Footings' }],
      projectId: PROJECT,
      gateId: 25,
      approvalId: null,
    };
    const handler = (claimFetch: (url: string, init: RequestInit) => Promise<Response>, logged: Logged, limits = true) =>
      createProgressPayoutHandler({
        env: envOf(env),
        accounts: sandboxAccounts(env),
        fetch: async (url) => (new URL(url).pathname === '/v1/oauth2/token' ? jsonResponse(200, { access_token: 'T', expires_in: 32400 }) : jsonResponse(201, { batch_header: { payout_batch_id: 'B', batch_status: 'PENDING' } })),
        resolveUser: async () => '00000000-0000-4000-8000-000000000012',
        seesCosts: async () => true,
        claimTarget: { supabaseUrl: 'http://kong:8000', anonKey: 'anon', fetch: claimFetch },
        ...(limits ? { limits: { paymentsOn: async () => true, use: async () => Promise.reject(new Error('use_payment_quota: relation "public.quota_usage" does not exist')) } } : {}),
        batches: { record: async () => undefined, has: async () => true },
        log: logger(logged),
        timeoutMs: 1_000,
      });
    const post = () => new Request('http://local/x', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(payment) });

    it('an unplanned failure is a 500 with a request id, nothing of the database in it', async () => {
      const logged: Logged = [];
      const response = await handler(async () => jsonResponse(200, { needed: false }), logged)(post());
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'INTERNAL_ERROR', request_id: expect.stringMatching(/^[0-9a-f]{12}$/) });
      expect(JSON.stringify(body)).not.toMatch(INTERNAL);
      expect(String(logged[0]!.error)).toContain('use_payment_quota');
    });

    it('a claim that can’t reach the database says so plainly, without the address or RPC it called', async () => {
      const logged: Logged = [];
      const response = await handler(() => Promise.reject(new TypeError('error sending request for url (http://kong:8000/rest/v1/rpc/claim_pay_gate_payout)')), logged)(post());
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ refused: true, code: 'PAYOUT_REFUSED', request_id: expect.any(String) });
      expect(String(body.error)).toContain('nothing was sent');
      expect(JSON.stringify(body)).not.toMatch(INTERNAL);
      expect(String(logged[0]!.error)).toContain('claim_pay_gate_payout');
    });

    it('a missing Supabase address is a plain 500 too', async () => {
      const handle = createProgressPayoutHandler({
        env: envOf(env),
        accounts: sandboxAccounts(env),
        fetch: async () => jsonResponse(200, { access_token: 'T', expires_in: 32400 }),
        resolveUser: async () => '00000000-0000-4000-8000-000000000012',
        seesCosts: async () => true,
        claimTarget: { supabaseUrl: '', anonKey: '', fetch: () => Promise.reject(new Error('never')) },
        limits: { paymentsOn: async () => true, use: async () => true },
        batches: { record: async () => undefined, has: async () => true },
      });
      const response = await handle(post());
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.request_id).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(body)).not.toMatch(/Supabase URL|key/);
    });
  });
});

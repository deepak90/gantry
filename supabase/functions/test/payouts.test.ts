import { describe, expect, it } from 'vitest';
import { sandboxAccounts } from '../_shared/accounts.ts';
import { createPayoutHandler } from '../_shared/handlers.ts';
import type { PaymentLimits } from '../_shared/hosted.ts';
import { StoreError } from '../_shared/store.ts';
import {
  AUTH_ID,
  batchBody,
  FakePayPal,
  FakeStore,
  hangingResponse,
  jsonResponse,
  LIVE_ENV,
  payoutHandler,
  payoutRequest,
  PROJECT,
  readJson,
  SANDBOX_BATCH_EXISTS,
  TOKENS,
} from './fakes.ts';

const body = { authorization_id: AUTH_ID };

function setup(overrides: Parameters<FakeStore['add']>[0] = {}) {
  const store = new FakeStore();
  store.add(overrides);
  const paypal = new FakePayPal();
  return { store, paypal, execute: payoutHandler('execute', store, paypal), reconcile: payoutHandler('reconcile', store, paypal) };
}

describe('paypal-execute-payout: sending', () => {
  it('sends one payout whose ids are the authorization id, then records the item status and fee', async () => {
    const { store, paypal, execute } = setup();
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(200);
    const result = await readJson(response);
    expect(result).toMatchObject({
      action: 'submit',
      mode: 'live',
      notice: null,
      authorization: { id: AUTH_ID, status: 'succeeded', paypal_batch_id: 'BATCH-1', paypal_item_id: 'ITEM-1', fee_minor: 25, attempts: 1 },
    });
    expect(paypal.paths()).toEqual(['POST /v1/oauth2/token', 'POST /v1/payments/payouts', 'GET /v1/payments/payouts/BATCH-1']);

    const [post] = paypal.posts();
    expect(post?.headers.get('paypal-request-id')).toBe(AUTH_ID);
    expect(post?.headers.get('authorization')).toBe('Bearer TOKEN-1');
    expect(JSON.parse(post?.body ?? 'null')).toEqual({
      sender_batch_header: {
        sender_batch_id: AUTH_ID,
        email_subject: expect.any(String),
        email_message: expect.any(String),
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: '1200.00', currency: 'USD' },
          receiver: 'supplier@test.local',
          note: expect.stringContaining(AUTH_ID),
          sender_item_id: AUTH_ID,
        },
      ],
    });
    expect(store.calls).toEqual(['begin', 'record:pending', 'record:succeeded']);
  });

  it('signs in with the app credentials as HTTP Basic', async () => {
    const { paypal, execute } = setup();
    await execute(payoutRequest(body));
    const [token] = paypal.calls;
    expect(token?.headers.get('authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`);
    expect(token?.body).toBe('grant_type=client_credentials');
  });

  it('a double click sends exactly one POST: the second click waits', async () => {
    const { store, paypal, execute } = setup();
    const [first, second] = await Promise.all([execute(payoutRequest(body)), execute(payoutRequest(body))]);
    const actions = [(await readJson(first!)).action, (await readJson(second!)).action].sort();
    expect(actions).toEqual(['submit', 'wait']);
    expect(paypal.posts()).toHaveLength(1);
    expect(store.row().attempts).toBe(1);
  });

  it('a click after success sends nothing', async () => {
    const { paypal, execute } = setup();
    await execute(payoutRequest(body));
    const again = await readJson(await execute(payoutRequest(body)));
    expect(again).toMatchObject({ action: 'none', authorization: { status: 'succeeded' } });
    expect(paypal.posts()).toHaveLength(1);
  });

  it('records pending (and keeps the batch id) while PayPal still processes the item', async () => {
    const { store, paypal, execute } = setup();
    paypal.batch = () => jsonResponse(200, batchBody({ transactionStatus: 'PENDING' }));
    const result = await readJson(await execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'pending', paypal_batch_id: 'BATCH-1', fee_minor: 25 });

    paypal.batch = () => jsonResponse(200, batchBody({ transactionStatus: 'SUCCESS' }));
    const later = await readJson(await execute(payoutRequest(body)));
    expect(later).toMatchObject({ action: 'check', authorization: { status: 'succeeded' } });
    expect(paypal.posts()).toHaveLength(1);
    expect(store.row().attempts).toBe(1);
  });

  it('stays pending with the batch id when the immediate status read fails', async () => {
    const { paypal, execute } = setup();
    paypal.batch = () => jsonResponse(503, { name: 'SERVICE_UNAVAILABLE' });
    const result = await readJson(await execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'pending', paypal_batch_id: 'BATCH-1' });
    expect(result.notice).toContain('Could not read PayPal batch BATCH-1');
  });
});

describe('paypal-execute-payout: PayPal rejections and silence', () => {
  it('a 4xx fails the payout with PayPal name: message and the detail issues', async () => {
    const { paypal, execute } = setup();
    paypal.create = () =>
      jsonResponse(422, {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        details: [{ issue: 'INSUFFICIENT_FUNDS', description: 'Sender does not have sufficient funds.' }],
      });
    const result = await readJson(await execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({
      status: 'failed',
      message:
        'UNPROCESSABLE_ENTITY: The requested action could not be performed. (INSUFFICIENT_FUNDS: Sender does not have sufficient funds.)',
    });
    expect(paypal.paths()).toEqual(['POST /v1/oauth2/token', 'POST /v1/payments/payouts']);
  });

  it.each([
    ['409', 409, { name: 'CONFLICT', message: 'Request is still being processed' }],
    ['DUPLICATE name', 400, { name: 'DUPLICATE_REQUEST_ID', message: 'Duplicate request' }],
    ['ALREADY_USED issue', 400, { name: 'USER_BUSINESS_ERROR', details: [{ issue: 'SENDER_BATCH_ID_ALREADY_USED' }] }],
  ])('a rejection meaning "may already exist" (%s) is unknown, never failed', async (_, status, reply) => {
    const s = setup();
    s.paypal.create = () => jsonResponse(status, reply);
    const result = await readJson(await s.execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'unknown' });
    expect(String((result.authorization as { message: string }).message)).toContain('already submitted');
  });

  it('a resend refused because the batch already exists recovers that batch and records its real outcome', async () => {
    // What the live sandbox does when a payout whose first answer was lost is sent again.
    const s = setup({ status: 'unknown', submitted_at: '2026-01-01T00:00:00.000Z', attempts: 1, message: 'PayPal did not answer' });
    s.paypal.create = () => jsonResponse(400, SANDBOX_BATCH_EXISTS);
    s.paypal.batch = () => jsonResponse(200, batchBody({ batchId: 'XNK4D4A55AQ5G' }));
    const result = await readJson(await s.reconcile(payoutRequest(body)));
    expect(result.authorization).toMatchObject({
      status: 'succeeded',
      paypal_batch_id: 'XNK4D4A55AQ5G',
      paypal_item_id: 'ITEM-1',
      fee_minor: 25,
      message: null,
      attempts: 2,
    });
    expect(s.paypal.paths()).toEqual(['POST /v1/oauth2/token', 'POST /v1/payments/payouts', 'GET /v1/payments/payouts/XNK4D4A55AQ5G']);
    expect(s.store.calls).toEqual(['resume', 'record:pending', 'record:succeeded']);
  });

  it('an "already exists" rejection without a batch link stays unknown', async () => {
    const s = setup();
    const { link: _link, ...detail } = SANDBOX_BATCH_EXISTS.details[0]!;
    s.paypal.create = () => jsonResponse(400, { ...SANDBOX_BATCH_EXISTS, details: [detail] });
    const result = await readJson(await s.execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'unknown' });
    expect(String((result.authorization as { message: string }).message)).toContain('already submitted');
  });

  it.each([500, 502, 503, 401, 429])('HTTP %d is unknown', async (status) => {
    const s = setup();
    s.paypal.create = () => jsonResponse(status, { name: 'INTERNAL_SERVICE_ERROR', message: 'An internal service error occurred.' });
    const result = await readJson(await s.execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'unknown' });
    expect(String((result.authorization as { message: string }).message)).toContain(`HTTP ${status}`);
  });

  it('a network failure is unknown', async () => {
    const s = setup();
    s.paypal.create = () => Promise.reject(new TypeError('connection reset'));
    const result = await readJson(await s.execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'unknown' });
    expect(String((result.authorization as { message: string }).message)).toContain('connection reset');
  });

  it('a timeout aborts the request and is unknown', async () => {
    const store = new FakeStore();
    store.add();
    const paypal = new FakePayPal();
    paypal.create = hangingResponse;
    const execute = payoutHandler('execute', store, paypal, LIVE_ENV, 20);
    const result = await readJson(await execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'unknown' });
    expect(String((result.authorization as { message: string }).message)).toContain('no answer within');
    expect(paypal.posts()[0]?.signal?.aborted).toBe(true);
  });

  it('a timeout holds even when fetch ignores the abort signal', async () => {
    const store = new FakeStore();
    store.add();
    const paypal = new FakePayPal();
    paypal.create = () => new Promise<Response>(() => {});
    const execute = payoutHandler('execute', store, paypal, LIVE_ENV, 20);
    const result = await readJson(await execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'unknown' });
  });

  it('a retry after an unknown outcome re-sends the same request (same PayPal-Request-Id and sender_batch_id)', async () => {
    const { store, paypal, execute } = setup();
    paypal.create = () => jsonResponse(503, { name: 'SERVICE_UNAVAILABLE' });
    await execute(payoutRequest(body));
    expect(store.row().status).toBe('unknown');

    const tooSoon = await readJson(await execute(payoutRequest(body)));
    expect(tooSoon.action).toBe('wait');
    expect(paypal.posts()).toHaveLength(1);

    store.clock += 21_000;
    paypal.create = () => jsonResponse(201, { batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } });
    const retry = await readJson(await execute(payoutRequest(body)));
    expect(retry).toMatchObject({ action: 'submit', authorization: { status: 'succeeded', attempts: 2 } });

    const posts = paypal.posts();
    expect(posts).toHaveLength(2);
    expect(posts.map((post) => post.headers.get('paypal-request-id'))).toEqual([AUTH_ID, AUTH_ID]);
    expect(posts.map((post) => JSON.parse(post.body ?? 'null').sender_batch_header.sender_batch_id)).toEqual([AUTH_ID, AUTH_ID]);
    expect(posts[0]?.body).toBe(posts[1]?.body);
  });

  it('a payout accepted without a batch id is unknown', async () => {
    const s = setup();
    s.paypal.create = () => jsonResponse(201, { links: [] });
    const result = await readJson(await s.execute(payoutRequest(body)));
    expect(result.authorization).toMatchObject({ status: 'unknown', paypal_batch_id: null });
  });
});

describe('paypal-execute-payout: configuration and sign-in', () => {
  it('live mode without credentials is a 503 that names the fix, before any PayPal or database call', async () => {
    const store = new FakeStore();
    store.add();
    const paypal = new FakePayPal();
    const execute = payoutHandler('execute', store, paypal, { PAYPAL_MODE: 'live', PAYPAL_CLIENT_SECRET: 'x' });
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(503);
    const result = await readJson(response);
    expect(result.code).toBe('PAYPAL_NOT_CONFIGURED');
    expect(result.error).toContain('PAYPAL_CLIENT_ID');
    expect(result.error).toContain('.env.local');
    expect(result.error).toContain('pnpm functions:serve');
    expect(result.error).toContain('PAYPAL_MODE=mock');
    expect(paypal.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it.each<Record<string, string>>([{ PAYPAL_ENV: 'live' }, { PAYPAL_ENV: 'production' }, { PAYPAL_MODE: 'sandbox' }])(
    'refuses %j',
    async (override) => {
      const store = new FakeStore();
      store.add();
      const execute = payoutHandler('execute', store, new FakePayPal(), { ...LIVE_ENV, ...override });
      const response = await execute(payoutRequest(body));
      expect(response.status).toBe(503);
      expect((await readJson(response)).code).toBe('PAYPAL_NOT_CONFIGURED');
      expect(store.calls).toHaveLength(0);
    },
  );

  it('rejected credentials are a 503 and payout_begin is never called', async () => {
    const { store, paypal, execute } = setup();
    paypal.token = () => jsonResponse(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(503);
    const result = await readJson(response);
    expect(result.code).toBe('PAYPAL_AUTH_FAILED');
    expect(result.error).toContain('invalid_client: Client Authentication failed');
    expect(store.calls).toHaveLength(0);
    expect(store.row()).toMatchObject({ status: 'authorized', attempts: 0, submitted_at: null });
  });

  it('an unreachable PayPal at sign-in is a 503 and leaves the row untouched', async () => {
    const { store, paypal, execute } = setup();
    paypal.token = () => Promise.reject(new TypeError('dns error'));
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe('PAYPAL_UNAVAILABLE');
    expect(store.calls).toHaveLength(0);
  });
});

describe('paypal-execute-payout: HTTP contract', () => {
  it('answers the CORS preflight of the site', async () => {
    const { execute } = setup();
    const response = await execute(new Request('http://localhost/x', { method: 'OPTIONS', headers: { Origin: 'https://gantry-pearl.vercel.app' } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://gantry-pearl.vercel.app');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(response.headers.get('access-control-allow-headers')).toContain('apikey');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('puts CORS headers on errors too', async () => {
    const { execute } = setup();
    const request = payoutRequest({});
    request.headers.set('Origin', 'https://gantry-pearl.vercel.app');
    const response = await execute(request);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://gantry-pearl.vercel.app');
  });

  it.each([
    ['not JSON', '{'],
    ['no id', {}],
    ['not a uuid', { authorization_id: 'abc' }],
    ['a number', { authorization_id: 7 }],
  ])('400 for a body that is %s', async (_, requestBody) => {
    const { store, execute } = setup();
    const response = await execute(payoutRequest(requestBody));
    expect(response.status).toBe(400);
    expect((await readJson(response)).code).toBe('INVALID_REQUEST');
    expect(store.calls).toHaveLength(0);
  });

  it('405 for GET', async () => {
    const { execute } = setup();
    const response = await execute(new Request('http://localhost/x'));
    expect(response.status).toBe(405);
    expect((await readJson(response)).code).toBe('METHOD_NOT_ALLOWED');
  });

  it('401 without a valid session, before PayPal or the database', async () => {
    for (const token of [null, 'expired-token']) {
      const { store, paypal, execute } = setup();
      const response = await execute(payoutRequest(body, token));
      expect(response.status).toBe(401);
      expect((await readJson(response)).code).toBe('UNAUTHORIZED');
      expect(paypal.calls).toHaveLength(0);
      expect(store.calls).toHaveLength(0);
    }
  });

  it('403 for anyone but the cost manager, before PayPal is signed in to or the payout claimed', async () => {
    const { store, paypal, execute } = setup();
    const response = await execute(payoutRequest(body, 'pm-token'));
    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({ error: 'Only the project’s cost manager can send this payout.', code: 'FORBIDDEN' });
    expect(paypal.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it('403 in plain words when payout_begin refuses after the check (SQLSTATE 42501)', async () => {
    const { store, execute } = setup();
    store.begin = () => Promise.reject(new StoreError('payout_begin: only the cost manager of the project sends payouts', '42501'));
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({ error: 'Only the project’s cost manager can send this payout.', code: 'FORBIDDEN' });
  });

  it('404 for an unknown authorization, before PayPal is signed in to', async () => {
    const { store, paypal, execute } = setup();
    const response = await execute(payoutRequest({ authorization_id: '00000000-0000-4000-8000-00000000dead' }));
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: 'There’s no such payment in your projects.', code: 'NOT_FOUND' });
    expect(paypal.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it('500 for any other database failure: a plain sentence and a request id, the detail only in the log', async () => {
    const store = new FakeStore();
    store.add();
    const paypal = new FakePayPal();
    const logged: { message: string; error: unknown }[] = [];
    const execute = createPayoutHandler({
      kind: 'execute',
      env: { get: (name: string) => LIVE_ENV[name] },
      fetch: paypal.fetch,
      store,
      receipts: store.receipts,
      timeoutMs: 1_000,
      log: (message, error) => logged.push({ message, error }),
      resolveUser: async (token) => TOKENS[token] ?? null,
      access: (id, actor, kind) => store.access(id, actor, kind),
    });
    store.record = () => Promise.reject(new Error('payout_record: relation "public.payment_authorizations" is locked'));
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(500);
    const result = await readJson(response);
    expect(result).toEqual({ error: expect.stringContaining('Something went wrong on our side'), code: 'INTERNAL_ERROR', request_id: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(JSON.stringify(result)).not.toMatch(/payout_record|payment_authorizations|relation/);
    expect(result.error).toContain(String(result.request_id));
    expect(logged).toEqual([{ message: `unexpected failure, request id ${String(result.request_id)}`, error: expect.objectContaining({ message: expect.stringContaining('payout_record') }) }]);
  });
});

describe('paypal-reconcile', () => {
  it('never starts an authorized payout', async () => {
    const { store, paypal, reconcile } = setup();
    for (const token of ['pm-token', 'cm-token']) {
      const result = await readJson(await reconcile(payoutRequest(body, token)));
      expect(result).toMatchObject({ action: 'none', authorization: { status: 'authorized' } });
    }
    expect(paypal.posts()).toHaveLength(0);
    expect(store.calls).toEqual(['resume', 'resume']);
  });

  it('lets any member check a sent payout', async () => {
    const { paypal, reconcile } = setup({ status: 'pending', paypal_batch_id: 'BATCH-1', attempts: 1, submitted_at: '2026-11-02T08:00:00Z' });
    const result = await readJson(await reconcile(payoutRequest(body, 'pm-token')));
    expect(result).toMatchObject({ action: 'check', authorization: { status: 'succeeded', fee_minor: 25, paypal_item_id: 'ITEM-1' } });
    expect(paypal.paths()).toEqual(['POST /v1/oauth2/token', 'GET /v1/payments/payouts/BATCH-1']);
  });

  it('re-sends a stalled attempt with the same ids', async () => {
    const { paypal, reconcile } = setup({ status: 'unknown', attempts: 1, submitted_at: '2026-11-02T08:59:00Z' });
    const result = await readJson(await reconcile(payoutRequest(body, 'pm-token')));
    expect(result).toMatchObject({ action: 'submit', authorization: { status: 'succeeded', attempts: 2 } });
    expect(paypal.posts()[0]?.headers.get('paypal-request-id')).toBe(AUTH_ID);
  });

  it('404 for a non-member, the same as for a payment that doesn’t exist, before PayPal is signed in to', async () => {
    const { store, paypal, reconcile } = setup();
    const response = await reconcile(payoutRequest(body, 'outsider-token'));
    expect(response.status).toBe(404);
    expect((await readJson(response)).code).toBe('NOT_FOUND');
    expect(paypal.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it('a failed check leaves the row and says why', async () => {
    const { store, paypal, reconcile } = setup({ status: 'pending', paypal_batch_id: 'BATCH-1', attempts: 1 });
    paypal.batch = () => Promise.reject(new TypeError('socket hang up'));
    const result = await readJson(await reconcile(payoutRequest(body, 'pm-token')));
    expect(result).toMatchObject({ action: 'check', authorization: { status: 'pending' } });
    expect(result.notice).toContain('socket hang up');
    expect(store.calls).toEqual(['resume']);
  });
});

describe('paypal-execute-payout: whose account, and the hosted site’s limits', () => {
  const GRANITE = 'granite@personal.example.com';
  const ACCOUNTS = { ...LIVE_ENV, PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE, PAYPAL_SANDBOX_PAYEE_EMAIL: GRANITE };

  /** execute with the demo's accounts, the rental's payee and (hosted) the site's switch and caps. */
  function guarded(options: { env?: Record<string, string>; recipient?: string; on?: boolean; room?: number } = {}) {
    const env: Record<string, string> = options.env ?? ACCOUNTS;
    const store = new FakeStore();
    store.add({ recipient_email: options.recipient ?? 'northgate@personal.example.com' });
    const paypal = new FakePayPal();
    const uses: { kind: string; projectId: string; amountMinor: number | null }[] = [];
    const limits: PaymentLimits = {
      paymentsOn: async () => options.on ?? true,
      use: async (kind, projectId, amountMinor) => {
        if (uses.length >= (options.room ?? 5)) return false;
        uses.push({ kind, projectId, amountMinor });
        return true;
      },
    };
    const deps = {
      env: { get: (name: string) => env[name] },
      fetch: paypal.fetch,
      store,
      receipts: store.receipts,
      timeoutMs: 1_000,
      resolveUser: async (token: string) => TOKENS[token] ?? null,
      access: (id: string, actor: string, kind: 'execute' | 'reconcile') => store.access(id, actor, kind),
      accounts: sandboxAccounts(env),
      supplierOf: async () => 'Northgate Equipment Rental',
      limits,
    };
    return { store, paypal, uses, execute: createPayoutHandler({ ...deps, kind: 'execute' }), reconcile: createPayoutHandler({ ...deps, kind: 'reconcile' }) };
  }

  it('refuses a rental payout into another party’s account, records why, and asks PayPal to pay nothing', async () => {
    const { store, paypal, execute, reconcile } = guarded({ recipient: GRANITE });
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(409);
    const refusal = "Northgate Equipment Rental is set up to be paid into another party's PayPal account, so the payout can't be sent.";
    expect(await readJson(response)).toEqual({ error: refusal, code: 'PAYEE_REFUSED' });
    expect(store.row()).toMatchObject({ status: 'failed', message: refusal, paypal_batch_id: null });
    expect(paypal.posts()).toEqual([]);
    store.clock += 60_000;
    expect((await readJson(await reconcile(payoutRequest(body)))).action).toBe('none');
    expect(paypal.posts()).toEqual([]);
  });

  it('leaves the check to payout_begin’s own: someone who may not send a payout records nothing', async () => {
    const { store, execute } = guarded({ recipient: GRANITE });
    expect((await execute(payoutRequest(body, 'pm-token'))).status).toBe(403);
    expect(store.row().status).toBe('authorized');
  });

  it('pays a rental whose address is nobody else’s', async () => {
    const { execute } = guarded();
    expect((await readJson(await execute(payoutRequest(body)))).authorization).toMatchObject({ status: 'succeeded' });
  });

  it('leaves the payee alone in mock mode, where nothing is paid', async () => {
    const { execute } = guarded({ env: { ...ACCOUNTS, PAYPAL_MODE: 'mock' }, recipient: GRANITE });
    expect((await execute(payoutRequest(body))).status).toBe(200);
  });

  it('hosted, sends nothing while payments are switched off, and says so on the payment', async () => {
    const { store, paypal, execute } = guarded({ env: { ...ACCOUNTS, GANTRY_HOSTED: '1' }, on: false });
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(503);
    expect((await readJson(response)).code).toBe('PAYMENTS_OFF');
    expect(store.row()).toMatchObject({ status: 'failed', message: expect.stringContaining('switched off') });
    expect(paypal.posts()).toEqual([]);
  });

  it('hosted, counts the first send and its amount against the copy', async () => {
    const { uses, execute } = guarded({ env: { ...ACCOUNTS, GANTRY_HOSTED: '1' } });
    expect((await execute(payoutRequest(body))).status).toBe(200);
    expect(uses).toEqual([{ kind: 'payout', projectId: PROJECT, amountMinor: 120000 }]);
  });

  it('hosted, past the cap records the payout as failed (so nothing re-sends it) and asks PayPal to pay nothing', async () => {
    const { store, paypal, execute, reconcile } = guarded({ env: { ...ACCOUNTS, GANTRY_HOSTED: '1' }, room: 0 });
    const response = await execute(payoutRequest(body));
    expect(response.status).toBe(429);
    expect((await readJson(response)).code).toBe('QUOTA_REACHED');
    expect(store.row()).toMatchObject({ status: 'failed', message: expect.stringContaining('limit on payouts') });
    expect(paypal.posts()).toEqual([]);
    store.clock += 60_000;
    expect((await readJson(await reconcile(payoutRequest(body)))).action).toBe('none');
    expect(paypal.posts()).toEqual([]);
  });

  it('hosted, a re-send of the same attempt is not counted again', async () => {
    const { store, uses, execute } = guarded({ env: { ...ACCOUNTS, GANTRY_HOSTED: '1' } });
    store.add({ status: 'submitted', attempts: 1, submitted_at: new Date(store.clock - 60_000).toISOString(), recipient_email: 'northgate@personal.example.com' });
    expect((await execute(payoutRequest(body))).status).toBe(200);
    expect(uses).toEqual([]);
  });
});

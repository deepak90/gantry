/**
 * A progress payment's PayPal batch (_shared/progress-payouts.ts), the code the dev server's route and the hosted
 * site's paypal-progress-payout function share: the page's request checked, each firm paid to its own sandbox account,
 * the database's say first with the sender's own token, the hosted copy's caps, PayPal's batch read back for the page.
 */
import { describe, expect, it } from 'vitest';
import { firmAccounts, partyWord, rentalPayeeRefusal, sandboxAccounts } from '../_shared/accounts.ts';
import type { PaymentLimits } from '../_shared/hosted.ts';
import { mockPayPalFetch } from '../_shared/paypal-mock.ts';
import { PAYPAL_SANDBOX_API, type Fetch } from '../_shared/paypal.ts';
import { batchRequest, claimPayout, createProgressPayoutHandler, statusOf, unpaidOf, type BatchRequest, type ClaimTarget, type Unpaid } from '../_shared/progress-payouts.ts';
import { jsonResponse, SANDBOX_BATCH_EXISTS } from './fakes.ts';

const HARBOR = '00000000-0000-4000-8000-000000000002';
const APPROVAL = '00000000-0000-4000-8000-0000000007aa';
const SENDER = '00000000-0000-4000-8000-000000000012';
const CHRIS = '00000000-0000-4000-8000-000000000011';
const GRANITE = 'granite@personal.example.com';
const PINECREST = 'pinecrest@personal.example.com';

const request: BatchRequest = {
  batchId: 'PG-25-abc123',
  currency: 'USD',
  subject: 'Progress payment: Footings',
  message: 'Progress payment for Footings: work completed to date, net of 10% retainage.',
  items: [
    { itemId: 'PG-25-abc123-1', firm: 'Granite Ridge Concrete', amountMinor: 3_132_000, note: 'Footings' },
    { itemId: 'PG-25-abc123-2', firm: 'Pinecrest Sitework', amountMinor: 648_000, note: 'Footings' },
  ],
  projectId: HARBOR,
  gateId: 25,
  approvalId: APPROVAL,
};

describe('the page’s request', () => {
  it('reads the project, the gate and the approval, and refuses a request without them', () => {
    const body = { ...request, subject: 'x', message: 'y' };
    expect(batchRequest(body)).toMatchObject({ projectId: HARBOR, gateId: 25, approvalId: APPROVAL });
    expect(batchRequest({ ...body, approvalId: null })).toMatchObject({ approvalId: null });
    expect(batchRequest({ ...body, projectId: 'harbor' })).toBeNull();
    expect(batchRequest({ ...body, gateId: 0 })).toBeNull();
    expect(batchRequest({ ...body, approvalId: 'not-a-uuid' })).toBeNull();
  });

  it('takes US dollars only, 1 to 50 firms with whole positive amounts, and each item once', () => {
    const item = request.items[0]!;
    expect(batchRequest({ ...request, currency: 'EUR' })).toBeNull();
    expect(batchRequest({ ...request, items: [] })).toBeNull();
    expect(batchRequest({ ...request, items: [{ ...item, amountMinor: 0 }] })).toBeNull();
    expect(batchRequest({ ...request, items: [{ ...item, amountMinor: 12.5 }] })).toBeNull();
    expect(batchRequest({ ...request, items: [{ ...item, amountMinor: 6_000_001 }] })).toBeNull();
    expect(batchRequest({ ...request, items: [{ ...item, firm: '  ' }] })).toBeNull();
    expect(batchRequest({ ...request, items: [item, item] })).toBeNull();
    expect(batchRequest({ ...request, items: [{ ...item, itemId: 'bad id' }] })).toBeNull();
    expect(batchRequest(null)).toBeNull();
    expect(batchRequest('PG-25')).toBeNull();
  });

  it('refuses a note PayPal would read as a negative test', () => {
    expect(batchRequest({ ...request, items: [{ ...request.items[0]!, note: 'ERRPYO002' }] })).toBeNull();
  });

  it('keeps only what it knows of each item', () => {
    const extra = { ...request, items: request.items.map((item) => ({ ...item, receiver: 'someone@else.example.com' })) };
    expect(batchRequest(extra)!.items[0]).toEqual(request.items[0]);
  });
});

describe('each firm’s own sandbox account', () => {
  const accounts = sandboxAccounts({ PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE, PAYPAL_SANDBOX_PINECREST_EMAIL: ` ${PINECREST} `, PAYPAL_SANDBOX_TENANT_EMAIL: 'tenant@personal.example.com' });

  it('finds a firm by the first word of its name', () => {
    expect(partyWord('Granite Ridge Concrete')).toBe('GRANITE');
    expect(partyWord(' o’Neil & Sons ')).toBe('ONEIL');
    expect(accounts.of('Granite Ridge Concrete')).toBe(GRANITE);
    expect(accounts.of('Pinecrest Sitework')).toBe(PINECREST);
    expect(accounts.of('Northgate Equipment Rental')).toBeNull();
    expect(accounts.of('')).toBeNull();
  });

  it('refuses a firm with no account of its own', () => {
    expect(firmAccounts(['Granite Ridge Concrete', 'Northgate Lifts'], accounts)).toEqual({ ok: false, error: "Northgate Lifts has no PayPal account set up, so it can't be paid." });
  });

  it('refuses two firms of the payment sharing one account, whatever the case of the address', () => {
    const shared = sandboxAccounts({ PAYPAL_SANDBOX_GRANITE_EMAIL: 'one@personal.example.com', PAYPAL_SANDBOX_PINECREST_EMAIL: 'ONE@personal.example.com' });
    expect(firmAccounts(['Granite Ridge Concrete', 'Pinecrest Sitework'], shared)).toEqual({ ok: false, error: "Pinecrest Sitework and Granite Ridge Concrete point at the same PayPal account, so the payment can't be sent." });
  });

  it('refuses a firm whose account is set up for another party too, such as the tenant', () => {
    const tenantToo = sandboxAccounts({ PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE, PAYPAL_SANDBOX_TENANT_EMAIL: GRANITE.toUpperCase() });
    expect(firmAccounts(['Granite Ridge Concrete'], tenantToo)).toEqual({ ok: false, error: "Granite Ridge Concrete's PayPal account is set up for another party too, so the payment can't be sent." });
  });

  it('takes this machine’s catch-all payee for nobody’s account', () => {
    const withPayee = sandboxAccounts({ PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE, PAYPAL_SANDBOX_PAYEE_EMAIL: GRANITE });
    expect(firmAccounts(['Granite Ridge Concrete'], withPayee)).toEqual({ ok: true, accounts: new Map([['Granite Ridge Concrete', GRANITE]]) });
    expect(withPayee.of('Payee')).toBeNull();
  });

  it('ignores a setting that is not an address', () => {
    expect(sandboxAccounts({ PAYPAL_SANDBOX_GRANITE_EMAIL: 'granite' }).of('Granite Ridge Concrete')).toBeNull();
  });

  it('refuses a rental payout into another party’s account, and lets one to an address of nobody else’s go', () => {
    const payeeIsGranite = sandboxAccounts({ PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE, PAYPAL_SANDBOX_PAYEE_EMAIL: GRANITE });
    expect(rentalPayeeRefusal(payeeIsGranite, 'Northgate Equipment Rental', GRANITE)).toBe("Northgate Equipment Rental is set up to be paid into another party's PayPal account, so the payout can't be sent.");
    expect(rentalPayeeRefusal(payeeIsGranite, 'Northgate Equipment Rental', 'sb-northgate@personal.example.com')).toBeNull();
    const own = sandboxAccounts({ PAYPAL_SANDBOX_NORTHGATE_EMAIL: 'northgate@personal.example.com' });
    expect(rentalPayeeRefusal(own, 'Northgate Equipment Rental', 'Northgate@personal.example.com')).toBeNull();
  });
});

describe('the database lets the payout through first', () => {
  function target(answer: { status: number; body: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake: ClaimTarget = {
      supabaseUrl: 'http://127.0.0.1:54321/',
      anonKey: 'anon',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(answer.status, answer.body);
      },
    };
    return { fake, calls };
  }

  it('claims the payout as the sender, with the approval and exactly the firms and amounts going to PayPal', async () => {
    const { fake, calls } = target({ status: 200, body: { needed: true, over_minor: 2_500_000, approval_id: APPROVAL, approved_by: CHRIS } });
    expect(await claimPayout(request, 'user-token', fake)).toEqual({ ok: true, approvalId: APPROVAL, approvedBy: CHRIS });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:54321/rest/v1/rpc/claim_pay_gate_payout');
    expect(calls[0]!.init.headers).toMatchObject({ apikey: 'anon', Authorization: 'Bearer user-token' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      p_project: HARBOR,
      p_gate: 25,
      p_amount_minor: 3_780_000,
      p_currency: 'USD',
      p_lines: [
        { firm: 'Granite Ridge Concrete', amount_minor: 3_132_000, item_id: 'PG-25-abc123-1' },
        { firm: 'Pinecrest Sitework', amount_minor: 648_000, item_id: 'PG-25-abc123-2' },
      ],
      p_approval: APPROVAL,
      p_sender_batch_id: 'PG-25-abc123',
    });
  });

  it('passes the database’s refusal back in its own words', async () => {
    const { fake } = target({ status: 403, body: { code: '42501', message: 'claim_pay_gate_payout: the approval is requested, not approved' } });
    expect(await claimPayout(request, 'user-token', fake)).toEqual({ ok: false, status: 403, error: 'The approval is requested, not approved' });
  });

  it('refuses without a login before asking anyone', async () => {
    const { fake, calls } = target({ status: 200, body: {} });
    expect(await claimPayout(request, null, fake)).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(0);
  });
});

describe('PayPal’s batch, as the page reads it', () => {
  it('reads the fees PayPal reports for the batch and for each payment', () => {
    const settled = statusOf({
      batch_header: { payout_batch_id: 'SE3L5LQG334KY', batch_status: 'SUCCESS', amount: { currency: 'USD', value: '37800.00' }, fees: { currency: 'USD', value: '0.50' } },
      items: [
        { transaction_id: '9KL12345AB678901C', transaction_status: 'SUCCESS', payout_item_fee: { currency: 'USD', value: '0.25' }, payout_item: { sender_item_id: 'PG-46-x-1', amount: { currency: 'USD', value: '31320.00' } } },
        { transaction_id: null, transaction_status: 'UNCLAIMED', payout_item_fee: { currency: 'USD', value: '0.25' }, payout_item: { sender_item_id: 'PG-46-x-2', amount: { currency: 'USD', value: '6480.00' } }, errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' } },
      ],
    });
    expect(settled).toEqual({
      batchId: 'SE3L5LQG334KY',
      status: 'SUCCESS',
      feeMinor: 50,
      items: [
        { itemId: 'PG-46-x-1', status: 'SUCCESS', transactionId: '9KL12345AB678901C', feeMinor: 25, error: null },
        { itemId: 'PG-46-x-2', status: 'UNCLAIMED', transactionId: null, feeMinor: 25, error: 'Receiver is unregistered' },
      ],
    });
  });

  it('leaves the fee unknown while PayPal has not reported one', () => {
    expect(statusOf({ batch_header: { payout_batch_id: 'SE3L5LQG334KY', batch_status: 'PENDING' } })).toEqual({ batchId: 'SE3L5LQG334KY', status: 'PENDING', feeMinor: null, items: [] });
  });
});

describe('what PayPal did not pay, by our ids', () => {
  const batch = (status: string, items: [string, string][]) => ({
    batch_header: { payout_batch_id: 'SE3L5LQG334KY', batch_status: status, sender_batch_header: { sender_batch_id: 'PG-25-abc123' } },
    items: items.map(([itemId, itemStatus]) => ({ transaction_status: itemStatus, payout_item: { sender_item_id: itemId } })),
  });

  it('names each firm’s payment PayPal failed, returned or turned down', () => {
    expect(unpaidOf(batch('SUCCESS', [['PG-25-abc123-1', 'SUCCESS'], ['PG-25-abc123-2', 'FAILED']]))).toEqual({ senderBatchId: 'PG-25-abc123', itemIds: ['PG-25-abc123-2'], wholeBatch: false });
    for (const status of ['RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED']) {
      expect(unpaidOf(batch('SUCCESS', [['PG-25-abc123-1', status]]))).toEqual({ senderBatchId: 'PG-25-abc123', itemIds: ['PG-25-abc123-1'], wholeBatch: false });
    }
  });

  it('leaves out what PayPal paid or may still pay, unclaimed and on hold included', () => {
    expect(unpaidOf(batch('SUCCESS', [['PG-25-abc123-1', 'SUCCESS'], ['PG-25-abc123-2', 'SUCCESS']]))).toBeNull();
    expect(unpaidOf(batch('PROCESSING', [['PG-25-abc123-1', 'PENDING'], ['PG-25-abc123-2', 'UNCLAIMED'], ['PG-25-abc123-3', 'ONHOLD']]))).toBeNull();
    expect(unpaidOf(batch('PENDING', []))).toBeNull();
  });

  it('takes the whole batch when PayPal turned it down without paying any of it', () => {
    expect(unpaidOf(batch('DENIED', []))).toEqual({ senderBatchId: 'PG-25-abc123', itemIds: [], wholeBatch: true });
    expect(unpaidOf(batch('CANCELED', [['PG-25-abc123-1', 'FAILED']]))).toEqual({ senderBatchId: 'PG-25-abc123', itemIds: ['PG-25-abc123-1'], wholeBatch: true });
    expect(unpaidOf(batch('DENIED', [['PG-25-abc123-1', 'SUCCESS'], ['PG-25-abc123-2', 'FAILED']]))).toEqual({ senderBatchId: 'PG-25-abc123', itemIds: ['PG-25-abc123-2'], wholeBatch: false });
  });

  it('says nothing of a batch whose own id PayPal did not give back', () => {
    expect(unpaidOf({ batch_header: { payout_batch_id: 'SE3L5LQG334KY', batch_status: 'DENIED' }, items: [{ transaction_status: 'FAILED', payout_item: { sender_item_id: 'PG-25-abc123-1' } }] })).toBeNull();
    expect(unpaidOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The function
// ---------------------------------------------------------------------------------------------

const LIVE = { PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE, PAYPAL_SANDBOX_PINECREST_EMAIL: PINECREST };
const HOSTED = { ...LIVE, GANTRY_HOSTED: '1' };

interface Seen {
  paypal: { method: string; path: string; headers: Headers; body: unknown }[];
  claims: { token: string | null; body: unknown }[];
  uses: { kind: string; projectId: string; amountMinor: number | null }[];
  settled: { projectId: string; unpaid: Unpaid }[];
  /** The batches recorded for each copy (`project batch`); BATCH-1 was sent from Harbor before each test. */
  batches: Set<string>;
}

/** The function over scripted neighbors: PayPal, the database's claim, the site's switch and caps. */
function fn(
  options: {
    env?: Record<string, string>;
    claim?: { status: number; body: unknown };
    payout?: () => Response;
    batch?: (id: string) => Response;
    seesCosts?: boolean;
    on?: boolean;
    room?: number;
    limits?: PaymentLimits | null;
    fetch?: Fetch;
  } = {},
) {
  const env: Record<string, string> = options.env ?? LIVE;
  const seen: Seen = { paypal: [], claims: [], uses: [], settled: [], batches: new Set([`${HARBOR} BATCH-1`]) };
  const paypal: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') return jsonResponse(200, { access_token: 'TOKEN' });
    seen.paypal.push({ method: String(init.method), path, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : null });
    if (path === '/v1/payments/payouts' && init.method === 'POST') return options.payout?.() ?? jsonResponse(201, { batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } });
    const id = decodeURIComponent(path.slice('/v1/payments/payouts/'.length));
    return options.batch?.(id) ?? jsonResponse(200, { batch_header: { payout_batch_id: id, batch_status: 'PROCESSING' }, items: [] });
  };
  const limits: PaymentLimits = {
    paymentsOn: async () => options.on ?? true,
    use: async (kind, projectId, amountMinor) => {
      if (seen.uses.length >= (options.room ?? 5)) return false;
      seen.uses.push({ kind, projectId, amountMinor });
      return true;
    },
  };
  const handle = createProgressPayoutHandler({
    env: { get: (name) => env[name] },
    accounts: sandboxAccounts(env),
    fetch: options.fetch ?? paypal,
    resolveUser: async (token) => (token === 'deepak' ? SENDER : null),
    seesCosts: async () => options.seesCosts ?? true,
    claimTarget: {
      supabaseUrl: 'http://supabase.test',
      anonKey: 'anon',
      fetch: async (url, init) => {
        seen.claims.push({ token: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
        const answer = options.claim ?? { status: 200, body: { needed: true, approval_id: APPROVAL, approved_by: CHRIS } };
        return jsonResponse(answer.status, answer.body);
      },
    },
    ...(options.limits === null ? {} : { limits: options.limits ?? limits }),
    settle: async (projectId, unpaid) => {
      seen.settled.push({ projectId, unpaid });
    },
    batches: {
      record: async (batch) => void seen.batches.add(`${batch.projectId} ${batch.paypalBatchId}`),
      has: async (projectId, batchId) => seen.batches.has(`${projectId} ${batchId}`),
    },
    timeoutMs: 1_000,
  });
  return { handle, seen };
}

const post = (body: unknown, token: string | null = 'deepak') =>
  new Request('http://localhost/functions/v1/paypal-progress-payout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const read = async (response: Response) => (await response.json()) as Record<string, unknown>;
const payouts = (seen: Seen) => seen.paypal.filter((call) => call.method === 'POST' && call.path === '/v1/payments/payouts');

describe('paypal-progress-payout', () => {
  it('answers the browser’s preflight and takes POST only', async () => {
    const { handle } = fn();
    const preflight = await handle(new Request('http://localhost/', { method: 'OPTIONS' }));
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect((await handle(new Request('http://localhost/', { method: 'GET' }))).status).toBe(405);
  });

  it('refuses what is not a progress payment, and anyone not signed in, before asking anyone', async () => {
    const { handle, seen } = fn();
    expect((await handle(post('{nope'))).status).toBe(400);
    const notOne = await handle(post({ ...request, gateId: -1 }));
    expect(notOne.status).toBe(400);
    expect(await read(notOne)).toMatchObject({ refused: true, code: 'INVALID_REQUEST' });
    const stranger = await handle(post(request, 'someone'));
    expect(stranger.status).toBe(401);
    expect(await read(stranger)).toMatchObject({ refused: true, code: 'UNAUTHORIZED' });
    expect(seen.paypal).toEqual([]);
    expect(seen.claims).toEqual([]);
  });

  it('pays each firm to its own account in one batch, claimed first as the sender, with the batch id as PayPal’s request id', async () => {
    const { handle, seen } = fn();
    const response = await handle(post(request));
    expect(response.status).toBe(201);
    expect(await read(response)).toEqual({ batchId: 'BATCH-1', status: 'PENDING', feeMinor: null, items: [], mode: 'live', approvalId: APPROVAL });
    expect(seen.claims).toHaveLength(1);
    expect(seen.claims[0]!.token).toBe('Bearer deepak');
    const [sent] = payouts(seen);
    expect(sent!.headers.get('PayPal-Request-Id')).toBe('PG-25-abc123');
    const body = sent!.body as { sender_batch_header: { sender_batch_id: string }; items: { receiver: string; amount: { value: string }; sender_item_id: string }[] };
    expect(body.sender_batch_header.sender_batch_id).toBe('PG-25-abc123');
    expect(body.items.map((item) => [item.sender_item_id, item.receiver, item.amount.value])).toEqual([
      ['PG-25-abc123-1', GRANITE, '31320.00'],
      ['PG-25-abc123-2', PINECREST, '6480.00'],
    ]);
  });

  it('refuses a firm without its own account before the database is asked, and sends nothing', async () => {
    const { handle, seen } = fn({ env: { ...LIVE, PAYPAL_SANDBOX_PINECREST_EMAIL: '' } });
    const response = await handle(post(request));
    expect(response.status).toBe(409);
    expect(await read(response)).toEqual({ error: "Pinecrest Sitework has no PayPal account set up, so it can't be paid.", refused: true, code: 'PAYEE_REFUSED' });
    expect(seen.claims).toEqual([]);
    expect(payouts(seen)).toEqual([]);
  });

  it('passes the database’s refusal back and sends nothing', async () => {
    const { handle, seen } = fn({ claim: { status: 400, body: { code: '42501', message: 'claim_pay_gate_payout: payouts over 2500000 minor units need a second person who sees costs to approve them first' } } });
    const response = await handle(post({ ...request, approvalId: null }));
    expect(response.status).toBe(403);
    expect(await read(response)).toMatchObject({ refused: true, code: 'PAYOUT_REFUSED', error: 'Payouts over 2500000 minor units need a second person who sees costs to approve them first' });
    expect(payouts(seen)).toEqual([]);
  });

  it('reads back the batch PayPal already has when the same payment is sent again', async () => {
    const { handle, seen } = fn({
      payout: () => jsonResponse(400, SANDBOX_BATCH_EXISTS),
      batch: (id) => jsonResponse(200, { batch_header: { payout_batch_id: id, batch_status: 'SUCCESS' }, items: [] }),
    });
    const response = await handle(post(request));
    expect(response.status).toBe(201);
    expect(await read(response)).toMatchObject({ batchId: 'XNK4D4A55AQ5G', status: 'SUCCESS', resumed: true });
    expect(payouts(seen)).toHaveLength(1);
  });

  it('says PayPal turned the batch down, without calling it a refusal before PayPal', async () => {
    const { handle } = fn({ payout: () => jsonResponse(422, { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.' }) });
    const response = await handle(post(request));
    expect(response.status).toBe(502);
    expect(await read(response)).toMatchObject({ error: 'Sender does not have sufficient funds.', code: 'PAYPAL_REFUSED' });
  });

  it('refuses when PayPal’s credentials are refused, before the database uses up the approval', async () => {
    const { handle, seen } = fn({ fetch: async () => jsonResponse(401, { error: 'invalid_client', error_description: 'Client Authentication failed' }) });
    const response = await handle(post(request));
    expect(response.status).toBe(503);
    expect(await read(response)).toMatchObject({ refused: true, code: 'PAYPAL_AUTH_FAILED' });
    expect(seen.claims).toEqual([]);
  });

  describe('on the hosted site', () => {
    it('sends nothing while payments are switched off', async () => {
      const { handle, seen } = fn({ env: HOSTED, on: false });
      const response = await handle(post(request));
      expect(response.status).toBe(503);
      expect(await read(response)).toMatchObject({ refused: true, code: 'PAYMENTS_OFF' });
      expect(seen.claims).toEqual([]);
      expect(payouts(seen)).toEqual([]);
    });

    it('counts the payout and its amount against the copy once the database has let it through', async () => {
      const { handle, seen } = fn({ env: HOSTED });
      expect((await handle(post(request))).status).toBe(201);
      expect(seen.uses).toEqual([{ kind: 'payout', projectId: HARBOR, amountMinor: 3_780_000 }]);
    });

    it('does not count again a batch sent again after its answer was lost', async () => {
      const { handle, seen } = fn({
        env: HOSTED,
        claim: { status: 200, body: { needed: true, approval_id: APPROVAL, approved_by: CHRIS, resumed: true } },
        payout: () => jsonResponse(400, SANDBOX_BATCH_EXISTS),
        batch: (id) => jsonResponse(200, { batch_header: { payout_batch_id: id, batch_status: 'SUCCESS' }, items: [] }),
      });
      expect(await read(await handle(post(request)))).toMatchObject({ batchId: 'XNK4D4A55AQ5G', resumed: true });
      expect(seen.uses).toEqual([]);
    });

    it('sends nothing once the copy’s cap is reached', async () => {
      const { handle, seen } = fn({ env: HOSTED, room: 0 });
      const response = await handle(post(request));
      expect(response.status).toBe(429);
      expect(await read(response)).toMatchObject({ refused: true, code: 'QUOTA_REACHED' });
      expect(payouts(seen)).toEqual([]);
    });

    it('never pays without the site’s limits wired in', async () => {
      const { handle, seen } = fn({ env: HOSTED, limits: null });
      expect((await handle(post(request))).status).toBe(503);
      expect(payouts(seen)).toEqual([]);
    });
  });

  describe('following the batch', () => {
    const status = (batchId = 'BATCH-1', projectId = HARBOR) => post({ action: 'status', projectId, batchId });

    it('reads PayPal’s batch for a member who sees costs', async () => {
      const { handle } = fn({
        batch: (id) =>
          jsonResponse(200, {
            batch_header: { payout_batch_id: id, batch_status: 'SUCCESS', amount: { currency: 'USD', value: '37800.00' }, fees: { currency: 'USD', value: '0.50' } },
            items: [{ transaction_id: 'TX1', transaction_status: 'SUCCESS', payout_item_fee: { currency: 'USD', value: '0.25' }, payout_item: { sender_item_id: 'PG-25-abc123-1', amount: { currency: 'USD', value: '31320.00' } } }],
          }),
      });
      const response = await handle(status());
      expect(response.status).toBe(200);
      expect(await read(response)).toEqual({ batchId: 'BATCH-1', status: 'SUCCESS', feeMinor: 50, items: [{ itemId: 'PG-25-abc123-1', status: 'SUCCESS', transactionId: 'TX1', feeMinor: 25, error: null }] });
    });

    it('is only for a member of the project who sees costs, signed in', async () => {
      const { handle, seen } = fn({ seesCosts: false });
      expect((await handle(status())).status).toBe(403);
      expect((await handle(status('BATCH-1', HARBOR).clone())).status).toBe(403);
      expect((await handle(post({ action: 'status', projectId: HARBOR, batchId: 'BATCH-1' }, null))).status).toBe(401);
      expect(seen.paypal).toEqual([]);
    });

    it('needs a project and a batch id that could be PayPal’s', async () => {
      const { handle } = fn();
      expect((await handle(status('../../v1/oauth2/token'))).status).toBe(400);
      expect((await handle(status('BATCH-1', 'harbor'))).status).toBe(400);
    });

    it('still answers while payments are switched off, so a payout already sent can settle', async () => {
      const { handle } = fn({ env: HOSTED, on: false });
      expect((await handle(status())).status).toBe(200);
    });

    it('says when PayPal has no such batch', async () => {
      const { handle, seen } = fn({ batch: () => jsonResponse(404, { name: 'RESOURCE_NOT_FOUND' }) });
      expect((await handle(status())).status).toBe(404);
      expect(seen.settled).toEqual([]);
    });

    it('tells the database what PayPal did not pay before the page hears of it, so the next try pays the rest', async () => {
      const { handle, seen } = fn({
        batch: (id) =>
          jsonResponse(200, {
            batch_header: { payout_batch_id: id, batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: 'PG-25-abc123' } },
            items: [
              { transaction_id: 'TX1', transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'PG-25-abc123-1' } },
              { transaction_id: null, transaction_status: 'FAILED', payout_item: { sender_item_id: 'PG-25-abc123-2' }, errors: { name: 'RECEIVER_UNREGISTERED' } },
            ],
          }),
      });
      const response = await handle(status());
      expect(response.status).toBe(200);
      expect(await read(response)).toMatchObject({ status: 'SUCCESS', items: [{ itemId: 'PG-25-abc123-1', status: 'SUCCESS' }, { itemId: 'PG-25-abc123-2', status: 'FAILED' }] });
      expect(seen.settled).toEqual([{ projectId: HARBOR, unpaid: { senderBatchId: 'PG-25-abc123', itemIds: ['PG-25-abc123-2'], wholeBatch: false } }]);
    });

    it('tells it nothing while every firm is paid or on its way', async () => {
      const { handle, seen } = fn({
        batch: (id) =>
          jsonResponse(200, {
            batch_header: { payout_batch_id: id, batch_status: 'PROCESSING', sender_batch_header: { sender_batch_id: 'PG-25-abc123' } },
            items: [{ transaction_status: 'SUCCESS', payout_item: { sender_item_id: 'PG-25-abc123-1' } }, { transaction_status: 'PENDING', payout_item: { sender_item_id: 'PG-25-abc123-2' } }],
          }),
      });
      expect((await handle(status())).status).toBe(200);
      expect(seen.settled).toEqual([]);
    });
  });

  describe('with the mock PayPal', () => {
    it('pays every firm and settles with PayPal’s published fees, with nothing leaving the machine', async () => {
      const { handle } = fn({ env: { PAYPAL_MODE: 'mock' }, fetch: () => Promise.reject(new Error('mock mode never fetches')) });
      const sent = await read(await handle(post(request)));
      expect(sent).toMatchObject({ status: 'PENDING', mode: 'mock', approvalId: APPROVAL });
      expect(String(sent.batchId)).toMatch(/^MOCK-M-/);
      const settled = await read(await handle(post({ action: 'status', projectId: HARBOR, batchId: sent.batchId })));
      expect(settled).toMatchObject({ status: 'SUCCESS', feeMinor: 50 });
      expect((settled.items as { itemId: string; status: string; feeMinor: number }[]).map((item) => [item.itemId, item.status, item.feeMinor])).toEqual([
        ['PG-25-abc123-1', 'SUCCESS', 25],
        ['PG-25-abc123-2', 'SUCCESS', 25],
      ]);
    });

    it('takes back a firm’s payment the mock fails, by the item it went out in', async () => {
      const env = { PAYPAL_MODE: 'mock', PAYPAL_SANDBOX_PINECREST_EMAIL: 'pinecrest+fail@personal.example.com' };
      const { handle, seen } = fn({ env, fetch: () => Promise.reject(new Error('mock mode never fetches')) });
      const sent = await read(await handle(post(request)));
      await handle(post({ action: 'status', projectId: HARBOR, batchId: sent.batchId }));
      expect(seen.settled).toEqual([{ projectId: HARBOR, unpaid: { senderBatchId: 'PG-25-abc123', itemIds: ['PG-25-abc123-2'], wholeBatch: false } }]);
    });
  });
});

describe('the mock’s progress batch', () => {
  const auth = { Authorization: 'Bearer MOCK-ACCESS-TOKEN', 'PayPal-Request-Id': 'PG-9-key' };
  const create = (items: unknown[]) =>
    mockPayPalFetch(`${PAYPAL_SANDBOX_API}/v1/payments/payouts`, { method: 'POST', headers: auth, body: JSON.stringify({ sender_batch_header: { sender_batch_id: 'PG-9-key' }, items }) });
  const item = (n: number, receiver: string, value: string) => ({ recipient_type: 'EMAIL', receiver, amount: { value, currency: 'USD' }, sender_item_id: `PG-9-key-${n}`, note: 'x' });

  it('answers each item by its receiver, from the batch id alone', async () => {
    const made = (await (await create([item(1, 'a@b.c', '10.00'), item(2, 'x+unclaimed@b.c', '5.50')])).json()) as { batch_header: { payout_batch_id: string } };
    const id = made.batch_header.payout_batch_id;
    expect(id).toBe('MOCK-M-USD-S1000.U550-PG-9-key');
    const batch = (await (await mockPayPalFetch(`${PAYPAL_SANDBOX_API}/v1/payments/payouts/${id}`, { method: 'GET', headers: auth })).json()) as Parameters<typeof statusOf>[0];
    expect(statusOf(batch)).toMatchObject({ status: 'SUCCESS', feeMinor: 50, items: [{ itemId: 'PG-9-key-1', status: 'SUCCESS' }, { itemId: 'PG-9-key-2', status: 'UNCLAIMED' }] });
  });

  it('wants each item numbered after the batch, as the page sends them', async () => {
    expect((await create([item(1, 'a@b.c', '10.00'), { ...item(2, 'a@b.c', '1.00'), sender_item_id: 'other' }])).status).toBe(400);
  });
});

/**
 * Nobody reaches PayPal, not even its sign-in, until the functions know who is asking, that they are a member of the
 * project who may do this, and that what they ask about exists there; and then only within their allowance.
 */
import { describe, expect, it } from 'vitest';
import { sandboxAccounts } from '../_shared/accounts.ts';
import { createPayoutHandler } from '../_shared/handlers.ts';
import { HttpError } from '../_shared/http.ts';
import { createInvoiceHandler, type InvoiceRecord } from '../_shared/invoices.ts';
import type { Fetch } from '../_shared/paypal.ts';
import { createProgressPayoutHandler } from '../_shared/progress-payouts.ts';
import type { PayPalCallKind, RateGate } from '../_shared/rate-limit.ts';
import { AUTH_ID, envOf, FakePayPal, FakeStore, jsonResponse, LIVE_ENV, payoutRequest, PROJECT, TOKENS } from './fakes.ts';

const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000ff';

/** What happened, in order: user, access/member/record checks, the allowance, PayPal's sign-in and calls. */
function recorder(refuse: PayPalCallKind | null = null) {
  const events: string[] = [];
  const gate: RateGate = async (kind) => {
    events.push(`gate:${kind}`);
    if (kind === refuse) throw new HttpError(429, 'RATE_LIMITED', 'Too many.');
  };
  const watch = (fetch: Fetch): Fetch => async (url, init) => {
    events.push(new URL(url).pathname === '/v1/oauth2/token' ? 'oauth' : 'paypal');
    return fetch(url, init);
  };
  return { events, gate, watch };
}

const paypalCalls = (events: string[]) => events.filter((event) => event === 'oauth' || event === 'paypal');

describe('paypal-execute-payout and paypal-reconcile', () => {
  function handler(kind: 'execute' | 'reconcile', refuse: PayPalCallKind | null = null) {
    const store = new FakeStore();
    store.add({ status: kind === 'execute' ? 'authorized' : 'pending', paypal_batch_id: kind === 'execute' ? null : 'BATCH-1', attempts: kind === 'execute' ? 0 : 1 });
    const paypal = new FakePayPal();
    const { events, gate, watch } = recorder(refuse);
    const handle = createPayoutHandler({
      kind,
      env: envOf(LIVE_ENV),
      fetch: watch(paypal.fetch),
      store,
      receipts: store.receipts,
      timeoutMs: 1_000,
      resolveUser: async (token) => {
        events.push('user');
        return TOKENS[token] ?? null;
      },
      access: async (id, actor, asked) => {
        events.push('access');
        return store.access(id, actor, asked);
      },
      rateGate: gate,
    });
    return { handle, events, store };
  }

  it('checks the user, then whether they may act on the payment, then the allowance, and only then signs in to PayPal', async () => {
    const { handle, events } = handler('execute');
    expect((await handle(payoutRequest({ authorization_id: AUTH_ID }))).status).toBe(200);
    expect(events.slice(0, 4)).toEqual(['user', 'access', 'gate:paypal_call', 'oauth']);
  });

  it('counts a check of where a payout stands as a read', async () => {
    const { handle, events } = handler('reconcile');
    expect((await handle(payoutRequest({ authorization_id: AUTH_ID }, 'pm-token'))).status).toBe(200);
    expect(events.slice(0, 4)).toEqual(['user', 'access', 'gate:paypal_read', 'oauth']);
  });

  it.each([
    ['a stranger', 'outsider-token', AUTH_ID, 404],
    ['a payment that doesn’t exist', 'cm-token', '00000000-0000-4000-8000-00000000dead', 404],
    ['a member who may not send it', 'pm-token', AUTH_ID, 403],
    ['no session', 'expired', AUTH_ID, 401],
  ])('never reaches PayPal, nor counts against the allowance, for %s', async (_, token, id, status) => {
    const { handle, events, store } = handler('execute');
    const response = await handle(payoutRequest({ authorization_id: id }, token));
    expect(response.status).toBe(status);
    expect(paypalCalls(events)).toEqual([]);
    expect(events).not.toContain('gate:paypal_call');
    expect(store.calls).toEqual([]);
  });

  it('never reaches PayPal past the allowance', async () => {
    const { handle, events, store } = handler('execute', 'paypal_call');
    const response = await handle(payoutRequest({ authorization_id: AUTH_ID }));
    expect(response.status).toBe(429);
    expect((await response.json()) as unknown).toMatchObject({ code: 'RATE_LIMITED' });
    expect(paypalCalls(events)).toEqual([]);
    expect(store.calls).toEqual([]);
  });
});

describe('paypal-invoice', () => {
  const ID = '00000000-0000-4000-8000-0000000009a1';
  const sent: InvoiceRecord = {
    id: ID,
    project_id: PROJECT,
    title: 'Level 2: finished work',
    client_name: 'Harbor Street Properties',
    client_email: 'client@example.com',
    lines: [{ label: 'Install light fixtures', amount_minor: 620000 }],
    currency: 'USD',
    status: 'sent',
    paypal_invoice_id: 'INV2-TEST',
  };

  function handler(options: { invoice?: InvoiceRecord | null; canBill?: boolean; refuse?: PayPalCallKind | null } = {}) {
    const { events, gate, watch } = recorder(options.refuse ?? null);
    const fetch: Fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/oauth2/token') return jsonResponse(200, { access_token: 'TOKEN', expires_in: 32400 });
      return jsonResponse(200, { id: 'INV2-TEST', status: 'UNPAID', detail: {} });
    };
    let row = options.invoice === undefined ? sent : options.invoice;
    const handle = createInvoiceHandler({
      env: envOf({ PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }),
      fetch: watch(fetch),
      store: {
        read: async () => {
          events.push('record');
          return row;
        },
        update: async (_id, patch) => (row = { ...row!, ...patch } as InvoiceRecord),
        markSent: async () => row!,
        canBill: async () => {
          events.push('member');
          return options.canBill ?? true;
        },
      },
      resolveUser: async (token) => {
        events.push('user');
        return token === 'token' ? '00000000-0000-4000-8000-000000000012' : null;
      },
      rateGate: gate,
    });
    return { handle, events };
  }

  const post = (body: unknown, token = 'token') => new Request('http://local/paypal-invoice', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it.each([
    ['refresh', 'gate:paypal_read'],
    ['cancel', 'gate:paypal_call'],
  ])('%s: the user, the invoice, the member, the allowance, then PayPal', async (action, gate) => {
    const { handle, events } = handler();
    expect((await handle(post({ invoice_id: ID, action }))).status).toBe(200);
    expect(events.slice(0, 5)).toEqual(['user', 'record', 'member', gate, 'oauth']);
  });

  it.each([
    ['someone who doesn’t see costs on its project', { canBill: false }, 403],
    ['an invoice that doesn’t exist', { invoice: null }, 404],
    ['past the allowance', { refuse: 'paypal_call' as const }, 429],
  ])('never reaches PayPal for %s', async (_, options, status) => {
    const { handle, events } = handler(options);
    const response = await handle(post({ invoice_id: ID, action: 'cancel' }));
    expect(response.status).toBe(status);
    expect(paypalCalls(events)).toEqual([]);
  });

  it('never reaches PayPal without a session', async () => {
    const { handle, events } = handler();
    expect((await handle(post({ invoice_id: ID, action: 'refresh' }, 'nobody'))).status).toBe(401);
    expect(paypalCalls(events)).toEqual([]);
    expect(events).not.toContain('record');
  });
});

describe('paypal-progress-payout', () => {
  const GRANITE = 'granite@personal.example.com';
  const PINECREST = 'pinecrest@personal.example.com';
  const env = { PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_SANDBOX_GRANITE_EMAIL: GRANITE, PAYPAL_SANDBOX_PINECREST_EMAIL: PINECREST };
  const payment = {
    batchId: 'PG-25-abc123',
    currency: 'USD',
    subject: 'Progress payment: Footings',
    message: 'Progress payment for Footings.',
    items: [
      { itemId: 'PG-25-abc123-1', firm: 'Granite Ridge Concrete', amountMinor: 3_132_000, note: 'Footings' },
      { itemId: 'PG-25-abc123-2', firm: 'Pinecrest Sitework', amountMinor: 648_000, note: 'Footings' },
    ],
    projectId: PROJECT,
    gateId: 25,
    approvalId: null,
  };

  function handler(options: { seesCosts?: boolean; refuse?: PayPalCallKind | null; recorded?: string[] } = {}) {
    const { events, gate, watch } = recorder(options.refuse ?? null);
    const recorded = new Set(options.recorded ?? []);
    const fetch: Fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/oauth2/token') return jsonResponse(200, { access_token: 'TOKEN', expires_in: 32400 });
      if (init.method === 'POST') return jsonResponse(201, { batch_header: { payout_batch_id: 'BATCH-NEW', batch_status: 'PENDING' } });
      return jsonResponse(200, { batch_header: { payout_batch_id: decodeURIComponent(path.split('/').pop()!), batch_status: 'SUCCESS' }, items: [] });
    };
    const handle = createProgressPayoutHandler({
      env: envOf(env),
      accounts: sandboxAccounts(env),
      fetch: watch(fetch),
      resolveUser: async (token) => {
        events.push('user');
        return token === 'deepak' ? '00000000-0000-4000-8000-000000000012' : null;
      },
      seesCosts: async () => {
        events.push('member');
        return options.seesCosts ?? true;
      },
      claimTarget: {
        supabaseUrl: 'http://supabase.test',
        anonKey: 'anon',
        fetch: async () => {
          events.push('claim');
          return jsonResponse(200, { needed: false, approval_id: null });
        },
      },
      batches: {
        record: async (batch) => {
          events.push(`recorded:${batch.paypalBatchId}`);
          recorded.add(`${batch.projectId} ${batch.paypalBatchId}`);
        },
        has: async (projectId, batchId) => {
          events.push('record');
          return recorded.has(`${projectId} ${batchId}`);
        },
      },
      rateGate: gate,
      timeoutMs: 1_000,
    });
    return { handle, events };
  }

  const post = (body: unknown, token = 'deepak') => new Request('http://localhost/paypal-progress-payout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const status = (batchId: string, projectId = PROJECT) => post({ action: 'status', projectId, batchId });

  it('pays only after the member and the allowance, signs in to PayPal before the claim, and records the batch for the project', async () => {
    const { handle, events } = handler();
    expect((await handle(post(payment))).status).toBe(201);
    expect(events).toEqual(['user', 'member', 'gate:paypal_call', 'oauth', 'claim', 'paypal', 'recorded:BATCH-NEW']);
  });

  it('then lets the project’s members follow that batch, as a read', async () => {
    const { handle, events } = handler();
    await handle(post(payment));
    events.length = 0;
    expect((await handle(status('BATCH-NEW'))).status).toBe(200);
    // The kept token: no second sign-in.
    expect(events).toEqual(['user', 'member', 'record', 'gate:paypal_read', 'paypal']);
  });

  it.each([
    ['someone who doesn’t see costs', { seesCosts: false }, 403],
    ['past the allowance', { refuse: 'paypal_call' as const }, 429],
  ])('never reaches PayPal, nor the claim, for %s', async (_, options, expected) => {
    const { handle, events } = handler(options);
    const response = await handle(post(payment));
    expect(response.status).toBe(expected);
    expect(paypalCalls(events)).toEqual([]);
    expect(events).not.toContain('claim');
  });

  it.each([
    ['a batch this project never sent', { recorded: [] }, 'BATCH-ELSEWHERE', PROJECT, 404],
    ['a batch another copy sent', { recorded: [`${OTHER_PROJECT} BATCH-1`] }, 'BATCH-1', PROJECT, 404],
    ['a member who doesn’t see costs', { seesCosts: false, recorded: [`${PROJECT} BATCH-1`] }, 'BATCH-1', PROJECT, 403],
    ['a read past the allowance', { refuse: 'paypal_read' as const, recorded: [`${PROJECT} BATCH-1`] }, 'BATCH-1', PROJECT, 429],
  ])('never asks PayPal about %s', async (_, options, batchId, projectId, expected) => {
    const { handle, events } = handler(options);
    const response = await handle(status(batchId, projectId));
    expect(response.status).toBe(expected);
    expect(paypalCalls(events)).toEqual([]);
  });
});

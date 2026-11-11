/**
 * Test doubles: an in-memory PayoutStore that follows the payouts migration's rules (the pgTAP suite
 * 09_payouts_and_reset.sql pins the SQL itself), a receipt filer that records what it was asked to
 * file (receipt.test.ts covers the real one), and a scripted PayPal behind a fake `fetch`.
 */
import { createPayoutHandler, createWebhookHandler, type Handler, type PayoutAccess } from '../_shared/handlers.ts';
import type { PaymentStatus } from '../_shared/outcomes.ts';
import type { Fetch, PayPalMode } from '../_shared/paypal.ts';
import type { FiledReceipt, ReceiptFiler } from '../_shared/receipt.ts';
import {
  StoreError,
  type PaymentAuthorization,
  type PayoutAction,
  type PayoutEvent,
  type PayoutRecord,
  type PayoutStep,
  type PayoutStore,
} from '../_shared/store.ts';

export const PROJECT = '00000000-0000-4000-8000-000000000001';
export const PM = '00000000-0000-4000-8000-000000000011';
export const CM = '00000000-0000-4000-8000-000000000012';
export const OUTSIDER = '00000000-0000-4000-8000-000000000099';
export const AUTH_ID = '00000000-0000-4000-8000-0000000005bb';

interface Member {
  userId: string;
  role: 'pm' | 'cm';
  canViewCosts: boolean;
}

type Row = { -readonly [K in keyof PaymentAuthorization]: PaymentAuthorization[K] };

const RANK: Readonly<Record<PaymentStatus, number>> = {
  authorized: 0, submitted: 1, unknown: 1, pending: 2, succeeded: 3, failed: 3,
};

/** Files one receipt per operation id, like file_receipt; `failure` makes every call throw. */
export class FakeReceipts implements ReceiptFiler {
  readonly calls: { authorizationId: string; mode: PayPalMode }[] = [];
  readonly filed = new Set<string>();
  failure: Error | null = null;

  async file(authorizationId: string, mode: PayPalMode): Promise<FiledReceipt | null> {
    this.calls.push({ authorizationId, mode });
    if (this.failure !== null) {
      throw this.failure;
    }
    const created = !this.filed.has(authorizationId);
    this.filed.add(authorizationId);
    return { documentId: `receipt-of-${authorizationId}`, storagePath: null, created };
  }
}

export class FakeStore implements PayoutStore {
  readonly rows = new Map<string, Row>();
  /** The receipts the handlers filed for these operations. */
  readonly receipts = new FakeReceipts();
  readonly events = new Map<string, PayoutEvent>();
  readonly calls: string[] = [];
  readonly records: PayoutRecord[] = [];
  /** Milliseconds; the SQL's now(). */
  clock = Date.UTC(2026, 10, 2, 9, 0, 0);
  members: Member[] = [
    { userId: PM, role: 'pm', canViewCosts: false },
    { userId: CM, role: 'cm', canViewCosts: true },
  ];

  add(overrides: Partial<Row> = {}): Row {
    const row: Row = {
      id: AUTH_ID,
      project_id: PROJECT,
      status: 'authorized',
      amount_minor: 120000,
      currency: 'USD',
      recipient_email: 'supplier@test.local',
      paypal_batch_id: null,
      paypal_item_id: null,
      fee_minor: null,
      message: null,
      attempts: 0,
      submitted_at: null,
      raw: null,
      ...overrides,
    };
    this.rows.set(row.id, row);
    return row;
  }

  row(id = AUTH_ID): Row {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no row ${id}`);
    return row;
  }

  /** The read-only check before PayPal (supabase.ts payoutAccess), by the same rules; kept apart from `calls`. */
  readonly accessChecks: { authorizationId: string; actorId: string; kind: 'execute' | 'reconcile' }[] = [];

  async access(authorizationId: string, actorId: string, kind: 'execute' | 'reconcile'): Promise<PayoutAccess> {
    this.accessChecks.push({ authorizationId, actorId, kind });
    const row = this.rows.get(authorizationId);
    const member = this.members.find((m) => m.userId === actorId);
    if (!row || !member) return { ok: false, reason: 'not_found' };
    if (kind === 'execute' && !(member.role === 'cm' && member.canViewCosts)) return { ok: false, reason: 'forbidden' };
    return { ok: true, projectId: row.project_id };
  }

  async begin(authorizationId: string, actorId: string): Promise<PayoutStep> {
    this.calls.push('begin');
    const row = this.find('payout_begin', authorizationId);
    if (!this.members.some((m) => m.userId === actorId && m.role === 'cm' && m.canViewCosts)) {
      throw new StoreError('payout_begin: only the cost manager of the project sends payouts', '42501');
    }
    return this.takeAction(row, true);
  }

  async resume(authorizationId: string, actorId: string): Promise<PayoutStep> {
    this.calls.push('resume');
    const row = this.find('payout_resume', authorizationId);
    if (!this.members.some((m) => m.userId === actorId)) {
      throw new StoreError('payout_resume: not a member of the project', '42501');
    }
    return this.takeAction(row, false);
  }

  async record(update: PayoutRecord): Promise<PaymentAuthorization> {
    this.calls.push(`record:${update.status}`);
    this.records.push(update);
    const row = this.find('payout_record', update.authorizationId);
    const current = row.status;
    const wanted = update.status;
    const status =
      RANK[wanted] > RANK[current] ? wanted
      : current === 'succeeded' && wanted === 'failed' ? wanted
      : RANK[wanted] === RANK[current] && current !== 'succeeded' && current !== 'failed' ? wanted
      : current;
    // As payout_record: message and raw come with the status that is recorded, never with an ignored one.
    if (wanted === status) {
      row.message = update.message ?? null;
      row.raw = update.raw ?? row.raw;
    }
    row.status = status;
    row.paypal_batch_id = row.paypal_batch_id ?? update.batchId ?? null;
    row.paypal_item_id = row.paypal_item_id ?? update.itemId ?? null;
    row.fee_minor = update.feeMinor ?? row.fee_minor;
    return { ...row };
  }

  async recordEvent(event: PayoutEvent): Promise<boolean> {
    this.calls.push('event');
    this.find('payout_record_event', event.authorizationId);
    if (this.events.has(event.eventId)) {
      return false;
    }
    this.events.set(event.eventId, event);
    return true;
  }

  private find(fn: string, id: string): Row {
    const row = this.rows.get(id);
    if (row === undefined) {
      throw new StoreError(`${fn}: payment authorization ${id} not found`, 'P0002');
    }
    return row;
  }

  private takeAction(row: Row, mayStart: boolean): PayoutStep {
    let action: PayoutAction;
    if (row.status === 'authorized') {
      action = mayStart ? 'submit' : 'none';
    } else if (row.status === 'succeeded' || row.status === 'failed') {
      action = 'none';
    } else if (row.paypal_batch_id !== null) {
      action = 'check';
    } else if (row.attempts >= 5) {
      action = 'none';
    } else if (row.submitted_at === null || Date.parse(row.submitted_at) < this.clock - 20_000) {
      action = 'submit';
    } else {
      action = 'wait';
    }
    if (action === 'submit') {
      row.status = 'submitted';
      row.submitted_at = new Date(this.clock).toISOString();
      row.attempts += 1;
    }
    return { action, authorization: { ...row } };
  }
}

export interface PayPalCall {
  method: string;
  path: string;
  headers: Headers;
  body: string | null;
  signal: AbortSignal | null;
}

type Responder = (call: PayPalCall) => Response | Promise<Response>;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function batchBody(overrides: { transactionStatus?: string; fee?: string; errors?: unknown; batchId?: string } = {}) {
  const batchId = overrides.batchId ?? 'BATCH-1';
  return {
    batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: AUTH_ID } },
    items: [
      {
        payout_item_id: 'ITEM-1',
        transaction_status: overrides.transactionStatus ?? 'SUCCESS',
        payout_item_fee: { value: overrides.fee ?? '0.25', currency: 'USD' },
        payout_batch_id: batchId,
        payout_item: { amount: { value: '1200.00', currency: 'USD' }, sender_item_id: AUTH_ID },
        ...(overrides.errors === undefined ? {} : { errors: overrides.errors }),
      },
    ],
  };
}

/** A scripted PayPal sandbox; replace a responder to script an answer, read `calls` to assert. */
export class FakePayPal {
  readonly calls: PayPalCall[] = [];
  token: Responder = () => jsonResponse(200, { access_token: 'TOKEN-1', token_type: 'Bearer', expires_in: 32400 });
  create: Responder = () =>
    jsonResponse(201, { batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } });
  batch: Responder = () => jsonResponse(200, batchBody());
  verify: Responder = () => jsonResponse(200, { verification_status: 'SUCCESS' });

  readonly fetch: Fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const call: PayPalCall = {
      method: init.method ?? 'GET',
      path: pathname,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
      signal: init.signal ?? null,
    };
    this.calls.push(call);
    if (pathname === '/v1/oauth2/token') return this.token(call);
    if (pathname === '/v1/payments/payouts' && call.method === 'POST') return this.create(call);
    if (pathname.startsWith('/v1/payments/payouts/')) return this.batch(call);
    if (pathname === '/v1/notifications/verify-webhook-signature') return this.verify(call);
    return jsonResponse(404, { name: 'RESOURCE_NOT_FOUND' });
  };

  paths(): string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  posts(): PayPalCall[] {
    return this.calls.filter((call) => call.method === 'POST' && call.path === '/v1/payments/payouts');
  }
}

/** A PayPal that never replies: the request fails only when its signal aborts. */
export const hangingResponse: Responder = (call) =>
  new Promise((_, reject) => {
    call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

export const LIVE_ENV: Readonly<Record<string, string>> = {
  PAYPAL_MODE: 'live',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_CLIENT_ID: 'client-id',
  PAYPAL_CLIENT_SECRET: 'client-secret',
  PAYPAL_WEBHOOK_ID: 'WH-ID-1',
};

export const TOKENS: Readonly<Record<string, string>> = { 'cm-token': CM, 'pm-token': PM, 'outsider-token': OUTSIDER };

export function envOf(values: Readonly<Record<string, string>>) {
  return { get: (name: string) => values[name] };
}

export function payoutHandler(
  kind: 'execute' | 'reconcile',
  store: FakeStore,
  paypal: FakePayPal,
  env: Readonly<Record<string, string>> = LIVE_ENV,
  timeoutMs = 1_000,
): Handler {
  return createPayoutHandler({
    kind,
    env: envOf(env),
    fetch: paypal.fetch,
    store,
    receipts: store.receipts,
    timeoutMs,
    resolveUser: async (token) => TOKENS[token] ?? null,
    access: (authorizationId, actorId, asked) => store.access(authorizationId, actorId, asked),
  });
}

export function webhookHandler(
  store: FakeStore,
  paypal: FakePayPal,
  env: Readonly<Record<string, string>> = LIVE_ENV,
): Handler {
  return createWebhookHandler({ env: envOf(env), fetch: paypal.fetch, store, receipts: store.receipts, timeoutMs: 1_000 });
}

export function payoutRequest(body: unknown, token: string | null = 'cm-token'): Request {
  return new Request('http://localhost/functions/v1/paypal-execute-payout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const TRANSMISSION_HEADERS: Readonly<Record<string, string>> = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'TX-1',
  'paypal-transmission-sig': 'SIG-1',
  'paypal-transmission-time': '2026-11-02T09:00:00Z',
};

export function webhookRequest(rawBody: string, headers: Readonly<Record<string, string>> = TRANSMISSION_HEADERS): Request {
  return new Request('http://localhost/functions/v1/paypal-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** What the live sandbox answered to a resent payout (2026-10-22), links trimmed to the one that matters. */
export const SANDBOX_BATCH_EXISTS = {
  name: 'USER_BUSINESS_ERROR',
  message: 'User business error.',
  debug_id: 'f697176cb812c',
  information_link: 'https://developer.paypal.com/docs/api/payments.payouts-batch/#errors',
  details: [
    {
      field: 'SENDER_BATCH_ID',
      location: 'body',
      issue: 'Batch with given sender_batch_id already exists',
      link: [{ rel: 'self', href: 'https://api.sandbox.paypal.com/v1/payments/payouts/XNK4D4A55AQ5G', method: 'GET', encType: 'application/json' }],
    },
  ],
};

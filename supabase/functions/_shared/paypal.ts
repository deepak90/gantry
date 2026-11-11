/**
 * The PayPal REST calls a payout needs, over an injected `fetch`. Live mode passes the platform
 * fetch and talks to the sandbox; mock mode passes `mockPayPalFetch` (paypal-mock.ts), so both modes
 * run the same request building, idempotency headers and error handling.
 *
 * Every call has a deadline. A request that times out or cannot connect comes back as `unreachable`
 * rather than throwing: for a payout that is an unknown outcome, settled later by re-sending the
 * same request id.
 *
 * The OAuth access token is kept for the life of the function instance, until a minute before PayPal
 * says it expires (`expires_in`), so a request costs PayPal one call, not two. Tokens are kept per
 * `fetch` and app credentials. A call PayPal answers 401 drops the token, signs in again and repeats
 * once: every call that changes something carries a PayPal-Request-Id, or was refused unprocessed.
 */
import { minorToDecimal } from './amounts.ts';
import { asObject, text } from './json.ts';
import { describePayPalError } from './outcomes.ts';

export type PayPalMode = 'live' | 'mock';

/** PAYPAL_ENV=sandbox is the only environment this project talks to. */
export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';

/**
 * Shorter than the 20 seconds after which `payout_take_action` re-sends a submitted attempt, so a
 * slow POST has given up before a retry with the same request id can be in flight beside it.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type PayPalReply =
  | { kind: 'reply'; status: number; body: unknown }
  | { kind: 'unreachable'; message: string };

export interface PayoutRequest {
  /** The payment_authorizations id: sender_batch_id, sender_item_id and PayPal-Request-Id at once. */
  authorizationId: string;
  amountMinor: number;
  currency: string;
  recipientEmail: string;
}

/** The `paypal-*` transmission headers of a webhook delivery. */
export interface WebhookTransmission {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

/** Calls made with one OAuth access token. */
export interface PayPalSession {
  createPayout(request: PayoutRequest): Promise<PayPalReply>;
  getPayoutBatch(batchId: string): Promise<PayPalReply>;
  /** `rawEvent` is the webhook body exactly as delivered. */
  verifyWebhookSignature(transmission: WebhookTransmission, webhookId: string, rawEvent: string): Promise<PayPalReply>;
  /** Any other authorized call (invoices.ts). */
  request(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }): Promise<PayPalReply>;
}

export interface PayPalApi {
  readonly mode: PayPalMode;
  /** Obtains an access token; throws `PayPalAuthError` when PayPal refuses or cannot be reached. */
  connect(): Promise<PayPalSession>;
}

export type PayPalAuthErrorCode = 'PAYPAL_AUTH_FAILED' | 'PAYPAL_UNAVAILABLE';

export class PayPalAuthError extends Error {
  readonly code: PayPalAuthErrorCode;

  constructor(code: PayPalAuthErrorCode, message: string) {
    super(message);
    this.name = 'PayPalAuthError';
    this.code = code;
  }
}

export interface PayPalApiOptions {
  mode: PayPalMode;
  clientId: string;
  clientSecret: string;
  fetch: Fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** The clock the token's expiry is read against (Date.now unless a test passes its own). */
  now?: () => number;
}

/** A kept token is used until this long before PayPal says it expires. */
export const TOKEN_EARLY_MS = 60_000;

interface KeptToken {
  value: string;
  /** When to stop using it, on `now()`'s clock. */
  until: number;
}

/** The tokens of this instance, per fetch and then per app credentials, and the sign-ins in flight. */
const tokenShelves = new WeakMap<Fetch, { kept: Map<string, KeptToken>; signingIn: Map<string, Promise<string>> }>();

function shelfOf(fetch: Fetch) {
  let shelf = tokenShelves.get(fetch);
  if (!shelf) {
    shelf = { kept: new Map(), signingIn: new Map() };
    tokenShelves.set(fetch, shelf);
  }
  return shelf;
}

export function createPayPalApi(options: PayPalApiOptions): PayPalApi {
  const baseUrl = options.baseUrl ?? PAYPAL_SANDBOX_API;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const call: Call = (path, init) => send(options.fetch, `${baseUrl}${path}`, init, timeoutMs);
  const shelf = shelfOf(options.fetch);
  const key = `${baseUrl}\n${options.clientId}\n${options.clientSecret}`;

  const signIn = async (): Promise<string> => {
    const reply = await call('/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    if (reply.kind === 'unreachable' || reply.status >= 500) {
      const reason = reply.kind === 'unreachable' ? reply.message : describePayPalError(reply.status, reply.body);
      throw new PayPalAuthError('PAYPAL_UNAVAILABLE', `Could not sign in to PayPal (${reason}). Nothing was sent; try again shortly.`);
    }
    const token = text(asObject(reply.body).access_token);
    if (reply.status !== 200 || token === null) {
      throw new PayPalAuthError(
        'PAYPAL_AUTH_FAILED',
        `PayPal rejected the app credentials (${describePayPalError(reply.status, reply.body)}). Put the Sandbox ` +
          'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET of a REST app with Payouts enabled in .env.local and restart ' +
          '`pnpm functions:serve`, or set PAYPAL_MODE=mock. Nothing was sent.',
      );
    }
    // Kept until a minute before it expires; a token without a lifetime is used for this request only.
    const lifetimeMs = Number(asObject(reply.body).expires_in) * 1000;
    if (Number.isFinite(lifetimeMs) && lifetimeMs > TOKEN_EARLY_MS) shelf.kept.set(key, { value: token, until: now() + lifetimeMs - TOKEN_EARLY_MS });
    return token;
  };

  /** The kept token while it is fresh, else a sign-in (one at a time: requests that arrive meanwhile share it). */
  const token = (): Promise<string> => {
    const kept = shelf.kept.get(key);
    if (kept && now() < kept.until) return Promise.resolve(kept.value);
    let pending = shelf.signingIn.get(key);
    if (!pending) {
      pending = signIn().finally(() => shelf.signingIn.delete(key));
      shelf.signingIn.set(key, pending);
    }
    return pending;
  };

  /** PayPal stopped taking this token: it is no longer kept (unless a newer one already replaced it). */
  const forget = (used: string): void => {
    if (shelf.kept.get(key)?.value === used) shelf.kept.delete(key);
  };

  return {
    mode: options.mode,
    async connect() {
      return createSession(call, await token(), token, forget);
    },
  };
}

type Call = (path: string, init: RequestInit) => Promise<PayPalReply>;

function createSession(call: Call, first: string, token: () => Promise<string>, forget: (used: string) => void): PayPalSession {
  let current = first;
  const headers = (bearer: string, extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  });
  /** One call with the token; on a 401, once more with a new one (the 401 stands when no new one can be had). */
  const authorized = async (path: string, init: (bearer: string) => RequestInit): Promise<PayPalReply> => {
    const used = current;
    const reply = await call(path, init(used));
    if (reply.kind !== 'reply' || reply.status !== 401) return reply;
    forget(used);
    try {
      current = await token();
    } catch {
      return reply;
    }
    return call(path, init(current));
  };
  return {
    request(path, init) {
      return authorized(path, (bearer) => ({
        method: init.method,
        headers: headers(bearer, init.headers ?? {}),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }));
    },
    createPayout(request) {
      return authorized('/v1/payments/payouts', (bearer) => ({
        method: 'POST',
        headers: headers(bearer, { 'PayPal-Request-Id': request.authorizationId }),
        body: JSON.stringify(payoutRequestBody(request)),
      }));
    },
    getPayoutBatch(batchId) {
      return authorized(`/v1/payments/payouts/${encodeURIComponent(batchId)}`, (bearer) => ({ method: 'GET', headers: headers(bearer) }));
    },
    verifyWebhookSignature(transmission, webhookId, rawEvent) {
      // PayPal checks the signature against the event bytes it sent, so the event goes back
      // verbatim: re-serializing the parsed body can change spacing or number formatting.
      const envelope = JSON.stringify({
        auth_algo: transmission.authAlgo,
        cert_url: transmission.certUrl,
        transmission_id: transmission.transmissionId,
        transmission_sig: transmission.transmissionSig,
        transmission_time: transmission.transmissionTime,
        webhook_id: webhookId,
      });
      return authorized('/v1/notifications/verify-webhook-signature', (bearer) => ({
        method: 'POST',
        headers: headers(bearer),
        body: `${envelope.slice(0, -1)},"webhook_event":${rawEvent}}`,
      }));
    },
  };
}

/** The Payouts v1 body: one EMAIL item whose ids are the authorization id, so a retry is the same request. */
export function payoutRequestBody(request: PayoutRequest) {
  return {
    sender_batch_header: {
      sender_batch_id: request.authorizationId,
      email_subject: 'You have a payment for an approved equipment rental',
      email_message: 'The cost manager approved this equipment rental payment in the project cost review.',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: minorToDecimal(request.amountMinor), currency: request.currency },
        receiver: request.recipientEmail,
        note: `Equipment rental payment, payment authorization ${request.authorizationId}`,
        sender_item_id: request.authorizationId,
      },
    ],
  };
}

async function send(fetch: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<PayPalReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race keeps the deadline even for a fetch that ignores its abort signal.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async (): Promise<PayPalReply> => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return { kind: 'reply', status: response.status, body: parseBody(await response.text()) };
      })(),
      deadline,
    ]);
  } catch (error) {
    const message = controller.signal.aborted
      ? `no answer within ${timeoutMs / 1000} s`
      : error instanceof Error ? error.message : String(error);
    return { kind: 'unreachable', message };
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(raw: string): unknown {
  if (raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

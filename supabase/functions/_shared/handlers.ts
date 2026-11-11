/**
 * The three functions as plain `(Request) => Promise<Response>` handlers over injected dependencies,
 * so the whole HTTP contract runs under Vitest; the Deno entry points only wire them to the runtime.
 *
 * paypal-execute-payout and paypal-reconcile (browser, `supabase.functions.invoke`):
 *   POST { authorization_id } with the user's JWT → 200 { authorization, action, mode, notice }
 *   Order: body → PayPal config → user → may this user act on this payment (read only; a stranger's request, or one
 *   for a payment that doesn't exist, ends here) → the user's allowance of PayPal calls (rate-limit.ts) → PayPal
 *   sign-in (a kept token, paypal.ts) → payout_begin / payout_resume → PayPal.
 *   Signing in before payout_begin means a credentials problem never leaves a claimed attempt behind.
 *
 * paypal-webhook (PayPal, no JWT): see webhook.ts.
 *
 * Whenever a call leaves the operation succeeded (execute, reconcile or a webhook), its payment
 * receipt is filed (receipt.ts) before the response: once per operation, and a failure to file it
 * is logged rather than returned, so the next status check of a paid payout files it instead.
 *
 * Before a payout's first send, once payout_begin has said who may send it: on the hosted site (GANTRY_HOSTED=1)
 * payments must be switched on; live, the rental's payee must not be an address set up as another party's sandbox
 * account (accounts.ts), since the screen says who was paid; and on the hosted site the send counts against the copy's
 * caps (hosted.ts). A refusal there is recorded as failed, with its reason, so nothing re-sends it and nobody reads it
 * as PayPal paying; the answer's code (PAYMENTS_OFF, PAYEE_REFUSED, QUOTA_REACHED) says nothing reached PayPal.
 *
 * Every failure is `{ error, code }`: 400 INVALID_REQUEST, 401 UNAUTHORIZED, 403 FORBIDDEN, 404 NOT_FOUND (no such
 * payment, or one in a project the user is not a member of), 405 METHOD_NOT_ALLOWED, 409 PAYEE_REFUSED,
 * 429 QUOTA_REACHED / RATE_LIMITED, 503 PAYMENTS_OFF / PAYPAL_NOT_CONFIGURED / PAYPAL_AUTH_FAILED / PAYPAL_UNAVAILABLE /
 * WEBHOOK_NOT_CONFIGURED, 401 WEBHOOK_SIGNATURE_INVALID, and 500 INTERNAL_ERROR with a `request_id` (failures.ts).
 */
import { rentalPayeeRefusal, type SandboxAccounts } from './accounts.ts';
import { readPayPalConfig, type Env, type PayPalConfig } from './config.ts';
import { corsHeaders } from './cors.ts';
import { publicError } from './failures.ts';
import { countPayment, isHosted, requirePaymentsOn, type PaymentLimits } from './hosted.ts';
import { bearerToken, errorResponse, HttpError, json, readAuthorizationId, type Log } from './http.ts';
import { advancePayout } from './payouts.ts';
import { mockPayPalFetch } from './paypal-mock.ts';
import { createPayPalApi, type Fetch, type PayPalApi, type PayPalMode } from './paypal.ts';
import type { RateGate } from './rate-limit.ts';
import type { ReceiptFiler } from './receipt.ts';
import { StoreError, type PaymentAuthorization, type PayoutStore } from './store.ts';
import { processWebhook } from './webhook.ts';

export type { Log };

export interface FunctionDeps {
  env: Env;
  /** Used for PayPal in live mode; mock mode always uses `mockPayPalFetch`. */
  fetch: Fetch;
  store: PayoutStore;
  /** Files the payment receipt of a succeeded payout (once per operation). */
  receipts: ReceiptFiler;
  /** Per-request PayPal deadline (DEFAULT_TIMEOUT_MS when omitted). */
  timeoutMs?: number;
  log?: Log;
}

/**
 * Whether a user may act on a payment authorization, read before PayPal is asked anything: the project it belongs to,
 * or why not. `not_found` covers both a payment that doesn't exist and one in a project the user isn't a member of,
 * so a stranger learns nothing about other copies' payments.
 */
export type PayoutAccess = { ok: true; projectId: string } | { ok: false; reason: 'not_found' | 'forbidden' };

export interface PayoutHandlerDeps extends FunctionDeps {
  /** execute: payout_begin (the cost manager sends); reconcile: payout_resume (any member refreshes). */
  kind: 'execute' | 'reconcile';
  /** The user id behind a valid access token, or null. */
  resolveUser(accessToken: string): Promise<string | null>;
  /**
   * May this user send the payout (execute: the project's cost manager, who sees costs) or follow it (reconcile: any
   * member)? payout_begin and payout_resume decide again under the row's lock; this keeps everyone else from PayPal.
   */
  access(authorizationId: string, userId: string, kind: 'execute' | 'reconcile'): Promise<PayoutAccess>;
  /** Counts the user's calls to PayPal (rate-limit.ts); without one nothing is counted. */
  rateGate?: RateGate;
  /** The sandbox accounts of the demo's parties, to refuse a payout into another party's account (live). */
  accounts?: SandboxAccounts;
  /** The firm a payment authorization pays (its rental's supplier); null when the database has no such rental. */
  supplierOf?(authorizationId: string): Promise<string | null>;
  /** The hosted site's switch and caps (GANTRY_HOSTED=1). */
  limits?: PaymentLimits;
}

export type Handler = (request: Request) => Promise<Response>;

/** What a refused payment says: plain words, no database names. */
const NO_SUCH_PAYMENT = 'There’s no such payment in your projects.';
const FORBIDDEN_TO: Readonly<Record<PayoutHandlerDeps['kind'], string>> = {
  execute: 'Only the project’s cost manager can send this payout.',
  reconcile: 'Only a member of this project can check this payout.',
};

export function createPayoutHandler(deps: PayoutHandlerDeps): Handler {
  return async (request) => {
    const cors = corsHeaders(request, deps.env);
    if (request.method === 'OPTIONS') {
      return new Response('ok', { headers: cors });
    }
    try {
      if (request.method !== 'POST') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST with { "authorization_id": "<uuid>" }.');
      }
      const authorizationId = await readAuthorizationId(request);
      const config = readPayPalConfig(deps.env);
      const actorId = await authenticate(request, deps.resolveUser);
      // Who may act on it, read before PayPal is reached: a stranger's request ends here.
      const access = await deps.access(authorizationId, actorId, deps.kind);
      if (!access.ok) {
        throw access.reason === 'forbidden' ? new HttpError(403, 'FORBIDDEN', FORBIDDEN_TO[deps.kind]) : new HttpError(404, 'NOT_FOUND', NO_SUCH_PAYMENT);
      }
      // Sending asks PayPal to pay; checking asks where a payment stands (the page asks that by itself while it waits).
      await deps.rateGate?.(deps.kind === 'execute' ? 'paypal_call' : 'paypal_read', actorId, access.projectId);
      const paypal = await payPalApi(config, deps).connect();
      const step =
        deps.kind === 'execute'
          ? await deps.store.begin(authorizationId, actorId)
          : await deps.store.resume(authorizationId, actorId);
      // A payout's first send is checked first; a repeat of the same send (a lost answer) was checked when it was first sent.
      if (deps.kind === 'execute' && step.action === 'submit' && step.authorization.attempts === 1) await clearFirstSend(deps, config, step.authorization);
      const progress = await advancePayout(step, paypal, deps.store);
      await fileReceiptIfPaid(deps, progress.authorization, config.mode);
      return json(
        200,
        { authorization: progress.authorization, action: step.action, mode: config.mode, notice: progress.notice },
        cors,
      );
    } catch (error) {
      return errorResponse(toHttpError(error, deps), cors);
    }
  };
}

export function createWebhookHandler(deps: FunctionDeps): Handler {
  return async (request) => {
    try {
      if (request.method !== 'POST') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'PayPal delivers webhooks with POST.');
      }
      const config = readPayPalConfig(deps.env);
      const result = await processWebhook({
        rawBody: await request.text(),
        headers: request.headers,
        config,
        paypal: payPalApi(config, deps),
        store: deps.store,
      });
      if (result.authorization !== undefined) {
        await fileReceiptIfPaid(deps, result.authorization, config.mode);
      }
      return json(result.status, result.body);
    } catch (error) {
      return errorResponse(toHttpError(error, deps));
    }
  };
}

/**
 * What has to hold before a payout's first send: payments switched on (hosted), a payee that is not another party's
 * sandbox account (live), and room under the copy's caps (hosted, where the send is then counted). payout_begin has
 * already claimed the attempt, so a refusal, or a check that could not be made, records it as failed with the reason:
 * nothing was sent, and nothing will re-send it.
 */
async function clearFirstSend(deps: PayoutHandlerDeps, config: PayPalConfig, authorization: PaymentAuthorization): Promise<void> {
  try {
    await requirePaymentsOn(deps.env, deps.limits);
    const supplier = config.mode === 'live' && deps.accounts && deps.supplierOf ? await deps.supplierOf(authorization.id) : null;
    const refusal = supplier && deps.accounts ? rentalPayeeRefusal(deps.accounts, supplier, authorization.recipient_email) : null;
    if (refusal) {
      deps.log?.(`refused the payout of ${authorization.id}: its address is another party's sandbox account (${deps.accounts?.alsoOf(supplier!, authorization.recipient_email)})`);
      throw new HttpError(409, 'PAYEE_REFUSED', refusal);
    }
    if (isHosted(deps.env)) await countPayment(deps.env, deps.limits, 'payout', authorization.project_id, authorization.amount_minor);
  } catch (error) {
    const message = error instanceof HttpError ? error.message : 'The payout could not be checked before it was sent, so it was not sent.';
    await deps.store.record({ authorizationId: authorization.id, status: 'failed', message });
    throw error;
  }
}

/** The receipt never decides the payout's answer: a failure is logged and retried by the next check. */
async function fileReceiptIfPaid(deps: FunctionDeps, authorization: PaymentAuthorization, mode: PayPalMode): Promise<void> {
  if (authorization.status !== 'succeeded') {
    return;
  }
  try {
    await deps.receipts.file(authorization.id, mode);
  } catch (error) {
    deps.log?.(`filing the payment receipt of ${authorization.id} failed; the next status check retries`, error);
  }
}

function payPalApi(config: PayPalConfig, deps: FunctionDeps): PayPalApi {
  return createPayPalApi({
    mode: config.mode,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetch: config.mode === 'mock' ? mockPayPalFetch : deps.fetch,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
}

async function authenticate(request: Request, resolveUser: PayoutHandlerDeps['resolveUser']): Promise<string> {
  const token = bearerToken(request);
  const userId = token === null ? null : await resolveUser(token);
  if (userId === null) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Sign in again: the request carries no valid user session.');
  }
  return userId;
}

/**
 * The answer for a failure. The payout RPCs' own refusals (who may act changed between the check above and the row's
 * lock) are said in plain words, since their messages name the RPC; anything unplanned is a 500 with a request id.
 */
function toHttpError(error: unknown, deps: Pick<PayoutHandlerDeps, 'env' | 'log'> & { kind?: PayoutHandlerDeps['kind'] }): HttpError {
  if (error instanceof StoreError && error.sqlstate === '42501') {
    return new HttpError(403, 'FORBIDDEN', FORBIDDEN_TO[deps.kind ?? 'reconcile']);
  }
  if (error instanceof StoreError && error.sqlstate === 'P0002') {
    return new HttpError(404, 'NOT_FOUND', NO_SUCH_PAYMENT);
  }
  return publicError(error, deps.env, deps.log);
}

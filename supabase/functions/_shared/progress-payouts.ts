/**
 * Progress payments (pay to proceed, apps/web/src/gantt/pay-gates.ts): one PayPal Payouts batch pays every firm a
 * payment gate's progress payment owes, each to its own sandbox account, from the PayPal balance of the business
 * account behind the REST app. The same code runs behind the dev server's route on this machine (apps/web/paypal-dev.ts)
 * and behind the paypal-progress-payout function on the hosted site:
 *
 *   1. the page's request is checked (`batchRequest`);
 *   2. live, each firm is paid to its own sandbox account (accounts.ts): a firm with none, or with an account set up for
 *      anyone else, is refused, since the screen says who was paid;
 *   3. the payout is claimed with the sender's own Supabase token (`claim_pay_gate_payout`), which refuses a payout over
 *      the project's threshold unless someone else who sees costs approved exactly these firms and amounts, and uses that
 *      approval up;
 *   4. on the hosted site the payout counts against the copy's caps (hosted.ts);
 *   5. PayPal is asked to pay, with the page's batch id as sender_batch_id and PayPal-Request-Id, so a press after a lost
 *      answer is the same request, which PayPal never pays twice: it refuses the repeat, and the batch it already has is
 *      read back instead.
 *
 * The page then asks for the batch until PayPal settles it (`readProgressPayout`) and writes the outcome to the plan. On
 * a copy of the demo the database counts what each gate has paid; a firm's payment PayPal failed or turned down stops
 * counting when the batch is read (`unpaidOf`), so the next try can pay what is left.
 * A refusal before PayPal (`refused: true`) sent nothing, so the page leaves the plan as it is.
 */
import { firmAccounts, type SandboxAccounts } from './accounts.ts';
import { feeMinor, minorToDecimal } from './amounts.ts';
import type { ProgressBatch, ProgressBatchLog } from './batch-log.ts';
import { readPayPalConfig, type Env } from './config.ts';
import { corsHeaders } from './cors.ts';
import { internalError, publicError } from './failures.ts';
import { countPayment, isHosted, requirePaymentsOn, type PaymentLimits } from './hosted.ts';
import { bearerToken, HttpError, json, type ErrorCode } from './http.ts';
import { asObject, isUuid, text } from './json.ts';
import { existingBatchId, mayAlreadyExist } from './outcomes.ts';
import { mockPayPalFetch } from './paypal-mock.ts';
import { createPayPalApi, type Fetch, type PayPalReply, type PayPalSession } from './paypal.ts';
import type { RateGate } from './rate-limit.ts';

/** One firm's share of the batch, as the page sends it. */
export interface BatchItem {
  itemId: string;
  firm: string;
  amountMinor: number;
  note: string;
}

export interface BatchRequest {
  batchId: string;
  currency: string;
  subject: string;
  message: string;
  items: BatchItem[];
  /** The project and the payment gate (its milestone's task id) the payout is for. */
  projectId: string;
  gateId: number;
  /** The second person's approval of this payout (a `pay_gate_approvals` row), when it is over the threshold. */
  approvalId: string | null;
}

const SAFE_ID = /^[A-Za-z0-9._-]{6,60}$/;
/** PayPal's batch ids, and the longer ones the mock makes (paypal-mock.ts). */
const BATCH_ID = /^[A-Za-z0-9._-]{6,200}$/;

/** The request as the page sent it, checked; null when it isn't one. */
export function batchRequest(body: unknown): BatchRequest | null {
  const value = body as Partial<BatchRequest> | null;
  if (!value || typeof value !== 'object' || typeof value.batchId !== 'string' || !SAFE_ID.test(value.batchId)) return null;
  if (!isUuid(value.projectId) || !Number.isSafeInteger(value.gateId) || (value.gateId as number) <= 0) return null;
  if (value.approvalId !== null && value.approvalId !== undefined && !isUuid(value.approvalId)) return null;
  if (value.currency !== 'USD' || !Array.isArray(value.items) || value.items.length === 0 || value.items.length > 50) return null;
  for (const item of value.items as unknown[]) {
    const line = item as Partial<BatchItem> | null;
    if (!line || typeof line !== 'object' || typeof line.itemId !== 'string' || !SAFE_ID.test(line.itemId)) return null;
    if (typeof line.firm !== 'string' || line.firm.trim().length === 0 || line.firm.length > 80) return null;
    if (!Number.isSafeInteger(line.amountMinor) || (line.amountMinor as number) <= 0 || (line.amountMinor as number) > 6_000_000) return null;
    // PayPal reads a note starting with these as a negative test.
    if (typeof line.note !== 'string' || line.note.length > 4000 || /^(ERRPYO|POSPYO)/.test(line.note)) return null;
  }
  const items = (value.items as BatchItem[]).map(({ itemId, firm, amountMinor, note }) => ({ itemId, firm, amountMinor, note }));
  if (new Set(items.map((item) => item.itemId)).size !== items.length) return null;
  return {
    batchId: value.batchId,
    currency: 'USD',
    subject: String(value.subject ?? 'You have a progress payment').slice(0, 255),
    message: String(value.message ?? '').slice(0, 1000),
    items,
    projectId: value.projectId,
    gateId: value.gateId as number,
    approvalId: value.approvalId ?? null,
  };
}

/** What the payout comes to: every firm's amount. */
export const totalOf = (request: BatchRequest): number => request.items.reduce((sum, item) => sum + item.amountMinor, 0);

// ---------------------------------------------------------------------------------------------
// The database's say
// ---------------------------------------------------------------------------------------------

/** Where the payout is claimed: the project's Supabase, as the page's own user. */
export interface ClaimTarget {
  supabaseUrl: string;
  anonKey: string;
  fetch: Fetch;
}

/**
 * The database's answer to a claim: allowed (with the approval used, if one was needed; `resumed` when it was used
 * before for this very batch, sent again after its answer was lost), or refused with its reason.
 */
export type Claim = { ok: true; approvalId: string | null; approvedBy: string | null; resumed?: boolean } | { ok: false; status: number; error: string };

/**
 * Claims the payout for the person whose token this is, before anything goes to PayPal. Refused without a token,
 * and whenever the database refuses: over the threshold with no fresh, unused approval of these firms and amounts
 * by someone else who sees costs, or by anyone who may not pay.
 */
export async function claimPayout(request: BatchRequest, token: string | null, target: ClaimTarget): Promise<Claim> {
  if (!token) return { ok: false, status: 401, error: 'Sign in again: the payout needs your login.' };
  if (!target.supabaseUrl || !target.anonKey) return { ok: false, status: 500, error: 'There is no Supabase URL or key to check the payout with.' };
  let response: Response;
  try {
    response = await target.fetch(`${target.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/claim_pay_gate_payout`, {
      method: 'POST',
      headers: { apikey: target.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_project: request.projectId,
        p_gate: request.gateId,
        p_amount_minor: totalOf(request),
        p_currency: request.currency,
        // Each firm's item id too: on a copy of the demo, PayPal's word on an item later says which firm it did not pay.
        p_lines: request.items.map((item) => ({ firm: item.firm, amount_minor: item.amountMinor, item_id: item.itemId })),
        p_approval: request.approvalId,
        p_sender_batch_id: request.batchId,
      }),
    });
  } catch (error) {
    return { ok: false, status: 503, error: `The database could not be reached to check the payout (${error instanceof Error ? error.message : String(error)}).` };
  }
  const body = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    const said = text(body.message) ?? `The database answered ${response.status}.`;
    return { ok: false, status: response.status === 401 ? 401 : 403, error: said.replace(/^claim_pay_gate_payout:\s*/, '').replace(/^./, (first) => first.toUpperCase()) };
  }
  return { ok: true, approvalId: text(body.approval_id), approvedBy: text(body.approved_by), ...(body.resumed === true ? { resumed: true } : {}) };
}

// ---------------------------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------------------------

/**
 * What the page reads back: PayPal's batch and each firm's payment, in PayPal's own status words, with the fees
 * PayPal reports (`batch_header.fees` for the batch, `payout_item_fee` for each payment; null until it reports one).
 */
export interface ProgressBatchStatus {
  batchId: string;
  status: string;
  feeMinor: number | null;
  items: { itemId: string; status: string; transactionId: string | null; feeMinor: number | null; error: string | null }[];
}

/** PayPal's reply (the create call's or the batch read's) as the page reads it. */
export function statusOf(body: unknown): ProgressBatchStatus {
  const header = asObject(asObject(body).batch_header);
  const items = Array.isArray(asObject(body).items) ? (asObject(body).items as unknown[]) : [];
  const currency = text(asObject(header.amount).currency);
  return {
    batchId: text(header.payout_batch_id) ?? '',
    status: text(header.batch_status) ?? 'UNKNOWN',
    feeMinor: feeMinor(header.fees, currency),
    items: items.map((raw) => {
      const item = asObject(raw);
      const errors = asObject(item.errors);
      return {
        itemId: text(asObject(item.payout_item).sender_item_id) ?? '',
        status: text(item.transaction_status) ?? 'PENDING',
        transactionId: text(item.transaction_id),
        feeMinor: feeMinor(item.payout_item_fee, text(asObject(asObject(item.payout_item).amount).currency)),
        error: text(errors.message) ?? text(errors.name),
      };
    }),
  };
}

/** The Payouts body: one EMAIL item per firm, to its account, with the page's ids, so a repeat is the same request. */
export function payoutBody(request: BatchRequest, receiver: (firm: string) => string) {
  return {
    sender_batch_header: { sender_batch_id: request.batchId, email_subject: request.subject, email_message: request.message },
    items: request.items.map((item) => ({
      recipient_type: 'EMAIL',
      amount: { value: minorToDecimal(item.amountMinor), currency: request.currency },
      receiver: receiver(item.firm),
      note: item.note,
      sender_item_id: item.itemId,
    })),
  };
}

/** PayPal's refusal, or why it could not be reached, as one sentence. */
export function paypalError(reply: PayPalReply): string {
  if (reply.kind === 'unreachable') return `PayPal could not be reached (${reply.message}).`;
  const body = asObject(reply.body);
  const details = Array.isArray(body.details) ? body.details.map((detail) => text(asObject(detail).issue) ?? text(asObject(detail).description)).filter(Boolean) : [];
  return [text(body.message) ?? `PayPal answered ${reply.status}`, ...details].join(' ');
}

const slug = (firm: string) => firm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'firm';

/** Where a firm is paid: its own sandbox account; with the mock (nothing leaves the machine), a stand-in address. */
export function receiverOf(accounts: SandboxAccounts): (firm: string) => string {
  return (firm) => accounts.of(firm) ?? `sb-${slug(firm)}@personal.example.com`;
}

/** An answer for the page: the HTTP status and the body, the same from the route and from the function. */
export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const refusal = (status: number, error: string, code?: ErrorCode): Answer => ({ status, body: { error, refused: true, ...(code ? { code } : {}) } });

export interface Clearance {
  /** Live: pays to the firms' own sandbox accounts, so each must have one, set up for nobody else. */
  live: boolean;
  accounts: SandboxAccounts;
  /** Claims the payout with the sender's own token (claimPayout). */
  claim(request: BatchRequest): Promise<Claim>;
  /** Counts the payout against the hosted site's caps; throws an HttpError when one is reached. */
  count?(request: BatchRequest): Promise<void>;
}

/** Steps 2 to 4: a refusal, with nothing sent; or the go-ahead, with the approval it used. */
export async function clearProgressPayout(request: BatchRequest, clearance: Clearance): Promise<{ ok: false; answer: Answer } | { ok: true; approvalId: string | null }> {
  if (clearance.live) {
    const firms = firmAccounts(
      request.items.map((item) => item.firm),
      clearance.accounts,
    );
    if (!firms.ok) return { ok: false, answer: refusal(409, firms.error, 'PAYEE_REFUSED') };
  }
  // The database says whether this person may send it, and uses up the second person's approval.
  const claim = await clearance.claim(request);
  if (!claim.ok) return { ok: false, answer: refusal(claim.status, claim.error, claim.status === 401 ? 'UNAUTHORIZED' : 'PAYOUT_REFUSED') };
  // A batch sent again after its answer was lost was counted when it was first sent.
  if (clearance.count && !claim.resumed) {
    try {
      await clearance.count(request);
    } catch (error) {
      if (error instanceof HttpError) return { ok: false, answer: refusal(error.status, error.message, error.code) };
      throw error;
    }
  }
  return { ok: true, approvalId: claim.approvalId };
}

/** Step 5: PayPal pays the batch; a repeat of one PayPal already has reads that batch back instead. */
export async function submitProgressPayout(request: BatchRequest, receiver: (firm: string) => string, paypal: PayPalSession): Promise<Answer> {
  const sent = await paypal.request('/v1/payments/payouts', { method: 'POST', body: payoutBody(request, receiver), headers: { 'PayPal-Request-Id': request.batchId } });
  // PayPal already has a batch with this id: an earlier press whose answer was lost. Nothing is paid twice; the page
  // carries on watching that batch.
  if (sent.kind !== 'unreachable' && sent.status >= 300 && mayAlreadyExist(sent.status, sent.body)) {
    const existing = existingBatchId(sent.body);
    const read = existing ? await paypal.request(`/v1/payments/payouts/${encodeURIComponent(existing)}`, { method: 'GET' }) : null;
    if (read && read.kind !== 'unreachable' && read.status < 300) return { status: 201, body: { ...statusOf(read.body), resumed: true } };
    return { status: 409, body: { error: 'PayPal already has this payout, so it was not sent again. Check PayPal before paying it another way.', code: 'PAYPAL_REFUSED' } };
  }
  if (sent.kind === 'unreachable' || sent.status >= 300) return { status: sent.kind === 'unreachable' ? 504 : 502, body: { error: paypalError(sent), code: sent.kind === 'unreachable' ? 'PAYPAL_UNAVAILABLE' : 'PAYPAL_REFUSED' } };
  return { status: 201, body: { ...statusOf(sent.body) } };
}

/** What PayPal did not pay in a batch, by our ids: the batch, and the firms' items it failed, returned or turned down. */
export interface Unpaid {
  senderBatchId: string;
  itemIds: string[];
  /** PayPal turned the whole batch down, and paid none of it. */
  wholeBatch: boolean;
}

/** Item statuses after which PayPal never pays that item under its batch id; UNCLAIMED and ONHOLD may still be paid. */
const NOT_PAID = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED']);

/** From PayPal's batch as read back: what it did not pay, or null when it paid, or may yet pay, every item. */
export function unpaidOf(body: unknown): Unpaid | null {
  const header = asObject(asObject(body).batch_header);
  const senderBatchId = text(asObject(header.sender_batch_header).sender_batch_id);
  if (!senderBatchId) return null;
  const listed = Array.isArray(asObject(body).items) ? (asObject(body).items as unknown[]) : [];
  const items = listed.map((raw) => ({ itemId: text(asObject(asObject(raw).payout_item).sender_item_id), status: text(asObject(raw).transaction_status) ?? 'PENDING' }));
  const wholeBatch = ['DENIED', 'CANCELED'].includes(text(header.batch_status) ?? '') && items.every((item) => NOT_PAID.has(item.status));
  const itemIds = items.flatMap((item) => (item.itemId && NOT_PAID.has(item.status) ? [item.itemId] : []));
  return wholeBatch || itemIds.length > 0 ? { senderBatchId, itemIds, wholeBatch } : null;
}

/**
 * PayPal's batch as it stands, for the page that watches it until PayPal settles it. `settle`, when given, hears first
 * what PayPal did not pay, so that on a copy of the demo it no longer counts before the page offers to pay the rest.
 */
export async function readProgressPayout(batchId: string, paypal: PayPalSession, settle?: (unpaid: Unpaid) => Promise<void>): Promise<Answer> {
  const read = await paypal.request(`/v1/payments/payouts/${encodeURIComponent(batchId)}`, { method: 'GET' });
  if (read.kind === 'unreachable') return { status: 504, body: { error: paypalError(read), code: 'PAYPAL_UNAVAILABLE' } };
  if (read.status === 404) return { status: 404, body: { error: 'PayPal has no such payout batch.', code: 'NOT_FOUND' } };
  if (read.status >= 300) return { status: 502, body: { error: paypalError(read), code: 'PAYPAL_REFUSED' } };
  const unpaid = settle ? unpaidOf(read.body) : null;
  if (unpaid) await settle!(unpaid);
  return { status: 200, body: { ...statusOf(read.body) } };
}

// ---------------------------------------------------------------------------------------------
// The function (paypal-progress-payout)
// ---------------------------------------------------------------------------------------------

export interface ProgressPayoutDeps {
  env: Env;
  /** The sandbox accounts in the function's environment (PAYPAL_SANDBOX_<NAME>_EMAIL). */
  accounts: SandboxAccounts;
  /** Used for PayPal in live mode; mock mode always uses `mockPayPalFetch`. */
  fetch: Fetch;
  /** The user id behind a valid access token, or null. */
  resolveUser(accessToken: string): Promise<string | null>;
  /** Whether the user is a member of the project who sees costs (RLS is bypassed where this is answered). */
  seesCosts(projectId: string, userId: string): Promise<boolean>;
  /** Where the payout is claimed with the sender's own token. */
  claimTarget: ClaimTarget;
  /** The hosted site's switch and caps (GANTRY_HOSTED=1). */
  limits?: PaymentLimits;
  /**
   * Takes what PayPal did not pay off what the payment has paid, on a copy of the demo (settle_pay_gate_payout, with the
   * service role). Never throws: a batch read must still answer.
   */
  settle?(projectId: string, unpaid: Unpaid): Promise<void>;
  /** The batches sent from each copy: PayPal is asked about a batch only for a member of the copy it was sent from. */
  batches: ProgressBatchLog;
  /** Counts the user's calls to PayPal (rate-limit.ts); without one nothing is counted. */
  rateGate?: RateGate;
  timeoutMs?: number;
  log?(message: string, error?: unknown): void;
}

/** What the page asks for PayPal's batch: the project it belongs to, and the batch. */
export function statusRequest(body: unknown): { projectId: string; batchId: string } | null {
  const value = asObject(body);
  if (value.action !== 'status' || !isUuid(value.projectId) || typeof value.batchId !== 'string' || !BATCH_ID.test(value.batchId)) return null;
  return { projectId: value.projectId, batchId: value.batchId };
}

/**
 * paypal-progress-payout:
 *   POST <a progress payment, as the dev route takes it> → 201 { batchId, status, feeMinor, items, mode, approvalId, resumed? }
 *   POST { action: 'status', projectId, batchId }       → 200 { batchId, status, feeMinor, items }
 * with the user's JWT, checked here (the function doesn't rely on the gateway's own check). A refusal before PayPal is
 * { error, code, refused: true }; PayPal's own refusal or silence is { error, code } with 502 or 504; a failure nobody
 * planned for is a 500 with a `request_id`, its detail in the log only (failures.ts).
 *
 * Before PayPal is signed in to, both settle who is asking and that they are a member of the project who sees costs;
 * a status read also needs the batch to have been sent from that project (`batches`). Then the person's allowance of
 * PayPal calls is counted (rate-limit.ts). A payout still signs in to PayPal before the database's claim, so a
 * credentials problem never uses up an approval.
 */
export function createProgressPayoutHandler(deps: ProgressPayoutDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const cors = corsHeaders(request, deps.env);
    const answer = ({ status, body }: Answer) => json(status, plainly(status, body, deps.log), cors);
    if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      if (request.method !== 'POST') return answer(refusal(405, 'Use POST.', 'METHOD_NOT_ALLOWED'));
      let body: unknown;
      try {
        body = JSON.parse(await request.text()) as unknown;
      } catch {
        return answer(refusal(400, 'The body must be JSON.', 'INVALID_REQUEST'));
      }
      const asked = asObject(body).action === 'status' ? statusRequest(body) : null;
      const payment = asked ? null : batchRequest(body);
      if (!asked && !payment) return answer(refusal(400, asObject(body).action === 'status' ? 'Ask with the project and PayPal’s batch id.' : 'Not a progress payment.', 'INVALID_REQUEST'));

      const config = readPayPalConfig(deps.env);
      const token = bearerToken(request);
      const userId = token ? await deps.resolveUser(token) : null;
      if (!userId) return answer(refusal(401, 'Sign in again: the payout needs your login.', 'UNAUTHORIZED'));
      const connect = () =>
        createPayPalApi({
          mode: config.mode,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          fetch: config.mode === 'mock' ? mockPayPalFetch : deps.fetch,
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        }).connect();

      // A member of the project who sees costs, before anything else is read or PayPal is reached.
      const projectId = asked ? asked.projectId : payment!.projectId;
      if (!(await deps.seesCosts(projectId, userId))) {
        return answer(refusal(403, asked ? 'Only a project member who sees costs may follow this payout.' : 'Only a project member who sees costs may pay the firms.', 'FORBIDDEN'));
      }

      if (asked) {
        // Only a batch sent from this copy: nobody follows another copy's payouts, or any other batch on the account.
        if (!(await deps.batches.has(asked.projectId, asked.batchId))) return answer(refusal(404, 'No payout with that id was sent from this project.', 'NOT_FOUND'));
        await deps.rateGate?.('paypal_read', userId, asked.projectId);
        return answer(await readProgressPayout(asked.batchId, await connect(), deps.settle && ((unpaid) => deps.settle!(asked.projectId, unpaid))));
      }

      const live = config.mode === 'live';
      await requirePaymentsOn(deps.env, deps.limits);
      await deps.rateGate?.('paypal_call', userId, projectId);
      // Signed in to PayPal before the database is asked, so a credentials problem never uses up an approval.
      const paypal = await connect();
      const cleared = await clearProgressPayout(payment!, {
        live,
        accounts: deps.accounts,
        claim: (claimed) => claimPayout(claimed, token, deps.claimTarget),
        ...(isHosted(deps.env) ? { count: (claimed: BatchRequest) => countPayment(deps.env, deps.limits, 'payout', claimed.projectId, totalOf(claimed)) } : {}),
      });
      if (!cleared.ok) return answer(cleared.answer);
      const sent = await submitProgressPayout(payment!, receiverOf(deps.accounts), paypal);
      // PayPal has the batch: the copy's members may follow it from now on.
      const batchId = typeof sent.body.batchId === 'string' ? sent.body.batchId : '';
      if (sent.status < 300 && batchId) await recordBatch(deps, { projectId, gateId: payment!.gateId, senderBatchId: payment!.batchId, paypalBatchId: batchId, sentBy: userId });
      return answer({ status: sent.status, body: { ...sent.body, mode: config.mode, approvalId: cleared.approvalId } });
    } catch (error) {
      const failure = publicError(error, deps.env, deps.log);
      const id = failure.requestId ? { request_id: failure.requestId } : {};
      if (failure.status === 500) return answer({ status: 500, body: { error: failure.message, code: failure.code, ...id } });
      return answer({ status: failure.status, body: { ...refusal(failure.status, failure.message, failure.code).body, ...id } });
    }
  };
}

/** A batch PayPal took, recorded for its copy. PayPal has it whatever happens here, so a failure is only logged. */
async function recordBatch(deps: ProgressPayoutDeps, batch: ProgressBatch): Promise<void> {
  try {
    await deps.batches.record(batch);
  } catch (error) {
    deps.log?.(`recording PayPal's batch ${batch.paypalBatchId} for its project failed; its status can't be followed`, error);
  }
}

/**
 * An answer as the browser may see it. A 500 is plain, with a request id (its detail logged under that id); so is the
 * claim that could not reach the database, whose reason names the address and RPC it called.
 */
function plainly(status: number, body: Record<string, unknown>, log: ProgressPayoutDeps['log']): Record<string, unknown> {
  if ('request_id' in body) return body;
  if (status === 500 || (status === 503 && body.code === 'PAYOUT_REFUSED')) {
    const failure = internalError(new Error(String(body.error ?? 'no detail')), log);
    const message = status === 500 ? failure.message : `The payout couldn’t be checked just now, so nothing was sent. Try again in a moment (request id ${failure.requestId}).`;
    return { ...body, error: message, request_id: failure.requestId };
  }
  return body;
}

/**
 * Dev-server route for progress payments, on this machine only: one PayPal Payouts batch pays every firm
 * in a progress payment (gantt/pay-gates). The REST app's id and secret stay here, never in the browser:
 * the page sends the amounts and gets back PayPal's batch id, then asks for the batch's status until
 * PayPal settles it. With PAYPAL_MODE=mock nothing leaves the machine and the batch succeeds after a moment.
 * The hosted site has no dev server: its paypal-progress-payout function does the same with the same code
 * (supabase/functions/_shared/progress-payouts.ts).
 *
 * In the sandbox each firm is paid to its own test account, PAYPAL_SANDBOX_<first word of its name>_EMAIL. A live payment
 * is refused if a firm has none, or if its account is another firm's too: the screen says who was paid, so it has to be true.
 *
 * With PAYPAL_MODE=live the payment is made on PayPal's own pages (`/__paypal/progress-orders`): the page shows PayPal's
 * button, the payer signs in there and approves one order with a purchase unit per firm, and this route captures it.
 * PAYPAL_CAPTURE=skip rehearses that: PayPal's window and the approval are real, the capture is not, and no money moves.
 *
 * Nothing is sent without the database's say: before PayPal (or the mock) is called, the payout is claimed with
 * the sender's own Supabase token (`claim_pay_gate_payout`, supabase/migrations/20261108010000_pay_gate_approvals.sql),
 * which refuses a payout over the project's threshold unless someone else who sees costs approved exactly these
 * firms and amounts, recently, and uses that approval up. A refusal is passed back to the page as it is.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { firmAccounts, sandboxAccounts } from '../../supabase/functions/_shared/accounts.ts';
import { feeMinor, minorToDecimal } from '../../supabase/functions/_shared/amounts.ts';
import { createPayPalApi, type PayPalSession } from '../../supabase/functions/_shared/paypal.ts';
import {
  batchRequest,
  claimPayout,
  clearProgressPayout,
  paypalError,
  readProgressPayout,
  receiverOf,
  submitProgressPayout,
  type BatchRequest,
  type ClaimTarget,
  type ProgressBatchStatus,
} from '../../supabase/functions/_shared/progress-payouts.ts';
import { checkoutFeeMinor } from './src/payments/payout-sheet.ts';

export type { BatchItem, BatchRequest, ClaimTarget, ProgressBatchStatus } from '../../supabase/functions/_shared/progress-payouts.ts';

const fromThisMachine = (req: IncomingMessage) => !req.headers.origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin);

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return JSON.parse(body);
}

const bearer = (req: IncomingMessage) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;

const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const string = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** What the mock charges for each payment once a batch has gone through: PayPal's US Payouts API rate. */
const MOCK_FEE_MINOR = 25;

/** Mock mode: a batch is processing for a moment, then every payment in it has gone through, and its fees are known. */
export function mockPayouts(now: () => number = Date.now, settleMs = 2_500) {
  const batches = new Map<string, { request: BatchRequest; at: number }>();
  return {
    create(request: BatchRequest): ProgressBatchStatus {
      const batchId = `MOCK-${request.batchId}`;
      if (!batches.has(batchId)) batches.set(batchId, { request, at: now() });
      return { batchId, status: 'PENDING', feeMinor: null, items: [] };
    },
    get(batchId: string): ProgressBatchStatus | null {
      const batch = batches.get(batchId);
      if (!batch) return null;
      const done = now() - batch.at > settleMs;
      return {
        batchId,
        status: done ? 'SUCCESS' : 'PROCESSING',
        feeMinor: done ? MOCK_FEE_MINOR * batch.request.items.length : null,
        items: batch.request.items.map((item, index) => ({
          itemId: item.itemId,
          status: done ? 'SUCCESS' : 'PENDING',
          transactionId: done ? `MOCKTX${index + 1}${batch.at % 100000}` : null,
          feeMinor: done ? MOCK_FEE_MINOR : null,
          error: null,
        })),
      };
    },
  };
}

/** PayPal's order for a progress payment: one purchase unit per firm, each naming the firm for PayPal's own cart. */
export function orderBody(request: BatchRequest, accounts: ReadonlyMap<string, string>) {
  return {
    intent: 'CAPTURE',
    application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', brand_name: 'Gantry' },
    purchase_units: request.items.map((item) => {
      const amount = { currency_code: request.currency, value: minorToDecimal(item.amountMinor) };
      return {
        reference_id: item.itemId,
        description: item.note.slice(0, 127),
        amount: { ...amount, breakdown: { item_total: amount } },
        items: [{ name: `${item.firm} · ${request.subject}`.slice(0, 127), quantity: '1', unit_amount: amount }],
        payee: { email_address: accounts.get(item.firm) ?? '' },
      };
    }),
  };
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const paypalMoney = (value: unknown): number | null => feeMinor({ value: object(value).value, currency: 'USD' }, 'USD');
const CAPTURE_WORDS: Record<string, string> = { COMPLETED: 'SUCCESS', DECLINED: 'FAILED', FAILED: 'FAILED' };

/** PayPal's order as the page reads it, in the words the payment window already follows: paid is SUCCESS. */
export function orderStatusOf(body: unknown): ProgressBatchStatus {
  const order = object(body);
  const items = list(order.purchase_units).map((raw) => {
    const unit = object(raw);
    const capture = object(list(object(unit.payments).captures)[0]);
    const status = string(capture.status);
    return {
      itemId: string(unit.reference_id) ?? '',
      status: status ? (CAPTURE_WORDS[status] ?? status) : 'PENDING',
      transactionId: string(capture.id),
      feeMinor: paypalMoney(object(capture.seller_receivable_breakdown).paypal_fee),
      error: status === 'DECLINED' || status === 'FAILED' ? `PayPal: ${status.toLowerCase()}` : null,
    };
  });
  const fees = items.map((item) => item.feeMinor);
  return {
    batchId: string(order.id) ?? '',
    status: order.status === 'COMPLETED' ? 'SUCCESS' : (string(order.status) ?? 'UNKNOWN'),
    feeMinor: fees.length > 0 && fees.every((fee) => fee !== null) ? fees.reduce<number>((sum, fee) => sum + (fee ?? 0), 0) : null,
    items,
  };
}

/** A rehearsal: PayPal approved this order for real and nothing was captured, so nothing here may read as paid money. */
export function rehearsedStatus(body: unknown): ProgressBatchStatus {
  const order = object(body);
  const items = list(order.purchase_units).map((raw, index) => {
    const unit = object(raw);
    return { itemId: string(unit.reference_id) ?? '', status: 'SUCCESS', transactionId: `REHEARSAL-${index + 1}`, feeMinor: checkoutFeeMinor(paypalMoney(object(unit.amount)) ?? 0), error: null };
  });
  return { batchId: string(order.id) ?? '', status: 'SUCCESS', feeMinor: items.reduce((sum, item) => sum + item.feeMinor, 0), items };
}

export function paypalRoutes(): Plugin {
  return {
    name: 'collab-paypal-progress-routes',
    apply: (_config, env) => env.command === 'serve' && env.mode !== 'test',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.envDir || process.cwd(), '');
      const live = env.PAYPAL_MODE === 'live';
      const accounts = sandboxAccounts(env);
      const mock = mockPayouts(Date.now, Number(env.PAYPAL_MOCK_SETTLE_MS) || 2_500);
      const claimTarget: ClaimTarget = { supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? '', anonKey: env.VITE_SUPABASE_ANON_KEY ?? '', fetch: (url, init) => fetch(url, init) };
      let session: Promise<PayPalSession> | null = null;
      const connect = () => {
        session ??= createPayPalApi({ mode: 'live', clientId: env.PAYPAL_CLIENT_ID ?? '', clientSecret: env.PAYPAL_CLIENT_SECRET ?? '', fetch: (url, init) => fetch(url, init) })
          .connect()
          .catch((error: unknown) => {
            session = null;
            throw error;
          });
        return session;
      };

      const capturing = env.PAYPAL_CAPTURE !== 'skip';
      /** The order made for each payment, so pressing again after closing PayPal's window reuses its one claim. */
      const orders = new Map<string, string>();

      server.middlewares.use('/__paypal/progress-orders', (req, res) => {
        void (async () => {
          if (!fromThisMachine(req)) return reply(res, 403, { error: 'Not from this machine' });
          const path = new URL(req.url ?? '/', 'http://localhost').pathname;
          // The client id is public: PayPal's button is drawn with it in the browser. The secret stays here.
          if (req.method === 'GET' && path === '/config') return reply(res, 200, { live, clientId: live ? (env.PAYPAL_CLIENT_ID ?? null) : null, rehearsal: live && !capturing });
          if (!live) return reply(res, 404, { error: 'Paying on PayPal needs PAYPAL_MODE=live.' });
          if (req.method === 'POST' && path === '/') {
            const request = batchRequest(await readJson(req).catch(() => null));
            if (!request) return reply(res, 400, { error: 'Not a progress payment' });
            const known = orders.get(request.batchId);
            if (known) return reply(res, 201, { orderId: known, resumed: true });
            const firms = firmAccounts(
              request.items.map((item) => item.firm),
              accounts,
            );
            if (!firms.ok) return reply(res, 409, { error: firms.error, refused: true });
            const claim = await claimPayout(request, bearer(req), claimTarget);
            if (!claim.ok) return reply(res, claim.status, { error: claim.error, refused: true });
            const paypal = await connect();
            const made = await paypal.request('/v2/checkout/orders', { method: 'POST', body: orderBody(request, firms.accounts), headers: { 'PayPal-Request-Id': request.batchId } });
            if (made.kind === 'unreachable' || made.status >= 300) return reply(res, made.kind === 'unreachable' ? 504 : 502, { error: paypalError(made) });
            const orderId = string(object(made.body).id);
            if (!orderId) return reply(res, 502, { error: 'PayPal did not return an order.' });
            orders.set(request.batchId, orderId);
            return reply(res, 201, { orderId, approvalId: claim.approvalId });
          }
          const capture = /^\/([A-Z0-9]{10,30})\/capture$/.exec(path);
          if (req.method === 'POST' && capture) {
            const paypal = await connect();
            if (!capturing) {
              const read = await paypal.request(`/v2/checkout/orders/${capture[1]}`, { method: 'GET' });
              if (read.kind === 'unreachable' || read.status >= 300) return reply(res, read.kind === 'unreachable' ? 504 : 502, { error: paypalError(read) });
              if (object(read.body).status !== 'APPROVED') return reply(res, 409, { error: `PayPal has not approved this order (${string(object(read.body).status) ?? 'unknown'}).` });
              return reply(res, 200, rehearsedStatus(read.body));
            }
            const took = await paypal.request(`/v2/checkout/orders/${capture[1]}/capture`, { method: 'POST', body: {}, headers: { 'PayPal-Request-Id': `${capture[1]}-capture`, Prefer: 'return=representation' } });
            if (took.kind === 'unreachable' || took.status >= 300) return reply(res, took.kind === 'unreachable' ? 504 : 502, { error: paypalError(took) });
            return reply(res, 200, orderStatusOf(took.body));
          }
          const read = /^\/([A-Z0-9]{10,30})$/.exec(path);
          if (req.method === 'GET' && read) {
            const paypal = await connect();
            const order = await paypal.request(`/v2/checkout/orders/${read[1]}`, { method: 'GET' });
            if (order.kind === 'unreachable') return reply(res, 504, { error: paypalError(order) });
            if (order.status === 404) return reply(res, 404, { error: 'PayPal has no such order.' });
            if (order.status >= 300) return reply(res, 502, { error: paypalError(order) });
            return reply(res, 200, orderStatusOf(order.body));
          }
          reply(res, 405, { error: 'GET or POST' });
        })().catch((error: unknown) => reply(res, 500, { error: error instanceof Error ? error.message : String(error) }));
      });

      server.middlewares.use('/__paypal/progress-payouts', (req, res) => {
        void (async () => {
          if (!fromThisMachine(req)) return reply(res, 403, { error: 'Not from this machine' });
          if (req.method === 'POST') {
            const request = batchRequest(await readJson(req).catch(() => null));
            if (!request) return reply(res, 400, { error: 'Not a progress payment batch' });
            // Signed in to PayPal before the database is asked, so a credentials problem never uses up an approval.
            const paypal = live ? await connect() : null;
            // Each firm's own account (live), then the database's say, which uses up the second person's approval.
            const cleared = await clearProgressPayout(request, { live, accounts, claim: (claimed) => claimPayout(claimed, bearer(req), claimTarget) });
            if (!cleared.ok) return reply(res, cleared.answer.status, cleared.answer.body);
            if (!paypal) return reply(res, 201, { ...mock.create(request), mode: 'mock', approvalId: cleared.approvalId });
            const sent = await submitProgressPayout(request, receiverOf(accounts), paypal);
            return reply(res, sent.status, { ...sent.body, mode: 'live', approvalId: cleared.approvalId });
          }
          if (req.method === 'GET') {
            const batchId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('batch') ?? '';
            if (!/^[A-Za-z0-9._-]{6,80}$/.test(batchId)) return reply(res, 400, { error: 'Unknown batch' });
            if (batchId.startsWith('MOCK-')) {
              const status = mock.get(batchId);
              return status ? reply(res, 200, status) : reply(res, 404, { error: 'This dev server has no such mock batch; it may have restarted.' });
            }
            const read = await readProgressPayout(batchId, await connect());
            return reply(res, read.status, read.body);
          }
          reply(res, 405, { error: 'GET or POST' });
        })().catch((error: unknown) => reply(res, 500, { error: error instanceof Error ? error.message : String(error) }));
      });
    },
  };
}

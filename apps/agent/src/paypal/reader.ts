/**
 * Reading PayPal itself, for check_with_paypal: where an invoice to the client stands, and where a payout went. Read
 * only, on PayPal's sandbox only (read-only.ts checks every request before it is sent):
 *
 *   - an invoice through PayPal's Agent Toolkit (`@paypal/agent-toolkit/openai`), with only its get_invoice action
 *     turned on, and `context.sandbox` set (it defaults to production);
 *   - a payout batch (rentals, and progress payments on the hosted site) with a GET to the Payouts API, through the
 *     shared PayPal client the Edge Functions use (supabase/functions/_shared/paypal.ts); the toolkit has no Payouts
 *     tools. A local build pays the crews with PayPal's button instead, as one order: when PayPal has no batch by
 *     that id, the order is read with a GET to the Orders API.
 *
 * Nothing here decides which ids are read: the tool passes only ids this project's own records hold.
 */
import { decimalToMinor } from '../../../../supabase/functions/_shared/amounts.ts';
import { asObject, text } from '../../../../supabase/functions/_shared/json.ts';
import { describePayPalError } from '../../../../supabase/functions/_shared/outcomes.ts';
import { createPayPalApi, PayPalAuthError, type PayPalReply, type PayPalSession } from '../../../../supabase/functions/_shared/paypal.ts';
import type { PayPalAccess } from '../env';
import { CLIENT_READS, guardToolkitAxios, isPayPalId, readOnlyFetch, type Fetch } from './read-only';

/** One payment in a payout: a batch item, or a purchase unit's capture in an order. */
export interface PayPalPayment {
  /** PayPal's word for it (SUCCESS, PENDING, UNCLAIMED …; an order's COMPLETED …); null when it has none yet. */
  status: string | null;
  amount_minor: number | null;
  /** PayPal's reason, for a payment it refused or holds. */
  error: string | null;
}

export interface PayPalInvoice {
  id: string;
  /** PayPal's word for it: DRAFT, SENT, UNPAID, PARTIALLY_PAID, PAID, CANCELLED … */
  status: string;
  number: string | null;
  amount_minor: number | null;
  paid_minor: number | null;
  due_minor: number | null;
  /** When it falls due (its payment term), YYYY-MM-DD. */
  due_on: string | null;
  /** The last payment's day, YYYY-MM-DD. */
  paid_on: string | null;
}

export interface PayPalPayout {
  /** A Payouts batch, or one order through PayPal's button (a local build's crew payment). */
  via: 'payouts' | 'order';
  id: string;
  /** PayPal's word for it: a batch's PENDING, PROCESSING, SUCCESS, DENIED, CANCELED; an order's APPROVED, COMPLETED … */
  status: string;
  amount_minor: number | null;
  fee_minor: number | null;
  /** When PayPal finished it, YYYY-MM-DD. */
  completed_on: string | null;
  payments: PayPalPayment[];
}

export type PayPalAnswer<T> = { kind: 'found'; value: T } | { kind: 'not_found' } | { kind: 'failed'; message: string };

/** PayPal itself, read only. */
export interface PayPalReader {
  invoice(paypalInvoiceId: string): Promise<PayPalAnswer<PayPalInvoice>>;
  /** A payout batch, or the order a local build paid the crews with. */
  payout(paypalId: string): Promise<PayPalAnswer<PayPalPayout>>;
}

/** The toolkit as `@paypal/agent-toolkit/openai` has it: its tools, and its handler for one tool call. */
export interface ToolkitLike {
  getTools(): { function: { name: string } }[];
  handleToolCall(call: { id: string; type: 'function'; function: { name: string; arguments: string } }): Promise<{ content: unknown }>;
}

/** The toolkit's only action turned on, and its only tool: reading one invoice. */
export const TOOLKIT_ACTIONS = { invoices: { get: true } };
export const TOOLKIT_TOOL = 'get_invoice';

/** How long one read may take before the answer is given without it (PayPal's sandbox answers in about a second). */
export const READ_TIMEOUT_MS = 10_000;
/** A signed-in client is used this long, then signs in again (the toolkit never refreshes its token by itself). */
const SESSION_MS = 30 * 60_000;

/** The real toolkit, loaded on first use with its HTTP client guarded first. */
export async function loadToolkit(access: PayPalAccess): Promise<ToolkitLike> {
  guardToolkitAxios();
  const { PayPalAgentToolkit } = await import('@paypal/agent-toolkit/openai');
  return new PayPalAgentToolkit({
    clientId: access.clientId,
    clientSecret: access.clientSecret,
    configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true } },
  });
}

export interface ReaderOptions {
  /** Makes the toolkit (default: `loadToolkit`; tests pass a fake). */
  toolkit?: (access: PayPalAccess) => Promise<ToolkitLike>;
  /** The fetch under the read-only check (default: the platform's). */
  fetch?: Fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** A client kept for a while, made again after SESSION_MS or after PayPal turns its sign-in down. */
function kept<T>(make: () => Promise<T>, now: () => number) {
  let held: { at: number; value: Promise<T> } | null = null;
  return {
    get(): Promise<T> {
      if (!held || now() - held.at > SESSION_MS) {
        const value = make();
        held = { at: now(), value };
        value.catch(() => {
          if (held?.value === value) held = null;
        });
      }
      return held.value;
    },
    drop() {
      held = null;
    },
  };
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`PayPal gave no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

const reason = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

export function createPayPalReader(access: PayPalAccess, options: ReaderOptions = {}): PayPalReader {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const makeToolkit = options.toolkit ?? loadToolkit;
  const toolkit = kept(async () => {
    const made = await makeToolkit(access);
    // Fail closed: a toolkit that lists anything but reading an invoice is not used.
    const listed = made.getTools().map((tool) => tool.function.name);
    if (listed.length !== 1 || listed[0] !== TOOLKIT_TOOL) throw new Error(`The PayPal toolkit lists ${listed.join(', ') || 'no tools'}, not only ${TOOLKIT_TOOL}, so it is not used.`);
    return made;
  }, now);
  const api = createPayPalApi({
    mode: 'live',
    clientId: access.clientId,
    clientSecret: access.clientSecret,
    fetch: readOnlyFetch(options.fetch ?? ((url, init) => fetch(url, init)), CLIENT_READS),
    timeoutMs,
  });
  const session = kept(() => api.connect(), now);
  let calls = 0;

  async function invoice(id: string): Promise<PayPalAnswer<PayPalInvoice>> {
    if (!isPayPalId(id)) return { kind: 'failed', message: 'That is not an id PayPal gave.' };
    try {
      const kit = await toolkit.get();
      const answer = await withDeadline(kit.handleToolCall({ id: `check-${++calls}`, type: 'function', function: { name: TOOLKIT_TOOL, arguments: JSON.stringify({ invoice_id: id }) } }), timeoutMs);
      const body = asObject(parseContent(answer.content));
      // The toolkit answers with PayPal's invoice, or with its error: { ok: false, status, message } or { error: { message } }.
      if (body.ok === false || 'error' in body) {
        const status = typeof body.status === 'number' ? body.status : null;
        if (status === 404) return { kind: 'not_found' };
        if (status === 401 || status === null) toolkit.drop();
        return { kind: 'failed', message: text(body.message) ?? text(asObject(body.error).message) ?? 'PayPal answered with an error.' };
      }
      return { kind: 'found', value: invoiceOf(body) };
    } catch (failure) {
      toolkit.drop();
      return { kind: 'failed', message: reason(failure) };
    }
  }

  async function read(path: string): Promise<PayPalReply | { kind: 'failed'; message: string }> {
    try {
      const signedIn: PayPalSession = await session.get();
      const reply = await signedIn.request(path, { method: 'GET' });
      if (reply.kind === 'reply' && reply.status === 401) session.drop();
      return reply;
    } catch (failure) {
      session.drop();
      if (failure instanceof PayPalAuthError) {
        return { kind: 'failed', message: failure.code === 'PAYPAL_AUTH_FAILED' ? 'PayPal did not accept the assistant’s sandbox key.' : 'PayPal could not be reached to sign in.' };
      }
      return { kind: 'failed', message: reason(failure) };
    }
  }

  function answerOf<T>(reply: PayPalReply | { kind: 'failed'; message: string }, parse: (body: unknown) => T): PayPalAnswer<T> {
    if (reply.kind === 'failed') return reply;
    if (reply.kind === 'unreachable') return { kind: 'failed', message: `PayPal could not be reached (${reply.message}).` };
    if (reply.status === 404) return { kind: 'not_found' };
    if (reply.status >= 300) return { kind: 'failed', message: describePayPalError(reply.status, reply.body) };
    return { kind: 'found', value: parse(reply.body) };
  }

  async function payout(id: string): Promise<PayPalAnswer<PayPalPayout>> {
    if (!isPayPalId(id)) return { kind: 'failed', message: 'That is not an id PayPal gave.' };
    const batch = answerOf(await read(`/v1/payments/payouts/${encodeURIComponent(id)}`), payoutOf);
    if (batch.kind !== 'not_found') return batch;
    // No batch by that id: a local build paid the crews with PayPal's button, as one order.
    return answerOf(await read(`/v2/checkout/orders/${encodeURIComponent(id)}`), orderOf);
  }

  return { invoice, payout };
}

function parseContent(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return { ok: false, message: content.slice(0, 200) };
  }
}

/** PayPal's money object ({ value, currency_code } or { value, currency }) in minor units; null for anything but US dollars. */
function minorOf(value: unknown): number | null {
  const money = asObject(value);
  const currency = text(money.currency_code) ?? text(money.currency);
  if (currency !== null && currency !== 'USD') return null;
  try {
    return decimalToMinor(money.value);
  } catch {
    return null;
  }
}

const dayOf = (value: unknown): string | null => {
  const day = text(value)?.slice(0, 10) ?? null;
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** PayPal's v2 invoice as check_with_paypal reads it. */
export function invoiceOf(body: unknown): PayPalInvoice {
  const invoice = asObject(body);
  const detail = asObject(invoice.detail);
  const payments = asObject(invoice.payments);
  const paidDays = list(payments.transactions)
    .map((transaction) => dayOf(asObject(transaction).payment_date))
    .filter((day): day is string => day !== null)
    .sort();
  return {
    id: text(invoice.id) ?? '',
    status: text(invoice.status) ?? 'UNKNOWN',
    number: text(detail.invoice_number),
    amount_minor: minorOf(invoice.amount),
    paid_minor: minorOf(payments.paid_amount),
    due_minor: minorOf(invoice.due_amount),
    due_on: dayOf(asObject(detail.payment_term).due_date),
    paid_on: paidDays.at(-1) ?? null,
  };
}

/** A Payouts batch (GET /v1/payments/payouts/{id}): its status and each payment's. */
export function payoutOf(body: unknown): PayPalPayout {
  const batch = asObject(body);
  const header = asObject(batch.batch_header);
  return {
    via: 'payouts',
    id: text(header.payout_batch_id) ?? '',
    status: text(header.batch_status) ?? 'UNKNOWN',
    amount_minor: minorOf(header.amount),
    fee_minor: minorOf(header.fees),
    completed_on: dayOf(header.time_completed),
    payments: list(batch.items).map((raw) => {
      const item = asObject(raw);
      const errors = asObject(item.errors);
      return { status: text(item.transaction_status), amount_minor: minorOf(asObject(item.payout_item).amount), error: text(errors.message) ?? text(errors.name) };
    }),
  };
}

/** An order (GET /v2/checkout/orders/{id}): its status, and each firm's purchase unit as its capture stands. */
export function orderOf(body: unknown): PayPalPayout {
  const order = asObject(body);
  const captures = list(order.purchase_units).map((raw) => {
    const unit = asObject(raw);
    return { unit, capture: asObject(list(asObject(unit.payments).captures)[0]) };
  });
  const fees = captures.map(({ capture }) => minorOf(asObject(capture.seller_receivable_breakdown).paypal_fee));
  const done = captures.map(({ capture }) => dayOf(capture.update_time) ?? dayOf(capture.create_time)).filter((day): day is string => day !== null).sort();
  const amounts = captures.map(({ unit, capture }) => minorOf(capture.amount) ?? minorOf(unit.amount));
  return {
    via: 'order',
    id: text(order.id) ?? '',
    status: text(order.status) ?? 'UNKNOWN',
    amount_minor: amounts.length > 0 && amounts.every((amount) => amount !== null) ? amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) : null,
    fee_minor: fees.length > 0 && fees.every((fee) => fee !== null) ? fees.reduce<number>((sum, fee) => sum + (fee ?? 0), 0) : null,
    completed_on: text(order.status) === 'COMPLETED' ? (done.at(-1) ?? null) : null,
    payments: captures.map(({ capture }, index) => ({
      status: text(capture.status),
      amount_minor: amounts[index] ?? null,
      error: text(asObject(capture.status_details).reason),
    })),
  };
}

/**
 * paypal-invoice: bills a project's client through PayPal Invoicing. A person prepares the invoice
 * (the prepare_invoice RPC: one per floor for finished work, or one for a change to the plan, recorded
 * on the change's first task), then presses Send:
 *
 *   POST { invoice_id, action: 'send' }     creates the PayPal draft and sends it; safe to repeat; records who sent it
 *   POST { invoice_id, action: 'refresh' }  asks PayPal where it stands (sent, paid, cancelled)
 *   POST { invoice_id, action: 'cancel' }   cancels a sent invoice on PayPal, which tells the tenant; safe to repeat
 *   POST { project_id, action: 'seller' }   the business an invoice will come from, and on the hosted demo the
 *                                           address it bills, for the review window
 *
 * with the user's JWT → 200 { invoice } (for 'seller', 200 { seller, bill_to }: bill_to null where the project's own
 * client is billed). The invoice row's id is the
 * PayPal-Request-Id, so a retry after a lost answer gets the same draft back. Only a member who sees costs
 * may do any of these. Two people can have the same invoice open: the second to confirm gets the invoice as
 * it stands, and who sent it stays whoever was recorded first.
 *
 * One PayPal payment carries at most $60,000 (US sending limit), so an invoice over that lets the payer
 * pay in parts; the payer still picks PayPal, Venmo, Apple Pay or a card on PayPal's own page.
 *
 * On the hosted demo (GANTRY_HOSTED=1) every invoice bills the tenant's sandbox account,
 * PAYPAL_SANDBOX_TENANT_EMAIL, whatever the project row says, so nobody can make the app invoice another
 * address; the invoice row then records that address as the one billed. That account must be the tenant's
 * alone (not a crew's, accounts.ts), payments must be switched on, and creating an invoice at PayPal counts
 * against the copy's caps (hosted.ts).
 *
 * Who is asking, whether the invoice exists and whether they see costs on its project are all settled before PayPal
 * is signed in to; then the person's allowance of PayPal calls is counted (rate-limit.ts).
 */
import type { SandboxAccounts } from './accounts.ts';
import { minorToDecimal } from './amounts.ts';
import { ConfigError, readPayPalConfig, type Env } from './config.ts';
import { corsHeaders } from './cors.ts';
import { publicError } from './failures.ts';
import { countPayment, requirePaymentsOn, type PaymentLimits } from './hosted.ts';
import { bearerToken, errorResponse, HttpError, json } from './http.ts';
import { asObject, isUuid, text } from './json.ts';
import { describePayPalError } from './outcomes.ts';
import { mockPayPalFetch } from './paypal-mock.ts';
import { createPayPalApi, type Fetch, type PayPalReply, type PayPalSession } from './paypal.ts';
import type { RateGate } from './rate-limit.ts';

export interface InvoiceRecord {
  id: string;
  project_id: string;
  title: string;
  client_name: string;
  client_email: string;
  /** `detail`: what the line is made of, shown to the payer under it (a change order's floor lists its tasks). */
  lines: { label: string; amount_minor: number; detail?: string | null }[];
  currency: string;
  status: 'draft' | 'sent' | 'paid' | 'cancelled' | 'failed';
  paypal_invoice_id: string | null;
  [column: string]: unknown;
}

export interface InvoiceStore {
  read(id: string): Promise<InvoiceRecord | null>;
  update(id: string, patch: Record<string, unknown>): Promise<InvoiceRecord>;
  /** Marks it sent and records who and when, unless someone is recorded already: returns the row as it then stands. */
  markSent(id: string, stamp: { sent_by: string; sent_at: string }): Promise<InvoiceRecord>;
  canBill(projectId: string, userId: string): Promise<boolean>;
}

export interface InvoiceDeps {
  env: Env;
  fetch: Fetch;
  store: InvoiceStore;
  resolveUser(accessToken: string): Promise<string | null>;
  /** The sandbox accounts of the demo's parties: the hosted demo's tenant account must be no one else's. */
  accounts?: SandboxAccounts;
  /** The hosted site's switch and caps (GANTRY_HOSTED=1). */
  limits?: PaymentLimits;
  /** Counts the user's calls to PayPal (rate-limit.ts); without one nothing is counted. */
  rateGate?: RateGate;
  log?(message: string, error?: unknown): void;
}

/**
 * The most one PayPal payment carries in the US ($60,000, help286). Above it the invoice allows partial
 * payments, or the payer could not pay it at all. Mirrors PAYPAL_PAYMENT_LIMIT_MINOR in packages/shared.
 */
export const ONE_PAYMENT_LIMIT_MINOR = 6_000_000;

/**
 * The most PayPal takes in an invoice's text, kept one under what it documents: it refused an item name of exactly 200
 * characters ("INVALID_ITEM_NAME_LENGTH: Item Name should be less than 200 characters"). Counted in UTF-8 bytes, so a
 * "·" or "…" can't tip a name over. The drafts stay well inside these (apps/agent/src/plan/invoice.ts); this is the last
 * guard, so no wording ever fails a send.
 */
export const PAYPAL_TEXT_MAX = { name: 199, description: 999, reference: 119 } as const;

const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).length;

/** `text` in at most `maxBytes` bytes of UTF-8: whole when it fits, else cut at a word where that keeps most of it, with "…". */
export function fitPayPal(text: string, maxBytes: number): string {
  const whole = text.trim();
  if (bytesOf(whole) <= maxBytes) return whole;
  const room = maxBytes - bytesOf('…');
  let cut = '';
  let used = 0;
  for (const char of whole) {
    const size = bytesOf(char);
    if (used + size > room) break;
    cut += char;
    used += size;
  }
  const atWord = cut.replace(/[\s,;:·–—-]+\S*$/, '');
  return `${(atWord.length >= cut.length * 0.6 ? atWord : cut).trimEnd()}…`;
}

/**
 * Our own invoice number, so PayPal doesn't continue the account's sequence (a sandbox account carries whatever
 * prefix it was last given): "CO-" and the first eight hex digits of the invoice's id, unique per invoice.
 */
export const invoiceNumber = (invoice: Pick<InvoiceRecord, 'id'>): string => `CO-${invoice.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** The function's own environment, where it runs on Deno. */
const denoEnv: Env = { get: (name) => (globalThis as { Deno?: { env: Env } }).Deno?.env.get(name) };

/** The business the invoice comes from, as the payer reads it (PAYPAL_INVOICER_NAME); unset, PayPal uses the account's name. */
function sellerName(env: Env = denoEnv): string | null {
  return env.get('PAYPAL_INVOICER_NAME')?.trim() || null;
}

/** An email address as PayPal takes one: something, an @, a domain with a dot. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who PayPal bills. Hosted (GANTRY_HOSTED=1): always the tenant's sandbox account, PAYPAL_SANDBOX_TENANT_EMAIL,
 * and nothing is sent while it is not set to an address. Anywhere else: the project's client, as the invoice
 * recorded it when it was prepared.
 */
export function invoiceRecipient(invoice: Pick<InvoiceRecord, 'client_email'>, env: Env = denoEnv, accounts?: SandboxAccounts): string {
  if (env.get('GANTRY_HOSTED')?.trim() !== '1') return invoice.client_email;
  const tenant = env.get('PAYPAL_SANDBOX_TENANT_EMAIL')?.trim() ?? '';
  if (!EMAIL.test(tenant)) {
    throw new ConfigError('The hosted demo bills only PAYPAL_SANDBOX_TENANT_EMAIL, and it is not set to an email address.');
  }
  // The invoice names the tenant, so the account it bills must be the tenant's alone.
  if (accounts?.alsoOf('TENANT', tenant)) throw new HttpError(409, 'PAYEE_REFUSED', 'The tenant’s PayPal account is set up for another party too, so the invoice can’t be sent.');
  return tenant;
}

/** Whom the hosted demo bills (its tenant's sandbox account); null anywhere else, or while it is not set to an address. */
export function hostedBillTo(env: Env = denoEnv): string | null {
  if (env.get('GANTRY_HOSTED')?.trim() !== '1') return null;
  const tenant = env.get('PAYPAL_SANDBOX_TENANT_EMAIL')?.trim() ?? '';
  return EMAIL.test(tenant) ? tenant : null;
}

/**
 * The PayPal v2 invoice body: one item per line, billed to `recipient` (the project's client unless the hosted
 * demo says otherwise, see invoiceRecipient), net 30 (INVOICE_DUE_DAYS in packages/shared).
 */
export function invoiceBody(invoice: InvoiceRecord, seller: string | null = sellerName(), recipient: string = invoice.client_email) {
  const total = invoice.lines.reduce((sum, line) => sum + line.amount_minor, 0);
  return {
    ...(seller ? { invoicer: { business_name: seller.slice(0, 300) } } : {}),
    detail: {
      invoice_number: invoiceNumber(invoice),
      currency_code: invoice.currency,
      // The project and what is billed, e.g. "Harbor Street Offices · Change order: New light fixtures, levels 1 to 3".
      reference: fitPayPal(invoice.title, PAYPAL_TEXT_MAX.reference),
      note: invoice.title,
      payment_term: { term_type: 'NET_30' },
    },
    primary_recipients: [
      {
        billing_info: {
          // PayPal keeps the business name on the invoice (it drops full_name); its payer page shows the email.
          business_name: invoice.client_name.slice(0, 300),
          name: { full_name: invoice.client_name },
          email_address: recipient,
        },
      },
    ],
    items: invoice.lines.map((line) => ({
      name: fitPayPal(line.label, PAYPAL_TEXT_MAX.name),
      ...(line.detail ? { description: fitPayPal(line.detail, PAYPAL_TEXT_MAX.description) } : {}),
      quantity: '1',
      unit_amount: { currency_code: invoice.currency, value: minorToDecimal(line.amount_minor) },
    })),
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: total > ONE_PAYMENT_LIMIT_MINOR } },
  };
}

/** PayPal's invoice status as ours. PAID also fires for partial payments: only the fully paid states count. */
export function statusOf(paypalStatus: string | null): InvoiceRecord['status'] | null {
  switch (paypalStatus) {
    case 'PAID':
    case 'MARKED_AS_PAID':
      return 'paid';
    case 'CANCELLED':
      return 'cancelled';
    case 'SENT':
    case 'UNPAID':
    case 'SCHEDULED':
    case 'PARTIALLY_PAID':
    case 'PAYMENT_PENDING':
      return 'sent';
    case 'DRAFT':
      return 'draft';
    default:
      return null;
  }
}

const refused = (what: string, reply: PayPalReply) =>
  new HttpError(502, 'PAYPAL_REFUSED', `PayPal could not ${what}: ${reply.kind === 'reply' ? describePayPalError(reply.status, reply.body) : reply.message}.`);

const conflict = (message: string) => new HttpError(409, 'INVOICE_STATE_CONFLICT', message);

/** Reads the invoice from PayPal and stores what it says. Canceled is final: nothing read back changes it. */
async function refresh(session: PayPalSession, store: InvoiceStore, invoice: InvoiceRecord): Promise<InvoiceRecord> {
  if (invoice.status === 'cancelled') return invoice;
  const reply = await session.request(`/v2/invoicing/invoices/${encodeURIComponent(invoice.paypal_invoice_id ?? '')}`, { method: 'GET' });
  if (reply.kind !== 'reply' || reply.status !== 200) throw refused('find the invoice', reply);
  const body = asObject(reply.body);
  const detail = asObject(body.detail);
  const status = statusOf(text(body.status));
  const patch: Record<string, unknown> = {};
  const number = text(detail.invoice_number);
  const url = text(asObject(detail.metadata).recipient_view_url);
  if (number) patch.paypal_number = number;
  if (url) patch.payer_url = url;
  if (status && status !== invoice.status) {
    patch.status = status;
    if (status === 'paid') patch.paid_at = new Date().toISOString();
  }
  return Object.keys(patch).length > 0 ? store.update(invoice.id, patch) : invoice;
}

async function send(session: PayPalSession, store: InvoiceStore, invoice: InvoiceRecord, userId: string, recipient: string, seller: string | null): Promise<InvoiceRecord> {
  // Someone else's confirm got there first: it is out, and who sent it stays as recorded.
  if (invoice.status === 'sent' || invoice.status === 'paid') return invoice;
  if (invoice.status === 'cancelled') throw conflict('This invoice was canceled. Draft a new one to bill this change.');
  let current = invoice;
  if (!current.paypal_invoice_id) {
    // The row records who is billed: on the hosted demo, the tenant's sandbox account in place of the project's client.
    if (current.client_email !== recipient) current = await store.update(current.id, { client_email: recipient });
    const created = await session.request('/v2/invoicing/invoices', {
      method: 'POST',
      headers: { 'PayPal-Request-Id': current.id, Prefer: 'return=representation' },
      body: invoiceBody(current, seller, recipient),
    });
    if (created.kind !== 'reply' || created.status >= 300) {
      await store.update(current.id, { status: 'failed', message: refused('create the invoice', created).message.slice(0, 500) });
      throw refused('create the invoice', created);
    }
    const id = text(asObject(created.body).id) ?? /\/invoices\/([^/?]+)/.exec(text(asObject(created.body).href) ?? '')?.[1] ?? null;
    if (!id) throw new HttpError(502, 'PAYPAL_REFUSED', 'PayPal created the invoice but did not say its id.');
    current = await store.update(current.id, { paypal_invoice_id: id, message: null, status: 'draft' });
  }
  const sent = await session.request(`/v2/invoicing/invoices/${encodeURIComponent(current.paypal_invoice_id!)}/send`, {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `${current.id}-send` },
    body: { send_to_recipient: true, send_to_invoicer: false },
  });
  const stamp = { sent_by: userId, sent_at: new Date().toISOString() };
  if (sent.kind !== 'reply' || sent.status >= 300) {
    // Already sent: PayPal refuses a second send, and reading it back settles it.
    const again = await refresh(session, store, current).catch(() => null);
    if (again?.status === 'paid') return again;
    if (again?.status === 'sent') return store.markSent(current.id, stamp);
    await store.update(current.id, { status: 'failed', message: refused('send the invoice', sent).message.slice(0, 500) });
    throw refused('send the invoice', sent);
  }
  current = await store.markSent(current.id, stamp);
  return refresh(session, store, current);
}

/** Cancels a sent invoice on PayPal, which tells the tenant. The record stays, canceled. */
async function cancel(session: PayPalSession, store: InvoiceStore, invoice: InvoiceRecord): Promise<InvoiceRecord> {
  // Canceled already (the other window's press): nothing more to do.
  if (invoice.status === 'cancelled') return invoice;
  if (invoice.status === 'paid') throw conflict('This invoice has been paid, so it can no longer be canceled.');
  if (invoice.status !== 'sent' || !invoice.paypal_invoice_id) throw conflict('Only an invoice that has been sent can be canceled.');
  const reply = await session.request(`/v2/invoicing/invoices/${encodeURIComponent(invoice.paypal_invoice_id)}/cancel`, {
    method: 'POST',
    body: { send_to_recipient: true, send_to_invoicer: false },
  });
  if (reply.kind !== 'reply' || reply.status >= 300) {
    // Canceled already (a press that lost its answer, or on PayPal's own site): reading it back settles it.
    const again = await refresh(session, store, invoice).catch(() => null);
    if (again?.status === 'cancelled') return again;
    throw refused('cancel the invoice', reply);
  }
  return store.update(invoice.id, { status: 'cancelled', message: null });
}

export function createInvoiceHandler(deps: InvoiceDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const cors = corsHeaders(request, deps.env);
    if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      let body: Record<string, unknown>;
      try {
        body = asObject(JSON.parse(await request.text()));
      } catch {
        throw new HttpError(400, 'INVALID_REQUEST', 'The body must be JSON.');
      }
      const signedIn = async (): Promise<string> => {
        const token = bearerToken(request);
        const user = token ? await deps.resolveUser(token) : null;
        if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
        return user;
      };
      // The name PayPal will put on the invoice, and on the hosted demo whom it bills, for the window that reviews it
      // before anything is recorded: the screen names who is billed, so it must be the address PayPal is sent.
      if (body.action === 'seller') {
        const projectId = text(body.project_id);
        if (!isUuid(projectId)) throw new HttpError(400, 'INVALID_REQUEST', 'project_id is required.');
        if (!(await deps.store.canBill(projectId, await signedIn()))) throw new HttpError(403, 'FORBIDDEN', 'Only a project member who sees costs may do this.');
        return json(200, { seller: sellerName(deps.env), bill_to: hostedBillTo(deps.env) }, cors);
      }
      const invoiceId = text(body.invoice_id);
      const action = body.action === 'refresh' || body.action === 'cancel' ? body.action : 'send';
      if (!invoiceId || !/^[0-9a-f-]{36}$/i.test(invoiceId)) throw new HttpError(400, 'INVALID_REQUEST', 'invoice_id is required.');
      const config = readPayPalConfig(deps.env);
      const userId = await signedIn();
      const invoice = await deps.store.read(invoiceId);
      if (!invoice) throw new HttpError(404, 'NOT_FOUND', 'That invoice is gone.');
      if (!(await deps.store.canBill(invoice.project_id, userId))) throw new HttpError(403, 'FORBIDDEN', 'Only a project member who sees costs may do this.');
      if (action === 'send') await requirePaymentsOn(deps.env, deps.limits);
      // Settled before PayPal is reached: hosted, an invoice goes nowhere but the tenant's sandbox account.
      const recipient = action === 'send' ? invoiceRecipient(invoice, deps.env, deps.accounts) : invoice.client_email;
      // Sending and canceling ask PayPal to do something; refreshing asks where it stands (the page asks that by itself).
      await deps.rateGate?.(action === 'refresh' ? 'paypal_read' : 'paypal_call', userId, invoice.project_id);
      const session = await createPayPalApi({
        mode: config.mode,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        fetch: config.mode === 'mock' ? mockPayPalFetch : deps.fetch,
      }).connect();
      // Creating it at PayPal counts against the hosted copy's caps; sending one PayPal already has doesn't.
      if (action === 'send' && !invoice.paypal_invoice_id && (invoice.status === 'draft' || invoice.status === 'failed')) {
        await countPayment(deps.env, deps.limits, 'invoice', invoice.project_id, null);
      }
      const result =
        action === 'send'
          ? await send(session, deps.store, invoice, userId, recipient, sellerName(deps.env))
          : action === 'cancel'
            ? await cancel(session, deps.store, invoice)
            : invoice.paypal_invoice_id
              ? await refresh(session, deps.store, invoice)
              : invoice;
      return json(200, { invoice: result, mode: config.mode }, cors);
    } catch (error) {
      return errorResponse(publicError(error, deps.env, deps.log), cors);
    }
  };
}

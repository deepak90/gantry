/**
 * Paying a gate through PayPal: the gate's progress payment goes out as one Payouts batch, one payment per
 * firm, through the dev server's route here (apps/web/paypal-dev.ts, which keeps the REST app's secret) or, on
 * the hosted site, the paypal-progress-payout function (the same code, asked with the person's own login), and
 * PayPal's answer is written to the plan: each task's share as paid, and the held work released. A page
 * that reloads while PayPal is still paying picks the batch up again (`resumeGatePayments`).
 *
 * What PayPal last said about each batch this page sent or is watching (its status, each firm's payment and
 * transaction, the fees) is kept here for the payment window (`batchReport`, `onBatchReport`); the plan keeps
 * only the batch and the outcome.
 *
 * With PayPal live on this machine (`checkoutConfig`), the payment is made on PayPal's own pages instead: the window shows
 * PayPal's button, `createGateOrder` makes one order with a purchase unit per firm, the payer signs in and approves it at
 * PayPal, and `captureGateOrder` takes the money and writes the outcome the same way. The hosted site always sends the
 * payout: a visitor has no sandbox payer to sign in as.
 *
 * The route and the function let nothing through without the database's say, claimed with the sender's own login: a payout over the
 * project's threshold needs a second person's approval of exactly these firms and amounts (payments/pay-approvals.ts).
 * A refusal there sends nothing and changes nothing in the plan; it is thrown for the window to show.
 */
import type { ProjectModel } from '@bryntum/gantt';
import { readPayGate, type CurrencyCode, type ProgressPayment } from '@collab/shared';
import { HOSTED } from '../hosted';
import { readSupabaseConfig } from '../supabase/client';
import { wholeMoney } from './look';
import { gateIndex, markGate, paymentOf, recordPaid, recordPartlyPaid, type Gate } from './pay-gates';

const ROUTE = '/__paypal/progress-payouts';
const ORDERS = '/__paypal/progress-orders';
/** The hosted site's payout service, a Supabase function (supabase/functions/paypal-progress-payout). */
const FUNCTION = 'paypal-progress-payout';
const POLL_MS = 2_500;
/** PayPal's sandbox usually settles a batch in seconds; give up watching (not paying) after this. */
const WATCH_MS = 4 * 60_000;

/** PayPal's batch as the dev route reads it back (`ProgressBatchStatus` in apps/web/paypal-dev.ts). */
export interface BatchStatus {
  batchId: string;
  /** PayPal's batch status: PENDING, PROCESSING, SUCCESS, DENIED or CANCELED. */
  status: string;
  /** PayPal's fee for the batch (`batch_header.fees`), in minor units; null until PayPal reports it. */
  feeMinor: number | null;
  /** Each firm's payment, by our item id (`<sender batch id>-<n>`, n counting the firms from 1, as sent). */
  items: { itemId: string; status: string; transactionId: string | null; feeMinor?: number | null; error: string | null }[];
}

const FAILED_ITEM = new Set(['FAILED', 'UNCLAIMED', 'RETURNED', 'BLOCKED', 'ONHOLD', 'REFUNDED', 'REVERSED', 'DENIED']);
/** A refused payment's status, as the card shows it after the payee's name ("Pinecrest Sitework: unclaimed, …"). */
const ITEM_WORDS: Record<string, string> = {
  FAILED: 'failed at PayPal',
  UNCLAIMED: 'unclaimed, no PayPal account at the payee’s email',
  RETURNED: 'returned unclaimed',
  BLOCKED: 'blocked by PayPal',
  ONHOLD: 'on hold for PayPal review',
  REFUNDED: 'refunded by the payee',
  REVERSED: 'reversed by PayPal',
  DENIED: 'denied by PayPal',
};

export type BatchOutcome = { kind: 'working' } | { kind: 'paid' } | { kind: 'failed'; paid: string[]; error: string };

/**
 * What PayPal's answer means for the firms sent (named in the order sent). PayPal can pay one firm and refuse another,
 * so each firm is read on its own: working until every firm has an answer, paid only if every firm was, and otherwise
 * refused, naming whoever was paid so that the next try leaves them out.
 */
export function batchOutcome(status: BatchStatus, firms: readonly string[]): BatchOutcome {
  const items = status.items ?? [];
  const firmOf = (item: BatchStatus['items'][number]) => firms[Number(item.itemId.split('-').pop()) - 1];
  const paid = items.filter((item) => item.status === 'SUCCESS');
  const refused = items.filter((item) => FAILED_ITEM.has(item.status));
  const turnedDown = status.status === 'DENIED' || status.status === 'CANCELED';
  if (!turnedDown && (items.length === 0 || paid.length + refused.length < items.length)) return { kind: 'working' };
  if (!turnedDown && refused.length === 0) return status.status === 'SUCCESS' ? { kind: 'paid' } : { kind: 'working' };
  const paidFirms = paid.map(firmOf).filter((firm): firm is string => Boolean(firm));
  const reasons = refused.map((item) => {
    const firm = firmOf(item);
    return `${firm ? `${firm}: ` : ''}${ITEM_WORDS[item.status] ?? item.status.toLowerCase()}.${item.error ? ` ${item.error}` : ''}`;
  });
  const why = reasons.length > 0 ? reasons.join(' ') : `PayPal ${status.status.toLowerCase()} the batch.`;
  const error = paidFirms.length > 0 ? `${paidFirms.join(' and ')} ${paidFirms.length === 1 ? 'was' : 'were'} paid. ${why} Paying again sends only what is left.` : why;
  return { kind: 'failed', paid: paidFirms, error: error.slice(0, 400) };
}

async function readReply(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Whether payments are made on PayPal's own pages here (PAYPAL_MODE=live), and the public id PayPal's button needs. */
export interface CheckoutConfig {
  live: boolean;
  clientId: string | null;
  /** PayPal's window and approval are real, the capture isn't: no money moves. */
  rehearsal: boolean;
}

const NO_CHECKOUT: CheckoutConfig = { live: false, clientId: null, rehearsal: false };
let checkout: Promise<CheckoutConfig> | null = null;

export function checkoutConfig(): Promise<CheckoutConfig> {
  // The hosted site sends the payout through its function: PayPal's own pages need a payer who can sign in there.
  if (HOSTED) return Promise.resolve(NO_CHECKOUT);
  checkout ??= fetch(`${ORDERS}/config`)
    .then(async (response) => (response.ok ? ({ ...NO_CHECKOUT, ...(await readReply(response)) } as CheckoutConfig) : NO_CHECKOUT))
    .catch(() => NO_CHECKOUT);
  return checkout;
}

/** Batches this page is watching, so a reload's pick-up and the press that sent it share one watch. */
const watching = new Map<string, Promise<'paid' | 'failed'>>();

/** What PayPal last said about each batch, and who wants to hear when that changes. */
const reports = new Map<string, BatchStatus>();
const listeners = new Set<() => void>();

function report(status: BatchStatus): void {
  if (!status.batchId) return;
  reports.set(status.batchId, { ...status, feeMinor: status.feeMinor ?? null, items: status.items ?? [] });
  for (const listener of [...listeners]) listener();
}

/** What PayPal last said about a batch this page sent or is watching; null before it has said anything here. */
export function batchReport(batchId: string | null | undefined): BatchStatus | null {
  return batchId ? (reports.get(batchId) ?? null) : null;
}

/** Calls `listener` whenever PayPal says something new about a batch; returns the way to stop. */
export function onBatchReport(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The batch's firms, in the order sent, so a refusal can name the firm. */
function firmsOf(payment: ProgressPayment) {
  return payment.firms.filter((firm) => firm.dueMinor > 0);
}

/** Who sends the payout, for the database's check: the project, the sender's login, the second person's approval. */
export interface PayoutAuth {
  projectId: string;
  /** The sender's Supabase access token. */
  token: string | null;
  /** The approval of this payout by someone else, when it is over the project's threshold. */
  approvalId: string | null;
}

/** Who asks PayPal how a payout stands, on the hosted site: a member of the project, with their login as it is when asked. */
export interface PayoutReader {
  projectId: string;
  token(): Promise<string | null>;
}

/** The hosted site's function, asked with the person's login and the project's public key. */
function askFunction(body: unknown, token: string | null): Promise<Response> {
  const { url, anonKey } = readSupabaseConfig();
  return fetch(`${url.replace(/\/$/, '')}/functions/v1/${FUNCTION}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/** The route refused the payout before anything reached PayPal (no login, or the database said no). */
export class PayoutRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutRefused';
  }
}

/**
 * Sends the gate's payment as it stands now. Resolves when PayPal has settled it (paid, or refused with its
 * reason recorded on the gate); throws when nothing could be sent (`PayoutRefused` when the database said no).
 * `onSent` hears PayPal's batch id as soon as PayPal has taken the batch.
 */
export async function payGateNow(
  project: ProjectModel,
  gate: Gate,
  currency: CurrencyCode,
  { onSent, auth, reader }: { onSent?(batchId: string): void; auth: PayoutAuth; reader?: PayoutReader },
): Promise<'paid' | 'failed'> {
  const payment = paymentOf(gate);
  const request = await paymentRequest(project, gate, currency, auth, payment);
  const response = HOSTED ? await askFunction(JSON.parse(String(request.body)), auth.token) : await fetch(ROUTE, request);
  const sent = await readReply(response);
  // An answer without the function's own words is Supabase's gateway (the function not deployed, the login refused):
  // nothing reached PayPal.
  if (HOSTED && !response.ok && typeof sent.error !== 'string') {
    throw new PayoutRefused(`The payment service did not take the payout (${typeof sent.message === 'string' ? sent.message : `HTTP ${response.status}`}). Nothing was sent.`);
  }
  // Refused before PayPal: nothing was sent, so the plan stays as it is.
  if (sent.refused === true) throw new PayoutRefused(typeof sent.error === 'string' ? sent.error : 'The payout was refused.');
  if (!response.ok || typeof sent.batchId !== 'string' || !sent.batchId) {
    const error = typeof sent.error === 'string' ? sent.error : `PayPal's route answered ${response.status}.`;
    await markGate(project, gate.id, { state: 'failed', error });
    return 'failed';
  }
  report({ batchId: sent.batchId, status: typeof sent.status === 'string' ? sent.status : 'PENDING', feeMinor: null, items: [] });
  onSent?.(sent.batchId);
  // Watching starts before the plan says "paying", so the pick-up that change triggers joins this watch.
  const watch = watchBatch(project, gate.id, sent.batchId, payment, reader ?? { projectId: auth.projectId, token: async () => auth.token });
  await markGate(project, gate.id, { state: 'paying', batchId: sent.batchId, amountMinor: payment.dueMinor, error: null });
  return watch;
}

/** The POST that asks for this payment, for either route: the firms and amounts, the sender's login, the approval. */
async function paymentRequest(project: ProjectModel, gate: Gate, currency: CurrencyCode, auth: PayoutAuth, payment: ProgressPayment): Promise<RequestInit> {
  const firms = firmsOf(payment);
  if (payment.dueMinor <= 0 || firms.length === 0) throw new Error('Nothing is due yet: no work it pays for has been reported done.');
  if (typeof gate.id !== 'number') throw new Error('The payment is still being saved; try again in a moment.');
  const senderBatchId = `PG-${String(gate.id).replace(/[^A-Za-z0-9]/g, '')}-${await batchKeyFor(project, gate)}`.slice(0, 60);
  const paysWhat = gate.pays.map((row) => row.name).join(', ');
  const retainage = Math.round(payment.retainage * 100);
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
    body: JSON.stringify({
      projectId: auth.projectId,
      gateId: gate.id,
      approvalId: auth.approvalId,
      batchId: senderBatchId,
      currency,
      // What the payee reads in PayPal's email and activity: a pay application's terms.
      subject: `Progress payment: ${paysWhat}`,
      message: `Progress payment for ${paysWhat}: work completed to date, net of ${retainage}% retainage.`,
      items: firms.map((firm, index) => ({
        itemId: `${senderBatchId}-${index + 1}`,
        firm: firm.firm,
        amountMinor: firm.dueMinor,
        note: `Progress payment, ${paysWhat}: ${Math.round(firm.percentDone)}% complete of ${wholeMoney(firm.valueMinor, currency)} scheduled value, ${wholeMoney(firm.retainedMinor, currency)} retainage held (${retainage}%).`,
      })),
    }),
  };
}

/** Makes PayPal's order for the payment, for PayPal's window to approve. Throws when it can't (`PayoutRefused` when the database said no). */
export async function createGateOrder(project: ProjectModel, gate: Gate, currency: CurrencyCode, auth: PayoutAuth): Promise<string> {
  const response = await fetch(ORDERS, await paymentRequest(project, gate, currency, auth, paymentOf(gate)));
  const made = await readReply(response);
  if (response.ok && typeof made.orderId === 'string' && made.orderId) return made.orderId;
  const error = typeof made.error === 'string' ? made.error : `PayPal's route answered ${response.status}.`;
  throw made.refused === true ? new PayoutRefused(error) : new Error(error);
}

/** The payer approved at PayPal: takes the money, then writes PayPal's answer to the plan. */
export function captureGateOrder(project: ProjectModel, gate: Gate, orderId: string): Promise<'paid' | 'failed'> {
  const payment = paymentOf(gate);
  report({ batchId: orderId, status: 'APPROVED', feeMinor: null, items: [] });
  // In the watch list before the plan says "paying", so the pick-up that change triggers joins this one.
  const taking = capture(project, gate.id, orderId, payment).finally(() => watching.delete(orderId));
  watching.set(orderId, taking);
  return markGate(project, gate.id, { state: 'paying', batchId: orderId, amountMinor: payment.dueMinor, error: null }).then(() => taking);
}

async function capture(project: ProjectModel, gateId: number | string, orderId: string, payment: ProgressPayment): Promise<'paid' | 'failed'> {
  const response = await fetch(`${ORDERS}/${encodeURIComponent(orderId)}/capture`, { method: 'POST' });
  const answer = await readReply(response);
  if (!response.ok) {
    // PayPal didn't answer, so the money may have moved: ask it, rather than calling this failed and letting a new payment be made.
    if (response.status === 504) return settleBatch(project, gateId, orderId, payment);
    await markGate(project, gateId, { state: 'failed', batchKey: null, error: typeof answer.error === 'string' ? answer.error : `PayPal's route answered ${response.status}.` });
    return 'failed';
  }
  const status = { ...(answer as unknown as BatchStatus), batchId: orderId };
  report(status);
  // Not settled yet (a payment can stay pending at PayPal): the plan stays "paying" and keeps asking.
  return (await conclude(project, gateId, orderId, payment, status)) ?? settleBatch(project, gateId, orderId, payment);
}

/**
 * The key of this payment's batch id: the one already on the gate, or a new one saved there first. Saved before PayPal
 * is called, so a press after a lost answer repeats the id instead of paying again.
 */
async function batchKeyFor(project: ProjectModel, gate: Gate): Promise<string> {
  const current = readPayGate((gate.task as unknown as { payGate?: unknown }).payGate)?.batchKey;
  if (current) return current;
  const key = crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  await markGate(project, gate.id, { batchKey: key });
  return key;
}

/** Asks PayPal about the batch until it settles, then writes the outcome to the plan. */
function watchBatch(project: ProjectModel, gateId: number | string, batchId: string, payment: ProgressPayment, reader: PayoutReader | null): Promise<'paid' | 'failed'> {
  const already = watching.get(batchId);
  if (already) return already;
  const watch = settleBatch(project, gateId, batchId, payment, reader).finally(() => watching.delete(batchId));
  watching.set(batchId, watch);
  return watch;
}

async function settleBatch(project: ProjectModel, gateId: number | string, batchId: string, payment: ProgressPayment, reader: PayoutReader | null = null): Promise<'paid' | 'failed'> {
  const until = Date.now() + WATCH_MS;
  while (Date.now() < until && !project.isDestroyed) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const status = await readStatus(batchId, reader);
    if (!status) continue;
    // Approved at PayPal and not yet captured: the page went away between the two.
    if (status.status === 'APPROVED') return capture(project, gateId, batchId, payment);
    report({ ...status, batchId });
    const outcome = await conclude(project, gateId, batchId, payment, status);
    if (outcome) return outcome;
  }
  return 'failed';
}

/** What PayPal says now: about an order, or, when PayPal has no order by this id, a Payouts batch. */
async function readStatus(batchId: string, reader: PayoutReader | null): Promise<BatchStatus | null> {
  // The hosted site asks its function, as a member of the project; a moment it can't answer is asked again.
  if (HOSTED) {
    if (!reader) return null;
    const response = await askFunction({ action: 'status', projectId: reader.projectId, batchId }, await reader.token()).catch(() => null);
    return response?.ok ? ((await readReply(response)) as unknown as BatchStatus) : null;
  }
  if ((await checkoutConfig()).live && !batchId.startsWith('MOCK-')) {
    const order = await fetch(`${ORDERS}/${encodeURIComponent(batchId)}`);
    if (order.ok) return (await readReply(order)) as unknown as BatchStatus;
  }
  const response = await fetch(`${ROUTE}?batch=${encodeURIComponent(batchId)}`);
  return response.ok ? ((await readReply(response)) as unknown as BatchStatus) : null;
}

/** Writes a settled answer to the plan; null while PayPal is still working. */
async function conclude(project: ProjectModel, gateId: number | string, batchId: string, payment: ProgressPayment, status: BatchStatus): Promise<'paid' | 'failed' | null> {
  const outcome = batchOutcome(status, firmsOf(payment).map((firm) => firm.firm));
  if (outcome.kind === 'working') return null;
  if (outcome.kind === 'paid') {
    await recordPaid(project, gateId, payment, batchId, new Date());
    return 'paid';
  }
  if (outcome.paid.length > 0) await recordPartlyPaid(project, gateId, payment, new Set(outcome.paid), outcome.error);
  else await markGate(project, gateId, { state: 'failed', batchKey: null, error: outcome.error });
  return 'failed';
}

/**
 * Picks up any gate PayPal is still paying (after a reload, or on another person's screen nothing is sent). The hosted
 * site asks as a member of the project (`reader`), and without one there is nobody to ask as.
 */
export function resumeGatePayments(project: ProjectModel, reader: PayoutReader | null = null): void {
  if (HOSTED && !reader) return;
  for (const gate of gateIndex(project).gates.values()) {
    if (gate.payGate.state !== 'paying' || !gate.payGate.batchId || watching.has(gate.payGate.batchId)) continue;
    void watchBatch(project, gate.id, gate.payGate.batchId, paymentOf(gate), reader);
  }
}

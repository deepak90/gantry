/**
 * check_with_paypal: where this project's invoices to its client and its payouts stand, asked of PayPal itself, read
 * only (src/paypal: the toolkit for invoices, a GET for payouts, every request checked by read-only.ts).
 *
 * Scoped to the project. The model names an invoice by its number, a progress payment by its gate_id or a rental by its
 * booking_id, as the app's other tools give them, or nothing for everything; the PayPal ids read are only those this
 * project's own records hold (an invoice row, a rental's payment, a payment gate on the plan), never an id the model
 * typed. The sandbox business account holds every session's invoices and payouts, so nothing here lists or searches it.
 *
 * Without PayPal (no key for the assistant, or PAYPAL_MODE not live) it says PayPal isn't connected here, and the
 * assistant answers from the app's records instead (get_payment_status, get_progress_payments).
 */
import type { InvoiceRow } from '@collab/shared';
import { z } from 'zod';
import { day, usd } from '../plan/format';
import { findTask, type PlanSnapshot } from '../plan/snapshot';
import { isPayPalId } from '../paypal/read-only';
import type { PayPalAnswer, PayPalInvoice, PayPalPayout } from '../paypal/reader';
import { ToolRefusal } from './refusal';
import type { ToolContext } from './tools';

export const PayPalToolSchemas = {
  check_with_paypal: z.object({
    invoice: z.string().trim().min(1).max(40).nullish().describe('Only this invoice to the client, by its number as get_payment_status gives it'),
    progress_payment: z.int().positive().nullish().describe('Only this progress payment, by its gate_id from get_progress_payments'),
    rental: z.string().trim().min(1).max(60).nullish().describe('Only this rental’s payment, by its booking_id from get_payment_status'),
  }),
};
export type PayPalToolName = keyof typeof PayPalToolSchemas;

export const PAYPAL_TOOL_DESCRIPTIONS: Record<PayPalToolName, string> = {
  check_with_paypal:
    'Ask PayPal itself, read only, where this project’s invoices to the client (the tenant) and its payouts (rentals and progress payments) stand. For an invoice: its status as PayPal reports it (DRAFT, SENT, PARTIALLY_PAID, PAID …), the amount, what is paid and still due, the due date, its number and when it was paid. For a payout: its status and each payment’s (SUCCESS, or COMPLETED for one paid with PayPal’s button, means PayPal paid it). Name one with invoice (its number from get_payment_status), progress_payment (a gate_id from get_progress_payments) or rental (a booking_id from get_payment_status), or none for everything this project has sent through PayPal. Use it when someone asks whether the tenant paid, whether a payout went through, or to check with PayPal. It changes nothing, at PayPal or in the app.',
};

export const isPayPalTool = (name: string): name is PayPalToolName => name in PayPalToolSchemas;

/** The most PayPal is asked about in one call, of each kind (a project has a handful; the newest come first). */
const MOST = 6;

export const NOT_CONNECTED = {
  connected: false,
  note: 'PayPal isn’t connected here, so nothing was asked of PayPal. Answer from the app’s records (get_payment_status for invoices and rentals, get_progress_payments for progress payments), and say that is the app’s record, as last checked.',
} as const;

const dollars = (minor: number) => usd(minor).replace(/\.00$/, '');

/** "a, b and c". */
function inWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const capitalized = (line: string) => line.replace(/^./, (first) => first.toUpperCase());

/** The invoice number the app gives PayPal (`invoiceNumber` in supabase/functions/_shared/invoices.ts): CO- and 8 hex digits of its id. */
const appNumber = (invoice: Pick<InvoiceRow, 'id'>) => `CO-${invoice.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
const numberOf = (invoice: InvoiceRow) => invoice.paypal_number ?? appNumber(invoice);

/** A payout the project made or will make: a progress payment (a gate on the plan) or a rental's payment. */
interface PayoutTarget {
  ref: { progress_payment: number } | { rental: string };
  /** How people call it: "the payout for Footings", "the Tower crane rental from Northgate Equipment Rental". */
  what: string;
  /** The app's own record of it. */
  app_record: 'not paid' | 'being paid' | 'paid' | 'failed';
  /** The PayPal batch or order the project's records hold for it, if it was sent. */
  paypalId: string | null;
  /** Why it failed, as the app recorded it (PayPal's words when PayPal turned it down). */
  error: string | null;
  /** Its newest moment, for "the newest first". */
  at: string;
}

const GATE_RECORD = { waiting: 'not paid', paying: 'being paid', paid: 'paid', failed: 'failed' } as const;

/** The progress payments on the plan: each payment gate, and the batch or order PayPal was asked to pay it with. */
function gateTargets(plan: PlanSnapshot): PayoutTarget[] {
  return plan.tasks.flatMap((task) => {
    const gate = task.payGate;
    if (!gate) return [];
    const paysFor = gate.pays.map((id) => (typeof id === 'number' ? findTask(plan, id)?.name : null)).filter((name): name is string => Boolean(name));
    return [{ ref: { progress_payment: task.id }, what: `the payout for ${inWords(paysFor) || task.name}`, app_record: GATE_RECORD[gate.state], paypalId: gate.batchId, error: gate.error ?? null, at: gate.paidAt ?? '' }];
  });
}

/** Each rental's payment, the latest that reached PayPal, through its proposals as the app links them. */
function rentalTargets(ctx: ToolContext): PayoutTarget[] {
  const { plan, workflow } = ctx;
  return plan.bookings.map((booking) => {
    const proposals = new Set(workflow.proposals.filter((proposal) => proposal.booking_id === booking.id).map((proposal) => proposal.id));
    const versions = new Set(workflow.versions.filter((version) => proposals.has(version.proposal_id)).map((version) => version.id));
    const payments = workflow.payments.filter((payment) => payment.project_id === plan.projectId && versions.has(payment.proposal_version_id)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const sent = payments.filter((payment) => payment.paypal_batch_id).at(-1);
    const latest = sent ?? payments.at(-1);
    const equipment = plan.resources.find((resource) => resource.id === booking.resourceId)?.name ?? 'equipment';
    return {
      ref: { rental: booking.id },
      what: `the ${equipment} rental from ${booking.supplierName}`,
      app_record: !latest ? 'not paid' : latest.status === 'succeeded' ? 'paid' : latest.status === 'failed' ? 'failed' : 'being paid',
      paypalId: sent?.paypal_batch_id ?? null,
      error: latest?.status === 'failed' ? latest.message : null,
      at: sent?.submitted_at ?? sent?.created_at ?? '',
    };
  });
}

function invoiceResult(invoice: InvoiceRow, answer: PayPalAnswer<PayPalInvoice>) {
  const number = numberOf(invoice);
  const who = `the invoice to ${invoice.client_name} (${number})`;
  const base = { invoice: number, title: invoice.title, to: invoice.client_name, app_record: invoice.status };
  if (answer.kind === 'not_found') return { ...base, paypal: null, text: `PayPal has no invoice by the id the app holds for ${who}.` };
  if (answer.kind === 'failed') return { ...base, paypal: null, text: `PayPal couldn’t be asked about ${who}: ${answer.message} The app’s record says ${invoice.status}.` };
  const found = answer.value;
  const paypal = { status: found.status, number: found.number, amount_minor: found.amount_minor, paid_minor: found.paid_minor, due_minor: found.due_minor, due_on: found.due_on, paid_on: found.paid_on };
  const head = `PayPal shows ${who}${found.amount_minor !== null ? `, ${dollars(found.amount_minor)},` : ''} as ${found.status}`;
  const due = found.due_on ? `, due ${day(found.due_on)}` : '';
  let said: string;
  switch (found.status) {
    case 'PAID':
    case 'MARKED_AS_PAID':
      said = `${head}${found.paid_on ? `, paid ${day(found.paid_on)}` : ''}.`;
      break;
    case 'PARTIALLY_PAID':
      said = `${head}: ${found.paid_minor !== null ? dollars(found.paid_minor) : 'part'} paid so far${found.paid_on ? `, last on ${day(found.paid_on)}` : ''}${found.due_minor !== null ? `, ${dollars(found.due_minor)} still due` : ''}${due}.`;
      break;
    case 'DRAFT':
      said = `${head}: it has not gone to ${invoice.client_name} yet.`;
      break;
    case 'CANCELLED':
      said = `${head}.`;
      break;
    default:
      said = `${head}${due}${found.paid_minor ? `, ${dollars(found.paid_minor)} paid so far` : ', nothing paid yet'}.`;
  }
  // PayPal has settled it (paid, or canceled) and the app's record hasn't caught up: PayPal's answer is the newer one.
  const settled = found.status === 'PAID' || found.status === 'MARKED_AS_PAID' ? 'paid' : found.status === 'CANCELLED' ? 'cancelled' : null;
  const behind = settled !== null && settled !== invoice.status;
  return { ...base, paypal, app_record_behind: behind, text: behind ? `${said} The app’s record still says ${invoice.status}.` : said };
}

function payoutResult(target: PayoutTarget, answer: PayPalAnswer<PayPalPayout>) {
  const base = { payment: target.what, ...target.ref, app_record: target.app_record };
  if (answer.kind === 'not_found') return { ...base, paypal: null, text: `PayPal has no payout or order by the id the app holds for ${target.what}.` };
  if (answer.kind === 'failed') return { ...base, paypal: null, text: `PayPal couldn’t be asked about ${target.what}: ${answer.message} The app’s record says ${target.app_record}.` };
  const found = answer.value;
  const paypal = { via: found.via, status: found.status, amount_minor: found.amount_minor, fee_minor: found.fee_minor, completed_on: found.completed_on, payments: found.payments };
  const payments = found.payments.map((payment) => `${payment.amount_minor !== null ? dollars(payment.amount_minor) : 'one'} ${payment.status ?? 'not taken yet'}${payment.error ? ` (${payment.error})` : ''}`);
  const how = found.via === 'order' ? ', one order paid with PayPal’s button,' : '';
  const finished = found.completed_on ? `, finished ${day(found.completed_on)}` : '';
  const each = payments.length === 0 ? '' : `: ${payments.length === 1 ? 'one payment' : `${payments.length} payments`}, ${inWords(payments)}`;
  const said = `PayPal shows ${target.what}${how} as ${found.status}${finished}${each}.`;
  // PayPal has settled it (paid, or turned down) and the app's record hasn't caught up.
  const paid = found.via === 'order' ? found.status === 'COMPLETED' : found.status === 'SUCCESS' && found.payments.length > 0 && found.payments.every((payment) => payment.status === 'SUCCESS');
  const turnedDown = found.via === 'order' ? found.status === 'VOIDED' : found.status === 'DENIED' || found.status === 'CANCELED';
  const behind = (paid && target.app_record !== 'paid') || (turnedDown && target.app_record !== 'failed');
  return { ...base, paypal, app_record_behind: behind, text: behind ? `${said} The app’s record still says ${target.app_record}.` : said };
}

/** This project's invoices to read: the one named (by its number, never by a PayPal id), or every one not canceled. */
function invoicesNamed(ctx: ToolContext, number: string | null | undefined, everything: boolean): InvoiceRow[] {
  const own = (ctx.workflow.invoices ?? []).filter((invoice) => invoice.project_id === ctx.plan.projectId);
  if (!number) return everything ? own.filter((invoice) => invoice.status !== 'cancelled') : [];
  const wanted = number.toUpperCase();
  const found = own.filter((invoice) => invoice.paypal_number?.toUpperCase() === wanted || appNumber(invoice) === wanted);
  if (found.length === 0) throw new ToolRefusal(`This project has no invoice numbered ${number}. get_payment_status lists its invoices and their numbers.`);
  return found;
}

/** This project's payouts to read: the progress payment and rental named, or all of them. */
function payoutsNamed(ctx: ToolContext, gateId: number | null | undefined, bookingId: string | null | undefined, everything: boolean): PayoutTarget[] {
  if (everything) return [...gateTargets(ctx.plan), ...rentalTargets(ctx)];
  const out: PayoutTarget[] = [];
  if (gateId) {
    const gate = gateTargets(ctx.plan).find((target) => 'progress_payment' in target.ref && target.ref.progress_payment === gateId);
    if (!gate) throw new ToolRefusal(`No progress payment in this plan has gate_id ${gateId}. get_progress_payments lists them.`);
    out.push(gate);
  }
  if (bookingId) {
    const rental = rentalTargets(ctx).find((target) => 'rental' in target.ref && target.ref.rental === bookingId);
    if (!rental) throw new ToolRefusal(`No rental in this plan has booking_id ${bookingId}. get_payment_status lists them.`);
    out.push(rental);
  }
  return out;
}

export async function runPayPalTool(_name: PayPalToolName, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const parsed = PayPalToolSchemas.check_with_paypal.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  const paypal = ctx.paypal;
  if (!paypal) return NOT_CONNECTED;
  await ctx.refresh();
  const { invoice, progress_payment, rental } = parsed.data;
  const everything = !invoice && !progress_payment && !rental;
  const invoices = invoicesNamed(ctx, invoice, everything);
  const payouts = payoutsNamed(ctx, progress_payment, rental, everything);

  // What PayPal has never seen is said from the app's records, without asking PayPal.
  const notAtPayPal: string[] = [];
  if (everything && invoices.length === 0) notAtPayPal.push(`there is no invoice to ${ctx.plan.clientName?.trim() || 'the client'} in the app yet.`);
  for (const row of invoices.filter((row) => !isPayPalId(row.paypal_invoice_id))) {
    notAtPayPal.push(`the invoice to ${row.client_name} (${numberOf(row)}) ${row.paypal_invoice_id ? 'was made while PayPal was mocked, so PayPal never saw it' : 'has not been sent, so PayPal has nothing on it yet'}.`);
  }
  for (const target of payouts.filter((target) => !isPayPalId(target.paypalId))) {
    // Asked about everything, a rental nobody has paid goes unsaid; a progress payment waiting for its money is worth saying.
    if (everything && 'rental' in target.ref && target.app_record === 'not paid') continue;
    if (target.paypalId) notAtPayPal.push(`${target.what} was paid while PayPal was mocked, so PayPal never saw it.`);
    else if (target.app_record === 'failed') notAtPayPal.push(`${target.what} failed when it was sent and never became a PayPal payout, so there is nothing at PayPal to look up.${target.error ? ` The app recorded why: ${target.error}` : ''}`);
    else notAtPayPal.push(`${target.what} has not been sent to PayPal (the app’s record says ${target.app_record}).`);
  }
  const newestFirst = <T>(rows: T[], at: (row: T) => string) => [...rows].sort((a, b) => (at(a) < at(b) ? 1 : -1)).slice(0, MOST);
  const invoicesToRead = newestFirst(invoices.filter((row) => isPayPalId(row.paypal_invoice_id)), (row) => row.created_at);
  const payoutsToRead = newestFirst(payouts.filter((target) => isPayPalId(target.paypalId)), (target) => target.at);

  const [invoiceAnswers, payoutAnswers] = await Promise.all([
    Promise.all(invoicesToRead.map((row) => paypal.invoice(row.paypal_invoice_id!))),
    Promise.all(payoutsToRead.map((target) => paypal.payout(target.paypalId!))),
  ]);
  const read = {
    invoices: invoicesToRead.map((row, index) => invoiceResult(row, invoiceAnswers[index]!)),
    payouts: payoutsToRead.map((target, index) => payoutResult(target, payoutAnswers[index]!)),
  };
  const asked = read.invoices.length + read.payouts.length > 0;
  return {
    connected: true,
    from: asked ? 'PayPal’s sandbox, read just now' : 'the app’s records only: nothing here has gone to PayPal, so PayPal was not asked',
    ...read,
    not_at_paypal: notAtPayPal.slice(0, MOST).map(capitalized),
    note: asked
      ? 'Each status in invoices and payouts is PayPal’s own word for it, read just now: say the answer comes from PayPal. A payout’s SUCCESS (an order’s COMPLETED) means PayPal paid it; PENDING or PROCESSING means it is still going through. app_record is the app’s own record, as last checked; where app_record_behind is true, PayPal’s answer is the newer one. not_at_paypal is the app’s own record of what PayPal holds nothing on: say so, never that PayPal said it. Nothing was changed at PayPal or in the app.'
      : 'PayPal was not asked: by the app’s records, nothing here has gone to PayPal yet. Say that is the app’s record, never that PayPal said it.',
  };
}

/** One line for the logs and the progress stream. */
export function summarizePayPalTool(value: Record<string, any>): string {
  if (value.connected === false) return 'PayPal isn’t connected here';
  const lines = [
    ...((value.invoices ?? []) as { invoice: string; paypal: { status: string } | null }[]).map((row) => `invoice ${row.invoice}: ${row.paypal?.status ?? 'not read'}`),
    ...((value.payouts ?? []) as { payment: string; paypal: { status: string } | null }[]).map((row) => `${row.payment}: ${row.paypal?.status ?? 'not read'}`),
  ];
  return lines.join('; ') || 'nothing sent through PayPal';
}

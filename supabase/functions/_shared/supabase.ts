/**
 * Runtime wiring for the Deno entry points: the environment, the service-role client behind the
 * payout and receipt stores, pdf-lib for the receipt, and the user behind a browser JWT. The only
 * shared module that touches `Deno` or npm; everything it feeds is plain TypeScript tested under Vitest.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { PDFDocument, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';
import { sandboxAccounts, type SandboxAccounts } from './accounts.ts';
import { createBatchLog, type ProgressBatchLog } from './batch-log.ts';
import type { FunctionDeps, PayoutAccess } from './handlers.ts';
import type { PaymentLimits } from './hosted.ts';
import { createRateGate, type RateGate } from './rate-limit.ts';
import { createReceiptFiler, createSupabaseReceiptStore } from './receipt.ts';
import type { InvoiceStore } from './invoices.ts';
import type { Unpaid } from './progress-payouts.ts';
import { createRpcPayoutStore } from './store.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set (the Supabase edge runtime provides it)`);
  }
  return value;
}

/** Service role: the payout RPCs are granted to it alone, and it bypasses RLS. */
const service = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

export const edgeDependencies: FunctionDeps = {
  env: { get: (name) => Deno.env.get(name) },
  fetch: (url, init) => fetch(url, init),
  store: createRpcPayoutStore({ rpc: (fn, args) => service.rpc(fn, args) }),
  receipts: createReceiptFiler({
    store: createSupabaseReceiptStore({ rpc: (fn, args) => service.rpc(fn, args), storage: service.storage }),
    pdf: { PDFDocument, StandardFonts, rgb },
  }),
  log: (message, error) => console.error(`[paypal] ${message}`, error),
};

/** GoTrue checks the token (signature, expiry, a live user); null when it is not a valid session. */
export async function resolveUser(accessToken: string): Promise<string | null> {
  const { data, error } = await service.auth.getUser(accessToken);
  return error === null && data.user !== null ? data.user.id : null;
}

/** Whether a user is a member of a project (RLS is bypassed here, so the check is explicit). */
export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const { data, error } = await service.from('project_members').select('user_id').eq('project_id', projectId).eq('user_id', userId).maybeSingle();
  return error === null && data !== null;
}

/** Whether a user is a member of a project who sees costs (RLS is bypassed here, so the check is explicit). */
export async function seesCosts(projectId: string, userId: string): Promise<boolean> {
  const { data, error } = await service.from('project_members').select('can_view_costs').eq('project_id', projectId).eq('user_id', userId).maybeSingle();
  return error === null && data !== null && (data as { can_view_costs: boolean }).can_view_costs === true;
}

/**
 * Whether a user may act on a payment authorization, read before PayPal is asked anything (the rules payout_begin and
 * payout_resume apply again under the row's lock): execute needs the project's cost manager who sees costs, reconcile
 * any member. A payment in a project the user isn't a member of reads as no payment at all.
 */
export async function payoutAccess(authorizationId: string, userId: string, kind: 'execute' | 'reconcile'): Promise<PayoutAccess> {
  const payment = await service.from('payment_authorizations').select('project_id').eq('id', authorizationId).maybeSingle();
  if (payment.error) throw new Error(`payment_authorizations: ${payment.error.message}`);
  const projectId = (payment.data as { project_id: string } | null)?.project_id;
  if (!projectId) return { ok: false, reason: 'not_found' };
  const member = await service.from('project_members').select('role, can_view_costs').eq('project_id', projectId).eq('user_id', userId).maybeSingle();
  if (member.error) throw new Error(`project_members: ${member.error.message}`);
  const row = member.data as { role: string; can_view_costs: boolean } | null;
  if (!row) return { ok: false, reason: 'not_found' };
  if (kind === 'execute' && !(row.role === 'cm' && row.can_view_costs)) return { ok: false, reason: 'forbidden' };
  return { ok: true, projectId };
}

const log = (message: string, error?: unknown) => console.error(`[paypal] ${message}`, error ?? '');

/** Each person's allowance of calls to PayPal, counted by public.rate_gate. */
export const rateGate: RateGate = createRateGate({ rpc: (fn, args) => service.rpc(fn, args) });

/** The progress payouts sent from each copy (public.progress_payout_batches). */
export const progressBatches: ProgressBatchLog = createBatchLog(
  {
    insert: (row) => service.from('progress_payout_batches').upsert(row, { onConflict: 'project_id,paypal_batch_id', ignoreDuplicates: true }),
    find: (projectId, paypalBatchId) => service.from('progress_payout_batches').select('paypal_batch_id').eq('project_id', projectId).eq('paypal_batch_id', paypalBatchId).maybeSingle(),
  },
);

/** The sandbox account of each party, from the function's whole environment (PAYPAL_SANDBOX_<NAME>_EMAIL). */
export const accounts: SandboxAccounts = sandboxAccounts(Deno.env.toObject());

/** The hosted site's switch and caps, read and counted with the service role. */
export const paymentLimits: PaymentLimits = {
  async paymentsOn() {
    const { data, error } = await service.from('app_flags').select('enabled').eq('key', 'live_payments').maybeSingle();
    if (error) throw new Error(`app_flags: ${error.message}`);
    return (data as { enabled?: boolean } | null)?.enabled === true;
  },
  async use(kind, projectId, amountMinor) {
    const { data, error } = await service.rpc('use_payment_quota', { p_kind: kind, p_project: projectId, p_amount_minor: amountMinor });
    if (error) throw new Error(`use_payment_quota: ${error.message}`);
    return data === true;
  },
};

/**
 * What PayPal did not pay of a progress payout no longer counts against the gate on a copy of the demo
 * (settle_pay_gate_payout). Logged, never thrown: should it fail, the next try is refused rather than paid twice.
 */
export async function settlePayout(projectId: string, unpaid: Unpaid): Promise<void> {
  try {
    const { error } = await service.rpc('settle_pay_gate_payout', {
      p_project: projectId,
      p_sender_batch_id: unpaid.senderBatchId,
      p_item_ids: unpaid.itemIds,
      p_whole_batch: unpaid.wholeBatch,
    });
    if (error) console.error('[paypal] settle_pay_gate_payout', error.message);
  } catch (error) {
    console.error('[paypal] settle_pay_gate_payout', error);
  }
}

/** The firm a payment authorization pays: the supplier of the rental it was approved for. */
export async function rentalSupplier(authorizationId: string): Promise<string | null> {
  const one = async <T>(table: string, columns: string, id: string): Promise<T | null> => {
    const { data, error } = await service.from(table).select(columns).eq('id', id).maybeSingle();
    if (error) throw new Error(`${table}: ${error.message}`);
    return data as T | null;
  };
  const payment = await one<{ proposal_version_id: string }>('payment_authorizations', 'proposal_version_id', authorizationId);
  const version = payment ? await one<{ proposal_id: string }>('proposal_versions', 'proposal_id', payment.proposal_version_id) : null;
  const proposal = version ? await one<{ booking_id: string }>('proposals', 'booking_id', version.proposal_id) : null;
  const booking = proposal ? await one<{ supplier_name: string }>('equipment_bookings', 'supplier_name', proposal.booking_id) : null;
  return booking?.supplier_name ?? null;
}

/** The invoices table, behind the service role: people prepare rows through RPCs; only this function marks them sent or paid. */
export const invoiceStore: InvoiceStore = {
  async read(id) {
    const { data, error } = await service.from('invoices').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
  async update(id, patch) {
    const { data, error } = await service.from('invoices').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
    if (error) throw new Error(error.message);
    return data;
  },
  async markSent(id, stamp) {
    // One statement, so of two people confirming at once only the first signs it; never a row already paid or canceled.
    const { data, error } = await service.from('invoices').update({ ...stamp, status: 'sent', message: null, updated_at: new Date().toISOString() }).eq('id', id).is('sent_by', null).in('status', ['draft', 'failed', 'sent']).select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
    const row = await invoiceStore.read(id);
    if (!row) throw new Error(`Invoice ${id} is gone.`);
    return row;
  },
  async canBill(projectId, userId) {
    const { data, error } = await service.from('project_members').select('can_view_costs').eq('project_id', projectId).eq('user_id', userId).maybeSingle();
    return error === null && data !== null && (data as { can_view_costs: boolean }).can_view_costs === true;
  },
};

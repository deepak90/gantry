/**
 * paypal-progress-payout: a progress payment on the hosted site, paid as one PayPal Payouts batch with each firm paid
 * to its own sandbox account (the dev server's route does the same on this machine, apps/web/paypal-dev.ts).
 * POST <the progress payment> with the user's JWT → 201 { batchId, status, feeMinor, items, mode, approvalId };
 * POST { action: 'status', projectId, batchId } → 200 PayPal's batch as the page reads it.
 * The payout is claimed with the user's own token first (claim_pay_gate_payout); see _shared/progress-payouts.ts.
 */
import { createProgressPayoutHandler } from '../_shared/progress-payouts.ts';
import { accounts, edgeDependencies, paymentLimits, progressBatches, rateGate, resolveUser, seesCosts, settlePayout } from '../_shared/supabase.ts';

Deno.serve(
  createProgressPayoutHandler({
    env: edgeDependencies.env,
    fetch: edgeDependencies.fetch,
    accounts,
    resolveUser,
    seesCosts,
    limits: paymentLimits,
    settle: settlePayout,
    batches: progressBatches,
    rateGate,
    // The project's own API, where the payout is claimed as the person sending it (their token, the public key).
    claimTarget: { supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '', anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '', fetch: (url, init) => fetch(url, init) },
    ...(edgeDependencies.log ? { log: edgeDependencies.log } : {}),
  }),
);

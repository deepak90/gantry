/**
 * paypal-reconcile: any project member refreshes a payout's status.
 * POST { "authorization_id": uuid } with the user's JWT → 200 { authorization, action, mode, notice }.
 * Reads PayPal's batch, or re-sends a stalled attempt with the same ids; never starts a payout the
 * cost manager has not sent. See _shared/handlers.ts.
 */
import { createPayoutHandler } from '../_shared/handlers.ts';
import { edgeDependencies, payoutAccess, rateGate, resolveUser } from '../_shared/supabase.ts';

Deno.serve(createPayoutHandler({ ...edgeDependencies, kind: 'reconcile', resolveUser, access: payoutAccess, rateGate }));

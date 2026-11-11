/**
 * paypal-execute-payout: the cost manager presses "Send payout".
 * POST { "authorization_id": uuid } with the user's JWT → 200 { authorization, action, mode, notice }.
 * Starts the PayPal payout (or resumes a stalled attempt with the same ids); see _shared/handlers.ts.
 */
import { createPayoutHandler } from '../_shared/handlers.ts';
import { accounts, edgeDependencies, paymentLimits, payoutAccess, rateGate, rentalSupplier, resolveUser } from '../_shared/supabase.ts';

Deno.serve(
  createPayoutHandler({ ...edgeDependencies, kind: 'execute', resolveUser, access: payoutAccess, rateGate, accounts, supplierOf: rentalSupplier, limits: paymentLimits }),
);

/**
 * The hosted site's limits on PayPal (GANTRY_HOSTED=1): the switch that turns payments off for everyone
 * (app_flags.live_payments), and each copy's caps on payouts and invoices, counted per copy of the demo and per day
 * (use_payment_quota, supabase/migrations/20261111020000_payment_quotas.sql). Off the hosted site neither applies.
 */
import type { Env } from './config.ts';
import { HttpError } from './http.ts';

export type PaymentKind = 'payout' | 'invoice';

export interface PaymentLimits {
  /** Whether payments are switched on (app_flags.live_payments). */
  paymentsOn(): Promise<boolean>;
  /** Counts one payout of this amount, or one invoice, against the copy and the day: false when a cap is reached, and then nothing is counted. */
  use(kind: PaymentKind, projectId: string, amountMinor: number | null): Promise<boolean>;
}

export const isHosted = (env: Env): boolean => env.get('GANTRY_HOSTED')?.trim() === '1';

export const PAYMENTS_OFF = 'Payments with PayPal are switched off on this site for now. Nothing was sent.';

export const LIMIT_REACHED: Readonly<Record<PaymentKind, string>> = {
  payout: 'This demo has reached its limit on payouts, for this copy or for the site today. Nothing was sent.',
  invoice: 'This demo has reached its limit on invoices, for this copy or for the site today. Nothing was sent.',
};

/** The hosted site's limits, or a refusal when they are missing: the hosted site never pays without them. */
function limitsOf(limits: PaymentLimits | undefined): PaymentLimits {
  if (!limits) throw new HttpError(503, 'PAYPAL_NOT_CONFIGURED', 'This site has no payment limits wired in, so nothing was sent.');
  return limits;
}

/** Refuses on the hosted site while payments are switched off; anywhere else there is nothing to check. */
export async function requirePaymentsOn(env: Env, limits: PaymentLimits | undefined): Promise<void> {
  if (!isHosted(env)) return;
  if (!(await limitsOf(limits).paymentsOn())) throw new HttpError(503, 'PAYMENTS_OFF', PAYMENTS_OFF);
}

/** Counts a payment against the hosted copy's caps, and refuses once one is reached; anywhere else nothing is counted. */
export async function countPayment(env: Env, limits: PaymentLimits | undefined, kind: PaymentKind, projectId: string, amountMinor: number | null): Promise<void> {
  if (!isHosted(env)) return;
  if (!(await limitsOf(limits).use(kind, projectId, amountMinor))) throw new HttpError(429, 'QUOTA_REACHED', LIMIT_REACHED[kind]);
}

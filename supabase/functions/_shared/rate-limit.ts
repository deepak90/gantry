/**
 * How often one person may make the functions call PayPal, counted in the database by `public.rate_gate` (service
 * role only), which records each call and refuses with SQLSTATE PT429 once the person has made too many in a window.
 * Each window is its own kind of row, the minute's counted first, so a call the minute refuses never uses up the day.
 *
 *   paypal_call  asks PayPal to pay, to send an invoice or to cancel one: 10 a minute, 100 a day
 *   paypal_read  asks PayPal where a payout or an invoice stands. The page asks these by itself while it waits (a
 *                progress payout every 2.5 s for up to 4 minutes, a sent invoice every 20 s), so they have their own
 *                allowance, above that, and a refused read only means the page asks again a little later.
 */
import { HttpError } from './http.ts';

export type PayPalCallKind = 'paypal_call' | 'paypal_read';

interface Allowance {
  /** The row kind rate_gate counts. */
  kind: string;
  max: number;
  /** A Postgres interval. */
  window: string;
  refusal: string;
}

const AGAIN_SOON = 'You’ve asked PayPal for a lot in the last minute. Nothing was sent; try again in a minute.';
const AGAIN_TOMORROW = 'You’ve reached today’s limit on PayPal requests on this site. Nothing was sent.';

export const PAYPAL_ALLOWANCES: Readonly<Record<PayPalCallKind, readonly Allowance[]>> = {
  paypal_call: [
    { kind: 'paypal_call', max: 10, window: '1 minute', refusal: AGAIN_SOON },
    { kind: 'paypal_call_day', max: 100, window: '1 day', refusal: AGAIN_TOMORROW },
  ],
  paypal_read: [
    { kind: 'paypal_read', max: 40, window: '1 minute', refusal: 'Too many status checks in the last minute; the next one will catch up.' },
    { kind: 'paypal_read_day', max: 600, window: '1 day', refusal: 'You’ve reached today’s limit on status checks with PayPal on this site.' },
  ],
};

/** Counts one call for this person; throws HttpError 429 RATE_LIMITED when it is one too many. */
export type RateGate = (kind: PayPalCallKind, userId: string, projectId: string | null) => Promise<void>;

/** The slice of a service-role Supabase client the gate uses. */
export interface RateGateClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string; code?: string | null } | null }>;
}

export function createRateGate(client: RateGateClient): RateGate {
  return async (kind, userId, projectId) => {
    for (const allowance of PAYPAL_ALLOWANCES[kind]) {
      const { error } = await client.rpc('rate_gate', {
        p_kind: allowance.kind,
        p_user: userId,
        // Per person only: the functions see the gateway's address, not the visitor's.
        p_ip: null,
        p_user_max: allowance.max,
        p_user_window: allowance.window,
        p_ip_max: allowance.max,
        p_ip_window: allowance.window,
        p_project: projectId,
      });
      if (!error) continue;
      if (error.code === 'PT429') throw new HttpError(429, 'RATE_LIMITED', allowance.refusal);
      throw new Error(`rate_gate: ${error.message}`);
    }
  };
}

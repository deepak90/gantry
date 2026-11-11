/**
 * The payout bookkeeping in Postgres, behind an interface the flows can be tested against. The
 * Supabase implementation calls the four service-role RPCs of the payouts migration:
 *
 *   payout_begin / payout_resume   lock the row and say what to do now (claiming a submit attempt)
 *   payout_record                  store what PayPal said (monotone; ids and fee only filled in)
 *   payout_record_event            a webhook event once (false for a replayed event id)
 *
 * The rules (who may start, when a stalled attempt is re-sent, which status wins) live in SQL;
 * nothing here second-guesses them.
 */
import { asObject, isObject, text } from './json.ts';
import type { PaymentStatus } from './outcomes.ts';

/** A payment_authorizations row as the RPCs return it (PaymentAuthorizationRow in packages/shared, plus `raw`). */
export interface PaymentAuthorization {
  readonly id: string;
  readonly project_id: string;
  readonly status: PaymentStatus;
  readonly amount_minor: number;
  readonly currency: string;
  readonly recipient_email: string;
  readonly paypal_batch_id: string | null;
  readonly paypal_item_id: string | null;
  readonly fee_minor: number | null;
  readonly message: string | null;
  readonly attempts: number;
  readonly submitted_at: string | null;
  readonly [column: string]: unknown;
}

export type PayoutAction = 'submit' | 'check' | 'wait' | 'none';

export interface PayoutStep {
  action: PayoutAction;
  authorization: PaymentAuthorization;
}

export interface PayoutRecord {
  authorizationId: string;
  status: PaymentStatus;
  batchId?: string | null;
  itemId?: string | null;
  feeMinor?: number | null;
  message?: string | null;
  raw?: unknown;
}

export interface PayoutEvent {
  authorizationId: string;
  eventId: string;
  eventType: string;
  verified: boolean;
  payload: unknown;
}

export interface PayoutStore {
  /** The cost manager sends the payout (42501 for anyone else). */
  begin(authorizationId: string, actorId: string): Promise<PayoutStep>;
  /** Any project member refreshes it; never starts an authorized operation. */
  resume(authorizationId: string, actorId: string): Promise<PayoutStep>;
  record(update: PayoutRecord): Promise<PaymentAuthorization>;
  /** False when the event id was recorded before. */
  recordEvent(event: PayoutEvent): Promise<boolean>;
}

/** A failed RPC; `sqlstate` is Postgres's error code (42501 forbidden, P0002 not found, ...). */
export class StoreError extends Error {
  readonly sqlstate: string | null;

  constructor(message: string, sqlstate: string | null) {
    super(message);
    this.name = 'StoreError';
    this.sqlstate = sqlstate;
  }
}

export interface RpcResult {
  data: unknown;
  error: { message: string; code?: string | null } | null;
}

/** The slice of a service-role SupabaseClient the store uses. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
}

const ACTIONS: ReadonlySet<string> = new Set(['submit', 'check', 'wait', 'none']);

export function createRpcPayoutStore(client: RpcClient): PayoutStore {
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(fn, args);
    if (error !== null) {
      throw new StoreError(error.message, error.code ?? null);
    }
    return data;
  };
  const step = (fn: string, data: unknown): PayoutStep => {
    const { action, authorization } = asObject(data);
    if (typeof action !== 'string' || !ACTIONS.has(action)) {
      throw new StoreError(`${fn} returned no action`, null);
    }
    return { action: action as PayoutAction, authorization: asAuthorization(fn, authorization) };
  };

  return {
    async begin(authorizationId, actorId) {
      return step('payout_begin', await call('payout_begin', { p_authorization: authorizationId, p_actor: actorId }));
    },
    async resume(authorizationId, actorId) {
      return step('payout_resume', await call('payout_resume', { p_authorization: authorizationId, p_actor: actorId }));
    },
    async record(update) {
      const data = await call('payout_record', {
        p_authorization: update.authorizationId,
        p_status: update.status,
        p_batch_id: update.batchId ?? null,
        p_item_id: update.itemId ?? null,
        p_fee_minor: update.feeMinor ?? null,
        p_message: update.message ?? null,
        p_raw: update.raw ?? null,
      });
      return asAuthorization('payout_record', data);
    },
    async recordEvent(event) {
      const data = await call('payout_record_event', {
        p_authorization: event.authorizationId,
        p_event_id: event.eventId,
        p_event_type: event.eventType,
        p_verified: event.verified,
        p_payload: event.payload,
      });
      if (typeof data !== 'boolean') {
        throw new StoreError('payout_record_event returned no boolean', null);
      }
      return data;
    },
  };
}

function asAuthorization(fn: string, value: unknown): PaymentAuthorization {
  if (!isObject(value) || text(value.id) === null || typeof value.status !== 'string') {
    throw new StoreError(`${fn} returned no payment authorization`, null);
  }
  return value as PaymentAuthorization;
}

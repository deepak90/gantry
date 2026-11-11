import { describe, expect, it } from 'vitest';
import { createRpcPayoutStore, StoreError, type RpcResult } from '../_shared/store.ts';
import { AUTH_ID, CM } from './fakes.ts';

function client(result: RpcResult) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return result;
    },
  };
}

const row = { id: AUTH_ID, status: 'submitted', amount_minor: 120000, currency: 'USD' };

describe('createRpcPayoutStore', () => {
  it('begin and resume pass the actor and read { action, authorization }', async () => {
    const rpc = client({ data: { action: 'submit', authorization: row }, error: null });
    const store = createRpcPayoutStore(rpc);
    expect(await store.begin(AUTH_ID, CM)).toEqual({ action: 'submit', authorization: row });
    await store.resume(AUTH_ID, CM);
    expect(rpc.calls).toEqual([
      { fn: 'payout_begin', args: { p_authorization: AUTH_ID, p_actor: CM } },
      { fn: 'payout_resume', args: { p_authorization: AUTH_ID, p_actor: CM } },
    ]);
  });

  it('record sends every parameter, null when not given', async () => {
    const rpc = client({ data: row, error: null });
    await createRpcPayoutStore(rpc).record({ authorizationId: AUTH_ID, status: 'pending', batchId: 'B' });
    expect(rpc.calls[0]).toEqual({
      fn: 'payout_record',
      args: {
        p_authorization: AUTH_ID,
        p_status: 'pending',
        p_batch_id: 'B',
        p_item_id: null,
        p_fee_minor: null,
        p_message: null,
        p_raw: null,
      },
    });
  });

  it('recordEvent returns the boolean', async () => {
    const rpc = client({ data: false, error: null });
    expect(
      await createRpcPayoutStore(rpc).recordEvent({ authorizationId: AUTH_ID, eventId: 'WH-1', eventType: 'T', verified: true, payload: {} }),
    ).toBe(false);
    expect(rpc.calls[0]?.args).toEqual({ p_authorization: AUTH_ID, p_event_id: 'WH-1', p_event_type: 'T', p_verified: true, p_payload: {} });
  });

  it('turns RPC errors into StoreError with the SQLSTATE', async () => {
    const store = createRpcPayoutStore(client({ data: null, error: { message: 'payout_begin: only the cost manager', code: '42501' } }));
    const error = await store.begin(AUTH_ID, CM).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ sqlstate: '42501', message: 'payout_begin: only the cost manager' });
  });

  it('rejects results of the wrong shape', async () => {
    await expect(createRpcPayoutStore(client({ data: { action: 'pay', authorization: row }, error: null })).begin(AUTH_ID, CM)).rejects.toThrow(
      StoreError,
    );
    await expect(createRpcPayoutStore(client({ data: null, error: null })).record({ authorizationId: AUTH_ID, status: 'pending' })).rejects.toThrow(
      StoreError,
    );
  });
});

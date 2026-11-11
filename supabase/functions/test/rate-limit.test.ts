import { describe, expect, it } from 'vitest';
import { HttpError } from '../_shared/http.ts';
import { createRateGate, PAYPAL_ALLOWANCES, type RateGateClient } from '../_shared/rate-limit.ts';

const USER = '00000000-0000-4000-8000-000000000012';
const OTHER = '00000000-0000-4000-8000-000000000013';
const PROJECT = '00000000-0000-4000-8000-000000000002';

const WINDOW_MS: Readonly<Record<string, number>> = { '1 minute': 60_000, '1 day': 86_400_000 };

/**
 * public.rate_gate as the migration has it: counts this person's rows of the kind within the window, refuses with
 * PT429 at the limit (recording nothing), else records one row.
 */
function fakeRateGate() {
  const state = { now: 0, rows: [] as { kind: string; user: string; at: number; project: unknown }[], calls: [] as Record<string, unknown>[] };
  const client: RateGateClient = {
    rpc: async (fn, args) => {
      expect(fn).toBe('rate_gate');
      state.calls.push(args);
      const windowMs = WINDOW_MS[String(args.p_user_window)];
      if (windowMs === undefined) throw new Error(`unexpected window ${String(args.p_user_window)}`);
      const used = state.rows.filter((row) => row.kind === args.p_kind && row.user === args.p_user && row.at > state.now - windowMs).length;
      if (used >= Number(args.p_user_max)) return { error: { code: 'PT429', message: 'Please wait a little before trying that again.' } };
      state.rows.push({ kind: String(args.p_kind), user: String(args.p_user), at: state.now, project: args.p_project });
      return { error: null };
    },
  };
  return { state, client };
}

const refusedWith = async (attempt: Promise<void>) => {
  const error = await attempt.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
};

describe('each person’s allowance of PayPal calls', () => {
  it('lets 10 calls a minute through, refuses the 11th with 429, and lets more through a minute later', async () => {
    const { state, client } = fakeRateGate();
    const gate = createRateGate(client);
    for (let i = 0; i < 10; i += 1) await gate('paypal_call', USER, PROJECT);
    const refused = await refusedWith(gate('paypal_call', USER, PROJECT));
    expect(refused).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(refused.message).toContain('Nothing was sent');
    // Someone else is counted on their own.
    await gate('paypal_call', OTHER, PROJECT);
    state.now += 60_001;
    await gate('paypal_call', USER, PROJECT);
  });

  it('stops at 100 a day, and a call the minute refused never used up the day', async () => {
    const { state, client } = fakeRateGate();
    const gate = createRateGate(client);
    for (let minute = 0; minute < 10; minute += 1) {
      for (let i = 0; i < 10; i += 1) await gate('paypal_call', USER, PROJECT);
      // Refused by the minute: not counted against the day.
      await refusedWith(gate('paypal_call', USER, PROJECT));
      state.now += 60_001;
    }
    expect(state.rows.filter((row) => row.kind === 'paypal_call_day')).toHaveLength(100);
    const refused = await refusedWith(gate('paypal_call', USER, PROJECT));
    expect(refused.message).toContain('today’s limit');
    state.now += 86_400_000;
    await gate('paypal_call', USER, PROJECT);
  });

  it('counts reads (the page’s own polling) apart from calls that pay, so polling never uses up paying', async () => {
    const { client } = fakeRateGate();
    const gate = createRateGate(client);
    // A progress payout's status every 2.5 s for a minute: 24 reads.
    for (let i = 0; i < 24; i += 1) await gate('paypal_read', USER, PROJECT);
    for (let i = 0; i < 10; i += 1) await gate('paypal_call', USER, PROJECT);
    expect(PAYPAL_ALLOWANCES.paypal_call.map((allowance) => [allowance.kind, allowance.max, allowance.window])).toEqual([
      ['paypal_call', 10, '1 minute'],
      ['paypal_call_day', 100, '1 day'],
    ]);
  });

  it('asks rate_gate per person only, with the project, through the service role’s RPC', async () => {
    const { state, client } = fakeRateGate();
    await createRateGate(client)('paypal_call', USER, PROJECT);
    expect(state.calls[0]).toEqual({
      p_kind: 'paypal_call',
      p_user: USER,
      p_ip: null,
      p_user_max: 10,
      p_user_window: '1 minute',
      p_ip_max: 10,
      p_ip_window: '1 minute',
      p_project: PROJECT,
    });
  });

  it('fails the call rather than letting it through uncounted when rate_gate is missing', async () => {
    const gate = createRateGate({
      rpc: async () => ({ error: { code: 'PGRST202', message: 'Could not find the function public.rate_gate in the schema cache' } }),
    });
    await expect(gate('paypal_call', USER, PROJECT)).rejects.toThrow('rate_gate');
  });

  it('fails the call, without saying the database’s words to the browser, when rate_gate itself fails', async () => {
    const gate = createRateGate({ rpc: async () => ({ error: { code: '57014', message: 'canceling statement due to statement timeout' } }) });
    const error = await gate('paypal_call', USER, PROJECT).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
  });
});

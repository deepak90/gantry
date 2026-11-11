import { describe, expect, it } from 'vitest';
import { createPayPalApi, PayPalAuthError, TOKEN_EARLY_MS, type Fetch } from '../_shared/paypal.ts';
import { jsonResponse } from './fakes.ts';

/** A PayPal that hands out numbered tokens and counts sign-ins; `reject` names tokens it no longer takes. */
function tokenPayPal(options: { expiresIn?: number | null } = {}) {
  const state = { signIns: 0, reads: [] as string[], reject: new Set<string>() };
  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') {
      state.signIns += 1;
      const lifetime = options.expiresIn === undefined ? 32400 : options.expiresIn;
      return jsonResponse(200, { access_token: `TOKEN-${state.signIns}`, token_type: 'Bearer', ...(lifetime === null ? {} : { expires_in: lifetime }) });
    }
    const bearer = new Headers(init.headers).get('authorization') ?? '';
    state.reads.push(bearer);
    if (state.reject.has(bearer.replace(/^Bearer /, ''))) return jsonResponse(401, { error: 'invalid_token', error_description: 'Token signature verification failed' });
    return jsonResponse(200, { batch_header: { payout_batch_id: 'B-1', batch_status: 'SUCCESS' } });
  };
  return { state, fetch };
}

const api = (fetch: Fetch, now: () => number, clientId = 'client-id') => createPayPalApi({ mode: 'live', clientId, clientSecret: 'secret', fetch, now });

describe('the PayPal sign-in is kept for the function instance', () => {
  it('signs in once, and every request after that uses the kept token', async () => {
    const { state, fetch } = tokenPayPal();
    let clock = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      const session = await api(fetch, () => clock).connect();
      await session.getPayoutBatch('B-1');
      clock += 60_000;
    }
    expect(state.signIns).toBe(1);
    expect(state.reads).toEqual(Array(5).fill('Bearer TOKEN-1'));
  });

  it('signs in again a minute before PayPal says the token expires', async () => {
    const { state, fetch } = tokenPayPal({ expiresIn: 3600 });
    let clock = 0;
    await api(fetch, () => clock).connect();
    clock = 3600_000 - TOKEN_EARLY_MS - 1;
    await api(fetch, () => clock).connect();
    expect(state.signIns).toBe(1);
    clock = 3600_000 - TOKEN_EARLY_MS;
    const session = await api(fetch, () => clock).connect();
    await session.getPayoutBatch('B-1');
    expect(state.signIns).toBe(2);
    expect(state.reads).toEqual(['Bearer TOKEN-2']);
  });

  it('keeps no token PayPal gave no lifetime, or one too short to keep', async () => {
    for (const expiresIn of [null, 30, 60]) {
      const { state, fetch } = tokenPayPal({ expiresIn });
      await api(fetch, () => 0).connect();
      await api(fetch, () => 0).connect();
      expect(state.signIns, String(expiresIn)).toBe(2);
    }
  });

  it('shares one sign-in between requests that arrive together', async () => {
    const { state, fetch } = tokenPayPal();
    const sessions = await Promise.all([1, 2, 3].map(() => api(fetch, () => 0).connect()));
    expect(sessions).toHaveLength(3);
    expect(state.signIns).toBe(1);
  });

  it('keeps tokens apart per app credentials and per fetch', async () => {
    const first = tokenPayPal();
    await api(first.fetch, () => 0, 'app-a').connect();
    await api(first.fetch, () => 0, 'app-b').connect();
    expect(first.state.signIns).toBe(2);
    const second = tokenPayPal();
    await api(second.fetch, () => 0, 'app-a').connect();
    expect(second.state.signIns).toBe(1);
  });

  it('drops a token PayPal stops taking, signs in again and repeats the call once', async () => {
    const { state, fetch } = tokenPayPal();
    const session = await api(fetch, () => 0).connect();
    state.reject.add('TOKEN-1');
    const reply = await session.getPayoutBatch('B-1');
    expect(reply).toMatchObject({ kind: 'reply', status: 200 });
    expect(state.reads).toEqual(['Bearer TOKEN-1', 'Bearer TOKEN-2']);
    // The next request starts from the new token.
    await (await api(fetch, () => 0).connect()).getPayoutBatch('B-1');
    expect(state.signIns).toBe(2);
    expect(state.reads.at(-1)).toBe('Bearer TOKEN-2');
  });

  it('gives the 401 back when no new token can be had, and repeats nothing', async () => {
    const { state, fetch: base } = tokenPayPal();
    let refuseSignIn = false;
    const fetch: Fetch = async (url, init) => {
      if (refuseSignIn && new URL(url).pathname === '/v1/oauth2/token') return jsonResponse(401, { error: 'invalid_client' });
      return base(url, init);
    };
    const session = await api(fetch, () => 0).connect();
    state.reject.add('TOKEN-1');
    refuseSignIn = true;
    const reply = await session.getPayoutBatch('B-1');
    expect(reply).toMatchObject({ kind: 'reply', status: 401 });
    expect(state.reads).toEqual(['Bearer TOKEN-1']);
  });

  it('does not keep a refused sign-in: the next request signs in again', async () => {
    let attempts = 0;
    const fetch: Fetch = async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse(401, { error: 'invalid_client' }) : jsonResponse(200, { access_token: 'TOKEN-OK', expires_in: 32400 });
    };
    await expect(api(fetch, () => 0).connect()).rejects.toBeInstanceOf(PayPalAuthError);
    await expect(api(fetch, () => 0).connect()).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });
});

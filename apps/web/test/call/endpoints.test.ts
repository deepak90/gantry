/**
 * Where the call's token and room news come from: the dev server's `/__call/*` on this machine, asked every 4 s; the
 * hosted site's `/api/call/*`, signed with the person's access token, asked every 15 s. On the hosted site a 403 or
 * 409 comes back in the server's own words.
 */
import { describe, expect, it, vi } from 'vitest';
import { callEndpoints, CallRefusedError, DEV_POLL_MS, HOSTED_POLL_MS, requestCallToken, requestRoom } from '../../src/call/endpoints';
import type { TokenRequest } from '../../src/call/protocol';

const REQUEST: TokenRequest = {
  projectId: '00000000-0000-4000-8000-000000000002',
  sessionId: '0f8e5c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b',
  name: 'Deepak Jayaram',
  color: '#2563eb',
  role: 'cm',
  sim: false,
  remy: true,
};

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('callEndpoints', () => {
  it('uses the dev server’s routes on this machine, every 4 s, unsigned', async () => {
    const endpoints = callEndpoints({ hosted: false, accessToken: async () => 'jwt' });
    expect(endpoints.tokenUrl).toBe('/__call/token');
    expect(endpoints.roomUrl(REQUEST.projectId)).toBe(`/__call/room?projectId=${REQUEST.projectId}`);
    expect(endpoints.pollMs).toBe(DEV_POLL_MS);
    expect(DEV_POLL_MS).toBe(4_000);
    await expect(endpoints.headers()).resolves.toEqual({});
  });

  it('uses the site’s routes on the hosted site, every 15 s, with the access token', async () => {
    const endpoints = callEndpoints({ hosted: true, accessToken: async () => 'jwt-abc', livekitUrl: 'wss://calls.example' });
    expect(endpoints.tokenUrl).toBe('/api/call/token');
    expect(endpoints.roomUrl('p 1')).toBe('/api/call/room?projectId=p%201');
    expect(endpoints.pollMs).toBe(HOSTED_POLL_MS);
    expect(HOSTED_POLL_MS).toBe(15_000);
    await expect(endpoints.headers()).resolves.toEqual({ Authorization: 'Bearer jwt-abc' });
  });

  it('sends no Authorization when there is no token to send', async () => {
    await expect(callEndpoints({ hosted: true, accessToken: async () => null }).headers()).resolves.toEqual({});
    await expect(callEndpoints({ hosted: true, accessToken: async () => Promise.reject(new Error('no session')) }).headers()).resolves.toEqual({});
  });
});

describe('requestCallToken', () => {
  it('posts the same request to the hosted route, signed, and reads the same answer', async () => {
    const fetcher = vi.fn(async () => reply(200, { url: 'wss://calls.example', token: 'lk-token', remy: 'dispatched' }));
    const token = await requestCallToken(callEndpoints({ hosted: true, accessToken: async () => 'jwt-abc' }), REQUEST, fetcher);
    expect(token).toEqual({ url: 'wss://calls.example', token: 'lk-token', remy: 'dispatched' });
    expect(fetcher).toHaveBeenCalledWith('/api/call/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify(REQUEST),
    });
  });

  it('connects to VITE_LIVEKIT_URL when the answer names no server', async () => {
    const fetcher = async () => reply(200, { token: 'lk-token' });
    await expect(requestCallToken(callEndpoints({ hosted: true, livekitUrl: 'wss://calls.example' }), REQUEST, fetcher)).resolves.toMatchObject({ url: 'wss://calls.example' });
  });

  it('turns a hosted refusal into the server’s own words, with its status', async () => {
    for (const status of [403, 409]) {
      const words = status === 409 ? 'Remy is on three calls, the most she takes at once.' : 'Calls are switched off.';
      const error = await requestCallToken(callEndpoints({ hosted: true }), REQUEST, async () => reply(status, { error: words })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CallRefusedError);
      expect((error as CallRefusedError).message).toBe(words);
      expect((error as CallRefusedError).status).toBe(status);
      expect((error as CallRefusedError).code).toBeNull();
    }
  });

  it('carries the server’s reason with a refusal, and ignores one that isn’t a plain word', async () => {
    const spent = await requestCallToken(callEndpoints({ hosted: true }), REQUEST, async () => reply(403, { error: 'Used up.', code: 'allowance_spent' })).catch((caught: unknown) => caught);
    expect((spent as CallRefusedError).code).toBe('allowance_spent');
    const odd = await requestCallToken(callEndpoints({ hosted: true }), REQUEST, async () => reply(409, { error: 'Busy.', code: '<script>' })).catch((caught: unknown) => caught);
    expect((odd as CallRefusedError).code).toBeNull();
  });

  it('keeps the dev server’s answers plain errors, as they always were', async () => {
    const error = await requestCallToken(callEndpoints({ hosted: false }), REQUEST, async () => reply(403, { error: 'Not from this machine' })).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(CallRefusedError);
    expect((error as Error).message).toBe('Not from this machine');
    const silent = await requestCallToken(callEndpoints({ hosted: false }), REQUEST, async () => reply(500, {})).catch((caught: unknown) => caught);
    expect((silent as Error).message).toBe('the dev server answered 500');
  });
});

describe('requestRoom', () => {
  it('asks the hosted route who is on the call, signed', async () => {
    const fetcher = vi.fn(async () => reply(200, { up: true, people: ['Chris Hale', 7], remy: true }));
    const news = await requestRoom(callEndpoints({ hosted: true, accessToken: async () => 'jwt-abc' }), 'p-1', fetcher);
    expect(news).toEqual({ up: true, people: ['Chris Hale'], remy: true });
    expect(fetcher).toHaveBeenCalledWith('/api/call/room?projectId=p-1', { headers: { Authorization: 'Bearer jwt-abc' } });
  });

  it('says nothing when the route refuses or can’t be reached', async () => {
    await expect(requestRoom(callEndpoints({ hosted: true }), 'p-1', async () => reply(403, { error: 'No.' }))).resolves.toBeNull();
    await expect(requestRoom(callEndpoints({ hosted: false }), 'p-1', async () => Promise.reject(new TypeError('Failed to fetch')))).resolves.toBeNull();
  });
});

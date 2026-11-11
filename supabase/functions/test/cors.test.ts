import { describe, expect, it } from 'vitest';
import { allowedOrigin, corsHeaders, SITE_ORIGIN } from '../_shared/cors.ts';
import { createInvoiceHandler } from '../_shared/invoices.ts';
import { createProgressPayoutHandler } from '../_shared/progress-payouts.ts';
import { sandboxAccounts } from '../_shared/accounts.ts';
import { envOf, FakePayPal, FakeStore, payoutHandler } from './fakes.ts';

const HOSTED = envOf({ GANTRY_HOSTED: '1' });
const LOCAL = envOf({});

const asked = (origin: string | null, method = 'OPTIONS') => new Request('http://localhost/x', { method, headers: origin ? { Origin: origin } : {} });

describe('which pages may read the functions’ answers', () => {
  it('lets the hosted site in, on the hosted project and off it', () => {
    expect(allowedOrigin(SITE_ORIGIN, HOSTED)).toBe(SITE_ORIGIN);
    expect(allowedOrigin('https://gantry-pearl.vercel.app', LOCAL)).toBe('https://gantry-pearl.vercel.app');
  });

  it('lets a dev server on this machine in only off the hosted project', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5214', 'http://[::1]:4173']) {
      expect(allowedOrigin(origin, LOCAL)).toBe(origin);
      expect(allowedOrigin(origin, HOSTED)).toBeNull();
    }
  });

  it('keeps every other page out', () => {
    for (const origin of [
      'https://evil.example',
      'https://gantry-pearl.vercel.app.evil.example',
      'https://gantry-git-preview.vercel.app',
      'http://gantry-pearl.vercel.app',
      'https://localhost:5173',
      'http://localhost',
      'http://localhost:5173.evil.example',
      'null',
    ]) {
      expect(allowedOrigin(origin, LOCAL), origin).toBeNull();
      expect(allowedOrigin(origin, HOSTED), origin).toBeNull();
    }
    expect(allowedOrigin(null, LOCAL)).toBeNull();
  });

  it('follows the site when it moves (GANTRY_SITE_ORIGIN)', () => {
    const moved = envOf({ GANTRY_HOSTED: '1', GANTRY_SITE_ORIGIN: 'https://gantry.example/' });
    expect(allowedOrigin('https://gantry.example', moved)).toBe('https://gantry.example');
    expect(allowedOrigin(SITE_ORIGIN, moved)).toBeNull();
  });

  it('names the asking origin, never *, and says the answer varies by it', () => {
    const allowed = corsHeaders(asked(SITE_ORIGIN), HOSTED);
    expect(allowed['Access-Control-Allow-Origin']).toBe(SITE_ORIGIN);
    expect(allowed.Vary).toBe('Origin');
    const refused = corsHeaders(asked('https://evil.example'), HOSTED);
    expect(refused['Access-Control-Allow-Origin']).toBeUndefined();
    expect(refused.Vary).toBe('Origin');
    expect(Object.values(corsHeaders(asked(null), LOCAL))).not.toContain('*');
  });
});

describe('every PayPal function answers CORS by origin', () => {
  const store = new FakeStore();
  const handlers = {
    'paypal-execute-payout': payoutHandler('execute', store, new FakePayPal(), { GANTRY_HOSTED: '1' }),
    'paypal-reconcile': payoutHandler('reconcile', store, new FakePayPal(), { GANTRY_HOSTED: '1' }),
    'paypal-invoice': createInvoiceHandler({
      env: HOSTED,
      fetch: () => Promise.reject(new Error('never')),
      store: { read: async () => null, update: async () => Promise.reject(new Error('never')), markSent: async () => Promise.reject(new Error('never')), canBill: async () => false },
      resolveUser: async () => null,
    }),
    'paypal-progress-payout': createProgressPayoutHandler({
      env: HOSTED,
      accounts: sandboxAccounts({}),
      fetch: () => Promise.reject(new Error('never')),
      resolveUser: async () => null,
      seesCosts: async () => false,
      claimTarget: { supabaseUrl: '', anonKey: '', fetch: () => Promise.reject(new Error('never')) },
      batches: { record: async () => undefined, has: async () => false },
    }),
  };

  for (const [name, handle] of Object.entries(handlers)) {
    it(`${name}: the site's preflight and answers carry its origin; another page's carry none`, async () => {
      const preflight = await handle(asked(SITE_ORIGIN));
      expect(preflight.status).toBe(200);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(SITE_ORIGIN);
      expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');

      const refusedPreflight = await handle(asked('https://evil.example'));
      expect(refusedPreflight.headers.get('access-control-allow-origin')).toBeNull();

      const answer = await handle(new Request('http://localhost/x', { method: 'POST', headers: { Origin: SITE_ORIGIN }, body: '{}' }));
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(answer.headers.get('access-control-allow-origin')).toBe(SITE_ORIGIN);
      expect(answer.headers.get('vary')).toBe('Origin');

      const elsewhere = await handle(new Request('http://localhost/x', { method: 'POST', headers: { Origin: 'http://localhost:5173' }, body: '{}' }));
      expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
    });
  }
});

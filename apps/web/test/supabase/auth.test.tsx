import type { Session } from '@supabase/supabase-js';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { signInWithPassword, signOut, useSession, type AuthClient, type SessionState } from '../../src/supabase/auth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(token: string): Session {
  return {
    access_token: token,
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id: 'user-1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-21T00:00:00Z' },
  } as Session;
}

function fakeAuth(initial: Session | null) {
  const calls: unknown[] = [];
  let listener: ((event: string, session: Session | null) => void) | undefined;
  let unsubscribed = 0;
  const client: AuthClient = {
    auth: {
      async signInWithPassword(credentials) {
        calls.push(['signIn', credentials]);
        return credentials.password === 'wrong'
          ? { data: { session: null }, error: { message: 'Invalid login credentials' } }
          : { data: { session: session('jwt-signed-in') }, error: null };
      },
      async signOut() {
        calls.push(['signOut']);
        return { error: null };
      },
      async getSession() {
        return { data: { session: initial }, error: null };
      },
      onAuthStateChange(callback) {
        listener = callback;
        return { data: { subscription: { unsubscribe: () => unsubscribed++ } } };
      },
    },
  };
  return {
    client,
    calls,
    emit: (event: string, next: Session | null) => listener?.(event, next),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('supabase/auth helpers', () => {
  it('signInWithPassword() returns the session or throws the auth message', async () => {
    const fake = fakeAuth(null);
    const result = await signInWithPassword(fake.client, 'pm@demo.local', 'demo-pm-2026');
    expect(result.access_token).toBe('jwt-signed-in');
    expect(fake.calls).toEqual([['signIn', { email: 'pm@demo.local', password: 'demo-pm-2026' }]]);
    await expect(signInWithPassword(fake.client, 'pm@demo.local', 'wrong')).rejects.toThrow('Sign-in failed: Invalid login credentials');
  });

  it('signOut() delegates to the auth client', async () => {
    const fake = fakeAuth(session('jwt-current'));
    await signOut(fake.client);
    expect(fake.calls).toEqual([['signOut']]);
  });
});

describe('useSession()', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) {
      const r = root;
      await act(async () => r.unmount());
    }
    container?.remove();
  });

  it('reads the stored session once, then follows auth changes and unsubscribes on unmount', async () => {
    const fake = fakeAuth(session('jwt-stored'));
    const seen: SessionState[] = [];
    function Probe() {
      const state = useSession(fake.client);
      seen.push(state);
      return <span>{state.loading ? 'loading' : state.session?.access_token ?? 'signed out'}</span>;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const mounted = root;

    await act(async () => mounted.render(<Probe />));
    expect(seen[0]).toEqual({ session: null, loading: true });
    expect(container.textContent).toBe('jwt-stored');

    await act(async () => fake.emit('TOKEN_REFRESHED', session('jwt-refreshed')));
    expect(container.textContent).toBe('jwt-refreshed');

    await act(async () => fake.emit('SIGNED_OUT', null));
    expect(container.textContent).toBe('signed out');
    expect(seen.at(-1)).toEqual({ session: null, loading: false });

    await act(async () => mounted.unmount());
    root = undefined;
    expect(fake.unsubscribed).toBe(1);
  });
});

import type { Session } from '@supabase/supabase-js';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SEED_MEMBERS } from '@collab/shared/seed';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_LOGINS, LoginScreen } from '../../src/app/LoginScreen';
import type { AuthClient } from '../../src/supabase/auth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeAuth() {
  const attempts: Array<{ email: string; password: string }> = [];
  const client: AuthClient = {
    auth: {
      async signInWithPassword(credentials) {
        attempts.push(credentials);
        return credentials.password === 'demo-pm-2026'
          ? { data: { session: { access_token: 'jwt' } as Session }, error: null }
          : { data: { session: null }, error: { message: 'Invalid login credentials' } };
      },
      async signOut() {
        return { error: null };
      },
      async getSession() {
        return { data: { session: null }, error: null };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  return { client, attempts };
}

describe('LoginScreen', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
      root = undefined;
    }
    container?.remove();
  });

  async function mount(client: AuthClient) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const mounted = root;
    await act(async () => mounted.render(<LoginScreen client={client} />));
    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    const form = container.querySelector<HTMLFormElement>('form')!;
    return { email, password, form };
  }

  it('offers the two seeded demo accounts', () => {
    expect(DEMO_LOGINS.map((login) => [login.email, login.password])).toEqual(
      SEED_MEMBERS.map((member) => [member.email, member.password]),
    );
  });

  it('fills the demo credentials into the form and signs in with them', async () => {
    const { client, attempts } = fakeAuth();
    const { email, password, form } = await mount(client);
    expect(email.value).toBe('');

    const pmButton = container!.querySelector<HTMLButtonElement>('[data-testid="demo-login-pm"]')!;
    await act(async () => pmButton.click());
    expect(email.value).toBe('pm@demo.local');
    expect(password.value).toBe('demo-pm-2026');

    await act(async () => form.requestSubmit());
    expect(attempts).toEqual([{ email: 'pm@demo.local', password: 'demo-pm-2026' }]);
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the auth error for a rejected sign-in', async () => {
    const { client } = fakeAuth();
    const { form } = await mount(client);
    const cmButton = container!.querySelector<HTMLButtonElement>('[data-testid="demo-login-cm"]')!;
    await act(async () => cmButton.click());
    await act(async () => form.requestSubmit());
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe('Sign-in failed: Invalid login credentials');
  });
});

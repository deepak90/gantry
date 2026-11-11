import { describe, expect, it, vi } from 'vitest';
import {
  SupabaseConfigError,
  TEAMMATE_AUTH_KEY,
  TEAMMATE_MARK,
  chooseTab,
  createSupabaseClient,
  readSupabaseConfig,
  type TabStorage,
} from '../../src/supabase/client';

const ENV = { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: 'anon-key' };

/** Web Storage in memory, with the calls it got. */
function memoryStorage(initial: Record<string, string> = {}): TabStorage & { items: Map<string, string>; getItem: ReturnType<typeof vi.fn> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
  };
}

describe('supabase/client', () => {
  it('reads and trims the Vite variables', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: ' http://127.0.0.1:54321 ', VITE_SUPABASE_ANON_KEY: ' anon ' })).toEqual({
      url: 'http://127.0.0.1:54321',
      anonKey: 'anon',
    });
  });

  it('names every missing variable in one clear error', () => {
    expect(() => readSupabaseConfig({})).toThrow(SupabaseConfigError);
    expect(() => readSupabaseConfig({})).toThrow(/set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps\/web\/\.env/);
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: 'http://x' })).toThrow(/set VITE_SUPABASE_ANON_KEY/);
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: 'k' })).toThrow(/set VITE_SUPABASE_URL /);
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: 'localhost:54321', VITE_SUPABASE_ANON_KEY: 'k' })).toThrow(/http\(s\) URL/);
  });

  it('creates a client from a valid configuration', () => {
    const client = createSupabaseClient(ENV);
    expect(typeof client.rpc).toBe('function');
    expect(typeof client.channel).toBe('function');
    expect(typeof client.auth.getSession).toBe('function');
    expect(() => createSupabaseClient({})).toThrow(SupabaseConfigError);
  });
});

describe('a teammate in the next tab', () => {
  it('is the browser’s tab, as always, unless the address asks for a teammate', () => {
    const local = memoryStorage();
    const session = memoryStorage();
    expect(chooseTab({ hosted: true, search: '?join=tok', local, session })).toEqual({ teammate: false, storage: local, asked: false });
    expect(session.items.size).toBe(0);
  });

  it('is never a teammate’s off the hosted site', () => {
    const local = memoryStorage();
    const session = memoryStorage({ [TEAMMATE_MARK]: '1' });
    expect(chooseTab({ hosted: false, search: '?join=tok&as=teammate', local, session })).toEqual({ teammate: false, storage: local, asked: false });
  });

  it('becomes a teammate’s on as=teammate, marked in its own sessionStorage, as a new person', () => {
    const local = memoryStorage();
    const session = memoryStorage({ [TEAMMATE_AUTH_KEY]: '{"copied":"from the tab that opened it"}', [`${TEAMMATE_AUTH_KEY}-user`]: '{}', other: 'kept' });
    const tab = chooseTab({ hosted: true, search: '?join=tok&as=teammate', local, session });
    expect(tab).toEqual({ teammate: true, storage: session, asked: true });
    expect(session.items.get(TEAMMATE_MARK)).toBe('1');
    expect(session.items.has(TEAMMATE_AUTH_KEY)).toBe(false);
    expect(session.items.has(`${TEAMMATE_AUTH_KEY}-user`)).toBe(false);
    expect(session.items.get('other')).toBe('kept');
  });

  it('stays a teammate’s after a reload, keeping its sign-in', () => {
    const local = memoryStorage();
    const session = memoryStorage({ [TEAMMATE_MARK]: '1', [TEAMMATE_AUTH_KEY]: '{"access_token":"teammate"}' });
    expect(chooseTab({ hosted: true, search: '', local, session })).toEqual({ teammate: true, storage: session, asked: false });
    expect(session.items.get(TEAMMATE_AUTH_KEY)).toBe('{"access_token":"teammate"}');
  });

  it('is the browser’s tab where sessionStorage is missing or blocked', () => {
    const local = memoryStorage();
    expect(chooseTab({ hosted: true, search: '?as=teammate', local, session: null })).toMatchObject({ teammate: false, storage: local });
    const blocked = memoryStorage();
    blocked.setItem = () => {
      throw new Error('SecurityError');
    };
    expect(chooseTab({ hosted: true, search: '?as=teammate', local, session: blocked })).toMatchObject({ teammate: false, storage: local });
  });

  it('signs in from its own storage, under its own key; the browser’s tab keeps the default', async () => {
    const session = memoryStorage();
    const teammate = createSupabaseClient(ENV, { teammate: true, storage: session, asked: false });
    await teammate.auth.getSession();
    expect(session.getItem).toHaveBeenCalledWith(TEAMMATE_AUTH_KEY);

    const local = memoryStorage();
    const browsers = createSupabaseClient(ENV, { teammate: false, storage: local, asked: false });
    await browsers.auth.getSession();
    expect(local.getItem).not.toHaveBeenCalled();
  });
});

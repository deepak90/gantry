import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HOSTED } from '../hosted';

/** `import.meta.env` or a test substitute: Vite exposes every variable as a string. */
export type SupabaseEnv = Readonly<Record<string, string | boolean | undefined>>;

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

/** Reads and validates the browser-side Supabase settings (only `VITE_*` variables reach the bundle). */
export function readSupabaseConfig(env: SupabaseEnv = import.meta.env): SupabaseConfig {
  const url = stringValue(env.VITE_SUPABASE_URL);
  const anonKey = stringValue(env.VITE_SUPABASE_ANON_KEY);
  const missing = [url === '' && 'VITE_SUPABASE_URL', anonKey === '' && 'VITE_SUPABASE_ANON_KEY'].filter(
    (name): name is string => typeof name === 'string',
  );
  if (missing.length > 0) {
    throw new SupabaseConfigError(
      `Supabase is not configured: set ${missing.join(' and ')} in .env.local at the repo root (copy .env.example; ` +
        'for a local stack, paste the ANON_KEY that `supabase status -o env` prints).',
    );
  }
  if (!/^https?:\/\//.test(url)) {
    throw new SupabaseConfigError(`VITE_SUPABASE_URL must be an http(s) URL, got "${url}"`);
  }
  return { url, anonKey };
}

function stringValue(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

// A teammate in the next tab ---------------------------------------------------------------------------------------
//
// On the hosted site, the invite card opens `/app?join=<token>&as=teammate` in a new tab, so someone alone at one
// computer can try a session with two people. Every tab of a browser shares one anonymous sign-in (localStorage),
// so that tab keeps a sign-in of its own in its sessionStorage instead, and so does what it remembers (copy/store.ts):
// it signs in as someone else and takes the next seat. A reload keeps it a teammate; the other tabs are unaffected.

/** Where a teammate tab keeps its own sign-in, in its sessionStorage. */
export const TEAMMATE_AUTH_KEY = 'gantry.teammate.auth';
/** The mark a teammate tab keeps in its sessionStorage, so a reload keeps it a teammate. */
export const TEAMMATE_MARK = 'gantry.teammate';

/** The part of Web Storage this uses. */
export interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface TabChoice {
  /** A second person in this browser, signed in on this tab alone. */
  teammate: boolean;
  /** Where this tab keeps its sign-in and the session it remembers: sessionStorage for a teammate, else localStorage. */
  storage: TabStorage | null;
  /** The address asked for a teammate (`as=teammate`): it comes out of the address. */
  asked: boolean;
}

/**
 * Whether this tab is a teammate's: the address asks for one, or the tab was one before a reload. Only on the hosted
 * site, and only where sessionStorage works; otherwise the tab is the browser's, as always. A new ask is a new person:
 * whatever sign-in this tab's sessionStorage held goes (a browser may copy sessionStorage into a tab it opens).
 */
export function chooseTab({ hosted, search, local, session }: { hosted: boolean; search: string; local: TabStorage | null; session: TabStorage | null }): TabChoice {
  const asked = hosted && new URLSearchParams(search).get('as') === 'teammate';
  const browsers: TabChoice = { teammate: false, storage: local, asked };
  if (!hosted || !session) return browsers;
  try {
    if (asked) {
      const held = Array.from({ length: session.length }, (_, index) => session.key(index)).filter((key): key is string => key?.startsWith(TEAMMATE_AUTH_KEY) ?? false);
      for (const key of held) session.removeItem(key);
      session.setItem(TEAMMATE_MARK, '1');
      return { teammate: true, storage: session, asked };
    }
    return session.getItem(TEAMMATE_MARK) === '1' ? { teammate: true, storage: session, asked } : browsers;
  } catch {
    return browsers;
  }
}

function webStorage(kind: 'localStorage' | 'sessionStorage'): TabStorage | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    return null;
  }
}

let tab: TabChoice | undefined;

/** This tab's choice, made once when the page starts; `as=teammate` is then taken out of the address. */
export function currentTab(): TabChoice {
  if (tab) return tab;
  const search = typeof window === 'undefined' ? '' : window.location.search;
  tab = chooseTab({ hosted: HOSTED, search, local: webStorage('localStorage'), session: webStorage('sessionStorage') });
  if (tab.asked) {
    const url = new URL(window.location.href);
    url.searchParams.delete('as');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return tab;
}

/** A client; a teammate tab's keeps its sign-in in that tab's own storage, under a key of its own. */
export function createSupabaseClient(env?: SupabaseEnv, choice?: TabChoice): SupabaseClient {
  const { url, anonKey } = readSupabaseConfig(env);
  if (choice?.teammate && choice.storage) {
    return createClient(url, anonKey, { auth: { storage: choice.storage, storageKey: TEAMMATE_AUTH_KEY } });
  }
  return createClient(url, anonKey);
}

let shared: SupabaseClient | undefined;

/** The app-wide client, created on first use so a missing configuration fails where it can be shown. */
export function getSupabaseClient(): SupabaseClient {
  shared ??= createSupabaseClient(undefined, currentTab());
  return shared;
}

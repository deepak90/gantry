/**
 * The session this browser is in, remembered beside the anonymous sign-in, so a reload or a second tab opens the
 * same session instead of claiming another. Both live in the tab's storage (supabase/client.ts): localStorage, shared
 * by the browser's tabs, or a teammate tab's own sessionStorage. Kept per user: a different sign-in never picks up
 * someone else's session. Storage may be missing or blocked; then nothing is remembered and a reload asks again.
 * The name the person has in the session goes with it, so starting over can ask for the same one.
 */
import { currentTab } from '../supabase/client';
import type { Copy } from './rpc';

const KEY = 'gantry.copy';

export interface CopyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function tabStorage(): CopyStorage | null {
  try {
    return currentTab().storage;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function readStoredCopy(userId: string, storage: CopyStorage | null = tabStorage()): Copy | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Record<string, unknown> | null;
    const projectId = text(saved?.projectId);
    if (!saved || saved.userId !== userId || !projectId) return null;
    return { projectId, joinToken: text(saved.joinToken), code: text(saved.code), leaseUntil: text(saved.leaseUntil), name: text(saved.name) };
  } catch {
    return null;
  }
}

export function storeCopy(userId: string, copy: Copy, storage: CopyStorage | null = tabStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ userId, ...copy }));
  } catch {
    // Not remembered: a reload asks again.
  }
}

export function forgetCopy(storage: CopyStorage | null = tabStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    // Nothing to forget it in.
  }
}

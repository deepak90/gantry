/**
 * The project's library for this tab: one LibraryStore, started with the project and stopped with
 * it, and its snapshot for rendering.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { LibraryStore, type LibraryClient, type LibraryRealtimeClient, type LibrarySnapshot } from './store';

export function useLibraryStore(client: SupabaseClient, projectId: string): LibraryStore | null {
  const [store, setStore] = useState<LibraryStore | null>(null);
  useEffect(() => {
    const next = new LibraryStore(client as unknown as LibraryClient & LibraryRealtimeClient, projectId);
    next.start();
    setStore(next);
    return () => {
      next.dispose();
      setStore(null);
    };
  }, [client, projectId]);
  return store;
}

const EMPTY: LibrarySnapshot = { status: 'loading', folders: [], entries: [], unreadable: 0, error: null };

export function useLibrarySnapshot(store: LibraryStore | null): LibrarySnapshot {
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => undefined), [store]);
  const read = useCallback(() => (store ? store.getSnapshot() : EMPTY), [store]);
  return useSyncExternalStore(subscribe, read, read);
}

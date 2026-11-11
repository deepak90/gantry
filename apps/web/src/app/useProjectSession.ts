import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { projectSessions, sessionKey, type ProjectSessionHandle, type ProjectSessionState } from './project-session';
import { supabaseProjectSessionDeps } from './supabase-deps';

export interface UseProjectSessionResult {
  state: ProjectSessionState;
  /** Clears a sync error and re-attempts the outbox. */
  retrySync(): void;
  /** Throws the current boot away and runs it again (after a boot error). */
  restart(): void;
}

/**
 * Joins (or starts) the collaborating client for the signed-in user. The shared manager makes the
 * StrictMode double effect harmless: both runs join the same boot, and the cleanup of the first run
 * only schedules a disposal that the second run cancels.
 */
export function useProjectSession(client: SupabaseClient, session: Session, projectId?: string): UseProjectSessionResult {
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<ProjectSessionState>({ phase: 'resolving' });
  const handleRef = useRef<ProjectSessionHandle | null>(null);
  const userId = session.user.id;
  const email = session.user.email;

  useEffect(() => {
    const handle = projectSessions.acquire(sessionKey(userId, projectId), () =>
      supabaseProjectSessionDeps(client, { id: userId, email }, projectId),
    );
    handleRef.current = handle;
    setState(handle.state);
    const unsubscribe = handle.subscribe(() => setState(handle.state));
    return () => {
      unsubscribe();
      if (handleRef.current === handle) {
        handleRef.current = null;
      }
      projectSessions.release(handle);
    };
  }, [client, userId, email, projectId, generation]);

  const retrySync = useCallback(() => handleRef.current?.retrySync(), []);
  const restart = useCallback(() => {
    const handle = handleRef.current;
    if (handle) {
      projectSessions.discard(handle);
    }
    setGeneration((value) => value + 1);
  }, []);

  return { state, retrySync, restart };
}

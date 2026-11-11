import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

export interface AuthErrorLike {
  message: string;
}

/** The slice of `SupabaseClient` the auth helpers use; small enough to fake in tests. */
export interface AuthClient {
  auth: {
    signInWithPassword(credentials: {
      email: string;
      password: string;
    }): Promise<{ data: { session: Session | null }; error: AuthErrorLike | null }>;
    signOut(): Promise<{ error: AuthErrorLike | null }>;
    getSession(): Promise<{ data: { session: Session | null }; error: AuthErrorLike | null }>;
    onAuthStateChange(callback: (event: string, session: Session | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
}

export async function signInWithPassword(client: AuthClient, email: string, password: string): Promise<Session> {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Sign-in failed: ${error.message}`);
  }
  if (!data.session) {
    throw new Error('Sign-in did not return a session (is the account confirmed?)');
  }
  return data.session;
}

export async function signOut(client: AuthClient): Promise<void> {
  const { error } = await client.auth.signOut();
  if (error) {
    throw new Error(`Sign-out failed: ${error.message}`);
  }
}

export interface SessionState {
  session: Session | null;
  /** True until the stored session has been read once. */
  loading: boolean;
}

/** Tracks the signed-in session: reads it once, then follows auth state changes. */
export function useSession(client: AuthClient): SessionState {
  const [state, setState] = useState<SessionState>({ session: null, loading: true });

  useEffect(() => {
    let active = true;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      if (active) {
        setState({ session, loading: false });
      }
    });
    void client.auth.getSession().then(
      ({ data }) => {
        if (active) {
          setState({ session: data.session, loading: false });
        }
      },
      () => {
        if (active) {
          setState({ session: null, loading: false });
        }
      },
    );
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  return state;
}

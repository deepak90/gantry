import type { SupabaseClient } from '@supabase/supabase-js';
import { useMemo } from 'react';
import { LoginScreen } from './app/LoginScreen';
import { StatusScreen } from './app/StatusScreen';
import { Workspace } from './app/Workspace';
import { CopyGate } from './copy/CopyGate';
import { HOSTED } from './hosted';
import { useSession } from './supabase/auth';
import { getSupabaseClient } from './supabase/client';

/**
 * Root of the web app: configuration check, then the way in. On this machine, the auth gate between the sign-in
 * screen and the workspace. On the hosted site, the visitor's own copy (copy/CopyGate.tsx): the sign-in screen and
 * its demo accounts are left out of that build.
 */
export function App() {
  const client = useMemo<SupabaseClient | string>(() => {
    try {
      return getSupabaseClient();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, []);

  if (typeof client === 'string') {
    return <StatusScreen tone="error" title="Configuration needed" message={client} />;
  }
  return HOSTED ? <CopyGate client={client} /> : <AuthGate client={client} />;
}

function AuthGate({ client }: { client: SupabaseClient }) {
  const { session, loading } = useSession(client);
  if (loading) {
    return <StatusScreen title="Checking your session…" />;
  }
  if (!session) {
    return <LoginScreen client={client} />;
  }
  return <Workspace client={client} session={session} />;
}

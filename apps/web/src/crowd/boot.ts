/**
 * Signs one simulated person in and boots their session the way a browser tab does (project-session.ts
 * with the Supabase deps): a `sessions` row, `load_project`, their own ProjectModel and RevisionSync,
 * and a presence session marked simulated. Each person has their own Supabase client: own auth, own
 * Realtime socket, nothing persisted.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ProjectSessionHandle, type ReadyProjectSession } from '../app/project-session';
import { supabaseProjectSessionDeps } from '../app/supabase-deps';
import { PresenceSession } from '../presence/session';
import { SupabasePresenceTransport, asPresenceClient } from '../presence/supabase-presence';
import type { SupabaseConfig } from '../supabase/client';
import type { PersonParts } from './person';
import type { Persona } from './personas';

export interface Credentials {
  id: string;
  email: string;
  password: string;
}

export interface BootedPerson {
  client: SupabaseClient;
  ready: ReadyProjectSession;
  parts: PersonParts;
  dispose(): void;
}

/** Pointer updates go out at most this often per simulated person (the hand usually sends less). */
const CURSOR_INTERVAL_MS = 120;
/** View frames while followed: ten a second (a browser sends twenty); the follower draws in between. */
const FRAME_INTERVAL_MS = 100;

export async function bootPerson(config: SupabaseConfig, projectId: string | null, credentials: Credentials, persona: Persona): Promise<BootedPerson> {
  const client = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `crowd-${credentials.id}` },
  });
  const { data, error } = await client.auth.signInWithPassword({ email: credentials.email, password: credentials.password });
  if (error || !data.user) throw new Error(`${persona.person.name} could not sign in: ${error?.message ?? 'no user'}`);
  const base = supabaseProjectSessionDeps(client, { id: data.user.id, email: credentials.email }, projectId ?? undefined);
  const handle = new ProjectSessionHandle(`crowd:${credentials.id}:${projectId ?? '*'}`, {
    ...base,
    createPresence: ({ projectId: id, sessionId, userId, role, profile }) =>
      new PresenceSession({
        self: { session: sessionId, user: userId, name: profile.displayName, color: profile.color ?? persona.person.color, role, simulated: true },
        transport: new SupabasePresenceTransport(asPresenceClient(client), id, sessionId, { onWarning: (message) => console.warn(`[crowd ${persona.firstName}] ${message}`) }),
        cursorIntervalMs: CURSOR_INTERVAL_MS,
        frameIntervalMs: FRAME_INTERVAL_MS,
      }),
  });
  let ready: ReadyProjectSession;
  try {
    ready = await new Promise<ReadyProjectSession>((resolve, reject) => {
      const check = () => {
        const state = handle.state;
        if (state.phase === 'ready') resolve(state);
        else if (state.phase === 'error') reject(new Error(state.message));
      };
      handle.subscribe(check);
      check();
    });
  } catch (bootError) {
    handle.dispose();
    void client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    throw bootError;
  }
  if (!ready.presence) throw new Error('presence did not start');
  return {
    client,
    ready,
    parts: { persona, displayName: ready.profile.displayName, project: ready.project, sync: ready.revisions, presence: ready.presence, sessionId: ready.sessionId },
    dispose() {
      handle.dispose();
      void client.removeAllChannels();
      void client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    },
  };
}

/** Tasks with rented equipment (bookings drive payments and the demo's story): the crowd keeps out of them. */
export async function bookedTasks(client: SupabaseClient, projectId: string): Promise<Set<number>> {
  const { data, error } = await client.from('equipment_bookings').select('task_id').eq('project_id', projectId);
  if (error) throw new Error(`Cannot read bookings: ${error.message}`);
  return new Set((data ?? []).map((row: { task_id: unknown }) => Number(row.task_id)).filter(Number.isInteger));
}

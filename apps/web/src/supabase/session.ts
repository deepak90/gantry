import type { SupabaseClient } from '@supabase/supabase-js';

export interface SessionsErrorLike {
  message: string;
}

/** The slice of `SupabaseClient` used to register a browser session; small enough to fake in tests. */
export interface SessionsClient {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null }; error: SessionsErrorLike | null }>;
  };
  /** The real method type: a structural copy of the PostgREST builder chain is too deep for the compiler to compare. */
  from: SupabaseClient['from'];
}

export interface RegisterSessionOptions {
  /** Heartbeat period for `last_seen`; 30 s by default. */
  heartbeatMs?: number;
  /** Client-generated UUID; defaults to `crypto.randomUUID()`. */
  sessionId?: string;
  now?: () => Date;
  /** Heartbeat failures are reported here instead of being thrown. */
  onError?: (error: unknown) => void;
}

export interface SessionRegistration {
  /** The `sessions.id`; also the Bryntum clientId. */
  sessionId: string;
  userId: string;
  /** Stops the heartbeat. */
  stop(): void;
}

export const SESSION_HEARTBEAT_MS = 30_000;

/** Inserts a `sessions` row for this tab and keeps `last_seen` fresh until `stop()`. */
export async function registerSession(
  client: SessionsClient,
  projectId: string,
  options: RegisterSessionOptions = {},
): Promise<SessionRegistration> {
  const { data, error } = await client.auth.getSession();
  if (error) {
    throw new Error(`Cannot register the session: ${error.message}`);
  }
  const user = data.session?.user;
  if (!user) {
    throw new Error('Cannot register the session: nobody is signed in');
  }

  const sessionId = options.sessionId ?? randomUuid();
  const now = options.now ?? (() => new Date());
  const { error: insertError } = await client
    .from('sessions')
    .insert({ id: sessionId, user_id: user.id, project_id: projectId, last_seen: now().toISOString() });
  if (insertError) {
    throw new Error(`Cannot register the session: ${insertError.message}`);
  }

  const report = options.onError ?? ((heartbeatError: unknown) => console.warn('session heartbeat failed', heartbeatError));
  const timer = setInterval(() => {
    Promise.resolve(client.from('sessions').update({ last_seen: now().toISOString() }).eq('id', sessionId)).then(
      ({ error: updateError }) => {
        if (updateError) {
          report(new Error(updateError.message));
        }
      },
      report,
    );
  }, options.heartbeatMs ?? SESSION_HEARTBEAT_MS);

  return { sessionId, userId: user.id, stop: () => clearInterval(timer) };
}

export function randomUuid(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  // RFC 4122 v4 from getRandomValues, for runtimes without randomUUID.
  const bytes = new Uint8Array(16);
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

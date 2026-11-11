import type { OutgoingRevision, ProjectRevisionRow, SubmitRevisionArgs } from '@collab/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asProjectRevisionRow, projectRevisionRowSchema } from '../supabase/schemas';
import {
  RevisionRejectedError,
  TransportUnavailableError,
  type RevisionTransport,
  type TransportHandlers,
  type TransportStatus,
} from './transport';

export interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export interface PostgrestResultLike {
  data: unknown;
  error: PostgrestErrorLike | null;
  status?: number;
}

/**
 * The two RealtimeChannel methods the transport calls. Their return values are not used, and typing
 * them as `unknown` keeps the structural check against the real class from recursing.
 */
export interface RevisionChannel {
  on(type: 'broadcast', filter: { event: string }, callback: (message: { payload?: unknown }) => void): unknown;
  subscribe(callback?: (status: string, err?: Error) => void, timeout?: number): unknown;
}

/** The slice of `SupabaseClient` the transport uses; the real client satisfies it, and tests fake it. */
export interface RevisionSupabaseClient {
  rpc(fn: string, args?: object): PromiseLike<PostgrestResultLike>;
  /** The real method type: a structural copy of the PostgREST builder chain is too deep for the compiler to compare. */
  from: SupabaseClient['from'];
  channel(name: string, options?: { config?: { private?: boolean } }): RevisionChannel;
  removeChannel(channel: RevisionChannel): Promise<unknown>;
  realtime: { setAuth(token?: string | null): Promise<void> };
  auth: { getSession(): Promise<{ data: { session: { access_token: string } | null } }> };
}

export interface SupabaseTransportOptions {
  /** Defaults to the signed-in session's JWT; private channels are joined with it. */
  getAccessToken?: () => Promise<string | null>;
  onWarning?: (message: string, error?: unknown) => void;
}

export const REVISION_BROADCAST_EVENT = 'revision';

export function revisionsTopic(projectId: string): string {
  return `project:${projectId}:revisions`;
}

/**
 * `RevisionTransport` over Supabase: `submit_revision` RPC, `project_revisions` select for catch-up,
 * and the private `project:{id}:revisions` broadcast channel.
 */
export class SupabaseTransport implements RevisionTransport {
  readonly projectId: string;
  private readonly client: RevisionSupabaseClient;
  private readonly options: SupabaseTransportOptions;

  constructor(client: RevisionSupabaseClient, projectId: string, options: SupabaseTransportOptions = {}) {
    this.client = client;
    this.projectId = projectId;
    this.options = options;
  }

  async submit(rev: OutgoingRevision): Promise<ProjectRevisionRow> {
    const args: SubmitRevisionArgs = {
      p_project: this.projectId,
      p_client_id: rev.clientId,
      p_local_revision_id: String(rev.localRevisionId),
      p_conflict_for: rev.conflictResolutionFor == null ? null : String(rev.conflictResolutionFor),
      p_changes: rev.changes,
    };
    if (rev.origin) {
      args.p_origin = rev.origin;
    }
    if (rev.publicationId) {
      args.p_publication = rev.publicationId;
    }
    const { data, error } = await this.client.rpc('submit_revision', args);
    if (error) {
      throw toTransportError(error, 'submit_revision');
    }
    // A `returns project_revisions` RPC yields one object; `returns setof` yields a one-element array.
    const row = Array.isArray(data) ? data[0] : data;
    const parsed = projectRevisionRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new RevisionRejectedError(`submit_revision returned an unexpected row: ${parsed.error.message}`, 'INVALID_RESPONSE');
    }
    return asProjectRevisionRow(parsed.data);
  }

  async fetchAfter(revisionNo: number): Promise<ProjectRevisionRow[]> {
    const { data, error } = await this.client
      .from('project_revisions')
      .select('*')
      .eq('project_id', this.projectId)
      .gt('revision_no', revisionNo)
      .order('revision_no', { ascending: true });
    if (error) {
      throw toTransportError(error, 'project_revisions select');
    }
    const parsed = projectRevisionRowSchema.array().safeParse(data ?? []);
    if (!parsed.success) {
      throw new TransportUnavailableError(`project_revisions returned unexpected rows: ${parsed.error.message}`);
    }
    return parsed.data.map(asProjectRevisionRow);
  }

  subscribe({ onRevision, onStatus }: TransportHandlers): () => void {
    let active = true;
    const channel = this.client.channel(revisionsTopic(this.projectId), { config: { private: true } });

    channel.on('broadcast', { event: REVISION_BROADCAST_EVENT }, (message) => {
      if (!active) {
        return;
      }
      const parsed = projectRevisionRowSchema.safeParse(unwrapBroadcastPayload(message.payload));
      if (parsed.success) {
        onRevision(asProjectRevisionRow(parsed.data));
      } else {
        this.warn('ignoring a malformed revision broadcast', parsed.error);
      }
    });

    void (async () => {
      try {
        const token = await this.getAccessToken();
        if (token) {
          await this.client.realtime.setAuth(token);
        } else {
          this.warn('no access token: joining the private revisions channel will be refused');
        }
      } catch (error) {
        this.warn('realtime.setAuth failed', error);
      }
      if (!active) {
        return;
      }
      channel.subscribe((status, error) => {
        if (!active) {
          return;
        }
        if (error) {
          this.warn(`revisions channel ${status}`, error);
        }
        const mapped = mapChannelStatus(status);
        if (mapped) {
          onStatus(mapped);
        }
      });
    })();

    return () => {
      active = false;
      this.client.removeChannel(channel).catch((error: unknown) => this.warn('removeChannel failed', error));
    };
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.options.getAccessToken) {
      return this.options.getAccessToken();
    }
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  private warn(message: string, error?: unknown): void {
    if (this.options.onWarning) {
      this.options.onWarning(message, error);
    } else {
      console.warn(`[SupabaseTransport ${this.projectId}] ${message}`, error);
    }
  }
}

export function mapChannelStatus(status: string): TransportStatus | undefined {
  switch (status) {
    case 'SUBSCRIBED':
      return 'connected';
    case 'CHANNEL_ERROR':
    case 'TIMED_OUT':
      return 'reconnecting';
    case 'CLOSED':
      return 'closed';
    default:
      return undefined;
  }
}

/** `realtime.send()` delivers the row itself; `realtime.broadcast_changes()` wraps it as `{ record, ... }`. */
function unwrapBroadcastPayload(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null && !('revision_no' in payload) && 'record' in payload) {
    return (payload as { record: unknown }).record;
  }
  return payload;
}

/**
 * Postgres and PostgREST failures carry a code and mean the server refused the request; a failed
 * fetch has no code. Transient instead, so the outbox keeps retrying: connection-class SQLSTATEs
 * (08, 53, 57), serialization failures (40001, 40P01) and PostgREST's own connection errors
 * PGRST000-PGRST003 (database unreachable, pool timeout), which never reached the function.
 */
export function toTransportError(error: PostgrestErrorLike, operation: string): Error {
  const code = error.code ?? '';
  const transient =
    code === '' || /^(08|53|57)/.test(code) || code === '40001' || code === '40P01' || /^PGRST00[0-3]$/.test(code);
  if (transient) {
    return new TransportUnavailableError(`${operation} failed: ${error.message}`, { cause: error });
  }
  return new RevisionRejectedError(`${operation} failed: ${error.message}`, code);
}

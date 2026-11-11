import type { ProjectRevisionRow } from '@collab/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  SupabaseTransport,
  mapChannelStatus,
  toTransportError,
  type PostgrestResultLike,
  type RevisionChannel,
  type RevisionSupabaseClient,
} from '../../src/sync/supabase-transport';
import { RevisionRejectedError, TransportUnavailableError, type TransportStatus } from '../../src/sync/transport';

const PROJECT = '00000000-0000-4000-8000-0000000000aa';

function sampleRow(revisionNo: number): ProjectRevisionRow {
  return {
    id: `row-${revisionNo}`,
    project_id: PROJECT,
    revision_no: revisionNo,
    client_id: 'session-1',
    local_revision_id: `local-${revisionNo}`,
    conflict_resolution_for: null,
    changes: { tasks: { updated: [{ id: 1, name: `v${revisionNo}` }], $input: { updated: [{ id: 1, name: `v${revisionNo}` }] } } },
    actor_user_id: 'user-1',
    origin: 'human',
    created_at: '2026-10-21T10:00:00Z',
  };
}

/** Records the query chain and resolves with a preset result, like a PostgrestFilterBuilder. */
class FakeQuery implements PromiseLike<PostgrestResultLike> {
  readonly chain: Array<[string, unknown[]]> = [];

  constructor(private readonly result: PostgrestResultLike) {}

  select(...args: unknown[]) {
    this.chain.push(['select', args]);
    return this;
  }

  eq(...args: unknown[]) {
    this.chain.push(['eq', args]);
    return this;
  }

  gt(...args: unknown[]) {
    this.chain.push(['gt', args]);
    return this;
  }

  order(...args: unknown[]) {
    this.chain.push(['order', args]);
    return this;
  }

  then<TResult1 = PostgrestResultLike, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResultLike) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

class FakeChannel implements RevisionChannel {
  readonly bindings: Array<{ type: string; filter: { event: string }; callback: (message: { payload?: unknown }) => void }> = [];
  statusCallback: ((status: string, err?: Error) => void) | undefined;
  subscribed = false;

  constructor(
    readonly topic: string,
    readonly options: unknown,
  ) {}

  on(type: 'broadcast', filter: { event: string }, callback: (message: { payload?: unknown }) => void): RevisionChannel {
    this.bindings.push({ type, filter, callback });
    return this;
  }

  subscribe(callback?: (status: string, err?: Error) => void): RevisionChannel {
    this.subscribed = true;
    this.statusCallback = callback;
    return this;
  }

  broadcast(payload: unknown): void {
    for (const binding of this.bindings) {
      binding.callback({ payload });
    }
  }
}

class FakeSupabase implements RevisionSupabaseClient {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  rpcResult: PostgrestResultLike = { data: null, error: null };
  fromCalls: string[] = [];
  queries: FakeQuery[] = [];
  queryResult: PostgrestResultLike = { data: [], error: null };
  channels: FakeChannel[] = [];
  removed: RevisionChannel[] = [];
  tokensSet: Array<string | null | undefined> = [];
  accessToken: string | null = 'jwt-123';
  events: string[] = [];

  rpc(fn: string, args?: object): PromiseLike<PostgrestResultLike> {
    this.rpcCalls.push({ fn, args });
    return Promise.resolve(this.rpcResult);
  }

  // The fake chain stands in for the PostgREST builder; the cast is the only way to satisfy its generic type.
  from = ((table: string) => {
    this.fromCalls.push(table);
    const query = new FakeQuery(this.queryResult);
    this.queries.push(query);
    return query;
  }) as unknown as SupabaseClient['from'];

  channel(name: string, options?: { config?: { private?: boolean } }): RevisionChannel {
    const channel = new FakeChannel(name, options);
    this.channels.push(channel);
    this.events.push('channel');
    return channel;
  }

  removeChannel(channel: RevisionChannel): Promise<unknown> {
    this.removed.push(channel);
    return Promise.resolve('ok');
  }

  realtime = {
    setAuth: async (token?: string | null) => {
      this.tokensSet.push(token);
      this.events.push('setAuth');
    },
  };

  auth = {
    getSession: async () => ({ data: { session: this.accessToken ? { access_token: this.accessToken } : null } }),
  };
}

describe('SupabaseTransport', () => {
  it('submit() maps the revision onto the submit_revision RPC arguments and returns the row', async () => {
    const client = new FakeSupabase();
    const transport = new SupabaseTransport(client, PROJECT);
    const changes = { tasks: { added: [{ $PhantomId: 'p1', name: 'New' }] } };
    client.rpcResult = { data: sampleRow(5), error: null };

    const row = await transport.submit({ clientId: 'session-1', localRevisionId: 3, changes });

    expect(client.rpcCalls).toEqual([
      {
        fn: 'submit_revision',
        args: {
          p_project: PROJECT,
          p_client_id: 'session-1',
          p_local_revision_id: '3',
          p_conflict_for: null,
          p_changes: changes,
        },
      },
    ]);
    expect(row).toEqual(sampleRow(5));
  });

  it('submit() passes conflictResolutionFor as a string and unwraps a setof result', async () => {
    const client = new FakeSupabase();
    const transport = new SupabaseTransport(client, PROJECT);
    client.rpcResult = { data: [sampleRow(6)], error: null };

    const row = await transport.submit({ clientId: 'session-1', localRevisionId: 'local-4', conflictResolutionFor: 5, changes: {} });

    expect(client.rpcCalls[0]!.args).toMatchObject({ p_local_revision_id: 'local-4', p_conflict_for: '5' });
    expect(row.revision_no).toBe(6);
  });

  it('submit() classifies Postgres errors as rejections and fetch failures as unavailable', async () => {
    const client = new FakeSupabase();
    const transport = new SupabaseTransport(client, PROJECT);

    client.rpcResult = { data: null, error: { message: 'store calendars is not allowed', code: 'P0001' } };
    await expect(transport.submit({ clientId: 'c', localRevisionId: 1, changes: {} })).rejects.toBeInstanceOf(RevisionRejectedError);

    client.rpcResult = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };
    await expect(transport.submit({ clientId: 'c', localRevisionId: 1, changes: {} })).rejects.toBeInstanceOf(
      TransportUnavailableError,
    );

    // PostgREST could not reach the database (pool timeout): the function never ran, so the outbox retries.
    client.rpcResult = { data: null, error: { message: 'Timed out acquiring connection from connection pool.', code: 'PGRST003' } };
    await expect(transport.submit({ clientId: 'c', localRevisionId: 1, changes: {} })).rejects.toBeInstanceOf(
      TransportUnavailableError,
    );

    client.rpcResult = { data: { unexpected: true }, error: null };
    await expect(transport.submit({ clientId: 'c', localRevisionId: 1, changes: {} })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('fetchAfter() queries project_revisions after the given revision, ordered ascending', async () => {
    const client = new FakeSupabase();
    const transport = new SupabaseTransport(client, PROJECT);
    client.queryResult = { data: [sampleRow(8), sampleRow(9)], error: null };

    const rows = await transport.fetchAfter(7);

    expect(client.fromCalls).toEqual(['project_revisions']);
    expect(client.queries[0]!.chain).toEqual([
      ['select', ['*']],
      ['eq', ['project_id', PROJECT]],
      ['gt', ['revision_no', 7]],
      ['order', ['revision_no', { ascending: true }]],
    ]);
    expect(rows.map((row) => row.revision_no)).toEqual([8, 9]);

    client.queryResult = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };
    await expect(transport.fetchAfter(7)).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it('subscribe() sets the realtime auth token, joins the private channel and maps events', async () => {
    const client = new FakeSupabase();
    const warnings: string[] = [];
    const transport = new SupabaseTransport(client, PROJECT, { onWarning: (message) => warnings.push(message) });
    const received: ProjectRevisionRow[] = [];
    const statuses: TransportStatus[] = [];

    const unsubscribe = transport.subscribe({ onRevision: (row) => received.push(row), onStatus: (status) => statuses.push(status) });

    const channel = client.channels[0]!;
    expect(channel.topic).toBe(`project:${PROJECT}:revisions`);
    expect(channel.options).toEqual({ config: { private: true } });
    expect(channel.bindings).toHaveLength(1);
    expect(channel.bindings[0]).toMatchObject({ type: 'broadcast', filter: { event: 'revision' } });

    await vi.waitFor(() => expect(channel.subscribed).toBe(true));
    expect(client.tokensSet).toEqual(['jwt-123']);
    expect(client.events).toEqual(['channel', 'setAuth']);

    channel.statusCallback!('SUBSCRIBED');
    channel.statusCallback!('CHANNEL_ERROR', new Error('boom'));
    channel.statusCallback!('TIMED_OUT');
    channel.statusCallback!('CLOSED');
    expect(statuses).toEqual(['connected', 'reconnecting', 'reconnecting', 'closed']);
    expect(warnings).toEqual(['revisions channel CHANNEL_ERROR']);

    channel.broadcast(sampleRow(11));
    channel.broadcast({ record: sampleRow(12), operation: 'INSERT', table: 'project_revisions' });
    channel.broadcast({ nonsense: true });
    expect(received.map((row) => row.revision_no)).toEqual([11, 12]);
    expect(warnings).toHaveLength(2);

    unsubscribe();
    expect(client.removed).toEqual([channel]);
    channel.broadcast(sampleRow(13));
    channel.statusCallback!('SUBSCRIBED');
    expect(received).toHaveLength(2);
    expect(statuses).toHaveLength(4);
  });

  it('subscribe() uses a custom token provider and warns when there is no token', async () => {
    const client = new FakeSupabase();
    const warnings: string[] = [];
    const transport = new SupabaseTransport(client, PROJECT, {
      getAccessToken: async () => null,
      onWarning: (message) => warnings.push(message),
    });
    transport.subscribe({ onRevision: () => undefined, onStatus: () => undefined });
    await vi.waitFor(() => expect(client.channels[0]!.subscribed).toBe(true));
    expect(client.tokensSet).toEqual([]);
    expect(warnings[0]).toMatch(/no access token/);
  });

  it('mapChannelStatus() and toTransportError() cover the documented states and codes', () => {
    expect(mapChannelStatus('SUBSCRIBED')).toBe('connected');
    expect(mapChannelStatus('CHANNEL_ERROR')).toBe('reconnecting');
    expect(mapChannelStatus('TIMED_OUT')).toBe('reconnecting');
    expect(mapChannelStatus('CLOSED')).toBe('closed');
    expect(mapChannelStatus('JOINING')).toBeUndefined();

    expect(toTransportError({ message: 'x', code: '' }, 'op')).toBeInstanceOf(TransportUnavailableError);
    expect(toTransportError({ message: 'x' }, 'op')).toBeInstanceOf(TransportUnavailableError);
    expect(toTransportError({ message: 'x', code: '08006' }, 'op')).toBeInstanceOf(TransportUnavailableError);
    expect(toTransportError({ message: 'x', code: '40001' }, 'op')).toBeInstanceOf(TransportUnavailableError);
    expect(toTransportError({ message: 'x', code: '42501' }, 'op')).toBeInstanceOf(RevisionRejectedError);
    expect(toTransportError({ message: 'x', code: 'PGRST301' }, 'op')).toBeInstanceOf(RevisionRejectedError);
    expect(toTransportError({ message: 'x', code: 'PGRST202' }, 'op')).toBeInstanceOf(RevisionRejectedError);
    // PostgREST connection group (PGRST000-003): the database was unreachable, nothing was evaluated.
    for (const code of ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003']) {
      expect(toTransportError({ message: 'db down', code }, 'op'), code).toBeInstanceOf(TransportUnavailableError);
    }
    expect(toTransportError({ message: 'denied', code: '42501' }, 'submit_revision').message).toBe('submit_revision failed: denied');
  });
});

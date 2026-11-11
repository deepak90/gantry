import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStore } from '../src/data/supabase-store';
import { silentLogger, type Logger } from '../src/log';
import { SupabaseAgentTransport, type RealtimeChannelLike, type RealtimeClientLike } from '../src/realtime/transport';
import { FakeDb } from '../src/dev/fake';

/** A tiny stand-in for supabase-js's query builder: filters rows in memory and records writes. */
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  const writes: { table: string; op: string; value: unknown; filters: [string, unknown][] }[] = [];
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    let op = 'select';
    let value: unknown = null;
    let single = false;
    let limit: number | null = null;
    const run = () => {
      let rows = (tables[table] ?? []).filter((row) =>
        filters.every(([kind, column, expected]) =>
          kind === 'eq' ? row[column] === expected : kind === 'gt' ? (row[column] as number) > (expected as number) : (expected as unknown[]).includes(row[column]),
        ),
      );
      if (op === 'insert') {
        const row = { id: `id-${writes.length + 1}`, ...(value as object) };
        writes.push({ table, op, value, filters: [] });
        rows = [row];
      } else if (op === 'update') {
        writes.push({ table, op, value, filters: filters.map(([, column, expected]) => [column, expected]) });
        for (const row of rows) Object.assign(row, value as object);
      }
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, expected: unknown) => (filters.push(['eq', column, expected]), builder),
      gt: (column: string, expected: unknown) => (filters.push(['gt', column, expected]), builder),
      in: (column: string, expected: unknown[]) => (filters.push(['in', column, expected]), builder),
      order: () => builder,
      limit: (count: number) => ((limit = count), builder),
      single: () => ((single = true), builder),
      maybeSingle: () => ((single = true), builder),
      insert: (row: unknown) => ((op = 'insert'), (value = row), builder),
      update: (patch: unknown) => ((op = 'update'), (value = patch), builder),
      then: (resolve: (result: unknown) => void) => resolve(run()),
    };
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, writes };
}

describe('SupabaseStore', () => {
  const seed = new FakeDb();
  const projectId = seed.projectId;

  it('reads the workflow with the shared schemas and skips a row that does not fit', async () => {
    const warnings: string[] = [];
    const log: Logger = { info() {}, warn: (message) => warnings.push(message) };
    const { client } = fakeSupabase({
      proposals: [
        { id: '11111111-1111-4111-8111-111111111111', project_id: projectId, booking_id: seed.plan.bookings[0]!.id, state: 'evaluated', current_version_no: 1, created_by: null, created_at: '2026-10-23T10:00:00+00:00', updated_at: '2026-10-23T10:00:00+00:00' },
        { id: 'not-a-uuid', project_id: projectId, state: 'weird' },
      ],
      project_documents: seed.workflow.documents as unknown as Record<string, unknown>[],
    });
    const workflow = await new SupabaseStore(client, log).loadWorkflow(projectId);
    expect(workflow.proposals).toHaveLength(1);
    expect(workflow.documents[0]?.kind).toBe('quote');
    expect(warnings.join()).toMatch(/skipped a proposals row/);
  });

  it('reads the plan rows: project, revisions after the snapshot, bookings, members with names', async () => {
    const { client } = fakeSupabase({
      projects: [{ ...seed.plan.project, snapshot_revision: 0 }],
      project_revisions: [
        { project_id: projectId, revision_no: 0, changes: {} },
        { project_id: projectId, revision_no: 1, changes: { tasks: { updated: [{ id: 15, name: 'Renamed' }] } } },
      ],
      equipment_bookings: seed.plan.bookings.map((booking) => ({ ...booking, project_id: projectId })),
      project_members: seed.plan.members.map((member) => ({ ...member, project_id: projectId })),
      profiles: seed.plan.profiles as unknown as Record<string, unknown>[],
    });
    const rows = await new SupabaseStore(client, silentLogger).loadPlanRows(projectId);
    expect(rows.revisions.map((revision) => revision.revision_no)).toEqual([1]);
    expect(rows.profiles.map((profile) => profile.display_name)).toEqual(['Chris Hale', 'Deepak Jayaram']);
  });

  it('stores the assistant’s reply and its commands, and withdraws only a pending command', async () => {
    const { client, writes } = fakeSupabase({ agent_commands: [{ id: 'c1', status: 'running' }] });
    const store = new SupabaseStore(client, silentLogger);
    await store.insertAssistantMessage({ project_id: projectId, thread_id: null, turn_id: 't1', channel: 'app', text: 'Hello', cards: [] });
    await store.insertCommand({ project_id: projectId, type: 'propose_fix', args: { x: 1 }, requested_by: 'u1', required_revision: 2 });
    expect(writes[0]).toMatchObject({ table: 'agent_messages', value: { role: 'assistant', author_id: null, action: null, channel: 'app', text: 'Hello' } });
    expect(writes[1]).toMatchObject({ table: 'agent_commands', value: { status: 'pending', requested_by: 'u1', required_revision: 2 } });
    expect(await store.cancelCommandIfPending('c1')).toBe(false);
  });
});

class FakeChannel implements RealtimeChannelLike {
  handlers: { type: string; event: string; callback: (message: { payload?: unknown }) => void }[] = [];
  subscribeCallback: ((status: string, error?: Error) => void) | undefined;
  sent: unknown[] = [];
  tracked = false;
  constructor(
    readonly name: string,
    readonly config: Record<string, unknown>,
  ) {}
  on(type: string, filter: { event: string }, callback: (message: { payload?: unknown }) => void) {
    this.handlers.push({ type, event: filter.event, callback });
    return this;
  }
  subscribe(callback?: (status: string, error?: Error) => void) {
    this.subscribeCallback = callback;
    return this;
  }
  presenceState() {
    return { s: [{ session: 's', user: 'u', name: 'P', role: 'pm', since: 1 }] };
  }
  track() {
    this.tracked = true;
    return Promise.resolve();
  }
  send(message: unknown) {
    this.sent.push(message);
    return Promise.resolve('ok');
  }
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers) if (handler.event === event) handler.callback({ payload });
  }
}

describe('SupabaseAgentTransport', () => {
  const projectId = '00000000-0000-4000-8000-000000000001';
  function setup() {
    const channels: FakeChannel[] = [];
    const removed: FakeChannel[] = [];
    const client: RealtimeClientLike = {
      channel: (name, options) => {
        const channel = new FakeChannel(name, options.config);
        channels.push(channel);
        return channel;
      },
      removeChannel: async (channel) => removed.push(channel as FakeChannel),
    };
    const calls: string[] = [];
    const transport = new SupabaseAgentTransport(client, silentLogger, 'agent-test', [5, 5]);
    transport.connect(projectId, {
      onPresence: () => calls.push('presence'),
      onWorkflowChange: () => calls.push('workflow'),
      onRevision: () => calls.push('revision'),
      onAgentMessage: (id) => calls.push(`message:${id}`),
      onCommand: (id) => calls.push(`command:${id}`),
    });
    return { channels, removed, calls, transport };
  }

  it('joins the four private topics, listens to presence without tracking, and routes database events', () => {
    const { channels, calls } = setup();
    expect(channels.map((channel) => channel.name)).toEqual([`project:${projectId}:presence`, `project:${projectId}:workflow`, `project:${projectId}:revisions`, `project:${projectId}:agent`]);
    expect(channels.every((channel) => channel.config.private === true)).toBe(true);
    for (const channel of channels) channel.subscribeCallback?.('SUBSCRIBED');
    channels[0]!.fire('sync');
    channels[2]!.fire('revision', { revision_no: 3 });
    channels[3]!.fire('message', { id: 'm1' });
    channels[3]!.fire('command', { id: 'c1', status: 'succeeded' });
    channels[3]!.fire('message', { nope: true });
    expect(calls).toEqual(['workflow', 'presence', 'revision', 'message:m1', 'command:c1']);
    expect(channels[0]!.tracked).toBe(false);
  });

  it('queues stream events until the agent topic is joined, then sends them as `stream`', () => {
    const { channels, transport } = setup();
    const event = { type: 'turn_end', turn_id: 't', message_id: null } as const;
    transport.sendStream(projectId, event);
    expect(channels[3]!.sent).toEqual([]);
    channels[3]!.subscribeCallback?.('SUBSCRIBED');
    expect(channels[3]!.sent).toEqual([{ type: 'broadcast', event: 'stream', payload: event }]);
  });

  it('joins a closed channel again from scratch after a delay', async () => {
    const { channels, removed } = setup();
    channels[1]!.subscribeCallback?.('CLOSED');
    expect(removed).toContain(channels[1]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channels.at(-1)!.name).toBe(`project:${projectId}:workflow`);
    expect(channels).toHaveLength(5);
  });
});

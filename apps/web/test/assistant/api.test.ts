/**
 * The assistant API against a fake Supabase client: the thread read (latest first from the server,
 * oldest first to the caller), the RPC arguments, validation of what comes back and of what is sent,
 * and refusals passed on with their SQLSTATE. The SQL rules are pinned by supabase/tests/12_assistant.sql.
 */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { AgentCommandRow, AgentMessageRow } from '@collab/shared';
import {
  AssistantError,
  claimAgentCommand,
  completeAgentCommand,
  loadCommand,
  loadThread,
  postAgentMessage,
  type AssistantClient,
} from '../../src/assistant/api';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const PM = '00000000-0000-4000-8000-000000000011';
const SESSION = '00000000-0000-4000-8000-00000000c011';
const COMMAND = '00000000-0000-4000-8000-00000000cc01';

function message(n: number, overrides: Partial<AgentMessageRow> = {}): AgentMessageRow {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    project_id: PROJECT,
    turn_id: null,
    role: 'person',
    author_id: PM,
    channel: 'text',
    text: `message ${n}`,
    cards: [],
    action: null,
    created_at: `2026-11-02T09:00:0${n}+00:00`,
    ...overrides,
  };
}

function command(overrides: Partial<AgentCommandRow> = {}): AgentCommandRow {
  return {
    id: COMMAND,
    project_id: PROJECT,
    type: 'propose_fix',
    args: { booking_id: '00000000-0000-4000-8000-000000000101' },
    required_revision: null,
    executor_session: null,
    status: 'pending',
    result: null,
    requested_by: PM,
    created_at: '2026-11-02T09:00:00+00:00',
    completed_at: null,
    ...overrides,
  };
}

type Answer = { data: unknown; error: { message: string; code?: string } | null };

function fakeClient(options: { tables?: Record<string, Answer>; rpc?: Record<string, (args: Record<string, unknown>) => Answer> } = {}) {
  const queries: { table: string; steps: [string, ...unknown[]][] }[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const query = { table, steps: [] as [string, ...unknown[]][] };
    queries.push(query);
    const result = options.tables?.[table] ?? { data: [], error: null };
    const step = (name: string) => (...args: unknown[]) => (query.steps.push([name, ...args]), chain);
    const chain = {
      select: step('select'),
      eq: step('eq'),
      is: step('is'),
      order: step('order'),
      limit: step('limit'),
      maybeSingle: () => (query.steps.push(['maybeSingle']), Promise.resolve(result)),
      then: (resolve: (value: Answer) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  const client: AssistantClient = {
    rpc: (fn: string, args: object = {}) => {
      rpcs.push({ fn, args: args as Record<string, unknown> });
      const handler = options.rpc?.[fn];
      return Promise.resolve(handler ? handler(args as Record<string, unknown>) : { data: null, error: { message: `${fn}: not faked`, code: 'XX000' } });
    },
    from: from as unknown as AssistantClient['from'],
  };
  return { client, queries, rpcs };
}

describe('the client', () => {
  it('the real SupabaseClient satisfies AssistantClient', () => {
    const real = createClient('http://127.0.0.1:54321', 'anon-key');
    const client: AssistantClient = real;
    expect(client).toBe(real);
  });
});

describe('loadThread', () => {
  it('reads the latest messages and returns them oldest first', async () => {
    const card = { id: 'card-1', component: 'show_issue_card' as const, props: { anything: true } };
    const newestFirst = [message(3, { role: 'assistant', author_id: null, turn_id: 'turn-1', cards: [card] }), message(2), message(1)];
    const fake = fakeClient({ tables: { agent_messages: { data: newestFirst, error: null } } });
    const thread = await loadThread(fake.client, PROJECT, null, 50);
    expect(thread.map((row) => row.text)).toEqual(['message 1', 'message 2', 'message 3']);
    expect(thread[2]?.cards).toEqual([card]);
    expect(fake.queries).toEqual([
      {
        table: 'agent_messages',
        steps: [
          ['select', '*'],
          ['eq', 'project_id', PROJECT],
          ['is', 'thread_id', null],
          ['order', 'created_at', { ascending: false }],
          ['order', 'id', { ascending: false }],
          ['limit', 50],
        ],
      },
    ]);
  });

  it('asks for 200 messages by default', async () => {
    const fake = fakeClient();
    await loadThread(fake.client, PROJECT);
    expect(fake.queries[0]?.steps.at(-1)).toEqual(['limit', 200]);
  });

  it('refuses rows of an unexpected shape and reports read errors', async () => {
    const bad = fakeClient({ tables: { agent_messages: { data: [message(1, { role: 'system' as 'person' })], error: null } } });
    await expect(loadThread(bad.client, PROJECT)).rejects.toMatchObject({ name: 'AssistantError', code: 'INVALID_RESPONSE' });
    const failing = fakeClient({ tables: { agent_messages: { data: null, error: { message: 'JWT expired', code: 'PGRST301' } } } });
    await expect(loadThread(failing.client, PROJECT)).rejects.toMatchObject({ message: 'Cannot read the assistant thread: JWT expired', code: 'PGRST301' });
  });
});

describe('postAgentMessage', () => {
  it('writes a typed message by default', async () => {
    const fake = fakeClient({ rpc: { post_agent_message: () => ({ data: message(1), error: null }) } });
    expect(await postAgentMessage(fake.client, PROJECT, 'Why is the crane idle?')).toEqual(message(1));
    expect(fake.rpcs).toEqual([
      { fn: 'post_agent_message', args: { p_project: PROJECT, p_text: 'Why is the crane idle?', p_channel: 'text', p_action: null, p_thread: null, p_context: null } },
    ]);
  });

  it('carries the thread and the selection, and refuses a context of the wrong shape', async () => {
    const thread = '00000000-0000-4000-8000-00000000a001';
    const context = { selected_tasks: [{ id: 3104, name: 'Crane erection', wbs: '3.4' }], approval_mode: 'risky' as const };
    const fake = fakeClient({ rpc: { post_agent_message: () => ({ data: message(1, { thread_id: thread, context }), error: null }) } });
    const row = await postAgentMessage(fake.client, PROJECT, 'What is wrong with this task?', { threadId: thread, context });
    expect(row).toMatchObject({ thread_id: thread, context });
    expect(fake.rpcs[0]?.args).toMatchObject({ p_thread: thread, p_context: context });
    await expect(postAgentMessage(fake.client, PROJECT, 'x', { context: { approval_mode: 'yolo' } as never })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('carries a spoken message and the card button pressed', async () => {
    const action = { kind: 'prepare_fix' as const, issue_id: 'idle-rental:1' };
    const fake = fakeClient({ rpc: { post_agent_message: () => ({ data: message(1, { channel: 'voice', action }), error: null }) } });
    const row = await postAgentMessage(fake.client, PROJECT, 'Yes, prepare the fix', { channel: 'voice', action });
    expect(row.action).toEqual(action);
    expect(fake.rpcs[0]?.args).toMatchObject({ p_channel: 'voice', p_action: action });
  });

  it('refuses an action the assistant does not know before calling the server', async () => {
    const fake = fakeClient();
    await expect(
      postAgentMessage(fake.client, PROJECT, 'ok', { action: { kind: 'approve', issue_id: 'x' } as never }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.rpcs).toEqual([]);
  });

  it('passes on the server refusal without the function prefix', async () => {
    const fake = fakeClient({
      rpc: { post_agent_message: () => ({ data: null, error: { message: 'post_agent_message: a message is 1-2000 characters', code: '22023' } }) },
    });
    const failure = postAgentMessage(fake.client, PROJECT, '   ');
    await expect(failure).rejects.toBeInstanceOf(AssistantError);
    await expect(failure).rejects.toMatchObject({ message: 'a message is 1-2000 characters', code: '22023' });
  });
});

describe('commands', () => {
  it('loads one command', async () => {
    const fake = fakeClient({ tables: { agent_commands: { data: command(), error: null } } });
    expect(await loadCommand(fake.client, COMMAND)).toEqual(command());
    expect(fake.queries[0]?.steps).toEqual([['select', '*'], ['eq', 'id', COMMAND], ['maybeSingle']]);
  });

  it('a command the viewer cannot see is not found', async () => {
    const fake = fakeClient({ tables: { agent_commands: { data: null, error: null } } });
    await expect(loadCommand(fake.client, COMMAND)).rejects.toMatchObject({ code: 'P0002' });
  });

  it('claims a command for this tab', async () => {
    const running = command({ status: 'running', executor_session: SESSION });
    const fake = fakeClient({ rpc: { claim_agent_command: () => ({ data: running, error: null }) } });
    expect(await claimAgentCommand(fake.client, COMMAND, SESSION)).toEqual(running);
    expect(fake.rpcs).toEqual([{ fn: 'claim_agent_command', args: { p_command: COMMAND, p_session: SESSION } }]);
  });

  it('a lost race comes back as 55000', async () => {
    const fake = fakeClient({
      rpc: {
        claim_agent_command: () => ({
          data: null,
          error: { message: `claim_agent_command: command ${COMMAND} is already running (another tab took it)`, code: '55000' },
        }),
      },
    });
    await expect(claimAgentCommand(fake.client, COMMAND, SESSION)).rejects.toMatchObject({
      message: `command ${COMMAND} is already running (another tab took it)`,
      code: '55000',
    });
  });

  it('completes a command with its result', async () => {
    const result = { proposal_id: '00000000-0000-4000-8000-0000000002aa', version_id: '00000000-0000-4000-8000-0000000003aa', version_no: 1 };
    const done = command({ status: 'succeeded', executor_session: SESSION, result, completed_at: '2026-11-02T09:00:04+00:00' });
    const fake = fakeClient({ rpc: { complete_agent_command: () => ({ data: done, error: null }) } });
    expect(await completeAgentCommand(fake.client, COMMAND, SESSION, 'succeeded', result)).toEqual(done);
    expect(fake.rpcs).toEqual([
      { fn: 'complete_agent_command', args: { p_command: COMMAND, p_session: SESSION, p_status: 'succeeded', p_result: result } },
    ]);
  });

  it('a refusal needs no result; a malformed result is refused before calling the server', async () => {
    const fake = fakeClient({ rpc: { complete_agent_command: () => ({ data: command({ status: 'rejected', executor_session: SESSION }), error: null }) } });
    expect((await completeAgentCommand(fake.client, COMMAND, SESSION, 'rejected', null)).status).toBe('rejected');
    await expect(
      completeAgentCommand(fake.client, COMMAND, SESSION, 'succeeded', { version_no: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.rpcs).toHaveLength(1);
  });
});

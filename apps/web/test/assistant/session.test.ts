/**
 * The assistant as a tab sees it, with a fake transport: the thread loads and stays in order, a
 * reply streams in (text in order, tools, card drafts) and gives way to the stored reply, a tab that
 * joins halfway shows the rest, and a turn the assistant starts on its own is counted so the panel
 * can come forward.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessageRow, AgentStreamEvent } from '@collab/shared';
import { AssistantSession, type AssistantTransport } from '../../src/assistant/session';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const PRIYA = '00000000-0000-4000-8000-000000000011';

let counter = 0;
function row(overrides: Partial<AgentMessageRow> = {}): AgentMessageRow {
  counter++;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    project_id: PROJECT,
    turn_id: null,
    role: 'person',
    author_id: PRIYA,
    channel: 'text',
    text: 'Hello',
    cards: [],
    action: null,
    created_at: `2026-11-10T14:${String(counter).padStart(2, '0')}:00+00:00`,
    ...overrides,
  };
}

function fake(thread: AgentMessageRow[] = []) {
  let handlers: Parameters<AssistantTransport['subscribe']>[0] | null = null;
  const posted: { text: string; action: unknown }[] = [];
  const transport: AssistantTransport = {
    loadThread: vi.fn(async () => [...thread]),
    post: vi.fn(async (text, options) => {
      posted.push({ text, action: options.action ?? null });
      const saved = row({ text });
      thread.push(saved);
      return saved;
    }),
    subscribe: (next) => {
      handlers = next;
      return () => {
        handlers = null;
      };
    },
  };
  const emit = (event: AgentStreamEvent) => handlers?.onStream(event);
  const message = (id: string) => handlers?.onMessage(id);
  return { transport, thread, posted, emit, message, status: (value: 'connected' | 'reconnecting' | 'closed') => handlers?.onStatus?.(value) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('AssistantSession', () => {
  it('loads the thread oldest first and adds what this tab sends at once', async () => {
    const first = row({ text: 'first' });
    const second = row({ text: 'second' });
    const { transport, posted } = fake([second, first]);
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    expect(session.getSnapshot().messages.map((message) => message.text)).toEqual(['first', 'second']);

    expect(await session.send('  What needs attention?  ')).toBe(true);
    expect(posted).toEqual([{ text: 'What needs attention?', action: null }]);
    expect(session.getSnapshot().messages.at(-1)?.text).toBe('What needs attention?');
    expect(await session.send('   ')).toBe(false);
  });

  it('streams a reply, then gives way to the stored one', async () => {
    const { transport, thread, emit, message } = fake();
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    emit({ type: 'turn_start', turn_id: 't1', kind: 'utterance', speaker_id: PRIYA });
    emit({ type: 'tool', turn_id: 't1', tool_id: 'a', name: 'find_issues', state: 'start' });
    emit({ type: 'text_delta', turn_id: 't1', seq: 0, text: 'The crane ' });
    emit({ type: 'text_delta', turn_id: 't1', seq: 1, text: 'is idle.' });
    emit({ type: 'text_delta', turn_id: 't1', seq: 1, text: 'is idle.' });
    emit({ type: 'ui_partial', turn_id: 't1', card_id: 'c1', component: 'show_issue_card', props: { headline: 'The cr' } });
    emit({ type: 'ui_partial', turn_id: 't1', card_id: 'c1', component: 'show_issue_card', props: { headline: 'The crane is idle' } });
    let live = session.getSnapshot().live!;
    expect(live.text).toBe('The crane is idle.');
    expect(live.tools).toEqual([{ id: 'a', name: 'find_issues', state: 'start', summary: undefined }]);
    expect(live.cards).toEqual([{ id: 'c1', component: 'show_issue_card', props: { headline: 'The crane is idle' } }]);

    const reply = row({ role: 'assistant', author_id: null, turn_id: 't1', text: 'The crane is idle.' });
    emit({ type: 'turn_end', turn_id: 't1', message_id: reply.id });
    live = session.getSnapshot().live!;
    expect(live.ending).toBe(true);
    thread.push(reply);
    message(reply.id);
    await flush();
    await flush();
    expect(session.getSnapshot().live).toBeNull();
    expect(session.getSnapshot().messages.map((entry) => entry.text)).toEqual(['The crane is idle.']);
  });

  it('drops a card draft the assistant withdrew', async () => {
    const { transport, emit } = fake();
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    emit({ type: 'turn_start', turn_id: 't4', kind: 'utterance', speaker_id: PRIYA });
    emit({ type: 'tool', turn_id: 't4', tool_id: 'toolu_1', name: 'show_fix_card', state: 'start' });
    emit({ type: 'ui_partial', turn_id: 't4', card_id: 'toolu_1', component: 'show_fix_card', props: { title: 'Move the' } });
    expect(session.getSnapshot().live?.cards).toHaveLength(1);
    emit({ type: 'tool', turn_id: 't4', tool_id: 'toolu_1', name: 'show_fix_card', state: 'error', summary: 'an amount did not come from a check' });
    expect(session.getSnapshot().live?.cards).toHaveLength(0);
  });

  it('drops a quiet turn at once, and counts the turns it starts on its own', async () => {
    const { transport, emit } = fake();
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    emit({ type: 'turn_start', turn_id: 't2', kind: 'proactive', speaker_id: null });
    expect(session.getSnapshot().raised).toBe(1);
    emit({ type: 'turn_end', turn_id: 't2', message_id: null });
    expect(session.getSnapshot().live).toBeNull();
  });

  it('counts a problem raised while this tab was still opening, once', async () => {
    const noticed = row({
      role: 'assistant',
      author_id: null,
      channel: 'app',
      turn_id: 'opening',
      created_at: new Date(Date.now() - 5_000).toISOString(),
      cards: [{ id: 'c1', component: 'show_issue_card', props: {} }],
    });
    const old = row({ role: 'assistant', author_id: null, channel: 'app', turn_id: 'yesterday', created_at: '2026-10-01T10:00:00+00:00', cards: [{ id: 'c0', component: 'show_issue_card', props: {} }] });
    const { transport, emit, message } = fake([old, noticed]);
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    expect(session.getSnapshot().raised).toBe(1);
    // The same turn heard live, or the thread loaded again, does not count twice.
    emit({ type: 'turn_start', turn_id: 'opening', kind: 'proactive', speaker_id: null });
    message(noticed.id);
    await flush();
    expect(session.getSnapshot().raised).toBe(1);
  });

  it('shows the rest of a turn to a tab that joined halfway', async () => {
    const { transport, emit } = fake();
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    emit({ type: 'text_delta', turn_id: 't3', seq: 4, text: 'second half' });
    expect(session.getSnapshot().live).toMatchObject({ turnId: 't3', text: 'second half' });
  });

  it('says when the assistant cannot be reached, and reloads when the connection is back', async () => {
    const { transport, status } = fake();
    (transport.loadThread as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    expect(session.getSnapshot().error).toContain('offline');
    status('connected');
    await flush();
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().status).toBe('connected');
  });

  it('sends the selection (less what was taken off) and the approval mode with each message, and keeps the mode', async () => {
    const { transport } = fake();
    const stored = new Map<string, string>();
    const selection = [
      { id: 3104, name: 'Crane erection', wbs: '3.4' },
      { id: 3105, name: 'Steel frame', wbs: '3.5' },
    ];
    const session = new AssistantSession(transport, { selection: () => selection, storage: { get: () => stored.get('mode') ?? null, set: (value) => stored.set('mode', value) } });
    session.start();
    session.openThread(null);
    await flush();
    session.toggleExcluded(3105);
    session.setApprovalMode('risky');
    await session.send('What is wrong with this task?');
    expect(transport.post).toHaveBeenLastCalledWith('What is wrong with this task?', {
      channel: 'text',
      action: null,
      threadId: null,
      context: { selected_tasks: [selection[0]], approval_mode: 'risky' },
    });
    // The next message takes whatever is selected then.
    expect(session.getSnapshot().excluded.size).toBe(0);
    expect(stored.get('mode')).toBe('risky');
    expect(new AssistantSession(transport, { storage: { get: () => 'risky', set: () => undefined } }).getSnapshot().approvalMode).toBe('risky');
    expect(new AssistantSession(transport, { storage: { get: () => 'nonsense', set: () => undefined } }).getSnapshot().approvalMode).toBe('ask');
    // An automatic apply says so in its own context.
    await session.send('Applied it automatically.', { kind: 'apply_edit', card_id: 'c1' }, 'text', { approval_mode: 'auto' });
    expect((transport.post as ReturnType<typeof vi.fn>).mock.lastCall?.[1].context.approval_mode).toBe('auto');
    expect(session.getSnapshot().sentHere.size).toBe(2);
  });

  it('opens a thread, writes in it, and marks another thread unread when a turn ends there', async () => {
    const thread = '00000000-0000-4000-8000-00000000a001';
    const { transport, emit } = fake();
    const threads = [{ id: thread, project_id: PROJECT, title: 'Level 2 pours', created_by: PRIYA, created_at: '2026-11-10T14:00:00+00:00', last_message_at: '2026-11-10T14:00:00+00:00', title_source: 'person' as const, visibility: 'project' as const, costs_shared_by: null, costs_shared_at: null }];
    transport.loadThreads = vi.fn(async () => ({ threads, mainLastMessageAt: null }));
    transport.createThread = vi.fn(async (title: string) => ({ ...threads[0]!, title }));
    transport.deleteThread = vi.fn(async () => undefined);
    const session = new AssistantSession(transport);
    session.start();
    session.openThread(null);
    await flush();
    expect(session.getSnapshot().threads).toHaveLength(1);
    session.openThread(thread);
    await flush();
    expect(transport.loadThread).toHaveBeenLastCalledWith(thread);
    await session.send('Hello there');
    expect((transport.post as ReturnType<typeof vi.fn>).mock.lastCall?.[1].threadId).toBe(thread);

    // A turn in the main thread is not shown here, and leaves the main thread unread.
    emit({ type: 'turn_start', turn_id: 'tm', kind: 'utterance', speaker_id: null, thread_id: null });
    expect(session.getSnapshot().live).toBeNull();
    expect(session.getSnapshot().busyThread).toBe('main');
    emit({ type: 'turn_end', turn_id: 'tm', message_id: null });
    expect(session.getSnapshot().unread.has('main')).toBe(true);
    session.openThread(null);
    expect(session.getSnapshot().unread.has('main')).toBe(false);

    // Deleting the open thread goes back to the main thread.
    session.openThread(thread);
    expect(await session.deleteThread(thread)).toBe(true);
    expect(session.getSnapshot().threadId).toBeNull();
  });

  it('opens on a new conversation; its first message creates a private thread named by its first words', async () => {
    const thread = '00000000-0000-4000-8000-00000000a002';
    const { transport } = fake([row({ text: 'from the main thread' })]);
    const created = { id: thread, project_id: PROJECT, title: '', created_by: PRIYA, created_at: '2026-11-10T14:00:00+00:00', last_message_at: '2026-11-10T14:00:00+00:00', title_source: 'auto' as const, visibility: 'private' as const, costs_shared_by: null, costs_shared_at: null };
    transport.loadThreads = vi.fn(async () => ({ threads: [], mainLastMessageAt: '2026-11-10T14:00:00+00:00' }));
    transport.createThread = vi.fn(async (title: string) => ({ ...created, title }));
    const watched: string[] = [];
    let threadStream: ((event: AgentStreamEvent) => void) | null = null;
    transport.watchThread = vi.fn((threadId: string, onStream: (event: AgentStreamEvent) => void) => {
      watched.push(threadId);
      threadStream = onStream;
      return () => {
        threadStream = null;
      };
    });
    const session = new AssistantSession(transport);
    session.start();
    await flush();
    // A new conversation: nothing of the main thread shows, and the main thread is not marked read.
    expect(session.getSnapshot()).toMatchObject({ draft: true, threadId: null, messages: [] });
    expect(transport.loadThread).not.toHaveBeenCalled();

    expect(await session.send('What is wrong with the steel frame erection and the crane rental?')).toBe(true);
    expect(transport.createThread).toHaveBeenCalledWith('What is wrong with the steel frame erection and the crane…', { auto: true, private: true });
    expect(session.getSnapshot()).toMatchObject({ draft: false, threadId: thread });
    expect((transport.post as ReturnType<typeof vi.fn>).mock.lastCall?.[1].threadId).toBe(thread);
    // The private thread's live reply comes on its own topic.
    expect(watched).toEqual([thread]);
    threadStream!({ type: 'turn_start', turn_id: 'tp', kind: 'utterance', speaker_id: PRIYA, thread_id: thread });
    threadStream!({ type: 'text_delta', turn_id: 'tp', seq: 0, text: 'The crane' });
    expect(session.getSnapshot().live?.text).toBe('The crane');

    // "New" starts another conversation and stops listening to the private one.
    session.startNewThread();
    expect(session.getSnapshot()).toMatchObject({ draft: true, messages: [], live: null });
    expect(threadStream).toBeNull();
  });
});

describe('what was on the screen', () => {
  const screen = { view: 'chart', panel: 'library', modal: 'drop_card', modal_about: 'Light fixtures' } as const;

  it('goes with each message, next to the selection; a screen that can’t be read leaves the message alone', async () => {
    const { transport } = fake();
    const session = new AssistantSession(transport, { selection: () => [{ id: 7, name: 'Pour footings', wbs: '1.2.3' }], screen: () => screen });
    session.start();
    session.openThread(null);
    await flush();
    expect(await session.send('close that')).toBe(true);
    expect(vi.mocked(transport.post).mock.calls[0]![1].context).toEqual({ selected_tasks: [{ id: 7, name: 'Pour footings', wbs: '1.2.3' }], approval_mode: 'ask', screen });
    const broken = new AssistantSession(transport, {
      screen: () => {
        throw new Error('no chart');
      },
    });
    expect(broken.contextNow()).toEqual({ selected_tasks: [], approval_mode: 'ask' });
  });

  it('goes without the screen when the database refuses it, and stops at any other refusal', async () => {
    const { transport, posted } = fake();
    const post = vi.mocked(transport.post);
    const session = new AssistantSession(transport, { screen: () => screen });
    session.start();
    session.openThread(null);
    await flush();
    post.mockRejectedValueOnce(new Error('unknown field "screen"'));
    expect(await session.send('close that')).toBe(true);
    expect(post.mock.calls.map(([, options]) => Boolean(options.context?.screen))).toEqual([true, false]);
    expect(posted.map((entry) => entry.text)).toEqual(['close that']);
    post.mockRejectedValueOnce(new Error('Too many messages for now'));
    expect(await session.send('and the invoice')).toBe(false);
    expect(post).toHaveBeenCalledTimes(3);
    expect(session.getSnapshot().error).toBe('Too many messages for now');
  });
});

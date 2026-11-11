/**
 * The call and the thread: a line said to Remy is posted from the speaker's own tab, as their message
 * said aloud, into the call's thread; the host's tab hands Remy's spoken answers to her voice, each once
 * and only the new ones; a reply is said the way a voice should say it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessageRow } from '@collab/shared';
import { REMY, type Heard, type RemyMessage } from '../../src/call/protocol';
import { speakable } from '../../src/call/speech';
import { answerTo, linkThread, repliesToSay, type CallPort, type ThreadPort } from '../../src/call/thread';

const ME = 'deepak-tab';
const NORA = 'nora-tab';
const PROJECT = '00000000-0000-4000-8000-000000000002';

let counter = 0;
function row(overrides: Partial<AgentMessageRow> = {}): AgentMessageRow {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    project_id: PROJECT,
    turn_id: null,
    role: 'assistant',
    author_id: null,
    channel: 'voice',
    text: 'The crane is idle Monday to Wednesday.',
    cards: [],
    action: null,
    created_at: new Date(Date.now() + 1000).toISOString(),
    ...overrides,
  };
}

const heard = (overrides: Partial<Heard> = {}): RemyMessage => ({ kind: 'heard', identity: ME, text: 'Remy, what is the crane doing?', addressed: true, final: true, at: Date.now(), ...overrides });

function fakeCall({ host = false }: { host?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const messageListeners = new Set<(message: RemyMessage, from: string | null) => void>();
  const said: string[] = [];
  const to: (string | null | undefined)[] = [];
  const call: CallPort & { host: boolean } = {
    me: ME,
    inCall: true,
    host,
    get isHost() {
      return this.host;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    say: vi.fn(async (text: string, options?: { to?: string | null }) => {
      said.push(text);
      to.push(options?.to);
      return { id: `line-${said.length}`, interrupted: false };
    }),
  };
  return {
    call,
    said,
    to,
    changed: () => listeners.forEach((listener) => listener()),
    hear: (message: RemyMessage, from: string | null = REMY) => messageListeners.forEach((listener) => listener(message, from)),
  };
}

function fakeThread({ threadId = 'private-thread', draft = false, messages = [] }: { threadId?: string | null; draft?: boolean; messages?: AgentMessageRow[] } = {}) {
  const listeners = new Set<() => void>();
  const snapshot = { threadId: threadId as string | null, draft, sending: false, messages };
  const sent: { text: string; channel: string; threadId: string | null }[] = [];
  let refusals = 0;
  const thread: ThreadPort = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openThread: vi.fn((id: string | null) => {
      snapshot.threadId = id;
      snapshot.draft = false;
    }),
    send: vi.fn(async (text: string, _action: null, channel: 'voice') => {
      if (refusals > 0) {
        refusals -= 1;
        return false;
      }
      sent.push({ text, channel, threadId: snapshot.threadId });
      return true;
    }),
  };
  return {
    thread,
    snapshot,
    sent,
    busyFor: (times: number) => {
      refusals = times;
      snapshot.sending = true;
    },
    land: (...rows: AgentMessageRow[]) => {
      snapshot.messages = [...snapshot.messages, ...rows];
      listeners.forEach((listener) => listener());
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a line said to Remy', () => {
  it('goes to the call’s thread from the speaker’s own tab, said aloud, as heard', async () => {
    const { call, hear } = fakeCall();
    const { thread, sent } = fakeThread();
    const link = linkThread(call, thread, { retryMs: 1 });
    hear(heard());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ text: 'Remy, what is the crane doing?', channel: 'voice', threadId: null });
    link.stop();
  });

  it('is left to the other person’s own tab, and nothing goes for people talking to each other', async () => {
    const { call, hear } = fakeCall();
    const { thread, sent } = fakeThread();
    const link = linkThread(call, thread, { retryMs: 1 });
    hear(heard({ identity: NORA }));
    hear(heard({ addressed: false }));
    // Not Remy's word: someone else sending on her topic.
    hear(heard(), NORA);
    await settle();
    expect(sent).toHaveLength(0);
    link.stop();
  });

  it('waits for the tab’s message before it, then goes', async () => {
    const { call, hear } = fakeCall();
    const fake = fakeThread();
    fake.busyFor(2);
    const link = linkThread(call, fake.thread, { retryMs: 1 });
    hear(heard());
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.thread.send).toHaveBeenCalledTimes(3);
    link.stop();
  });

  it('keeps the order things were said in', async () => {
    const { call, hear } = fakeCall();
    const { thread, sent } = fakeThread();
    const link = linkThread(call, thread, { retryMs: 1 });
    hear(heard({ text: 'Remy, first.' }));
    hear(heard({ text: 'And second.' }));
    await vi.waitFor(() => expect(sent.map((line) => line.text)).toEqual(['Remy, first.', 'And second.']));
    link.stop();
  });
});

describe('the call’s thread', () => {
  it('opens in every tab on the call: the project’s General thread unless told otherwise', () => {
    const { call } = fakeCall();
    const { thread } = fakeThread({ threadId: null, draft: true });
    const link = linkThread(call, thread);
    expect(thread.openThread).toHaveBeenCalledWith(null);
    link.stop();
    const other = fakeThread();
    linkThread(call, other.thread, { threadId: 'call-thread' }).stop();
    expect(other.thread.openThread).toHaveBeenCalledWith('call-thread');
  });
});

describe('Remy’s answers', () => {
  it('are said by the host’s tab, word for word, each once', async () => {
    const { call, said } = fakeCall({ host: true });
    const fake = fakeThread({ threadId: null, messages: [row({ created_at: '2020-01-01T00:00:00Z', text: 'An old answer.' })] });
    const link = linkThread(call, fake.thread);
    const answer = row({ text: 'It’s idle Monday to Wednesday.' });
    fake.land(answer);
    fake.land();
    await vi.waitFor(() => expect(said).toEqual(['It’s idle Monday to Wednesday.']));
    link.stop();
  });

  it('are not said by anyone else’s tab, nor when written rather than spoken', async () => {
    const guest = fakeCall({ host: false });
    const fake = fakeThread({ threadId: null });
    const link = linkThread(guest.call, fake.thread);
    fake.land(row());
    await settle();
    expect(guest.said).toEqual([]);
    link.stop();

    const host = fakeCall({ host: true });
    const written = fakeThread({ threadId: null });
    const hosted = linkThread(host.call, written.thread);
    written.land(row({ channel: 'text' }), row({ role: 'person', author_id: PROJECT }), row({ text: '   ' }));
    await settle();
    expect(host.said).toEqual([]);
    hosted.stop();
  });

  it('start being said when this tab becomes the host', async () => {
    const { call, said, changed } = fakeCall({ host: false });
    const fake = fakeThread({ threadId: null });
    const link = linkThread(call, fake.thread);
    call.host = true;
    changed();
    fake.land(row({ text: 'Booked.' }));
    await vi.waitFor(() => expect(said).toEqual(['Booked.']));
    link.stop();
  });

  it('are left to the walkthrough while it says them itself, and what it said isn’t said again', async () => {
    const { call, said } = fakeCall({ host: true });
    const fake = fakeThread({ threadId: null });
    const link = linkThread(call, fake.thread);
    link.speakReplies(false);
    fake.land(row({ text: 'The walkthrough said this one.' }));
    await settle();
    link.speakReplies(true);
    fake.land(row({ text: 'This one is Remy’s.' }));
    await vi.waitFor(() => expect(said).toEqual(['This one is Remy’s.']));
    link.stop();
  });

  it('say whose words they answer, so that person’s next words count as said to Remy', async () => {
    const { call, said, to, hear } = fakeCall({ host: true });
    const fake = fakeThread({ threadId: null });
    const link = linkThread(call, fake.thread);
    hear(heard({ identity: NORA, text: 'Remy, who supplies the crane?' }));
    fake.land(row({ role: 'person', author_id: PROJECT, text: 'Remy, who supplies the crane?', created_at: new Date(Date.now() + 500).toISOString() }));
    fake.land(row({ text: 'Northgate does.' }));
    await vi.waitFor(() => expect(said).toEqual(['Northgate does.']));
    expect(to).toEqual([NORA]);
    link.stop();
  });

  it('tell whose words they answer from the question said aloud just before them', () => {
    const question = row({ role: 'person', author_id: PROJECT, text: 'Remy, which days?', created_at: '2026-11-07T20:00:00Z' });
    const typed = row({ role: 'person', author_id: PROJECT, channel: 'text', text: 'typed', created_at: '2026-11-07T20:00:01Z' });
    const answer = row({ text: 'Monday to Wednesday.', created_at: '2026-11-07T20:00:03Z' });
    const later = row({ role: 'person', author_id: PROJECT, text: 'Remy, thanks.', created_at: '2026-11-07T20:00:05Z' });
    const asked = [
      { identity: NORA, text: 'Remy, which days?' },
      { identity: ME, text: 'Remy, thanks.' },
    ];
    expect(answerTo([question, typed, answer, later], answer, asked)).toBe(NORA);
    expect(answerTo([answer], answer, asked)).toBeNull();
    expect(answerTo([question, answer], answer, [])).toBeNull();
  });

  it('are only the new ones in the thread', () => {
    const since = Date.parse('2026-11-07T20:00:00Z');
    const old = row({ created_at: '2026-11-07T19:59:59Z' });
    const fresh = row({ created_at: '2026-11-07T20:00:01Z' });
    const done = row({ created_at: '2026-11-07T20:00:02Z' });
    expect(repliesToSay([old, fresh, done], { since, done: new Set([done.id]) })).toEqual([fresh]);
  });
});

describe('a reply, as Remy’s voice is handed it', () => {
  it('says a task link by its name and drops marks for emphasis', () => {
    expect(speakable('I moved [Erect crane](task:3104) to **Monday**.')).toBe('I moved Erect crane to Monday.');
    expect(speakable('It’s _only_ two days, `today`.')).toBe('It’s only two days, today.');
  });

  it('says days and money the way people say them', () => {
    expect(speakable('Booked from Mon, Nov 30 for $8,400.00.')).toBe('Booked from Monday, November 30 for $8,400.');
  });
});

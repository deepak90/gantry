/**
 * subscribeAssistant against a fake Realtime client: the private agent topic, the auth token set
 * before joining, every payload validated (malformed ones dropped), statuses, the rejoin after the
 * server closes the channel, and silence after unsubscribing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '@collab/shared';
import { subscribeAssistant, type AssistantHandlers, type AssistantRealtimeClient, type AssistantStatus } from '../../src/assistant/realtime';
import type { RevisionChannel } from '../../src/sync/supabase-transport';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const MESSAGE = '00000000-0000-4000-8000-0000000000a1';

class FakeChannel implements RevisionChannel {
  readonly handlers = new Map<string, (message: { payload?: unknown }) => void>();
  statusCallback: ((status: string, err?: Error) => void) | undefined;

  constructor(
    readonly topic: string,
    readonly options: unknown,
  ) {}

  on(_type: 'broadcast', filter: { event: string }, callback: (message: { payload?: unknown }) => void): FakeChannel {
    this.handlers.set(filter.event, callback);
    return this;
  }

  subscribe(callback?: (status: string, err?: Error) => void): FakeChannel {
    this.statusCallback = callback;
    return this;
  }

  deliver(event: string, payload: unknown) {
    this.handlers.get(event)?.({ payload });
  }

  status(status: string, error?: Error) {
    this.statusCallback?.(status, error);
  }
}

function setup(options: { token?: string | null } = {}) {
  const channels: FakeChannel[] = [];
  const removed: FakeChannel[] = [];
  const order: string[] = [];
  const setAuth = vi.fn(async (token?: string | null) => {
    order.push(`setAuth:${token}`);
  });
  const client: AssistantRealtimeClient = {
    channel: (name, channelOptions) => {
      const channel = new FakeChannel(name, channelOptions);
      const subscribe = channel.subscribe.bind(channel);
      channel.subscribe = (callback) => (order.push('subscribe'), subscribe(callback));
      channels.push(channel);
      return channel;
    },
    removeChannel: async (channel) => {
      removed.push(channel as FakeChannel);
      return 'ok';
    },
    realtime: { setAuth },
    auth: {
      getSession: async () => ({ data: { session: options.token === null ? null : { access_token: options.token ?? 'jwt-1' } } }),
    },
  };
  const events = { messages: [] as string[], stream: [] as AgentStreamEvent[], statuses: [] as AssistantStatus[] };
  const handlers: AssistantHandlers = {
    onMessage: (id) => events.messages.push(id),
    onStream: (event) => events.stream.push(event),
    onStatus: (status) => events.statuses.push(status),
  };
  const warnings: string[] = [];
  const stop = subscribeAssistant(client, PROJECT, handlers, { rejoinDelaysMs: [0], onWarning: (message) => warnings.push(message) });
  return { channels, removed, order, setAuth, events, warnings, stop };
}

async function joined(fake: ReturnType<typeof setup>, index = 0): Promise<FakeChannel> {
  await vi.waitFor(() => expect(fake.channels[index]?.statusCallback).toBeTypeOf('function'));
  return fake.channels[index]!;
}

describe('subscribeAssistant', () => {
  it('joins the private agent topic after setting the auth token', async () => {
    const fake = setup();
    const channel = await joined(fake);
    expect(channel.topic).toBe(`project:${PROJECT}:agent`);
    expect(channel.options).toEqual({ config: { private: true } });
    expect(fake.order).toEqual(['setAuth:jwt-1', 'subscribe']);
    channel.status('SUBSCRIBED');
    expect(fake.events.statuses).toEqual(['connected']);
  });

  it('delivers message announcements and stream events', async () => {
    const fake = setup();
    const channel = await joined(fake);
    channel.deliver('message', { id: MESSAGE });
    const start: AgentStreamEvent = { type: 'turn_start', turn_id: 'turn-1', kind: 'utterance', speaker_id: '00000000-0000-4000-8000-000000000011' };
    const delta: AgentStreamEvent = { type: 'text_delta', turn_id: 'turn-1', seq: 0, text: 'The crane ' };
    const end: AgentStreamEvent = { type: 'turn_end', turn_id: 'turn-1', message_id: MESSAGE };
    for (const event of [start, delta, end]) channel.deliver('stream', event);
    expect(fake.events.messages).toEqual([MESSAGE]);
    expect(fake.events.stream).toEqual([start, delta, end]);
  });

  it('drops payloads that do not match the shared schemas', async () => {
    const fake = setup();
    const channel = await joined(fake);
    channel.deliver('message', { id: 'not-a-uuid' });
    channel.deliver('stream', { type: 'text_delta', turn_id: 'turn-1', seq: -1, text: 'x' });
    channel.deliver('stream', { type: 'approve_payment', turn_id: 'turn-1' });
    expect(fake.events).toMatchObject({ messages: [], stream: [] });
    expect(fake.warnings).toEqual([
      'dropped a malformed message announcement',
      'dropped a malformed stream event',
      'dropped a malformed stream event',
    ]);
  });

  it('joins without a token when there is no session', async () => {
    const fake = setup({ token: null });
    await joined(fake);
    expect(fake.setAuth).not.toHaveBeenCalled();
  });

  it('reports errors while Realtime retries, and rejoins a channel the server closed', async () => {
    const fake = setup();
    const first = await joined(fake);
    first.status('SUBSCRIBED');
    first.status('CHANNEL_ERROR', new Error('socket'));
    first.status('SUBSCRIBED');
    first.status('CLOSED');
    const second = await joined(fake, 1);
    expect(fake.removed).toEqual([first]);
    expect(fake.events.statuses).toEqual(['connected', 'reconnecting', 'connected', 'closed', 'reconnecting']);
    expect(fake.setAuth).toHaveBeenCalledTimes(2);

    // The old channel's late messages are ignored; the new one delivers.
    first.deliver('message', { id: MESSAGE });
    second.status('SUBSCRIBED');
    second.deliver('message', { id: MESSAGE });
    expect(fake.events.messages).toEqual([MESSAGE]);
    expect(fake.events.statuses.at(-1)).toBe('connected');
  });

  it('is silent after unsubscribing and removes its channel', async () => {
    const fake = setup();
    const channel = await joined(fake);
    fake.stop();
    channel.status('SUBSCRIBED');
    channel.deliver('message', { id: MESSAGE });
    channel.status('CLOSED');
    expect(fake.events.statuses).toEqual([]);
    expect(fake.events.messages).toEqual([]);
    expect(fake.removed).toEqual([channel]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.channels).toHaveLength(1);
  });

  it('unsubscribing before the join finishes never subscribes', async () => {
    const fake = setup();
    fake.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.order).toEqual(['setAuth:jwt-1']);
  });
});

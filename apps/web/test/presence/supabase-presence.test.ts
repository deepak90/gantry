import { describe, expect, it, vi } from 'vitest';
import type { PresenceState } from '../../src/presence/peers';
import { SupabasePresenceTransport, mapPresenceStatus, type PresenceChannel, type PresenceSupabaseClient } from '../../src/presence/supabase-presence';
import type { PresenceHandlers, PresenceStatus } from '../../src/presence/transport';
import { VIEW, peer } from './helpers';

const PROJECT = '00000000-0000-4000-8000-0000000000aa';

class FakeChannel implements PresenceChannel {
  readonly broadcastHandlers = new Map<string, (message: { payload?: unknown }) => void>();
  syncHandler: (() => void) | undefined;
  statusCallback: ((status: string, err?: Error) => void) | undefined;
  state: PresenceState = {};
  readonly tracked: Record<string, unknown>[] = [];
  readonly sent: { event: string; payload: unknown }[] = [];
  untracked = 0;

  constructor(
    readonly topic: string,
    readonly options: unknown,
  ) {}

  on(type: 'presence' | 'broadcast', filter: { event: string }, callback: (() => void) | ((message: { payload?: unknown }) => void)): FakeChannel {
    if (type === 'presence') this.syncHandler = callback as () => void;
    else this.broadcastHandlers.set(filter.event, callback as (message: { payload?: unknown }) => void);
    return this;
  }

  subscribe(callback?: (status: string, err?: Error) => void): FakeChannel {
    this.statusCallback = callback;
    return this;
  }

  presenceState(): PresenceState {
    return this.state;
  }

  track(payload: Record<string, unknown>): Promise<unknown> {
    this.tracked.push(payload);
    return Promise.resolve('ok');
  }

  untrack(): Promise<unknown> {
    this.untracked++;
    return Promise.resolve('ok');
  }

  send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<unknown> {
    this.sent.push({ event: message.event, payload: message.payload });
    return Promise.resolve('ok');
  }

  deliver(event: string, payload: unknown) {
    this.broadcastHandlers.get(event)?.({ payload });
  }
}

function setup() {
  const channels: FakeChannel[] = [];
  const removed: FakeChannel[] = [];
  const setAuth = vi.fn(async () => undefined);
  const client: PresenceSupabaseClient = {
    channel: (name, options) => {
      const channel = new FakeChannel(name, options);
      channels.push(channel);
      return channel;
    },
    removeChannel: async (channel) => {
      removed.push(channel as FakeChannel);
      return 'ok';
    },
    realtime: { setAuth },
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt-1' } } }) },
  };
  const warnings: string[] = [];
  const transport = new SupabasePresenceTransport(client, PROJECT, 'pm', { onWarning: (message) => warnings.push(message) });
  const events = { peers: [] as unknown[][], cursors: [] as unknown[], frames: [] as unknown[], requests: [] as unknown[], states: [] as unknown[], statuses: [] as PresenceStatus[] };
  const handlers: PresenceHandlers = {
    onPeers: (peers) => events.peers.push(peers),
    onCursor: (message) => events.cursors.push(message),
    onFrame: (frame) => events.frames.push(frame),
    onFrameRequest: (request) => events.requests.push(request),
    onState: (message) => events.states.push(message),
    onStatus: (status) => events.statuses.push(status),
  };
  return { transport, handlers, channels, removed, setAuth, events, warnings };
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SupabasePresenceTransport', () => {
  it('joins the private presence topic keyed by session, after authorizing realtime', async () => {
    const { transport, handlers, channels, setAuth } = setup();
    transport.connect(handlers);
    const channel = channels[0]!;
    expect(channel.topic).toBe(`project:${PROJECT}:presence`);
    expect(channel.options).toEqual({ config: { private: true, presence: { key: 'pm', enabled: true }, broadcast: { self: false, ack: false } } });
    await flushPromises();
    expect(setAuth).toHaveBeenCalledWith('jwt-1');
    expect(channel.statusCallback).toBeDefined();
  });

  it('tracks only once joined, and again after every reconnect', async () => {
    const { transport, handlers, channels, events } = setup();
    transport.connect(handlers);
    transport.track(peer('pm', { taskId: 3 }));
    await flushPromises();
    const channel = channels[0]!;
    expect(channel.tracked).toHaveLength(0);
    channel.statusCallback?.('SUBSCRIBED');
    expect(channel.tracked).toEqual([peer('pm', { taskId: 3 })]);
    transport.track(peer('pm', { taskId: 4 }));
    expect(channel.tracked).toHaveLength(2);
    channel.statusCallback?.('CHANNEL_ERROR', new Error('socket dropped'));
    transport.track(peer('pm', { taskId: 5 }));
    expect(channel.tracked).toHaveLength(2);
    channel.statusCallback?.('SUBSCRIBED');
    expect(channel.tracked.at(-1)).toEqual(peer('pm', { taskId: 5 }));
    expect(events.statuses).toEqual(['connected', 'reconnecting', 'connected']);
  });

  it('broadcasts only over a joined channel', async () => {
    const { transport, handlers, channels } = setup();
    transport.connect(handlers);
    await flushPromises();
    const channel = channels[0]!;
    transport.sendCursor({ session: 'pm', seq: 0, point: null });
    expect(channel.sent).toHaveLength(0);
    channel.statusCallback?.('SUBSCRIBED');
    transport.sendCursor({ session: 'pm', seq: 1, point: null });
    transport.sendFrame({ ...VIEW, session: 'pm', seq: 0, revision: 1 });
    transport.requestFrame({ session: 'pm', target: 'cm' });
    expect(channel.sent.map((message) => message.event)).toEqual(['cursor', 'frame', 'frame-request']);
  });

  it('hands on valid presence and broadcasts and drops forged or malformed ones', async () => {
    const { transport, handlers, channels, events } = setup();
    transport.connect(handlers);
    await flushPromises();
    const channel = channels[0]!;
    channel.state = { pm: [peer('pm')], cm: [peer('cm', { role: 'cm' })], bogus: [peer('not-bogus')] };
    channel.syncHandler?.();
    expect((events.peers[0] as { session: string }[]).map((p) => p.session).sort()).toEqual(['cm', 'pm']);

    channel.deliver('cursor', { session: 'cm', seq: 1, point: { kind: 'grid', taskId: 15, column: 'name', dx: 0.5, dy: 0.5 } });
    channel.deliver('cursor', { session: 'cm', seq: 2, point: { kind: 'grid', taskId: 15, column: 'name', dx: 7, dy: 0.5 } });
    channel.deliver('frame', { ...VIEW, session: 'cm', seq: 0, revision: 3 });
    channel.deliver('frame', { session: 'cm', seq: 1 });
    channel.deliver('frame-request', { session: 'cm', target: 'pm' });
    channel.deliver('frame-request', { target: 'pm' });
    channel.deliver('state', { session: 'cm', rev: 3, taskId: 15, cells: [{ taskId: 15, columns: ['task'] }], active: { taskId: 15, column: 'task' }, activity: { kind: 'editing', taskId: 15, column: 'task' } });
    channel.deliver('state', { session: 'cm', rev: 4, taskId: 15, cells: [{ taskId: 15, columns: [] }], active: null, activity: null });
    expect(events.states).toHaveLength(1);
    expect(events.cursors).toHaveLength(1);
    expect(events.frames).toHaveLength(1);
    expect(events.requests).toEqual([{ session: 'cm', target: 'pm' }]);
  });

  it('untracks, leaves the channel and goes quiet on disconnect', async () => {
    const { transport, handlers, channels, removed, events } = setup();
    transport.connect(handlers);
    await flushPromises();
    const channel = channels[0]!;
    channel.statusCallback?.('SUBSCRIBED');
    transport.disconnect();
    expect(channel.untracked).toBe(1);
    expect(removed).toEqual([channel]);
    channel.deliver('frame', { ...VIEW, session: 'cm', seq: 0, revision: 3 });
    channel.statusCallback?.('CLOSED');
    expect(events.frames).toHaveLength(0);
    expect(events.statuses).toEqual(['connected']);
    transport.sendCursor({ session: 'pm', seq: 3, point: null });
    expect(channel.sent).toHaveLength(0);
  });

  it('joins again, with a growing delay, when the server closes the channel', async () => {
    const { handlers, channels, removed, events } = setup();
    const client = {
      channel: (name: string, options: unknown) => {
        const channel = new FakeChannel(name, options);
        channels.push(channel);
        return channel;
      },
      removeChannel: async (channel: PresenceChannel) => {
        removed.push(channel as FakeChannel);
        return 'ok';
      },
      realtime: { setAuth: async () => undefined },
      auth: { getSession: async () => ({ data: { session: { access_token: 'jwt-1' } } }) },
    } as PresenceSupabaseClient;
    const transport = new SupabasePresenceTransport(client, PROJECT, 'pm', { rejoinDelaysMs: [5, 20], onWarning: () => undefined });
    transport.connect(handlers);
    transport.track(peer('pm'));
    await flushPromises();
    channels[0]!.statusCallback?.('SUBSCRIBED');
    // A restart of the realtime server closes every channel.
    channels[0]!.statusCallback?.('CLOSED');
    expect(events.statuses).toEqual(['connected', 'reconnecting']);
    expect(removed).toEqual([channels[0]]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(channels).toHaveLength(2);
    // The closed channel's late messages no longer count.
    channels[0]!.deliver('frame', { ...VIEW, session: 'cm', seq: 0, revision: 3 });
    expect(events.frames).toHaveLength(0);
    channels[1]!.statusCallback?.('SUBSCRIBED');
    expect(channels[1]!.tracked).toEqual([peer('pm')]);
    expect(events.statuses).toEqual(['connected', 'reconnecting', 'connected']);
    transport.disconnect();
    channels[1]!.statusCallback?.('CLOSED');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(channels).toHaveLength(2);
  });

  it('does not let a person blink out while their presence is updated, but reports a real leave after the grace period', async () => {
    const { handlers, channels, events } = setup();
    const client = {
      channel: (name: string, options: unknown) => {
        const channel = new FakeChannel(name, options);
        channels.push(channel);
        return channel;
      },
      removeChannel: async () => 'ok',
      realtime: { setAuth: async () => undefined },
      auth: { getSession: async () => ({ data: { session: { access_token: 'jwt-1' } } }) },
    } as PresenceSupabaseClient;
    const transport = new SupabasePresenceTransport(client, PROJECT, 'pm', { leaveGraceMs: 30 });
    transport.connect(handlers);
    await flushPromises();
    const channel = channels[0]!;
    const sessions = () => (events.peers.at(-1) as { session: string }[]).map((p) => p.session).sort();
    channel.state = { pm: [peer('pm')], cm: [peer('cm', { taskId: 1 })] };
    channel.syncHandler?.();
    expect(sessions()).toEqual(['cm', 'pm']);
    // An update arrives as a leave then a join: the state in between lacks the person.
    channel.state = { pm: [peer('pm')] };
    channel.syncHandler?.();
    expect(sessions()).toEqual(['cm', 'pm']);
    channel.state = { pm: [peer('pm')], cm: [peer('cm', { taskId: 2 })] };
    channel.syncHandler?.();
    expect((events.peers.at(-1) as { session: string; taskId: number }[]).find((p) => p.session === 'cm')?.taskId).toBe(2);
    // A real leave: gone once the grace period is over.
    channel.state = { pm: [peer('pm')] };
    channel.syncHandler?.();
    expect(sessions()).toEqual(['cm', 'pm']);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sessions()).toEqual(['pm']);
    transport.disconnect();
  });

  it('maps channel statuses', () => {
    expect(mapPresenceStatus('SUBSCRIBED')).toBe('connected');
    expect(mapPresenceStatus('TIMED_OUT')).toBe('reconnecting');
    expect(mapPresenceStatus('CLOSED')).toBe('closed');
    expect(mapPresenceStatus('JOINING')).toBeUndefined();
  });
});

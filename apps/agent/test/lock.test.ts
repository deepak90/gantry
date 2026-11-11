/**
 * Only one agent service answers: the one running longest leads. A newcomer whose first presence sync
 * lists only itself (before the running service shows up) must not lead, or every reply comes twice;
 * it decides once its presence has settled, and says in which mode the leader answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceLock, leaderOf, type LockChannel, type LockClient } from '../src/realtime/lock';
import type { PresenceState } from '../src/realtime/presence';

class FakeChannel implements LockChannel {
  state: PresenceState = {};
  private sync: (() => void) | null = null;
  private subscribed: ((status: string) => void) | null = null;
  tracked: Record<string, unknown> | null = null;

  on(_type: 'presence', _filter: { event: 'sync' }, callback: () => void) {
    this.sync = callback;
    return this;
  }
  subscribe(callback?: (status: string) => void) {
    this.subscribed = callback ?? null;
    return this;
  }
  presenceState() {
    return this.state;
  }
  async track(payload: Record<string, unknown>) {
    this.tracked = payload;
  }
  /** The server confirms the subscription. */
  open() {
    this.subscribed?.('SUBSCRIBED');
  }
  /** A presence sync with these instances. */
  emit(state: PresenceState) {
    this.state = state;
    this.sync?.();
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function lock(mode: string) {
  const channel = new FakeChannel();
  const client: LockClient = { channel: () => channel };
  return { channel, lock: new ServiceLock(client, log as never, { mode, settleMs: 3_000 }) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('one agent service at a time', () => {
  it('picks the instance running longest', () => {
    expect(leaderOf({ a: [{ instance: 'a', since: 20 }], b: [{ instance: 'b', since: 10, mode: 'mock' }] })).toEqual({ instance: 'b', since: 10, mode: 'mock' });
    expect(leaderOf({})).toBeNull();
  });

  it('does not lead on a first sync that lists only itself; it stands by once the running service shows up', () => {
    const { channel, lock: newcomer } = lock('live');
    const onLeader = vi.fn();
    newcomer.acquire(onLeader);
    channel.open();
    const me = channel.tracked as { instance: string; since: number };
    expect(me).toMatchObject({ mode: 'live' });

    channel.emit({ [me.instance]: [me] });
    expect(onLeader).not.toHaveBeenCalled();
    channel.emit({ [me.instance]: [me], running: [{ instance: 'running', since: me.since - 60_000, mode: 'mock' }] });
    vi.advanceTimersByTime(3_000);
    expect(onLeader).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already running in mock mode'));

    // The running service stops: the newcomer takes over.
    channel.emit({ [me.instance]: [me] });
    expect(onLeader).toHaveBeenCalledTimes(1);
  });

  it('leads once settled when it is alone', () => {
    const { channel, lock: only } = lock('mock');
    const onLeader = vi.fn();
    only.acquire(onLeader);
    channel.open();
    const me = channel.tracked as { instance: string };
    channel.emit({ [me.instance]: [me] });
    vi.advanceTimersByTime(3_000);
    expect(onLeader).toHaveBeenCalledTimes(1);
  });
});

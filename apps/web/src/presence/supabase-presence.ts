/**
 * `PresenceTransport` over Supabase Realtime: the private `project:{id}:presence` channel, keyed by
 * session id, with presence for who is here and broadcasts for pointers and view frames. Realtime
 * authorizes it with the RLS policies on `realtime.messages` (members may receive and send on the
 * presence topic). Every incoming payload is validated: any member can send anything on it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { byArrival, peersFromPresence, type PresenceState } from './peers';
import { PRESENCE_EVENTS, cursorMessageSchema, frameRequestSchema, presenceTopic, stateMessageSchema, viewFrameSchema, type Peer } from './protocol';
import type { PresenceHandlers, PresenceStatus, PresenceTransport } from './transport';

/** The RealtimeChannel methods used here; return values are not read. */
export interface PresenceChannel {
  on(type: 'presence', filter: { event: 'sync' }, callback: () => void): unknown;
  on(type: 'broadcast', filter: { event: string }, callback: (message: { payload?: unknown }) => void): unknown;
  subscribe(callback?: (status: string, err?: Error) => void): unknown;
  presenceState(): PresenceState;
  track(payload: Record<string, unknown>): Promise<unknown>;
  untrack(): Promise<unknown>;
  send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<unknown>;
}

export interface PresenceSupabaseClient {
  channel(name: string, options: { config: { private: boolean; presence: { key: string; enabled: boolean }; broadcast: { self: boolean; ack: boolean } } }): PresenceChannel;
  removeChannel(channel: PresenceChannel): Promise<unknown>;
  realtime: { setAuth(token?: string | null): Promise<void> };
  auth: { getSession(): Promise<{ data: { session: { access_token: string } | null } }> };
}

export interface SupabasePresenceOptions {
  onWarning?: (message: string, error?: unknown) => void;
  /** Delays before rejoining a channel the server closed; the last one repeats. */
  rejoinDelaysMs?: readonly number[];
  /** How long a tab that drops out of the presence state is still reported (see `reportPeers`). */
  leaveGraceMs?: number;
}

/**
 * Realtime delivers a tab's presence update as a leave and a join, and the state can be synced in
 * between: without a grace period everything drawn for that person (pointer, selection) would blink
 * out. Tabs track their presence once (and again after a reconnect), so this is rare, but a reconnect
 * must not end somebody's follow mode either.
 */
const LEAVE_GRACE_MS = 1_500;

const REJOIN_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function asPresenceClient(client: SupabaseClient): PresenceSupabaseClient {
  return client as unknown as PresenceSupabaseClient;
}

export class SupabasePresenceTransport implements PresenceTransport {
  private channel: PresenceChannel | null = null;
  private subscribed = false;
  private me: Peer | null = null;
  private active = false;
  private rejoins = 0;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  /** Every tab seen, with when it was last in the presence state. */
  private readonly seen = new Map<string, { peer: Peer; at: number }>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: PresenceSupabaseClient,
    private readonly projectId: string,
    private readonly sessionId: string,
    private readonly options: SupabasePresenceOptions = {},
  ) {}

  connect(handlers: PresenceHandlers): void {
    if (this.channel || this.active) return;
    this.active = true;
    this.join(handlers);
  }

  private join(handlers: PresenceHandlers): void {
    const channel = this.client.channel(presenceTopic(this.projectId), {
      config: { private: true, presence: { key: this.sessionId, enabled: true }, broadcast: { self: false, ack: false } },
    });
    this.channel = channel;
    // A channel that was replaced after a close may still deliver a last message: it is ignored.
    const live = () => this.active && channel === this.channel;

    channel.on('presence', { event: 'sync' }, () => {
      if (live()) this.reportPeers(handlers, peersFromPresence(channel.presenceState()));
    });
    channel.on('broadcast', { event: PRESENCE_EVENTS.cursor }, ({ payload }) => {
      const parsed = cursorMessageSchema.safeParse(payload);
      if (live() && parsed.success) handlers.onCursor(parsed.data);
    });
    channel.on('broadcast', { event: PRESENCE_EVENTS.frame }, ({ payload }) => {
      const parsed = viewFrameSchema.safeParse(payload);
      if (live() && parsed.success) handlers.onFrame(parsed.data);
    });
    channel.on('broadcast', { event: PRESENCE_EVENTS.frameRequest }, ({ payload }) => {
      const parsed = frameRequestSchema.safeParse(payload);
      if (live() && parsed.success) handlers.onFrameRequest(parsed.data);
    });
    channel.on('broadcast', { event: PRESENCE_EVENTS.state }, ({ payload }) => {
      const parsed = stateMessageSchema.safeParse(payload);
      if (live() && parsed.success) handlers.onState(parsed.data);
    });

    void (async () => {
      try {
        const { data } = await this.client.auth.getSession();
        if (data.session?.access_token) await this.client.realtime.setAuth(data.session.access_token);
      } catch (error) {
        this.warn('realtime.setAuth failed', error);
      }
      if (!live()) return;
      channel.subscribe((status, error) => {
        if (!live()) return;
        if (error) this.warn(`presence channel ${status}`, error);
        const mapped = mapPresenceStatus(status);
        this.subscribed = mapped === 'connected';
        if (this.subscribed) this.rejoins = 0;
        // Realtime retries an errored channel by itself, but not one the server closed (a restart, a
        // dropped tenant): that one is joined again from scratch, with a growing delay.
        if (mapped === 'closed') {
          handlers.onStatus('reconnecting');
          this.scheduleRejoin(handlers);
          return;
        }
        if (mapped) handlers.onStatus(mapped);
        // Presence is per connection: a reconnect starts without this tab until it tracks again.
        if (this.subscribed && this.me) this.publish(this.me);
      });
    })();
  }

  track(me: Peer): void {
    this.me = me;
    if (this.subscribed) this.publish(me);
  }

  sendCursor(message: Parameters<PresenceTransport['sendCursor']>[0]): void {
    this.broadcast(PRESENCE_EVENTS.cursor, message);
  }

  sendFrame(frame: Parameters<PresenceTransport['sendFrame']>[0]): void {
    this.broadcast(PRESENCE_EVENTS.frame, frame);
  }

  requestFrame(request: Parameters<PresenceTransport['requestFrame']>[0]): void {
    this.broadcast(PRESENCE_EVENTS.frameRequest, request);
  }

  sendState(message: Parameters<PresenceTransport['sendState']>[0]): void {
    this.broadcast(PRESENCE_EVENTS.state, message);
  }

  disconnect(): void {
    this.active = false;
    if (this.rejoinTimer !== null) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    const channel = this.channel;
    this.channel = null;
    this.subscribed = false;
    if (!channel) return;
    channel.untrack().catch(() => undefined);
    this.client.removeChannel(channel).catch((error: unknown) => this.warn('removeChannel failed', error));
  }

  /** Reports the tabs present, plus those that dropped out less than the grace period ago. */
  private reportPeers(handlers: PresenceHandlers, present: Peer[]): void {
    const now = Date.now();
    const grace = this.options.leaveGraceMs ?? LEAVE_GRACE_MS;
    for (const peer of present) this.seen.set(peer.session, { peer, at: now });
    const here = new Set(present.map((peer) => peer.session));
    const lingering: Peer[] = [];
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [session, { peer, at }] of this.seen) {
      if (here.has(session)) continue;
      if (now - at >= grace) {
        this.seen.delete(session);
        continue;
      }
      lingering.push(peer);
      nextExpiry = Math.min(nextExpiry, at + grace);
    }
    handlers.onPeers([...present, ...lingering].sort(byArrival));
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (Number.isFinite(nextExpiry)) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.active && this.channel) this.reportPeers(handlers, peersFromPresence(this.channel.presenceState()));
      }, Math.max(0, nextExpiry - now) + 5);
    }
  }

  private scheduleRejoin(handlers: PresenceHandlers): void {
    if (this.rejoinTimer !== null || !this.active) return;
    const delays = this.options.rejoinDelaysMs ?? REJOIN_DELAYS_MS;
    const delay = delays[Math.min(this.rejoins, delays.length - 1)] ?? 10_000;
    this.rejoins++;
    const closed = this.channel;
    this.channel = null;
    if (closed) this.client.removeChannel(closed).catch(() => undefined);
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      if (this.active) this.join(handlers);
    }, delay);
  }

  private publish(me: Peer): void {
    this.channel?.track({ ...me }).catch((error: unknown) => this.warn('presence track failed', error));
  }

  /** Broadcasts only over the joined socket: before that, supabase-js would fall back to REST. */
  private broadcast(event: string, payload: unknown): void {
    if (!this.subscribed || !this.channel) return;
    this.channel.send({ type: 'broadcast', event, payload }).catch((error: unknown) => this.warn(`${event} send failed`, error));
  }

  private warn(message: string, error?: unknown): void {
    if (this.options.onWarning) this.options.onWarning(message, error);
    else console.warn(`[presence ${this.projectId}] ${message}`, error);
  }
}

export function mapPresenceStatus(status: string): PresenceStatus | undefined {
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

/**
 * A presence channel in memory, for tests and for the people who are in one page only
 * (local-peers.ts): every connected tab sees the others' presence and
 * broadcasts (never its own, like Realtime with `broadcast.self: false`). Messages go through the
 * same validation as the wire, are counted per event, and are delivered on a microtask unless the
 * hub is held, so tests can interleave, drop or reorder them.
 */
import { peersFromPresence } from './peers';
import { cursorMessageSchema, frameRequestSchema, peerSchema, stateMessageSchema, viewFrameSchema, type Peer } from './protocol';
import type { PresenceHandlers, PresenceTransport } from './transport';

type Event = 'cursor' | 'frame' | 'frame-request' | 'state';

interface Member {
  session: string;
  handlers: PresenceHandlers | null;
  meta: Peer | null;
}

export class InMemoryPresenceHub {
  private readonly members = new Map<string, Member>();
  private readonly queue: (() => void)[] = [];
  private scheduled = false;
  private held = false;
  /** Broadcasts sent, per event. */
  readonly sent: Record<Event, number> = { cursor: 0, frame: 0, 'frame-request': 0, state: 0 };
  /** Presence updates per tab (Realtime allows a client 5 in 30 seconds). */
  readonly tracks = new Map<string, number>();

  connect(session: string): PresenceTransport {
    const member: Member = { session, handlers: null, meta: null };
    return {
      connect: (handlers) => {
        member.handlers = handlers;
        this.members.set(session, member);
        this.enqueue(() => handlers.onStatus('connected'));
        this.enqueue(() => handlers.onPeers(this.peers()));
      },
      track: (me) => {
        this.tracks.set(session, (this.tracks.get(session) ?? 0) + 1);
        member.meta = peerSchema.parse(me);
        this.publishPresence();
      },
      sendCursor: (message) => this.broadcast(session, 'cursor', cursorMessageSchema.parse(message)),
      sendFrame: (frame) => this.broadcast(session, 'frame', viewFrameSchema.parse(frame)),
      requestFrame: (request) => this.broadcast(session, 'frame-request', frameRequestSchema.parse(request)),
      sendState: (message) => this.broadcast(session, 'state', stateMessageSchema.parse(message)),
      disconnect: () => this.drop(session),
    };
  }

  /** A tab vanishes (closed, network gone): the others see it leave. */
  drop(session: string): void {
    const member = this.members.get(session);
    if (!member) return;
    this.members.delete(session);
    member.handlers?.onStatus('closed');
    this.publishPresence();
  }

  /** Holds deliveries until `release()`; `discard()` loses them instead. */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
    this.schedule();
  }

  /** Drops every held message (a network blip). */
  discard(): void {
    this.queue.length = 0;
  }

  /** Delivers everything queued now, synchronously. */
  flush(): void {
    while (this.queue.length > 0 && !this.held) this.queue.shift()?.();
  }

  get pending(): number {
    return this.queue.length;
  }

  private peers(): Peer[] {
    const state: Record<string, unknown[]> = {};
    for (const member of this.members.values()) {
      if (member.meta) state[member.session] = [member.meta];
    }
    return peersFromPresence(state);
  }

  private publishPresence(): void {
    for (const member of this.members.values()) {
      const { handlers } = member;
      if (handlers) this.enqueue(() => handlers.onPeers(this.peers()));
    }
  }

  private broadcast(from: string, event: Event, payload: unknown): void {
    if (!this.members.has(from)) return;
    this.sent[event]++;
    for (const member of this.members.values()) {
      const { handlers } = member;
      if (member.session === from || !handlers) continue;
      this.enqueue(() => {
        if (!this.members.has(member.session)) return;
        if (event === 'cursor') handlers.onCursor(payload as never);
        else if (event === 'frame') handlers.onFrame(payload as never);
        else if (event === 'state') handlers.onState(payload as never);
        else handlers.onFrameRequest(payload as never);
      });
    }
  }

  private enqueue(run: () => void): void {
    this.queue.push(run);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.held) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }
}

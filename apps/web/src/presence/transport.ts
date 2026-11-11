/**
 * The network side of presence: one channel per project carrying the presence state and four
 * broadcast events (pointer, view frame, frame request, selection and activity). Implementations: `SupabasePresenceTransport` (Realtime) and
 * `InMemoryPresenceHub.connect()` (tests, and the page-local channel of local-peers.ts). Delivery is best effort and unordered across senders;
 * the session orders by `seq` and heals lost frames with heartbeats.
 */
import type { CursorMessage, FrameRequest, Peer, StateMessage, ViewFrame } from './protocol';

export type PresenceStatus = 'connected' | 'reconnecting' | 'closed';

export interface PresenceHandlers {
  /** Everyone present, this tab included, whenever the presence state changes. */
  onPeers(peers: Peer[]): void;
  onCursor(message: CursorMessage): void;
  onFrame(frame: ViewFrame): void;
  onFrameRequest(request: FrameRequest): void;
  onState(message: StateMessage): void;
  onStatus(status: PresenceStatus): void;
}

export interface PresenceTransport {
  connect(handlers: PresenceHandlers): void;
  /** Publishes this tab's presence; re-published after a reconnect. */
  track(me: Peer): void;
  sendCursor(message: CursorMessage): void;
  sendFrame(frame: ViewFrame): void;
  requestFrame(request: FrameRequest): void;
  sendState(message: StateMessage): void;
  disconnect(): void;
}

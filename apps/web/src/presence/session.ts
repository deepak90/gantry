/**
 * One tab's presence: says who it is (presence, once) and what it is doing (state broadcasts: its
 * selection, activity and whom it follows), sends its pointer, shows the others' pointers, follows
 * somebody's view or is followed. Framework-free: React reads it through
 * `subscribe()` / `getSnapshot()`, the Gantt plugs in through `attachViewport()`, and tests drive it
 * with the in-memory hub and a fake viewport.
 */
import type { MemberRole } from '@collab/shared';
import { systemClock, throttle, type Clock, type Throttled } from './clock';
import { RemoteCursors, type RemoteCursor } from './cursors';
import { FollowController, ViewBroadcaster, type FollowStopReason, type FrameSink } from './follow';
import { followersOf, followTarget, othersOf, type FollowRefusal } from './peers';
import { CURSOR_INTERVAL_MS, CURSOR_TTL_MS, capCells, type Activity, type CellRef, type CursorPoint, type Peer, type RowCells, type StateMessage, type ViewBody } from './protocol';
import type { PresenceStatus, PresenceTransport } from './transport';

export interface PresenceSelf {
  session: string;
  user: string;
  name: string;
  color: string;
  role: MemberRole;
  /** A simulated person (src/crowd): the others draw a robot badge on their avatar and pointer. */
  simulated?: boolean;
  /** The call this tab hosts while Remy is on it (presence carries it; see setCall). */
  call?: { remy: boolean; thread: string | null } | null;
}

/** The Gantt as presence sees it: read and apply views, hear about changes and about the user taking over. */
export interface PresenceViewport extends FrameSink {
  read(): ViewBody | null;
  /** Shows a view read earlier, at once (the person's own view, after following someone). */
  restore?(view: ViewBody): Promise<void>;
  /** Scroll, zoom, resize or selection changed (by anyone, programmatic changes included). */
  onChange(listener: () => void): () => void;
  /** The person at this screen scrolled, zoomed, clicked or pressed a key in the plan. */
  onUserNavigate(listener: (reason: 'escape' | 'navigate') => void): () => void;
}

export interface PresenceSnapshot {
  status: 'connecting' | PresenceStatus;
  /** Everyone else here, oldest first. */
  peers: readonly Peer[];
  /** The others' pointers that are fresh. */
  cursors: readonly RemoteCursor[];
  /** Who this tab follows, or null. */
  following: Peer | null;
  /** True until the followed person's first frame arrives. */
  followWaiting: boolean;
  /** Who follows this tab. */
  followers: readonly Peer[];
  /** One plain line after follow mode ended by itself, e.g. the person left. */
  notice: string | null;
  /** Following just ended: the view this person had before can be brought back for a little while. */
  canRestore: boolean;
  framesSent: number;
  framesApplied: number;
}

export interface PresenceSessionOptions {
  self: PresenceSelf;
  transport: PresenceTransport;
  clock?: Clock;
  cursorIntervalMs?: number;
  cursorTtlMs?: number;
  frameIntervalMs?: number;
  heartbeatMs?: number;
  stateIntervalMs?: number;
}

export type FollowResult = { ok: true; target: Peer } | { ok: false; reason: FollowRefusal };

/** Selection and activity are broadcast at most this often: ten a second keeps a drag live. */
export const STATE_INTERVAL_MS = 100;
/** This tab's state is broadcast again this often, so a lost message heals. */
export const STATE_HEARTBEAT_MS = 5_000;
/** Frame counters (shown nowhere, read by tests) reach the UI at most this often. */
const COUNTER_INTERVAL_MS = 250;
/** How long "Back to my view" is offered after following ends. */
export const RESTORE_OFFER_MS = 12_000;

const sameCells = (a: readonly RowCells[], b: readonly RowCells[]) =>
  a.length === b.length && a.every((row, index) => row.taskId === b[index]!.taskId && row.columns.join('\u0000') === b[index]!.columns.join('\u0000'));

const sameActivity = (a: Activity | null, b: Activity | null) =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.taskId === b.taskId && a.column === b.column && sameCells(a.cells ?? [], b.cells ?? []));

const STOP_NOTICES: Partial<Record<FollowStopReason, (name: string) => string>> = {
  left: (name) => `${name} left, so you stopped following.`,
  loop: (name) => `${name} started following you, so you stopped following them.`,
};

export class PresenceSession {
  private self: PresenceSelf;
  private readonly transport: PresenceTransport;
  private readonly clock: Clock;
  private readonly since: number;
  private readonly cursorTtlMs: number;
  private readonly cursors = new RemoteCursors();
  private readonly follow: FollowController;
  private readonly broadcaster: ViewBroadcaster;
  private readonly sendCursor: Throttled<CursorPoint | null>;
  private readonly sendState: Throttled<null>;
  private readonly countersChanged: Throttled<null>;
  /** The newest state heard from each tab. */
  private readonly live = new Map<string, StateMessage>();
  private readonly listeners = new Set<() => void>();
  private viewport: PresenceViewport | null = null;
  private detachViewport: (() => void) | null = null;
  private status: PresenceSnapshot['status'] = 'connecting';
  private everyone: Peer[] = [];
  private taskId: number | null = null;
  private cells: RowCells[] = [];
  private active: CellRef | null = null;
  private activity: Activity | null = null;
  /** Counts changes of this tab's selection and activity. */
  private stateRev = 0;
  private revision = 0;
  private cursorSeq = 0;
  private lastPoint: CursorPoint | null = null;
  /** The cursor sequence of `lastPoint`, as sent inside frames while followed. */
  private pointerSeq = 0;
  private notice: string | null = null;
  /** This person's own view from before they followed someone, while it can be restored. */
  private ownView: ViewBody | null = null;
  private restoreOffer: ViewBody | null = null;
  private restoreTimer: unknown = null;
  private pruneTimer: unknown = null;
  private stateHeartbeat: unknown = null;
  private snapshot: PresenceSnapshot | null = null;
  private started = false;
  private disposed = false;

  constructor(options: PresenceSessionOptions) {
    this.self = options.self;
    this.transport = options.transport;
    this.clock = options.clock ?? systemClock;
    this.since = this.clock.now();
    this.cursorTtlMs = options.cursorTtlMs ?? CURSOR_TTL_MS;
    this.countersChanged = throttle(COUNTER_INTERVAL_MS, () => this.changed(), this.clock);
    this.follow = new FollowController({
      request: (target) => this.transport.requestFrame({ session: this.self.session, target }),
      onChange: () => this.changed(),
      onCount: () => this.countersChanged.push(null),
    });
    this.broadcaster = new ViewBroadcaster({
      self: this.self.session,
      read: () => {
        const view = this.viewport?.read() ?? null;
        // While followed, the pointer travels in the frames: one message instead of two streams.
        return view ? { ...view, pointer: { seq: this.pointerSeq, point: this.lastPoint } } : null;
      },
      send: (frame) => this.transport.sendFrame(frame),
      revision: () => this.revision,
      clock: this.clock,
      intervalMs: options.frameIntervalMs,
      heartbeatMs: options.heartbeatMs,
      onSent: () => this.countersChanged.push(null),
    });
    this.sendCursor = throttle(
      options.cursorIntervalMs ?? CURSOR_INTERVAL_MS,
      (point) => this.transport.sendCursor({ session: this.self.session, seq: this.cursorSeq++, point, t: this.clock.now() }),
      this.clock,
    );
    // Selections and activities change while dragging: ten updates a second keep them live.
    this.sendState = throttle(options.stateIntervalMs ?? STATE_INTERVAL_MS, () => this.transport.sendState(this.state()), this.clock);
  }

  get sessionId(): string {
    return this.self.session;
  }

  get userId(): string {
    return this.self.user;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.transport.connect({
      onStatus: (status) => {
        this.status = status;
        this.changed();
      },
      onPeers: (peers) => this.onPeers(peers),
      onCursor: (message) => {
        if (message.session === this.self.session) return;
        if (this.cursors.receive(message, this.clock.now())) {
          this.changed();
          this.schedulePrune();
        }
      },
      onFrame: (frame) => {
        if (frame.session === this.self.session) return;
        // Anyone's frame may carry their pointer, whether or not this tab follows them.
        if (frame.pointer && this.cursors.receive({ session: frame.session, seq: frame.pointer.seq, point: frame.pointer.point, ...(frame.t !== undefined ? { t: frame.t } : {}) }, this.clock.now())) {
          this.changed();
          this.schedulePrune();
        }
        this.follow.receive(frame);
      },
      onState: (message) => {
        // Whom they follow may have changed: follow mode and "is following you" are worked out again.
        if (message.session !== this.self.session && this.takeState(message)) this.reconcile(this.everyone);
      },
      onFrameRequest: (request) => {
        if (request.target === this.self.session) this.broadcaster.requested();
      },
    });
    // Once: who this tab is. The transport tracks it again after a reconnect.
    this.transport.track(this.me());
    this.scheduleStateHeartbeat();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attachViewport(null);
    this.sendCursor.cancel();
    this.sendState.cancel();
    if (this.stateHeartbeat !== null) this.clock.clearTimeout(this.stateHeartbeat);
    this.countersChanged.cancel();
    this.broadcaster.dispose();
    if (this.restoreTimer !== null) this.clock.clearTimeout(this.restoreTimer);
    if (this.pruneTimer !== null) this.clock.clearTimeout(this.pruneTimer);
    this.transport.disconnect();
    this.listeners.clear();
  }

  /** Plugs the Gantt in (or out, with null). */
  attachViewport(viewport: PresenceViewport | null): void {
    this.detachViewport?.();
    this.detachViewport = null;
    this.viewport = viewport;
    this.follow.attach(viewport);
    if (!viewport) return;
    const offChange = viewport.onChange(() => this.broadcaster.changed());
    const offNavigate = viewport.onUserNavigate((reason) => this.stopFollowing(reason));
    this.detachViewport = () => {
      offChange();
      offNavigate();
    };
    if (this.broadcaster.isFollowed) this.broadcaster.requested();
  }

  /** The task selected in this tab's plan. */
  setSelectedTask(taskId: number | null): void {
    const value = typeof taskId === 'number' && Number.isInteger(taskId) && taskId >= 0 ? taskId : null;
    if (value === this.taskId) return;
    this.taskId = value;
    this.stateChanged();
  }

  /** The cells selected in this tab's grid and the cell its keyboard is on. */
  setCellSelection(cells: readonly RowCells[], active: CellRef | null): void {
    const capped = capCells(cells);
    const sameActive = active?.taskId === this.active?.taskId && active?.column === this.active?.column;
    if (sameActive && sameCells(capped, this.cells)) return;
    this.cells = capped;
    this.active = active ? { taskId: active.taskId, column: active.column } : null;
    this.stateChanged();
  }

  /** What this person is doing (editing a cell, filling, moving a task…), or null. */
  setActivity(activity: Activity | null): void {
    const next = activity ? { ...activity, ...(activity.cells ? { cells: capCells(activity.cells) } : {}) } : null;
    if (sameActivity(next, this.activity)) return;
    const kindChanged = (next?.kind ?? null) !== (this.activity?.kind ?? null);
    this.activity = next;
    this.stateChanged();
    // Starting or finishing something shows at once; a fill range that grows streams at the interval.
    if (kindChanged) this.sendState.flush();
  }

  /** The last revision this tab applied; frames carry it and wait for it. */
  setRevision(revision: number): void {
    this.revision = revision;
    this.follow.revisionChanged(revision);
  }

  /** Where this tab's pointer is over the plan (null: it left the plan). */
  moveCursor(point: CursorPoint | null): void {
    if (this.disposed) return;
    if (point === null && this.lastPoint === null) return;
    this.lastPoint = point;
    if (this.broadcaster.isFollowed) {
      // Rides in the next frame (at the same rate cursor messages would go).
      this.pointerSeq = this.cursorSeq++;
      this.sendCursor.cancel();
      this.broadcaster.changed();
      return;
    }
    this.sendCursor.push(point);
    if (point === null) this.sendCursor.flush();
  }

  /** Follows `session`, or whoever they follow. */
  startFollowing(session: string): FollowResult {
    const resolved = followTarget(this.merged(), this.self.session, session);
    if ('refused' in resolved) return { ok: false, reason: resolved.refused };
    this.notice = null;
    // Kept to come back to afterwards (switching from one person to another keeps the first one).
    if (!this.follow.target) this.ownView = this.viewport?.read() ?? null;
    this.clearRestoreOffer();
    this.follow.follow(resolved.target.session);
    this.stateChanged();
    this.sendState.flush();
    return { ok: true, target: this.withLiveState(resolved.target) };
  }

  stopFollowing(reason: FollowStopReason = 'manual'): void {
    const target = this.follow.target;
    if (!target) return;
    const name = this.everyone.find((peer) => peer.session === target)?.name ?? 'They';
    this.notice = STOP_NOTICES[reason]?.(name) ?? null;
    this.offerRestore();
    this.follow.stop(reason);
    this.stateChanged();
    this.sendState.flush();
  }

  dismissNotice(): void {
    if (this.notice === null && !this.restoreOffer) return;
    this.notice = null;
    this.clearRestoreOffer();
    this.changed();
  }

  /** Brings back the view this person had before following (offered for a while after it ends). */
  restoreOwnView(): void {
    const view = this.restoreOffer;
    if (!view || this.follow.target) return;
    this.clearRestoreOffer();
    this.notice = null;
    void this.viewport?.restore?.(view);
    this.changed();
  }

  private offerRestore(): void {
    const view = this.ownView;
    this.ownView = null;
    if (!view || !this.viewport?.restore) return;
    this.clearRestoreOffer();
    this.restoreOffer = view;
    this.restoreTimer = this.clock.setTimeout(() => {
      this.restoreTimer = null;
      this.restoreOffer = null;
      this.changed();
    }, RESTORE_OFFER_MS);
  }

  private clearRestoreOffer(): void {
    if (this.restoreTimer !== null) this.clock.clearTimeout(this.restoreTimer);
    this.restoreTimer = null;
    this.restoreOffer = null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PresenceSnapshot {
    if (this.snapshot) return this.snapshot;
    const others = othersOf(this.merged(), this.self.session);
    const present = new Set(others.map((peer) => peer.session));
    const target = this.follow.target;
    const state = this.follow.state;
    this.snapshot = {
      status: this.status,
      peers: others,
      cursors: this.cursors.list().filter((cursor) => present.has(cursor.session)),
      following: target ? (others.find((peer) => peer.session === target) ?? null) : null,
      followWaiting: state.mode === 'following' && state.waiting,
      followers: followersOf(others, this.self.session),
      notice: this.notice,
      canRestore: this.restoreOffer !== null,
      framesSent: this.broadcaster.sent,
      framesApplied: this.follow.applied,
    };
    return this.snapshot;
  }

  /** Who this tab is, for presence. What it is doing travels in state broadcasts (`state()`). */
  private me(): Peer {
    return {
      session: this.self.session,
      user: this.self.user,
      name: this.self.name.slice(0, 80),
      color: this.self.color,
      role: this.self.role,
      taskId: null,
      following: null,
      since: this.since,
      cells: [],
      active: null,
      activity: null,
      rev: 0,
      ...(this.self.simulated ? { simulated: true } : {}),
      ...(this.self.call ? { call: this.self.call } : {}),
    };
  }

  /**
   * The call this tab hosts: Remy on it (and which conversation it uses), or none. Presence carries it, once per
   * change (Realtime allows a tab a few presence updates a minute), so the assistant service can greet the call.
   */
  setCall(call: { remy: boolean; thread: string | null } | null): void {
    const before = JSON.stringify(this.self.call ?? null);
    if (before === JSON.stringify(call)) return;
    this.self = { ...this.self, call };
    if (!this.disposed) this.transport.track(this.me());
  }

  /** Everyone here, each with the newest state heard from them (this tab with its own). */
  private merged(): Peer[] {
    return this.everyone.map((peer) => (peer.session === this.self.session ? { ...peer, following: this.follow.target } : this.withLiveState(peer)));
  }

  private onPeers(peers: Peer[]): void {
    const before = this.everyone;
    this.everyone = peers;
    const present = new Set(peers.map((peer) => peer.session));
    this.cursors.retain(present);
    for (const session of [...this.live.keys()]) if (!present.has(session)) this.live.delete(session);
    // Somebody new: they know nothing of what this tab is doing yet.
    const known = new Set(before.map((peer) => peer.session));
    if (peers.some((peer) => peer.session !== this.self.session && !known.has(peer.session))) {
      this.sendState.push(null);
      this.sendState.flush();
    }
    this.reconcile(before);
  }

  /** Works out follow mode again from who is here and whom they follow. */
  private reconcile(before: readonly Peer[]): void {
    const peers = this.merged();
    const followed = this.follow.target;
    this.follow.peersChanged(peers, this.self.session);
    if (followed && this.follow.target !== followed) {
      const reason = this.follow.state.mode === 'idle' ? this.follow.state.stopped?.reason : undefined;
      // Someone who left is only in the previous list.
      const name = [...peers, ...before].find((peer) => peer.session === followed)?.name ?? 'They';
      this.notice = reason ? (STOP_NOTICES[reason]?.(name) ?? null) : null;
      if (this.follow.state.mode === 'idle') this.offerRestore();
      // Whom this tab follows changed by itself: the others hear it now.
      this.stateChanged();
      this.sendState.flush();
    }
    this.broadcaster.setFollowed(followersOf(peers, this.self.session).length > 0);
    this.changed();
  }

  /** This tab's selection, activity and whom it follows, as broadcast. */
  private state(): StateMessage {
    return {
      session: this.self.session,
      rev: this.stateRev,
      taskId: this.taskId,
      cells: this.cells,
      active: this.active,
      activity: this.activity,
      following: this.follow.target,
    };
  }

  private stateChanged(): void {
    this.stateRev++;
    this.sendState.push(null);
  }

  /** Re-sends this tab's state now and then: a lost broadcast heals within a few seconds. */
  private scheduleStateHeartbeat(): void {
    this.stateHeartbeat = this.clock.setTimeout(() => {
      this.stateHeartbeat = null;
      if (this.disposed) return;
      this.sendState.push(null);
      this.scheduleStateHeartbeat();
    }, STATE_HEARTBEAT_MS);
  }

  /** Keeps a tab's newest state; true when it replaced an older one. */
  private takeState(message: StateMessage): boolean {
    const known = this.live.get(message.session);
    if (known && known.rev >= message.rev) return false;
    this.live.set(message.session, message);
    return true;
  }

  private withLiveState(peer: Peer): Peer {
    const state = this.live.get(peer.session);
    if (!state || state.rev < peer.rev) return peer;
    return { ...peer, taskId: state.taskId, cells: state.cells, active: state.active, activity: state.activity, following: state.following, rev: state.rev };
  }

  private schedulePrune(): void {
    if (this.pruneTimer !== null || this.disposed) return;
    this.pruneTimer = this.clock.setTimeout(() => {
      this.pruneTimer = null;
      if (this.cursors.prune(this.clock.now(), this.cursorTtlMs)) this.changed();
      if (this.cursors.size > 0) this.schedulePrune();
    }, Math.min(1_000, this.cursorTtlMs));
  }

  private changed(): void {
    if (this.disposed) return;
    this.snapshot = null;
    for (const listener of [...this.listeners]) listener();
  }
}

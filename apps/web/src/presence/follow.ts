/**
 * Follow mode, both ends, without the DOM.
 *
 * The follower (`FollowController`) mirrors one person's view: it asks for a frame when it starts,
 * applies that person's frames in the order they were sent (the sink plays them back smoothly, see
 * follow-motion.ts), holds a frame back while its own plan is
 * behind the revision the frame was taken at, moves on to whoever that person follows, and stops when
 * they leave or when this person takes the controls (Escape, scrolling, clicking, zooming).
 *
 * The leader (`ViewBroadcaster`) sends its view only while somebody follows it: on every change (at
 * most every `FRAME_INTERVAL_MS`), on request, and on a heartbeat so a lost frame heals. A follower is
 * never followed in turn (a new follower is sent to the person it follows), so applying a frame
 * never produces one: there is no feedback loop.
 */
import { throttle, systemClock, type Clock, type Throttled } from './clock';
import { followTarget } from './peers';
import { FRAME_HEARTBEAT_MS, FRAME_INTERVAL_MS, sameView, type Peer, type ViewBody, type ViewFrame } from './protocol';

export type FollowStopReason = 'manual' | 'escape' | 'navigate' | 'left' | 'loop';

/** `missing-anchor`: the dates were matched but the task in the middle is not in this plan (yet). */
export type ApplyOutcome = 'applied' | 'missing-anchor';

/** Where frames are applied: the Gantt adapter, or a fake in tests. */
export interface FrameSink {
  apply(frame: ViewFrame): ApplyOutcome;
  /** Following started or stopped: forget frames in flight and stop moving the plan. */
  reset?(): void;
}

export type FollowState =
  | { mode: 'idle'; stopped: { target: string; reason: FollowStopReason } | null }
  | { mode: 'following'; target: string; /** No frame applied yet. */ waiting: boolean };

export interface FollowControllerOptions {
  /** Asks `target` for its view now. */
  request(target: string): void;
  /** The state changed (started, stopped, first frame in). */
  onChange(): void;
  /** Only the counters moved: up to 20 times a second, so not worth a redraw each time. */
  onCount?(): void;
}

export class FollowController {
  private current: FollowState = { mode: 'idle', stopped: null };
  private lastSeq = -1;
  /** The newest frame not applied yet: the plan was behind its revision, or no view was attached. */
  private pending: ViewFrame | null = null;
  private sink: FrameSink | null = null;
  private revision = 0;
  private appliedCount = 0;
  private missingCount = 0;

  constructor(private readonly options: FollowControllerOptions) {}

  get state(): FollowState {
    return this.current;
  }

  /** The session being followed, or null. */
  get target(): string | null {
    return this.current.mode === 'following' ? this.current.target : null;
  }

  /** Frames applied since this controller was made. */
  get applied(): number {
    return this.appliedCount;
  }

  /** Frames whose middle task was not in this plan. */
  get missingAnchors(): number {
    return this.missingCount;
  }

  attach(sink: FrameSink | null): void {
    this.sink = sink;
    this.flushPending();
  }

  /** Starts following `target` (already resolved to the person driving the view). */
  follow(target: string): void {
    this.current = { mode: 'following', target, waiting: true };
    this.lastSeq = -1;
    this.pending = null;
    this.sink?.reset?.();
    this.options.request(target);
    this.options.onChange();
  }

  stop(reason: FollowStopReason): void {
    if (this.current.mode !== 'following') return;
    this.current = { mode: 'idle', stopped: { target: this.current.target, reason } };
    this.pending = null;
    this.sink?.reset?.();
    this.options.onChange();
  }

  /** A frame from anyone; only the followed person's newer frames count. */
  receive(frame: ViewFrame): boolean {
    if (this.current.mode !== 'following' || frame.session !== this.current.target) return false;
    if (frame.seq <= this.lastSeq) return false;
    this.lastSeq = frame.seq;
    this.pending = frame;
    return this.flushPending();
  }

  /** This plan applied a revision: a held-back frame may apply now. */
  revisionChanged(revision: number): void {
    this.revision = revision;
    this.flushPending();
  }

  /** Presence changed: the followed person may have left or started following somebody else. */
  peersChanged(peers: readonly Peer[], self: string): void {
    if (this.current.mode !== 'following') return;
    const followed = peers.find((peer) => peer.session === (this.current as { target: string }).target);
    if (!followed) {
      this.stop('left');
      return;
    }
    if (!followed.following) return;
    const resolved = followTarget(peers, self, followed.session);
    if ('refused' in resolved) this.stop(resolved.refused === 'loop' ? 'loop' : 'left');
    else if (resolved.target.session !== followed.session) this.follow(resolved.target.session);
  }

  private flushPending(): boolean {
    const frame = this.pending;
    if (!frame || !this.sink || frame.revision > this.revision || this.current.mode !== 'following') return false;
    this.pending = null;
    if (this.sink.apply(frame) === 'missing-anchor') this.missingCount++;
    this.appliedCount++;
    if (this.current.waiting) {
      this.current = { ...this.current, waiting: false };
      this.options.onChange();
    } else {
      (this.options.onCount ?? this.options.onChange)();
    }
    return true;
  }
}

export interface ViewBroadcasterOptions {
  self: string;
  /** The current view, or null when there is no plan to read. */
  read(): ViewBody | null;
  send(frame: ViewFrame): void;
  /** The last revision this plan applied. */
  revision(): number;
  clock?: Clock;
  intervalMs?: number;
  heartbeatMs?: number;
  /** A frame went out. */
  onSent?(): void;
}

export class ViewBroadcaster {
  private followed = false;
  private seq = 0;
  private lastSent: ViewBody | null = null;
  private sentCount = 0;
  private heartbeat: unknown = null;
  private readonly clock: Clock;
  private readonly throttled: Throttled<boolean>;
  private disposed = false;

  constructor(private readonly options: ViewBroadcasterOptions) {
    this.clock = options.clock ?? systemClock;
    this.throttled = throttle(options.intervalMs ?? FRAME_INTERVAL_MS, (force) => this.send(force), this.clock);
  }

  get sent(): number {
    return this.sentCount;
  }

  get isFollowed(): boolean {
    return this.followed;
  }

  /** Somebody follows this tab (true) or nobody does any more (false). */
  setFollowed(followed: boolean): void {
    if (this.disposed || followed === this.followed) return;
    this.followed = followed;
    if (followed) {
      this.sendNow();
      this.scheduleHeartbeat();
    } else {
      this.throttled.cancel();
      this.clearHeartbeat();
      this.lastSent = null;
    }
  }

  /** The view moved (scroll, zoom, selection, resize). */
  changed(): void {
    if (this.followed && !this.disposed) this.throttled.push(false);
  }

  /** A follower asked for the view; answered even before presence says it follows. */
  requested(): void {
    if (!this.disposed) this.sendNow();
  }

  dispose(): void {
    this.disposed = true;
    this.throttled.cancel();
    this.clearHeartbeat();
  }

  /** Through the throttle, so the next change still waits out the interval. */
  private sendNow(): void {
    this.throttled.push(true);
    this.throttled.flush();
  }

  private send(force: boolean): void {
    if (this.disposed) return;
    const body = this.options.read();
    if (!body || (!force && sameView(body, this.lastSent))) return;
    this.options.send({ ...body, session: this.options.self, seq: this.seq++, revision: this.options.revision(), t: this.clock.now() });
    this.lastSent = body;
    this.sentCount++;
    this.options.onSent?.();
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = this.clock.setTimeout(() => {
      this.heartbeat = null;
      if (!this.followed || this.disposed) return;
      this.sendNow();
      this.scheduleHeartbeat();
    }, this.options.heartbeatMs ?? FRAME_HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat !== null) this.clock.clearTimeout(this.heartbeat);
    this.heartbeat = null;
  }
}

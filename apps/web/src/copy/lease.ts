/**
 * Keeping the copy while someone is looking at it: touch_copy every 2 minutes while the tab is visible, and once
 * more on coming back to a tab that was hidden for longer than that. Each touch extends the copy's 30-minute lease
 * (the database caps it at 2 hours). A copy nobody keeps is reset by the database.
 *
 * The lease is gone when a touch is refused (the database answered: the copy was reset or given to someone else),
 * or when touches can't get through and the lease has run out by this browser's clock. A touch that can't get
 * through before then is tried again at the next one.
 */
import { CopyError } from './rpc';

/** How often a visible tab keeps its copy. */
export const TOUCH_EVERY_MS = 2 * 60_000;

export interface LeaseOptions {
  /** touch_copy: when the lease now ends (ISO), or null when the database doesn't say. */
  touch(): Promise<string | null>;
  /** The lease is gone: the copy was reset. Called once. */
  onGone(): void;
  /** A touch that didn't get through (it is tried again). */
  onError?(error: unknown): void;
  /** The lease's end changed (ms since the epoch): for the header's "This session ends in 8 min". */
  onLease?(until: number): void;
  /** When the lease ends as last known (ISO). */
  leaseUntil?: string | null;
  everyMs?: number;
  now?(): number;
  /** Whether the page is visible, and a way to hear when that changes. */
  visible?(): boolean;
  onVisibilityChange?(listener: () => void): () => void;
  /** Timers, for tests. */
  setTimer?(run: () => void, ms: number): () => void;
}

const documentVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function onDocumentVisibility(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function windowTimer(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
}

export class LeaseKeeper {
  private readonly options: LeaseOptions;
  private readonly everyMs: number;
  private readonly now: () => number;
  private leaseUntil: number | null;
  private lastTouch: number;
  private touching: Promise<void> | null = null;
  private stops: (() => void)[] = [];
  private gone = false;
  private running = false;

  constructor(options: LeaseOptions) {
    this.options = options;
    this.everyMs = options.everyMs ?? TOUCH_EVERY_MS;
    this.now = options.now ?? (() => Date.now());
    this.leaseUntil = parse(options.leaseUntil ?? null);
    this.lastTouch = this.now();
  }

  /** When the lease ends as last known (ms since the epoch), or null. */
  get until(): number | null {
    return this.leaseUntil;
  }

  get isGone(): boolean {
    return this.gone;
  }

  start(): void {
    if (this.running || this.gone) return;
    this.running = true;
    const visible = this.options.visible ?? documentVisible;
    const setTimer = this.options.setTimer ?? windowTimer;
    this.stops.push(
      setTimer(() => {
        if (visible()) void this.touch();
      }, this.everyMs),
    );
    this.stops.push(
      (this.options.onVisibilityChange ?? onDocumentVisibility)(() => {
        if (visible() && this.now() - this.lastTouch >= this.everyMs) void this.touch();
      }),
    );
  }

  stop(): void {
    this.running = false;
    for (const stop of this.stops.splice(0)) stop();
  }

  /** Keeps the copy now (one touch at a time). */
  touch(): Promise<void> {
    if (this.gone) return Promise.resolve();
    this.touching ??= this.touchOnce().finally(() => {
      this.touching = null;
    });
    return this.touching;
  }

  private async touchOnce(): Promise<void> {
    try {
      const until = await this.options.touch();
      this.lastTouch = this.now();
      const parsed = parse(until);
      if (parsed !== null && parsed !== this.leaseUntil) {
        this.leaseUntil = parsed;
        this.options.onLease?.(parsed);
      }
    } catch (error) {
      const refused = error instanceof CopyError && error.refused;
      if (refused || (this.leaseUntil !== null && this.now() > this.leaseUntil)) {
        this.lose();
        return;
      }
      this.options.onError?.(error);
    }
  }

  private lose(): void {
    if (this.gone) return;
    this.gone = true;
    this.stop();
    this.options.onGone();
  }
}

/**
 * When the session ends, as last known, for React (`useSyncExternalStore`): the lease keeper sets it after each touch.
 */
export class LeaseClock {
  private until: number | null;
  private readonly listeners = new Set<() => void>();

  constructor(leaseUntil: string | null) {
    this.until = parse(leaseUntil);
  }

  set = (until: number | null): void => {
    if (until === this.until) return;
    this.until = until;
    for (const listener of [...this.listeners]) listener();
  };

  get = (): number | null => this.until;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** Shown from this long before the end: the lease is kept 30 minutes ahead while someone looks, up to 2 hours in all. */
export const ENDS_SOON_MS = 10 * 60_000;

/** "This session ends in 8 min" in its last 10 minutes; null before then, or when the end is not known. */
export function sessionEndsText(until: number | null, now: number): string | null {
  if (until === null) return null;
  const left = until - now;
  if (left >= ENDS_SOON_MS) return null;
  const minutes = Math.ceil(left / 60_000);
  return minutes > 1 ? `This session ends in ${minutes} min` : 'This session ends in less than a minute';
}

function parse(iso: string | null): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

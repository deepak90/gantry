import type { Clock } from '../../src/presence/clock';
import type { ApplyOutcome } from '../../src/presence/follow';
import { anchorTaskId, type Peer, type ViewBody } from '../../src/presence/protocol';
import type { PresenceViewport } from '../../src/presence/session';

/** A clock whose time only moves when the test says so. */
export class FakeClock implements Clock {
  private time = 1_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves time forward, running every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
    }
    this.time = end;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

export function peer(session: string, overrides: Partial<Peer> = {}): Peer {
  return {
    session,
    user: `user-${session}`,
    name: `Person ${session.toUpperCase()}`,
    color: '#2563eb',
    role: 'pm',
    taskId: null,
    following: null,
    since: 1,
    cells: [],
    active: null,
    activity: null,
    rev: 0,
    ...overrides,
  };
}

export const VIEW: ViewBody = { preset: 'collab-days', center: '2026-12-11T12:00:00', anchor: { taskId: 15, dy: 0.5 }, selected: [15] };

/**
 * A viewport without a Gantt: `view` is what it shows, `apply` copies a frame into it (as the real
 * adapter would scroll and zoom), and the test plays the user with `navigate()`.
 */
export class FakeViewport implements PresenceViewport {
  view: ViewBody | null;
  readonly applied: ViewBody[] = [];
  /** Task ids this plan has; a frame anchored elsewhere reports a missing anchor. */
  tasks: Set<number> | null = null;
  private readonly changeListeners = new Set<() => void>();
  private readonly navigateListeners = new Set<(reason: 'escape' | 'navigate') => void>();

  constructor(view: ViewBody | null = { ...VIEW, selected: [...VIEW.selected] }) {
    this.view = view;
  }

  read(): ViewBody | null {
    return this.view ? { ...this.view, selected: [...this.view.selected] } : null;
  }

  /** Times follow mode told this viewport to drop what it was playing. */
  resets = 0;
  readonly restored: ViewBody[] = [];

  apply(body: ViewBody): ApplyOutcome {
    const { preset, center, anchor, selected } = body;
    this.applied.push({ preset, center, anchor, selected: [...selected] });
    this.view = { preset, center, anchor, selected: [...selected] };
    // Applying moves the view like any scroll does: listeners hear about it.
    this.emitChange();
    const taskId = anchorTaskId(anchor);
    return taskId !== null && this.tasks && !this.tasks.has(taskId) ? 'missing-anchor' : 'applied';
  }

  reset(): void {
    this.resets++;
  }

  async restore(view: ViewBody): Promise<void> {
    this.restored.push(view);
    this.view = { ...view, selected: [...view.selected] };
    this.emitChange();
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onUserNavigate(listener: (reason: 'escape' | 'navigate') => void): () => void {
    this.navigateListeners.add(listener);
    return () => this.navigateListeners.delete(listener);
  }

  /** The person scrolls or zooms their own plan. */
  move(change: Partial<ViewBody>): void {
    this.view = { ...(this.view ?? { ...VIEW }), ...change };
    this.emitChange();
  }

  navigate(reason: 'escape' | 'navigate' = 'navigate'): void {
    for (const listener of [...this.navigateListeners]) listener(reason);
  }

  get listenerCount(): number {
    return this.changeListeners.size + this.navigateListeners.size;
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }
}

/**
 * A simulated person's hand on the mouse: plays reaches, drifts and pauses (motion.ts) on the virtual
 * screen in real (or test) time, scrolls the screen, and sends the pointer to presence the way a
 * browser would, only less often: quick reaches about eight times a second, slow drifts twice a
 * second, a still hand only to stay alive. Every viewer draws it between updates, so it still glides.
 */
import type { Clock } from '../presence/clock';
import type { CursorPoint } from '../presence/protocol';
import { clampToBounds, holdPath, minimumJerk, planDrift, planMove, Tremor, type Bounds, type MoveOptions, type Path, type Vec } from './motion';
import type { Random } from './random';

/**
 * The screen a hand moves over, in its own pixels: a simulated person's virtual screen (screen.ts), or
 * the plan on this page for page-local people (in-page-team.ts).
 */
export interface HandScreen {
  readonly width: number;
  readonly height: number;
  readonly timelineLeft: number;
  /** Where the pointer can be. */
  readonly bounds: Bounds;
  readonly scroll: Vec;
  setScroll(x: number, y: number): void;
  /** What a point is over, as presence sends it (null: nothing of the plan). */
  pointAt(point: Vec): CursorPoint | null;
}

export interface HandOptions {
  screen: HandScreen;
  clock: Clock;
  random: Random;
  /** Where the pointer is, as presence sends it (null: it left the plan). */
  send(point: CursorPoint | null): void;
  /** How often the hand is sampled (ms). */
  tickMs?: number;
  start?: Vec;
  /** Scales the gaps between pointer updates (1: the crowd's thrifty rates; less: smoother, where nothing is counted). */
  intervalScale?: number;
}

interface Program {
  path: Path;
  startedAt: number;
  scroll: { from: Vec; to: Vec; duration: number } | null;
  resolve: () => void;
}

/**
 * Shortest gap between two pointer updates, by how fast the hand moves (px/s). Every update is
 * delivered to everyone in the plan and Realtime counts each delivery (a local stack allows 100 a
 * second in all), so a crowd sends far less than a browser; viewers draw between updates.
 */
function sendInterval(speed: number): number {
  if (speed > 300) return 130;
  if (speed > 60) return 240;
  if (speed > 8) return 500;
  return 3_000;
}

/** Sent again this often even when nothing moved, so the pointer does not expire on the others' screens (after 5 s). */
const KEEPALIVE_MS = 3_000;

const keyOf = (point: CursorPoint | null): string =>
  !point
    ? ''
    : point.kind === 'grid'
      ? `g${point.taskId}|${point.column}|${point.dx.toFixed(2)}|${point.dy.toFixed(2)}`
      : `t${point.taskId}|${point.date}|${point.dy.toFixed(2)}`;

export class Hand {
  private pos: Vec;
  private present = true;
  private program: Program | null = null;
  private timer: unknown = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastSentKey = '';
  /** Where the hand was over the plan's content (screen position plus scroll) at the last tick. */
  private lastSample: { at: number; pos: Vec } | null = null;
  private readonly tremor: Tremor;
  private readonly tickMs: number;
  private disposed = false;
  /** Pointer updates sent (read by the status page and tests). */
  sent = 0;

  constructor(private readonly options: HandOptions) {
    const { screen, random } = options;
    this.pos = options.start ?? { x: random.range(screen.timelineLeft + 40, screen.width - 80), y: random.range(80, screen.height - 80) };
    this.tremor = new Tremor(random, random.range(0.6, 1.1));
    this.tickMs = options.tickMs ?? 33;
    this.schedule();
  }

  get position(): Vec {
    return this.pos;
  }

  get inPlan(): boolean {
    return this.present;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
    this.program?.resolve();
    this.program = null;
  }

  /** A reach to `to` (screen pixels). */
  move(to: Vec, options: MoveOptions = {}): Promise<void> {
    const target = clampToBounds(to, this.options.screen.bounds);
    return this.play(planMove(this.pos, target, this.options.random, { bounds: this.options.screen.bounds, ...options }));
  }

  /** Reading or thinking: slow small strokes around here. */
  drift(duration: number, options: { radius?: number; heading?: Vec } = {}): Promise<void> {
    return this.play(planDrift(this.pos, this.options.random, { duration, bounds: this.options.screen.bounds, ...options }));
  }

  /** Holding still (the tremor still shows). */
  hold(duration: number): Promise<void> {
    return this.play(holdPath(this.pos, duration));
  }

  /** Scrolls the screen to `scroll` over `duration` ms; the hand stays where it is, drifting a little. */
  scroll(scroll: Vec, duration?: number): Promise<void> {
    const { screen, random } = this.options;
    const from = screen.scroll;
    const span = Math.hypot(scroll.x - from.x, scroll.y - from.y);
    if (span < 2) return Promise.resolve();
    const time = duration ?? Math.min(1_500, 380 + Math.sqrt(span) * 26) * random.range(0.85, 1.2);
    return this.play(planDrift(this.pos, random, { duration: time, radius: 10, bounds: screen.bounds }), { from, to: scroll, duration: time });
  }

  /** The pointer leaves the plan (to the task panel, say). */
  leave(): void {
    this.present = false;
    this.lastSentKey = '';
    this.send(null, this.options.clock.now());
  }

  /** The pointer comes back into the plan at `at`. */
  enter(at: Vec): void {
    this.pos = clampToBounds(at, this.options.screen.bounds);
    this.present = true;
    this.lastSample = null;
  }

  private play(path: Path, scroll: Program['scroll'] = null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.program?.resolve();
    return new Promise<void>((resolve) => {
      this.program = { path, startedAt: this.options.clock.now(), scroll, resolve };
    });
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = this.options.clock.setTimeout(this.tick, this.tickMs);
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (this.disposed) return;
    const now = this.options.clock.now();
    const program = this.program;
    if (program) {
      const t = now - program.startedAt;
      this.pos = program.path.at(t);
      if (program.scroll) {
        const { from, to, duration } = program.scroll;
        const f = minimumJerk(t / duration);
        this.options.screen.setScroll(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f);
      }
      if (t >= Math.max(program.path.duration, program.scroll?.duration ?? 0)) {
        this.pos = program.path.end;
        if (program.scroll) this.options.screen.setScroll(program.scroll.to.x, program.scroll.to.y);
        this.program = null;
        program.resolve();
      }
    }
    this.emit(now);
    this.schedule();
  };

  private emit(now: number): void {
    if (!this.present) return;
    // Speed over the content: scrolling under a still hand moves the pointer across the plan too.
    const { scroll } = this.options.screen;
    const here = { x: this.pos.x + scroll.x, y: this.pos.y + scroll.y };
    const previous = this.lastSample;
    const speed = previous && now > previous.at ? (Math.hypot(here.x - previous.pos.x, here.y - previous.pos.y) * 1000) / (now - previous.at) : 0;
    this.lastSample = { at: now, pos: here };
    // A fast reach hides the tremor; a resting hand shows it.
    const shake = this.tremor.at(now, speed > 200 ? 0.15 : 1);
    const point = this.options.screen.pointAt(clampToBounds({ x: this.pos.x + shake.x, y: this.pos.y + shake.y }, this.options.screen.bounds));
    const key = keyOf(point);
    const since = now - this.lastSentAt;
    if ((since >= sendInterval(speed) * (this.options.intervalScale ?? 1) && key !== this.lastSentKey) || since >= KEEPALIVE_MS) this.send(point, now);
  }

  private send(point: CursorPoint | null, now: number): void {
    this.lastSentAt = now;
    this.lastSentKey = keyOf(point);
    this.sent++;
    try {
      this.options.send(point);
    } catch (error) {
      console.warn('[crowd] could not send the pointer', error);
    }
  }
}

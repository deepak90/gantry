/**
 * Smooth playback of a followed view. Frames arrive up to 20 times a second, a little irregularly;
 * the screen redraws 60 times a second. Jumping to each frame as it lands looks like a slide show, so
 * the follower plays the leader's movement back a moment late (`delayMs`), drawing every screen frame
 * between the two frames that bracket that moment, the way multiplayer games show other players.
 *
 * Frames carry the time the leader read them (its clock); the gap between that and when they arrive
 * here is the leader's clock offset plus transit time. The smallest gap seen lately stands for the
 * offset, so clocks on two machines never need to agree. DOM-free: the Gantt adapter turns the two
 * samples into scroll positions.
 */
import type { ViewAnchor } from './protocol';

export interface MotionSample {
  /** When the leader read it, on the leader's clock (ms). */
  t: number;
  /** The date in the middle of the timeline (ms since epoch). */
  center: number;
  anchor: ViewAnchor | null;
}

export interface MotionPoint {
  from: MotionSample;
  to: MotionSample;
  /** 0 at `from`, 1 at `to`. */
  f: number;
  /** The playback has reached the newest sample: nothing more to draw until another arrives. */
  settled: boolean;
}

export interface FramePlaybackOptions {
  /** How far behind the leader the playback runs: about one frame interval plus some jitter. */
  delayMs?: number;
  /** The leader's frame interval: a sample after a long pause is treated as if movement began one interval before it. */
  intervalMs?: number;
  /** Arrival gaps remembered for the offset estimate. */
  window?: number;
}

export const PLAYBACK_DELAY_MS = 90;

export class FramePlayback {
  private samples: MotionSample[] = [];
  private gaps: number[] = [];
  private readonly delayMs: number;
  private readonly intervalMs: number;
  private readonly window: number;

  constructor(options: FramePlaybackOptions = {}) {
    this.delayMs = options.delayMs ?? PLAYBACK_DELAY_MS;
    this.intervalMs = options.intervalMs ?? 50;
    this.window = options.window ?? 40;
  }

  get size(): number {
    return this.samples.length;
  }

  /** A frame arrived at local time `now`; `t` is absent from older senders (then it counts as arriving at once). */
  push(sample: Omit<MotionSample, 't'> & { t?: number }, now: number): void {
    const t = sample.t ?? now;
    this.gaps.push(now - t);
    if (this.gaps.length > this.window) this.gaps.shift();
    const last = this.samples[this.samples.length - 1];
    // Out of order or a clock that jumped back: start again from this one.
    if (last && t <= last.t) this.samples = [];
    this.samples.push({ t, center: sample.center, anchor: sample.anchor });
    if (this.samples.length > 32) this.samples.splice(0, this.samples.length - 32);
  }

  /** Forget everything (following stopped, or the zoom changed and old samples would mislead). */
  reset(): void {
    this.samples = [];
    this.gaps = [];
  }

  /** Jumps to the newest sample: the next `at()` draws it, without playing back what led to it. */
  snap(): void {
    const last = this.samples[this.samples.length - 1];
    if (!last) return;
    this.samples = [last];
  }

  /** What to draw at local time `now`, or null before the first sample. */
  at(now: number): MotionPoint | null {
    const samples = this.samples;
    if (samples.length === 0) return null;
    const offset = Math.min(...this.gaps);
    const playhead = now - offset - this.delayMs;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    if (samples.length === 1 || playhead >= last.t) return { from: last, to: last, f: 1, settled: true };
    if (playhead <= first.t) return { from: first, to: first, f: 0, settled: false };
    let index = 0;
    while (index < samples.length - 2 && samples[index + 1]!.t <= playhead) index++;
    // Samples before the one we are past are never needed again.
    if (index > 0) {
      this.samples = samples.slice(index);
      return this.at(now);
    }
    const from = samples[0]!;
    const to = samples[1]!;
    // A frame after a pause (a still leader sends nothing): the move began about one interval before it.
    const start = Math.max(from.t, to.t - this.intervalMs * 1.5);
    const f = to.t > start ? Math.min(1, Math.max(0, (playhead - start) / (to.t - start))) : 1;
    return { from, to, f, settled: false };
  }
}

/** Linear blend, with either end possibly unknown (then the other one is used). */
export function blend(a: number | null, b: number | null, f: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

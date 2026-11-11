/**
 * Smooth remote pointers. Pointer updates arrive 5 to 20 times a second, irregularly and sometimes in
 * bursts, while the screen redraws 60 times a second: drawn where they land, they hop. Like follow
 * mode (follow-motion.ts), each pointer is drawn a moment in the past, between the two updates that
 * bracket that moment.
 *
 * Updates carry the time they were sent (the sender's clock). The smallest gap seen lately between
 * sending and arriving stands for the clocks' offset, so each update is placed when it would have
 * arrived without network jitter, and a burst plays back at the pace it was made. (Without a send time
 * the arrival time is used.) The delay adapts to each sender: its usual gap plus how late its updates
 * tend to arrive (never under `minDelayMs`), so it rarely runs out of updates while the pointer moves. When it has (a pause), the next move starts from where
 * the pointer is drawn, never part-way along.
 *
 * Generic over the point type: the presence layer places both ends on its own screen and blends them.
 */

export interface PointerSpan<P> {
  from: P;
  to: P;
  /** 0 at `from`, 1 at `to`. */
  f: number;
}

export interface PointerPlaybackOptions {
  /** The shortest delay behind the newest update (ms). */
  minDelayMs?: number;
  /** The longest delay: a sender that goes quiet for longer is not waited for. */
  maxDelayMs?: number;
}

export const POINTER_DELAY_MS = 100;

interface Sample<P> {
  /** Local time it is placed at. */
  at: number;
  point: P;
}

interface Track<P> {
  samples: Sample<P>[];
  /** Recent gaps between updates (as sent), for the delay. */
  gaps: number[];
  /** Recent arrival minus send times, for the clock offset. */
  transit: number[];
}

const percentile = (values: readonly number[], share: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
};
const median = (values: readonly number[]) => percentile(values, 0.5);

export class PointerPlayback<P> {
  private readonly tracks = new Map<string, Track<P>>();
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: PointerPlaybackOptions = {}) {
    this.minDelayMs = options.minDelayMs ?? POINTER_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? 300;
  }

  /** A new position from `key` arrived at local time `now`; `sentAt` is when it was sent (the sender's clock). */
  push(key: string, point: P, now: number, sentAt?: number): void {
    let track = this.tracks.get(key);
    if (!track) {
      track = { samples: [], gaps: [], transit: [] };
      this.tracks.set(key, track);
    }
    let at = now;
    if (sentAt !== undefined && Number.isFinite(sentAt)) {
      track.transit.push(now - sentAt);
      if (track.transit.length > 40) track.transit.shift();
      at = Math.min(now, sentAt + Math.min(...track.transit));
    }
    const last = track.samples[track.samples.length - 1];
    if (last) {
      const gap = at - last.at;
      // Pauses say nothing about the sender's rate.
      if (gap > 0 && gap < 500) {
        track.gaps.push(gap);
        if (track.gaps.length > 12) track.gaps.shift();
      }
      // Drawn at the last position already (a pause): the move starts from there, now.
      const playhead = now - this.delayOf(key);
      if (playhead > last.at) {
        track.samples = [{ at: playhead, point: last.point }];
      }
      const newest = track.samples[track.samples.length - 1]!;
      if (at <= newest.at) at = newest.at + 1;
    }
    track.samples.push({ at, point });
    if (track.samples.length > 24) track.samples.splice(0, track.samples.length - 24);
  }

  /** Forgets one sender (its pointer left the plan). */
  forget(key: string): void {
    this.tracks.delete(key);
  }

  /** Keeps only these senders. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.tracks.keys()]) if (!keys.has(key)) this.tracks.delete(key);
  }

  /** How far behind `key` is drawn: enough for its usual gaps and for how late its updates tend to arrive. */
  delayOf(key: string): number {
    const track = this.tracks.get(key);
    const gaps = track?.gaps ?? [];
    const gap = gaps.length >= 3 ? median(gaps) : 0;
    const transit = track?.transit ?? [];
    // An update may come this much later than the earliest ones; the next one is a gap after it.
    const late = transit.length >= 5 ? percentile(transit, 0.9) - Math.min(...transit) + 20 : gap * 0.5;
    return Math.min(this.maxDelayMs, Math.max(this.minDelayMs, gap + late));
  }

  /** Where to draw `key` at local time `now`: between two of its positions, or null when unknown. */
  at(key: string, now: number): PointerSpan<P> | null {
    const track = this.tracks.get(key);
    const samples = track?.samples;
    if (!track || !samples || samples.length === 0) return null;
    const playhead = now - this.delayOf(key);
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    if (samples.length === 1 || playhead >= last.at) return { from: last.point, to: last.point, f: 1 };
    if (playhead <= first.at) return { from: first.point, to: first.point, f: 0 };
    let index = 0;
    while (index < samples.length - 2 && samples[index + 1]!.at <= playhead) index++;
    // Positions before the pair being drawn are never needed again.
    if (index > 0) samples.splice(0, index);
    const from = samples[0]!;
    const to = samples[1]!;
    const f = to.at > from.at ? Math.min(1, Math.max(0, (playhead - from.at) / (to.at - from.at))) : 1;
    return { from: from.point, to: to.point, f };
  }

  get size(): number {
    return this.tracks.size;
  }
}

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

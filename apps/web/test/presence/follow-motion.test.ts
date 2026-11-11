/**
 * Smooth playback of a followed view: frames are drawn a moment late, between the two that bracket
 * that moment, so the follower moves on every screen frame instead of jumping on every message.
 */
import { describe, expect, it } from 'vitest';
import { FramePlayback, blend } from '../../src/presence/follow-motion';

const DAY = 86_400_000;
const sample = (t: number, center: number) => ({ t, center, anchor: { taskId: 15, dy: 0.5 } });
/** Where the playback's middle date is at `now`. */
const centerAt = (playback: FramePlayback, now: number) => {
  const point = playback.at(now)!;
  return blend(point.from.center, point.to.center, point.f);
};

describe('FramePlayback', () => {
  it('draws between frames at the pace they were taken, a fixed moment behind', () => {
    const playback = new FramePlayback({ delayMs: 100, intervalMs: 50 });
    // The leader's clock runs 5 s ahead of this one; each frame takes 10 ms to arrive.
    for (let i = 0; i <= 4; i++) playback.push(sample(5_000 + i * 50, i * DAY), i * 50 + 10);
    // At local 160 the playhead is 160 - (-4990) - 100 - 5000 = 50 ms into the leader's run: exactly the second frame.
    expect(centerAt(playback, 160)).toBeCloseTo(DAY);
    // Halfway between the second and third frames.
    expect(centerAt(playback, 185)).toBeCloseTo(1.5 * DAY);
    // Every screen frame in between lands somewhere new.
    const positions = [170, 176, 182, 188, 194].map((now) => centerAt(playback, now));
    expect(new Set(positions).size).toBe(5);
    expect(positions).toEqual([...positions].sort((a, b) => a! - b!));
  });

  it('settles on the newest frame and stays there', () => {
    const playback = new FramePlayback({ delayMs: 100 });
    playback.push(sample(0, 0), 0);
    playback.push(sample(50, DAY), 50);
    expect(playback.at(10_000)).toMatchObject({ settled: true, to: { center: DAY } });
    expect(centerAt(playback, 10_000)).toBe(DAY);
  });

  it('does not play a pause as a slow drift: the move starts about one interval before the frame after it', () => {
    const playback = new FramePlayback({ delayMs: 100, intervalMs: 50 });
    playback.push(sample(0, 0), 0);
    // Two seconds later the leader moved again.
    playback.push(sample(2_000, DAY), 2_000);
    // Without the clamp the playhead at local 1_000 would be half-way; with it, the move has not begun.
    expect(centerAt(playback, 1_000)).toBe(0);
    // It plays over the last 75 ms before the second frame (1.5 intervals).
    expect(centerAt(playback, 2_100 - 75 / 2)).toBeCloseTo(DAY / 2);
  });

  it('holds the first frame until the playhead reaches it', () => {
    const playback = new FramePlayback({ delayMs: 100 });
    playback.push(sample(1_000, 0), 1_000);
    playback.push(sample(1_050, DAY), 1_050);
    expect(playback.at(1_060)).toMatchObject({ settled: false, f: 0, from: { center: 0 } });
  });

  it('snaps to the newest frame and forgets everything on reset', () => {
    const playback = new FramePlayback({ delayMs: 100 });
    playback.push(sample(0, 0), 0);
    playback.push(sample(50, DAY), 50);
    playback.snap();
    expect(playback.at(60)).toMatchObject({ settled: true, to: { center: DAY } });
    playback.reset();
    expect(playback.at(60)).toBeNull();
  });

  it('starts again when a frame is older than the last (a reloaded leader)', () => {
    const playback = new FramePlayback({ delayMs: 0 });
    playback.push(sample(1_000, DAY), 1_000);
    playback.push(sample(10, 3 * DAY), 1_010);
    expect(playback.size).toBe(1);
    expect(centerAt(playback, 2_000)).toBe(3 * DAY);
  });

  it('plays frames without a send time as if they were taken on arrival', () => {
    const playback = new FramePlayback({ delayMs: 0 });
    playback.push({ center: 0, anchor: null }, 100);
    playback.push({ center: DAY, anchor: null }, 150);
    expect(centerAt(playback, 125)).toBeCloseTo(DAY / 2);
  });
});

describe('blend', () => {
  it('blends two ends, or keeps the one that is known', () => {
    expect(blend(0, 10, 0.25)).toBe(2.5);
    expect(blend(null, 10, 0.25)).toBe(10);
    expect(blend(4, null, 0.25)).toBe(4);
    expect(blend(null, null, 0.5)).toBeNull();
  });
});

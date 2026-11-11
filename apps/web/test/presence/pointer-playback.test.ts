import { describe, expect, it } from 'vitest';
import { PointerPlayback, POINTER_DELAY_MS } from '../../src/presence/pointer-playback';

/** Positions are plain numbers here; the layer places CursorPoints and blends the pixels. */
const position = (playback: PointerPlayback<number>, key: string, now: number): number | null => {
  const span = playback.at(key, now);
  return span ? span.from + (span.to - span.from) * span.f : null;
};

describe('PointerPlayback', () => {
  it('draws a pointer about 100 ms late, between the two updates around that moment', () => {
    const playback = new PointerPlayback<number>();
    for (let index = 0; index <= 10; index++) playback.push('a', index * 10, index * 50);
    // 50 ms updates: the delay stays at its minimum.
    expect(playback.delayOf('a')).toBe(POINTER_DELAY_MS);
    // At 325 ms the playhead is at 225 ms: half-way between the updates of 200 ms (40) and 250 ms (50).
    expect(position(playback, 'a', 325)).toBeCloseTo(45, 5);
    // Every redraw moves it a little: no hops.
    const drawn = [330, 346, 362, 378, 394].map((now) => position(playback, 'a', now)!);
    for (let index = 1; index < drawn.length; index++) {
      expect(drawn[index]! - drawn[index - 1]!).toBeGreaterThan(0);
      expect(drawn[index]! - drawn[index - 1]!).toBeLessThan(5);
    }
  });

  it('settles on the newest position once the playhead passes it', () => {
    const playback = new PointerPlayback<number>();
    playback.push('a', 0, 0);
    playback.push('a', 100, 50);
    expect(position(playback, 'a', 1_000)).toBe(100);
  });

  it('waits longer for a sender that updates less often, so its pointer never stalls between updates', () => {
    const playback = new PointerPlayback<number>();
    for (let index = 0; index <= 10; index++) playback.push('slow', index, index * 125);
    expect(playback.delayOf('slow')).toBeGreaterThan(125);
    // Between two updates (1250 ms is the last), the pointer is still on its way.
    const early = position(playback, 'slow', 1_250)!;
    const later = position(playback, 'slow', 1_300)!;
    expect(later).toBeGreaterThan(early);
    expect(later).toBeLessThan(10);
  });

  it('after a pause, moves on from where the pointer is drawn, without jumping part of the way', () => {
    const playback = new PointerPlayback<number>();
    playback.push('a', 0, 0);
    playback.push('a', 100, 3_000);
    // The move starts when the update arrives and takes one delay: no crawl across the pause, no jump.
    expect(position(playback, 'a', 3_000)).toBeCloseTo(0, 5);
    expect(position(playback, 'a', 3_050)).toBeCloseTo(50, 5);
    expect(position(playback, 'a', 3_100)).toBe(100);
  });

  it('plays a burst back at the pace it was sent, using the send times', () => {
    const playback = new PointerPlayback<number>();
    // Sent every 60 ms (the sender's clock is 5 s ahead), moving 10 px each; delivered three at a time every 180 ms.
    const updates = Array.from({ length: 40 }, (_, index) => ({ point: index * 10, sent: 5_000 + index * 60, arrives: Math.ceil((index + 1) / 3) * 180 + 20 }));
    let next = 0;
    let previous: number | null = null;
    let largest = 0;
    // Drawn every screen frame while the updates come in.
    for (let now = 0; now < 2_700; now += 16) {
      while (next < updates.length && updates[next]!.arrives <= now) {
        playback.push('a', updates[next]!.point, now, updates[next]!.sent);
        next++;
      }
      const drawn = position(playback, 'a', now);
      if (drawn === null) continue;
      if (previous !== null && now > 600) largest = Math.max(largest, Math.abs(drawn - previous));
      previous = drawn;
    }
    // Steady: about 10 px per 60 ms is under 3 px a frame; nothing like a burst's 30 px hop.
    expect(largest).toBeLessThan(6);
    expect(previous).toBe(390);
  });

  it('forgets senders that are gone', () => {
    const playback = new PointerPlayback<number>();
    playback.push('a', 1, 0);
    playback.push('b', 2, 0);
    playback.retain(new Set(['b']));
    expect(playback.at('a', 500)).toBeNull();
    expect(position(playback, 'b', 500)).toBe(2);
    expect(playback.size).toBe(1);
  });
});

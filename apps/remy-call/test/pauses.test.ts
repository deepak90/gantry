import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '@livekit/rtc-node';
import { PauseShortener, shortenedPause } from '../src/pauses.ts';

/** A 20 ms frame, loud or silent, tagged with an index. */
const frame = (index: number, loud: boolean) => ({ index, samplesPerChannel: 480, sampleRate: 24000, data: new Int16Array(480).fill(loud ? 8000 : 0) }) as unknown as AudioFrame & { index: number };
const frames = (pattern: Array<[boolean, number]>) => {
  const out: Array<AudioFrame & { index: number }> = [];
  for (const [loud, count] of pattern) for (let i = 0; i < count; i++) out.push(frame(out.length, loud));
  return out;
};
const run = (input: Array<AudioFrame & { index: number }>) => {
  const shortener = new PauseShortener();
  const out: number[] = [];
  const emit = (f: AudioFrame) => out.push((f as AudioFrame & { index: number }).index);
  for (const f of input) shortener.add(f, emit);
  shortener.end(emit);
  return { out, droppedMs: shortener.droppedMs };
};

describe('shortenedPause', () => {
  it('keeps pauses up to 350 ms and 30% of the rest of longer ones', () => {
    expect(shortenedPause(300)).toBe(300);
    expect(shortenedPause(350)).toBe(350);
    expect(shortenedPause(500)).toBeCloseTo(395);
    expect(shortenedPause(900)).toBeCloseTo(515);
  });
});

describe('PauseShortener', () => {
  it('leaves a line with only short pauses as it is, but for the silence after it', () => {
    const { out, droppedMs } = run(frames([[true, 10], [false, 5], [true, 10], [false, 20]]));
    expect(out).toEqual(Array.from({ length: 31 }, (_, i) => i)); // 25 frames of speech and pause, 6 of the tail (120 ms)
    expect(droppedMs).toBe(280);
  });

  it('shortens a long pause from its middle, keeping both of its ends', () => {
    // 10 frames of speech, a 900 ms pause (45 frames), 10 more of speech
    const { out } = run(frames([[true, 10], [false, 45], [true, 10]]));
    const pause = out.filter((i) => i >= 10 && i < 55);
    expect(pause.length * 20).toBeGreaterThanOrEqual(500);
    expect(pause.length * 20).toBeLessThanOrEqual(530);
    expect(pause[0]).toBe(10); // the end of the word before
    expect(pause.at(-1)).toBe(54); // the breath before the next
    expect(out.slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => 55 + i));
  });

  it('leaves the silence before the first word alone (the trimmer handles it)', () => {
    const { out } = run(frames([[false, 30], [true, 5]]));
    expect(out).toEqual(Array.from({ length: 35 }, (_, i) => i));
  });
});

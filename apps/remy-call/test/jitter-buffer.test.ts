import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '@livekit/rtc-node';
import { bufferedLine, JitterBuffer } from '../src/jitter-buffer.ts';

/** Just enough of a 20 ms frame for the buffer: its length, tagged with an index. */
const frame = (index: number) => ({ index, samplesPerChannel: 480, sampleRate: 24000, data: new Int16Array(480) }) as unknown as AudioFrame & { index: number };
const ids = (frames: AudioFrame[]) => frames.map((f) => (f as AudioFrame & { index: number }).index);

/** A source the test feeds by hand. */
function handSource() {
  const queue: Array<AudioFrame | Error | null> = [];
  let wake: (() => void) | null = null;
  let stopped = false;
  const source = (async function* () {
    for (;;) {
      while (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
      const next = queue.shift();
      if (next === null || next === undefined) return;
      if (next instanceof Error) throw next;
      yield next;
    }
  })();
  const push = (item: AudioFrame | Error | null) => {
    queue.push(item);
    wake?.();
  };
  return { source, push, get stopped() { return stopped; }, stop: () => (stopped = true) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function readAll(stream: ReadableStream<AudioFrame>): Promise<AudioFrame[]> {
  const out: AudioFrame[] = [];
  for await (const f of stream as unknown as AsyncIterable<AudioFrame>) out.push(f);
  return out;
}

describe('JitterBuffer', () => {
  it('holds the first frames until 400 ms is in hand, then lets them out at once and the rest as they come', () => {
    const buffer = new JitterBuffer(400);
    for (let i = 0; i < 19; i++) expect(buffer.push(frame(i))).toEqual([]);
    expect(buffer.open).toBe(false);
    expect(ids(buffer.push(frame(19)))).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(buffer.open).toBe(true);
    expect(ids(buffer.push(frame(20)))).toEqual([20]);
    expect(buffer.end()).toEqual([]);
  });

  it('lets a line shorter than the preroll out whole when it ends', () => {
    const buffer = new JitterBuffer(400);
    for (let i = 0; i < 5; i++) buffer.push(frame(i));
    expect(ids(buffer.end())).toEqual([0, 1, 2, 3, 4]);
    expect(buffer.heldMs).toBe(100);
  });
});

describe('bufferedLine', () => {
  it('starts playing once the preroll fills, then passes each frame through', async () => {
    const hand = handSource();
    const opened: Array<{ heldMs: number; whole: boolean }> = [];
    const ended: Array<{ audioMs: number; error: unknown }> = [];
    const stream = bufferedLine(hand.source, 100, new AbortController(), { onOpen: (i) => opened.push(i), onEnd: (i) => ended.push(i) });
    const reader = stream.getReader();
    for (let i = 0; i < 4; i++) hand.push(frame(i));
    await tick();
    expect(opened).toEqual([]);
    hand.push(frame(4));
    const got: number[] = [];
    for (let i = 0; i < 5; i++) got.push(((await reader.read()).value as AudioFrame & { index: number }).index);
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect(opened).toEqual([{ heldMs: 100, whole: false }]);
    hand.push(frame(5));
    expect(((await reader.read()).value as AudioFrame & { index: number }).index).toBe(5);
    hand.push(null);
    expect((await reader.read()).done).toBe(true);
    await tick();
    expect(ended).toEqual([{ audioMs: 120, error: null }]);
  });

  it('plays a short line whole when it ends before the preroll fills', async () => {
    const hand = handSource();
    const opened: Array<{ heldMs: number; whole: boolean }> = [];
    const stream = bufferedLine(hand.source, 400, new AbortController(), { onOpen: (i) => opened.push(i) });
    for (let i = 0; i < 3; i++) hand.push(frame(i));
    hand.push(null);
    expect(ids(await readAll(stream))).toEqual([0, 1, 2]);
    expect(opened).toEqual([{ heldMs: 60, whole: true }]);
  });

  it('keeps synthesizing before anyone reads, so the sound is ready when the line gets the floor', async () => {
    const hand = handSource();
    const stream = bufferedLine(hand.source, 100, new AbortController());
    for (let i = 0; i < 30; i++) hand.push(frame(i));
    hand.push(null);
    await tick();
    expect(ids(await readAll(stream))).toHaveLength(30);
  });

  it('stops the synthesis when the stream is cancelled (a barge-in)', async () => {
    const hand = handSource();
    const abort = new AbortController();
    const ended: Array<{ audioMs: number; error: unknown }> = [];
    const stream = bufferedLine(hand.source, 40, abort, { onEnd: (i) => ended.push(i) });
    const reader = stream.getReader();
    hand.push(frame(0));
    hand.push(frame(1));
    await reader.read();
    await reader.cancel();
    expect(abort.signal.aborted).toBe(true);
    hand.push(frame(2));
    await tick();
    expect(ended).toHaveLength(1);
    expect(ended[0]?.error).toBeNull();
  });

  it('plays what came when the synthesis fails mid-line, and reports the failure', async () => {
    const hand = handSource();
    const ended: Array<{ audioMs: number; error: unknown }> = [];
    const stream = bufferedLine(hand.source, 400, new AbortController(), { onEnd: (i) => ended.push(i) });
    hand.push(frame(0));
    hand.push(frame(1));
    hand.push(new Error('connection reset'));
    expect(ids(await readAll(stream))).toEqual([0, 1]);
    await tick();
    expect(String(ended[0]?.error)).toContain('connection reset');
  });

  it('ends empty when the synthesis fails before any sound', async () => {
    const hand = handSource();
    const stream = bufferedLine(hand.source, 400, new AbortController());
    hand.push(new Error('500'));
    expect(await readAll(stream)).toEqual([]);
  });
});

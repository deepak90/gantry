import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillerCacheFile, prepareFiller, toFrames, type FillerMaker } from '../src/filler-audio.ts';
import type { Word } from '../src/speech-check.ts';

const RATE = 24000;
/** A take from [loud?, ms] pieces. */
function take(pieces: Array<[boolean, number]>): Int16Array {
  const out: number[] = [];
  for (const [loud, ms] of pieces) for (let i = 0; i < (RATE * ms) / 1000; i++) out.push(loud ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * out.length) / RATE)) : 0);
  return Int16Array.from(out);
}
const GOOD = take([[true, 250], [false, 60], [true, 300]]);
const TWO_BEATS = take([[true, 300], [false, 400], [true, 300]]);
const HEARD = { text: 'Let me check.', words: [{ word: 'Let', start: 0, end: 0.2 }, { word: 'me', start: 0.2, end: 0.3 }, { word: 'check', start: 0.3, end: 0.6 }] as Word[] };

/** A maker that hands out the takes in order and hears every one the same. */
function maker(takes: Array<Int16Array | Error>) {
  let made = 0;
  const m: FillerMaker = {
    synthesize: async () => {
      const next = takes[Math.min(made++, takes.length - 1)] as Int16Array | Error;
      if (next instanceof Error) throw next;
      return next;
    },
    transcribe: async () => HEARD,
  };
  return { m, made: () => made };
}

const LIMITS = { maxGapMs: 250, minUnitsPerSec: 3 };
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remy-fillers-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('prepareFiller', () => {
  it('keeps the first take that passes', async () => {
    const { m, made } = maker([GOOD]);
    const got = await prepareFiller('Let me check.', m, { cacheDir: null, voiceKey: 'v', attempts: 4, limits: LIMITS });
    expect(got?.attempts).toBe(1);
    expect(got?.verdict?.ok).toBe(true);
    expect(made()).toBe(1);
  });

  it('makes it again while takes are refused, and says why', async () => {
    const refused: string[][] = [];
    const { m } = maker([TWO_BEATS, new Error('429'), GOOD]);
    const got = await prepareFiller('Let me check.', m, { cacheDir: null, voiceKey: 'v', attempts: 4, limits: LIMITS, onRefused: ({ verdict, error }) => refused.push(verdict ? verdict.reasons : [String(error)]) });
    expect(got?.attempts).toBe(3);
    expect(got?.samples).toBe(GOOD);
    expect(refused).toEqual([['a 400 ms silence inside the speech'], ['Error: 429']]);
  });

  it('gives up after the last attempt: that filler is never said', async () => {
    const { m, made } = maker([TWO_BEATS]);
    expect(await prepareFiller('Let me check.', m, { cacheDir: null, voiceKey: 'v', attempts: 4, limits: LIMITS })).toBeNull();
    expect(made()).toBe(4);
  });

  it('keeps a passing take on disk and plays it next time without making or checking it again', async () => {
    const first = maker([GOOD]);
    await prepareFiller('Let me check.', first.m, { cacheDir: dir, voiceKey: 'v', attempts: 4, limits: LIMITS });
    expect(readdirSync(dir).filter((f) => f.endsWith('.wav'))).toHaveLength(1);
    const second = maker([TWO_BEATS]);
    const got = await prepareFiller('Let me check.', second.m, { cacheDir: dir, voiceKey: 'v', attempts: 4, limits: LIMITS });
    expect(second.made()).toBe(0);
    expect(got?.cached).toBe(true);
    expect(Array.from(got?.samples ?? [])).toEqual(Array.from(GOOD));
  });

  it('makes new takes for a new voice or a new check', () => {
    const base = fillerCacheFile(dir, 'Let me check.', 'v1', LIMITS);
    expect(base).toMatch(/let-me-check-[0-9a-f]{16}\.wav$/);
    expect(fillerCacheFile(dir, 'Let me check.', 'v2', LIMITS)).not.toBe(base);
    expect(fillerCacheFile(dir, 'Let me check.', 'v1', { ...LIMITS, maxGapMs: 200 })).not.toBe(base);
  });
});

describe('toFrames', () => {
  it('cuts a take into 20 ms frames, the last one shorter', () => {
    const frames = toFrames(new Int16Array(1000));
    expect(frames.map((f) => f.samplesPerChannel)).toEqual([480, 480, 40]);
    expect(frames[0]?.sampleRate).toBe(24000);
  });
});

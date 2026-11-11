import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRY } from '../src/config.ts';
import { fryFigures, HOP_MS, measureFry, pitchTrack, type PitchFrame } from '../src/fry.ts';
import { readWav } from '../src/wav.ts';
import { voice } from './tone.ts';

const RATE = 8000;

/** Her lines from a recorded take, at 8 kHz. */
const fixture = (name: string) => readWav(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

describe('pitchTrack', () => {
  it('finds the pitch of a steady voice, high or low', () => {
    const pitch = (hz: number) => {
      const voiced = pitchTrack(voice([[hz, 600]]), RATE).flatMap((f) => (f.hz === null ? [] : [f.hz]));
      return voiced.reduce((a, b) => a + b, 0) / voiced.length;
    };
    expect(pitch(200)).toBeCloseTo(200, 0);
    expect(pitch(250)).toBeCloseTo(250, 0);
    expect(pitch(100)).toBeCloseTo(100, 0);
  });

  it('calls silence unvoiced, and works at 24 kHz', () => {
    expect(pitchTrack(voice([[0, 500]]), RATE).every((f) => f.hz === null)).toBe(true);
    const at24k = pitchTrack(voice([[200, 500]], 24000), 24000).flatMap((f) => (f.hz === null ? [] : [f.hz]));
    expect(at24k.length).toBeGreaterThan(15);
    expect(Math.min(...at24k)).toBeGreaterThan(195);
  });
});

describe('fryFigures', () => {
  /** Frames every 20 ms from [hz or null, count] pieces. */
  const frames = (pieces: Array<[number | null, number]>): PitchFrame[] => {
    const out: PitchFrame[] = [];
    for (const [hz, count] of pieces) for (let i = 0; i < count; i++) out.push({ atMs: out.length * HOP_MS + 20, hz, corr: hz ? 0.9 : 0 });
    return out;
  };
  const tail: Array<[number | null, number]> = [[200, 20]]; // 400 ms of normal voice after, past the end that isn't judged

  it('flags a sustained low stretch', () => {
    const f = fryFigures(frames([[200, 100], [110, 8], ...tail]), FRY);
    expect(f.medianHz).toBe(200);
    expect(f.thresholdHz).toBe(135);
    expect(f.longestRunMs).toBe(160);
    expect(f.fry).toBe(true);
  });

  it('lets a short dip through, like a sentence-final fall', () => {
    const f = fryFigures(frames([[200, 100], [125, 7], ...tail]), FRY);
    expect(f.longestRunMs).toBe(140);
    expect(f.fry).toBe(false);
  });

  it('bridges one unvoiced window inside a run, not two', () => {
    expect(fryFigures(frames([[200, 100], [110, 4], [null, 1], [110, 4], ...tail]), FRY).longestRunMs).toBe(180);
    expect(fryFigures(frames([[200, 100], [110, 4], [null, 2], [110, 4], ...tail]), FRY).longestRunMs).toBe(80);
  });

  it('flags many short low stretches by their share', () => {
    const pieces: Array<[number | null, number]> = [];
    for (let i = 0; i < 6; i++) pieces.push([200, 12], [110, 2]);
    const f = fryFigures(frames([...pieces, ...tail]), FRY);
    expect(f.longestRunMs).toBe(40);
    expect(f.lowShare).toBeCloseTo(12 / 89, 3); // of the 89 voiced windows judged: the last 300 ms aren't
    expect(f.fry).toBe(true);
  });

  it('does not judge the last 300 ms of voicing', () => {
    const f = fryFigures(frames([[200, 100], [100, 15]]), FRY);
    expect(f.low).toBe(0);
    expect(f.fry).toBe(false);
  });

  it('judges low against the line: a low voice is not fry, a far lower stretch is', () => {
    expect(fryFigures(frames([[150, 100], [120, 10], ...tail]), FRY).fry).toBe(false); // 120 is above 0.7 × 150
    expect(fryFigures(frames([[150, 100], [100, 10], ...tail]), FRY)).toMatchObject({ thresholdHz: 105, fry: true });
  });

  it('has nothing to say about a take with no voice', () => {
    expect(fryFigures(frames([[null, 50]]), FRY)).toMatchObject({ medianHz: null, voiced: 0, fry: false });
  });
});

describe('fry on a recorded take', () => {
  it('flags the render that fell into fry on "Levels" and "look the same"', () => {
    const { samples, sampleRate } = fixture('remy-fry-levels.wav');
    const f = measureFry(samples, sampleRate, FRY);
    expect(f.fry).toBe(true);
    expect(Math.round(f.medianHz ?? 0)).toBe(190);
    expect(f.lowShare).toBeGreaterThan(0.17);
    expect(f.longestRunMs).toBe(300);
    expect(f.runAtMs).toBeGreaterThan(6300); // "look the same", 6.4 s in
  });

  it('passes her normal lines, the hardest one included (a 140 ms fall at a sentence end)', () => {
    const allSet = fixture('remy-all-set.wav');
    expect(measureFry(allSet.samples, allSet.sampleRate, FRY)).toMatchObject({ fry: false, longestRunMs: 140 });
    const greeting = fixture('remy-greeting.wav');
    expect(measureFry(greeting.samples, greeting.sampleRate, FRY).fry).toBe(false);
  });
});

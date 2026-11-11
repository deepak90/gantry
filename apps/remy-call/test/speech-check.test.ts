import { describe, expect, it } from 'vitest';
import { judgePhrase, levels, missingWords, normalizeWords, silences, speechSpan, syllables, wordGaps, type Word } from '../src/speech-check.ts';

const RATE = 24000;
/** A clip from [loud?, ms] pieces: a 220 Hz tone at about -12 dBFS, or digital silence. */
function clip(pieces: Array<[boolean, number]>): Int16Array {
  const out: number[] = [];
  for (const [loud, ms] of pieces) {
    const n = Math.round((RATE * ms) / 1000);
    for (let i = 0; i < n; i++) out.push(loud ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * out.length) / RATE)) : 0);
  }
  return Int16Array.from(out);
}
const words = (...spec: Array<[string, number, number]>): Word[] => spec.map(([word, start, end]) => ({ word, start, end }));
const LIMITS = { maxGapMs: 250, minUnitsPerSec: 3 };

describe('levels, speechSpan and silences', () => {
  it('finds the speech and the quiet stretches inside it, not the silence around it', () => {
    const lv = levels(clip([[false, 200], [true, 300], [false, 150], [true, 200], [false, 40], [true, 100], [false, 300]]), RATE);
    expect(lv).toHaveLength(129);
    expect(speechSpan(lv)).toEqual({ startMs: 200, endMs: 990 });
    expect(silences(lv)).toEqual([{ startMs: 500, endMs: 650, ms: 150 }]); // the 40 ms closure is not a pause
  });

  it('has no speech in a silent clip', () => {
    expect(speechSpan(levels(clip([[false, 500]]), RATE))).toBeNull();
    expect(silences(levels(clip([[false, 500]]), RATE))).toEqual([]);
  });
});

describe('words', () => {
  it('normalizes text to plain lowercase words', () => {
    expect(normalizeWords("Thirty-seven, it's — OK?")).toEqual(['thirty', 'seven', 'its', 'ok']);
  });

  it('finds the words Whisper missed, in order', () => {
    expect(missingWords(['just', 'a', 'sec'], ['just', 'a', 'sec'])).toEqual([]);
    expect(missingWords(['just', 'a', 'sec'], ['just', 'a', 'sack'])).toEqual(['sec']);
    expect(missingWords(['let', 'me', 'check'], ['me', 'let', 'check'])).toEqual(['me']);
  });

  it('measures the gaps between words', () => {
    expect(wordGaps(words(['One', 0, 0.3], ['sec', 0.9, 1.2]))).toEqual([600]);
    expect(wordGaps(words(['a', 0, 0.3], ['b', 0.25, 0.5]))).toEqual([0]);
  });

  it('counts syllables like the caption pacing does', () => {
    expect(syllables('One sec.')).toBe(2);
    expect(syllables('Give me a second.')).toBeGreaterThanOrEqual(4);
  });
});

describe('judgePhrase', () => {
  const heard = (text: string, w: Word[]) => ({ text, words: w });

  it('passes a phrase read in one breath', () => {
    const v = judgePhrase('Let me check.', heard('Let me check.', words(['Let', 0, 0.15], ['me', 0.15, 0.3], ['check', 0.3, 0.6])), levels(clip([[true, 250], [false, 70], [true, 300]]), RATE), LIMITS);
    expect(v.ok).toBe(true);
    expect(v.maxSilenceMs).toBe(70);
  });

  it('refuses a missing word', () => {
    const v = judgePhrase('Just a sec.', heard('Just a sack.', words(['Just', 0, 0.2], ['a', 0.2, 0.3], ['sack', 0.3, 0.6])), levels(clip([[true, 650]]), RATE), LIMITS);
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(['missing "sec"']);
  });

  it('refuses a long gap between words, by Whisper or by the loudness', () => {
    const byWhisper = judgePhrase('One sec.', heard('One sec.', words(['One', 0, 0.2], ['sec', 0.5, 0.7])), levels(clip([[true, 600]]), RATE), LIMITS);
    expect(byWhisper.reasons).toEqual(['a 300 ms gap between words']);
    const byLoudness = judgePhrase('Let me check.', heard('Let me check.', words(['Let', 0, 0.2], ['me', 0.2, 0.4], ['check', 0.4, 0.9])), levels(clip([[true, 300], [false, 300], [true, 300]]), RATE), LIMITS);
    expect(byLoudness.reasons).toEqual(['a 300 ms silence inside the speech']);
  });

  it('refuses a phrase drawn out into two beats, even without a long gap', () => {
    // Her old "One sec.": "Onnne" for half a second, a 150 ms beat, then "sec".
    const v = judgePhrase('One sec.', heard('One sec.', words(['One', 0, 0.62], ['sec', 0.62, 0.95])), levels(clip([[true, 470], [false, 150], [true, 280]]), RATE), LIMITS);
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(['drawn out: 2.22 syllables a second']);
  });

  it('refuses a take with no speech', () => {
    const v = judgePhrase('One sec.', heard('you', words(['you', 0, 0.3])), levels(clip([[false, 600]]), RATE), LIMITS);
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('no speech');
  });
});

/**
 * Listening back to Remy's voice: Whisper's word timings and the clip's own loudness. A read that breaks a phrase
 * apart ("One… sec") or drops a word shows as a long gap between words, a quiet stretch inside the speech, or a word
 * missing from what Whisper heard. The worker checks every filler with it before using it (filler-audio.ts).
 */
import { tokenize } from '@livekit/agents';
import { OpenAI, toFile } from 'openai';
import { wavBytes } from './wav.ts';

export interface Word {
  word: string;
  /** Seconds from the clip's start. */
  start: number;
  end: number;
}

export interface Span {
  startMs: number;
  endMs: number;
}

export interface Silence extends Span {
  ms: number;
}

const HOP_MS = 10;
/** Below this a 10 ms stretch is quiet: Remy's pauses sit under -50 dBFS, her softest sounds above -45. */
export const QUIET_DB = -45;
/** A quiet stretch shorter than this is a stop consonant's closure, not a pause. */
export const MIN_SILENCE_MS = 60;

/** Loudness in dBFS per 10 ms. */
export function levels(samples: Int16Array, sampleRate: number): number[] {
  const hop = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000));
  const out: number[] = [];
  for (let k = 0; (k + 1) * hop <= samples.length; k++) {
    let sum = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) sum += (samples[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / hop) / 32768;
    out.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  return out;
}

/** From the first loud 10 ms to the end of the last one; null for a clip with no speech. */
export function speechSpan(lv: readonly number[], quietDb = QUIET_DB): Span | null {
  const first = lv.findIndex((db) => db > quietDb);
  if (first < 0) return null;
  let last = lv.length - 1;
  while (last > first && (lv[last] ?? -120) <= quietDb) last--;
  return { startMs: first * HOP_MS, endMs: (last + 1) * HOP_MS };
}

/** The quiet stretches inside the speech, in order. */
export function silences(lv: readonly number[], { quietDb = QUIET_DB, minMs = MIN_SILENCE_MS } = {}): Silence[] {
  const span = speechSpan(lv, quietDb);
  if (!span) return [];
  const out: Silence[] = [];
  let runStart: number | null = null;
  for (let k = span.startMs / HOP_MS; k < span.endMs / HOP_MS; k++) {
    const quiet = (lv[k] ?? -120) <= quietDb;
    if (quiet && runStart === null) runStart = k;
    if (!quiet && runStart !== null) {
      const ms = (k - runStart) * HOP_MS;
      if (ms >= minMs) out.push({ startMs: runStart * HOP_MS, endMs: k * HOP_MS, ms });
      runStart = null;
    }
  }
  return out;
}

/** Plain lowercase words: "Thirty-seven, it's" → ["thirty", "seven", "its"]. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The expected words Whisper didn't hear, matching in order (a word may be skipped, never reordered). */
export function missingWords(expected: readonly string[], heard: readonly string[]): string[] {
  const missing: string[] = [];
  let from = 0;
  for (const word of expected) {
    const at = heard.indexOf(word, from);
    if (at < 0) missing.push(word);
    else from = at + 1;
  }
  return missing;
}

/** The gap before each word after the first, in ms (never negative). */
export function wordGaps(words: readonly Word[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) gaps.push(Math.max(0, Math.round(((words[i]?.start ?? 0) - (words[i - 1]?.end ?? 0)) * 1000)));
  return gaps;
}

export interface PhraseLimits {
  /** Longest gap allowed between two words, by Whisper's timings or by the loudness. */
  maxGapMs: number;
  /**
   * Slowest pace allowed, in syllables (hyphenation units) a second of speech. A short phrase drawn out like her old
   * "One sec." (an "Onnne" of half a second, a beat, then "sec": 2 syllables in 0.9 s) reads as two beats even when no
   * gap between its words is long; read in one breath, the fillers ran at 3 to 7 a second.
   */
  minUnitsPerSec: number;
}

/** Syllables as the caption pacing counts them (agents-js's hyphenation). */
export function syllables(text: string): number {
  return normalizeWords(text).reduce((n, word) => n + tokenize.basic.hyphenateWord(word).length, 0);
}

export interface PhraseVerdict {
  ok: boolean;
  reasons: string[];
  heard: string;
  missing: string[];
  maxWordGapMs: number;
  maxSilenceMs: number;
  speechMs: number;
  unitsPerSec: number;
}

/** Whether a short phrase was read in one breath: every word there, no gap between words over the limit, not drawn out. */
export function judgePhrase(text: string, heard: { text: string; words: readonly Word[] }, lv: readonly number[], limits: PhraseLimits): PhraseVerdict {
  const reasons: string[] = [];
  const missing = missingWords(normalizeWords(text), normalizeWords(heard.words.length ? heard.words.map((w) => w.word).join(' ') : heard.text));
  if (missing.length) reasons.push(`missing ${missing.map((w) => `"${w}"`).join(', ')}`);
  const maxWordGapMs = Math.max(0, ...wordGaps(heard.words));
  if (maxWordGapMs > limits.maxGapMs) reasons.push(`a ${maxWordGapMs} ms gap between words`);
  const maxSilenceMs = Math.max(0, ...silences(lv).map((s) => s.ms));
  if (maxSilenceMs > limits.maxGapMs) reasons.push(`a ${maxSilenceMs} ms silence inside the speech`);
  const span = speechSpan(lv);
  const speechMs = span ? span.endMs - span.startMs : 0;
  const unitsPerSec = speechMs ? Number(((syllables(text) / speechMs) * 1000).toFixed(2)) : 0;
  if (!span) reasons.push('no speech');
  else if (unitsPerSec < limits.minUnitsPerSec) reasons.push(`drawn out: ${unitsPerSec} syllables a second`);
  return { ok: reasons.length === 0, reasons, heard: heard.text.trim(), missing, maxWordGapMs, maxSilenceMs, speechMs, unitsPerSec };
}

/**
 * What Whisper hears in a clip, with word timings. `prompt` steers spelling (numbers as words, names); leave it out
 * when checking that every word is really there, since a prompt can lend Whisper words it didn't hear.
 */
export async function transcribeWords(client: OpenAI, samples: Int16Array, sampleRate: number, options: { prompt?: string; signal?: AbortSignal } = {}): Promise<{ text: string; words: Word[] }> {
  const result = await client.audio.transcriptions.create(
    {
      file: await toFile(wavBytes(samples, sampleRate), 'clip.wav', { type: 'audio/wav' }),
      model: 'whisper-1',
      language: 'en',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
    { signal: options.signal },
  );
  return { text: result.text, words: (result.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end })) };
}

/**
 * Remy's fillers, made once and checked before use. A filler is a short phrase ("Just a sec.") that has to sound like
 * one breath; the voice model sometimes reads one in two beats (her old "One sec." came out as "Onnne… sec"), which is
 * jarring on a call. Each take is transcribed with Whisper's word timings and refused when a word is missing, when two
 * words sit more than 250 ms apart (by Whisper's timings or by the loudness), or when it is drawn out (slower than 3
 * syllables a second); then it is made again, a few times at most. A take that passes is kept on disk, keyed by the
 * phrase, the voice and the check, so later calls play the very same take without making or checking it again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AudioFrame } from '@livekit/rtc-node';
import { judgePhrase, levels, type PhraseLimits, type PhraseVerdict, type Word } from './speech-check.ts';
import { FRAME_SAMPLES, SAMPLE_RATE } from './tts.ts';
import { readWav, writeWav } from './wav.ts';

/** Bump when the check changes, so takes kept under the old one are judged again. */
const CHECK_VERSION = 1;

export interface FillerMaker {
  /** A take of the phrase: trimmed 24 kHz mono PCM. */
  synthesize(text: string): Promise<Int16Array>;
  /** What Whisper hears in a take, with word timings. */
  transcribe(samples: Int16Array): Promise<{ text: string; words: Word[] }>;
}

export interface FillerTake {
  text: string;
  samples: Int16Array;
  /** How it was judged; null for a take from the cache, which passed when it was made. */
  verdict: PhraseVerdict | null;
  attempts: number;
  cached: boolean;
}

export interface FillerOptions {
  /** Where passing takes are kept; null keeps none. */
  cacheDir: string | null;
  /** The voice a take was made with (model, voice, speed, instructions): a new voice makes new takes. */
  voiceKey: string;
  attempts: number;
  limits: PhraseLimits;
  /** Each take refused or failed, for the log. */
  onRefused?(info: { text: string; attempt: number; verdict: PhraseVerdict | null; error: unknown }): void;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'filler';

export function fillerCacheFile(dir: string, text: string, voiceKey: string, limits: PhraseLimits): string {
  const hash = createHash('sha256').update(`${CHECK_VERSION}\n${limits.maxGapMs}/${limits.minUnitsPerSec}\n${voiceKey}\n${text}`).digest('hex').slice(0, 16);
  return join(dir, `${slug(text)}-${hash}.wav`);
}

/** A passing take of the phrase, from the cache or made and checked now; null when every attempt was refused. */
export async function prepareFiller(text: string, maker: FillerMaker, options: FillerOptions): Promise<FillerTake | null> {
  const file = options.cacheDir ? fillerCacheFile(options.cacheDir, text, options.voiceKey, options.limits) : null;
  if (file && existsSync(file)) {
    try {
      const wav = readWav(file);
      if (wav.sampleRate === SAMPLE_RATE && wav.samples.length) return { text, samples: wav.samples, verdict: null, attempts: 0, cached: true };
    } catch {
      // unreadable: make it again
    }
  }
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    let verdict: PhraseVerdict | null = null;
    try {
      const samples = await maker.synthesize(text);
      verdict = judgePhrase(text, await maker.transcribe(samples), levels(samples, SAMPLE_RATE), options.limits);
      if (verdict.ok) {
        if (file) keep(file, samples);
        return { text, samples, verdict, attempts: attempt, cached: false };
      }
      options.onRefused?.({ text, attempt, verdict, error: null });
    } catch (error) {
      options.onRefused?.({ text, attempt, verdict, error });
    }
  }
  return null;
}

function keep(file: string, samples: Int16Array): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const partial = `${file}.${process.pid}.part`;
    writeWav(partial, samples, SAMPLE_RATE);
    renameSync(partial, file);
  } catch {
    // no cache this time: the take still plays
  }
}

/** PCM cut into 20 ms frames for the mouth. */
export function toFrames(samples: Int16Array, sampleRate = SAMPLE_RATE, frameSamples = FRAME_SAMPLES): AudioFrame[] {
  const frames: AudioFrame[] = [];
  for (let at = 0; at < samples.length; at += frameSamples) {
    const data = samples.slice(at, at + frameSamples);
    frames.push(new AudioFrame(data, sampleRate, 1, data.length));
  }
  return frames;
}

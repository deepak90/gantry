/**
 * A line checked before it plays. gpt-4o-mini-tts varies its delivery per request: now and then it reads a line slow
 * and flat, or drops part of it about an octave into a creaky register (vocal fry), and either sounds like a different
 * voice (config.ts has the numbers). So a line is rendered whole first; its pace is taken as the sound kept (after
 * trimming) per spoken syllable (spoken.ts) and its fry from its pitch (fry.ts). A take that is too slow or has fry is
 * asked for once more; of the two, the one without fry plays, then the faster. Never more than one retry. A line under
 * a few syllables is not checked (one pause skews it) and streams as before.
 */
import type { AudioFrame } from '@livekit/rtc-node';
import { measureFry, type FryFigures, type FryOptions } from './fry.ts';
import { spokenSyllables } from './spoken.ts';
import { newSpeechStats, SAMPLE_RATE, type SpeechStats } from './tts.ts';

/** What voices a line: a `LineSpeech` (tts.ts), or a fake in the tests. */
export interface SpeechSource {
  frames(text: string, signal?: AbortSignal, stats?: SpeechStats): AsyncIterable<AudioFrame>;
}

export interface PaceOptions {
  /** Slowest pace a take may have, in ms of kept sound per spoken syllable. */
  limitMs: number;
  /** Lines with fewer syllables are not checked. */
  minSyllables: number;
  /** A retry faster than this has likely lost words, and never plays. */
  floorMs: number;
  /** How fry is judged (fry.ts); null leaves it unchecked. */
  fry: FryOptions | null;
}

export type RetryReason = 'slow' | 'fry';

export interface PaceReport {
  syllables: number;
  limitMs: number;
  /** Each take's pace in ms per syllable, in the order they were made: one, or two when the first was retried. */
  paceMs: number[];
  keptMs: number[];
  /** Each take's fry figures, in the same order; null where fry wasn't checked. */
  fry: Array<FryFigures | null>;
  /** Why the first take was asked for again; empty when it wasn't. */
  reasons: RetryReason[];
  /** The take that plays, from 1. */
  used: number;
  /** From the first request until the chosen take was let out, in ms. */
  waitMs: number;
  /** The retry failed; the first take plays. */
  retryError?: unknown;
}

export interface PacedLineEvents {
  /** The line was checked: what was measured and which take plays. */
  onPace?(report: PaceReport): void;
  /** The line is too short to check; it streams as it comes. */
  onSkip?(info: { syllables: number }): void;
}

interface Take {
  frames: AudioFrame[];
  stats: SpeechStats;
  failed: boolean;
  error: unknown;
  fry: FryFigures | null;
}

async function render(speech: SpeechSource, text: string, signal: AbortSignal | undefined): Promise<Take> {
  const stats = newSpeechStats();
  const frames: AudioFrame[] = [];
  try {
    for await (const frame of speech.frames(text, signal, stats)) frames.push(frame);
    return { frames, stats, failed: false, error: null, fry: null };
  } catch (error) {
    return { frames, stats, failed: true, error, fry: null };
  }
}

/** A take's fry figures from its frames; null when it can't be measured. */
function fryOf(frames: readonly AudioFrame[], options: FryOptions): FryFigures | null {
  const parts = frames.flatMap((frame) => (frame.data instanceof Int16Array ? [frame.data] : []));
  const samples = new Int16Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  try {
    return measureFry(samples, frames[0]?.sampleRate ?? SAMPLE_RATE, options);
  } catch {
    return null;
  }
}

/**
 * A line's frames once it has been checked: the first take when it is quick enough and has no fry, else the better of
 * two. `stats` is filled with the playing take's. A first take that fails plays what came and then throws, like a
 * streamed line; a retry that fails leaves the first take to play.
 */
export async function* pacedFrames(speech: SpeechSource, text: string, signal: AbortSignal | undefined, stats: SpeechStats, options: PaceOptions, events: PacedLineEvents = {}): AsyncGenerator<AudioFrame> {
  const syllables = spokenSyllables(text);
  if (syllables < options.minSyllables) {
    events.onSkip?.({ syllables });
    yield* speech.frames(text, signal, stats);
    return;
  }
  const startedAt = Date.now();
  const pace = (take: Take) => take.stats.keptMs / syllables;
  const hasFry = (take: Take) => take.fry?.fry === true;
  const judge = (take: Take) => {
    if (options.fry) take.fry = fryOf(take.frames, options.fry);
  };
  const first = await render(speech, text, signal);
  if (first.failed) {
    Object.assign(stats, first.stats);
    if (!signal?.aborted) yield* first.frames;
    throw first.error;
  }
  judge(first);
  const reasons: RetryReason[] = [];
  if (pace(first) > options.limitMs) reasons.push('slow');
  if (hasFry(first)) reasons.push('fry');
  const takes = [first];
  let failedRetry: Take | null = null;
  if (reasons.length && !signal?.aborted) {
    const second = await render(speech, text, signal);
    if (second.failed) failedRetry = second;
    else {
      judge(second);
      takes.push(second);
    }
  }
  if (signal?.aborted) return;
  // A retry plays only when it hasn't lost words; then no fry beats fry, and the faster wins.
  const better = (a: Take, b: Take) => (hasFry(a) !== hasFry(b) ? !hasFry(a) : pace(a) < pace(b));
  const best = takes.reduce((chosen, take) => (take !== first && pace(take) >= options.floorMs && better(take, chosen) ? take : chosen));
  Object.assign(stats, best.stats);
  events.onPace?.({
    syllables,
    limitMs: options.limitMs,
    paceMs: takes.map(pace),
    keptMs: takes.map((take) => take.stats.keptMs),
    fry: takes.map((take) => take.fry),
    reasons,
    used: takes.indexOf(best) + 1,
    waitMs: Date.now() - startedAt,
    ...(failedRetry ? { retryError: failedRetry.error } : {}),
  });
  yield* best.frames;
}

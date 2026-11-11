/**
 * Vocal fry in a take. Now and then the voice model drops a stretch of a line about an octave, into a creaky register
 * that sounds like a different voice: in one recorded take, "Levels" and "look the same" came out at 113–136 Hz in
 * a line otherwise at 150–300 (config.ts has the numbers). Pitch is tracked by autocorrelation on the take decimated to
 * 8 kHz, 40 ms windows every 20 ms, a window voiced when its normalized correlation peaks above 0.6. A voiced window is
 * low when its pitch is under an absolute floor and well under the line's own median; a take has fry when its low
 * windows run long enough, or make up enough of its voiced ones.
 */

export interface PitchFrame {
  /** The window's middle, ms from the take's start. */
  atMs: number;
  /** Its pitch; null when unvoiced (quiet, or no clear period). */
  hz: number | null;
  /** The normalized autocorrelation at the chosen period. */
  corr: number;
}

export interface FryOptions {
  /** A voiced window is low only under this pitch... */
  floorHz: number;
  /** ...and under this share of the line's median pitch. */
  ratio: number;
  /** Fry: low windows in a row covering at least this long (one window unvoiced inside a run is bridged)... */
  minRunMs: number;
  /** ...or more than this share of the voiced windows low. */
  maxShare: number;
  /** The last this-many ms of voicing aren't judged: a line's last syllable often falls into a creak of its own. */
  skipEndMs: number;
}

export interface FryFigures {
  medianHz: number | null;
  /** Under this a voiced window counted as low: the floor, or the median's share when that is lower. */
  thresholdHz: number | null;
  voiced: number;
  low: number;
  /** Low windows as a share of the voiced ones, 0 to 1. */
  lowShare: number;
  longestRunMs: number;
  /** Where the longest run starts, ms from the take's start. */
  runAtMs: number | null;
  fry: boolean;
}

const RATE = 8000;
const WINDOW = 320; // 40 ms
const HOP = 160; // 20 ms
export const HOP_MS = (HOP / RATE) * 1000;
const MIN_HZ = 60;
const MAX_HZ = 400;
const VOICED_CORR = 0.6;
/** Quieter windows aren't tracked: her pauses sit under -50 dBFS, her softest sounds above -45. */
const QUIET_DB = -45;

/** 16-bit PCM at a multiple of 8 kHz, low-passed (windowed sinc at 3.4 kHz) and decimated to 8 kHz, scaled to ±1. */
export function decimate(samples: Int16Array, sampleRate: number): Float32Array {
  const factor = Math.round(sampleRate / RATE);
  if (factor < 1 || factor * RATE !== sampleRate) throw new Error(`pitch tracking needs a multiple of 8 kHz, not ${sampleRate} Hz`);
  const out = new Float32Array(Math.floor(samples.length / factor));
  if (factor === 1) {
    for (let i = 0; i < out.length; i++) out[i] = (samples[i] ?? 0) / 32768;
    return out;
  }
  const half = 4 * factor;
  const cutoff = 3400 / sampleRate;
  const taps: number[] = [];
  for (let k = -half; k <= half; k++) {
    const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
    taps.push(sinc * (0.54 + 0.46 * Math.cos((Math.PI * k) / half)));
  }
  const gain = taps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < out.length; i++) {
    const center = i * factor;
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += (taps[k + half] ?? 0) * (samples[center + k] ?? 0);
    out[i] = sum / gain / 32768;
  }
  return out;
}

/** Pitch every 20 ms. */
export function pitchTrack(samples: Int16Array, sampleRate: number): PitchFrame[] {
  const x = decimate(samples, sampleRate);
  const minLag = Math.floor(RATE / MAX_HZ);
  const maxLag = Math.ceil(RATE / MIN_HZ);
  const quiet = 10 ** (QUIET_DB / 10) * WINDOW;
  const frames: PitchFrame[] = [];
  for (let start = 0; start + WINDOW + maxLag <= x.length; start += HOP) {
    const atMs = ((start + WINDOW / 2) / RATE) * 1000;
    let e0 = 0;
    for (let n = 0; n < WINDOW; n++) e0 += (x[start + n] ?? 0) ** 2;
    if (e0 <= quiet) {
      frames.push({ atMs, hz: null, corr: 0 });
      continue;
    }
    let eLag = 0;
    for (let n = 0; n < WINDOW; n++) eLag += (x[start + minLag + n] ?? 0) ** 2;
    let best = -1;
    let bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (lag > minLag) eLag += (x[start + lag + WINDOW - 1] ?? 0) ** 2 - (x[start + lag - 1] ?? 0) ** 2;
      let dot = 0;
      for (let n = 0; n < WINDOW; n++) dot += (x[start + n] ?? 0) * (x[start + n + lag] ?? 0);
      const r = eLag > 0 ? dot / Math.sqrt(e0 * eLag) : 0;
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    frames.push({ atMs, hz: best > VOICED_CORR ? RATE / bestLag : null, corr: best });
  }
  return frames;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** How much of a take sits in a low, creaky register, and whether that is fry. */
export function fryFigures(all: readonly PitchFrame[], options: FryOptions): FryFigures {
  const lastVoicedAt = all.reduce((at, f) => (f.hz === null ? at : f.atMs), -Infinity);
  const frames = all.filter((f) => f.atMs <= lastVoicedAt - options.skipEndMs);
  const pitches = frames.flatMap((f) => (f.hz === null ? [] : [f.hz]));
  const medianHz = median(pitches);
  if (medianHz === null) return { medianHz: null, thresholdHz: null, voiced: 0, low: 0, lowShare: 0, longestRunMs: 0, runAtMs: null, fry: false };
  const thresholdHz = Math.min(options.floorHz, medianHz * options.ratio);
  const isLow = (f: PitchFrame | undefined) => f !== undefined && f.hz !== null && f.hz < thresholdHz;
  let low = 0;
  let longest = 0;
  let longestAt: number | null = null;
  let run = 0;
  let runAt = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (isLow(frame)) {
      low++;
      if (run === 0) runAt = frame?.atMs ?? 0;
      run++;
    } else if (run > 0 && frame?.hz === null && isLow(frames[i + 1])) {
      run++; // one unvoiced window inside a run: creak's irregular pulses often lose one
    } else {
      run = 0;
    }
    if (run > longest) {
      longest = run;
      longestAt = runAt;
    }
  }
  const longestRunMs = longest * HOP_MS;
  const lowShare = low / pitches.length;
  return {
    medianHz,
    thresholdHz,
    voiced: pitches.length,
    low,
    lowShare,
    longestRunMs,
    runAtMs: longestAt,
    fry: longestRunMs >= options.minRunMs || lowShare > options.maxShare,
  };
}

/** A take's fry figures from its 16-bit PCM. */
export function measureFry(samples: Int16Array, sampleRate: number, options: FryOptions): FryFigures {
  return fryFigures(pitchTrack(samples, sampleRate), options);
}

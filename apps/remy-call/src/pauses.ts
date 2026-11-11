/**
 * Long pauses inside a line, shortened. Read whole, a line keeps the model's own timing, and gpt-4o-mini-tts pauses
 * 500–900 ms at a sentence break or after an opener ("Right. [700 ms] And waiting till Friday…"): the slow, read-aloud
 * beat that no wording of her instructions removes. A pause over 350 ms keeps 350 ms and 30% of the
 * rest (500 → 395 ms, 900 → 515 ms), so long pauses stay longer than short ones. The cut comes out of the pause's
 * middle, so the end of one word and the breath before the next stay as they were. Silence after the last word is cut
 * to 120 ms. Quiet means under -45 dBFS: her pauses sit below -50, her softest sounds above -45; a breath in a pause
 * counts as sound, so a pause with a breath in it is shortened on each side of the breath.
 */
import type { AudioFrame } from '@livekit/rtc-node';

export interface PauseOptions {
  /** Pauses up to this long are kept whole. */
  kneeMs: number;
  /** The share of a pause beyond the knee that is kept. */
  ratio: number;
  /** Silence kept after the last word. */
  tailMs: number;
}

export const PAUSES: PauseOptions = { kneeMs: 350, ratio: 0.3, tailMs: 120 };
const QUIET_DBFS = -45;

const frameMs = (frame: AudioFrame) => (frame.samplesPerChannel / frame.sampleRate) * 1000;

/** How long a pause of `ms` becomes. */
export function shortenedPause(ms: number, options: PauseOptions = PAUSES): number {
  return ms <= options.kneeMs ? ms : options.kneeMs + (ms - options.kneeMs) * options.ratio;
}

export class PauseShortener {
  #options: PauseOptions;
  #heard = false;
  #run: AudioFrame[] = [];
  #runMs = 0;
  /** Silence dropped so far, in ms. */
  droppedMs = 0;

  constructor(options: PauseOptions = PAUSES) {
    this.#options = options;
  }

  static quiet(frame: AudioFrame): boolean {
    const data = frame.data;
    if (!data.length) return true;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += (data[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / data.length) / 32768;
    return rms <= 0 || 20 * Math.log10(rms) <= QUIET_DBFS;
  }

  add(frame: AudioFrame, emit: (frame: AudioFrame) => void): void {
    const quiet = PauseShortener.quiet(frame);
    if (!this.#heard) {
      // Before the first word (the trimmer has already cut the lead-in): as it is.
      if (!quiet) this.#heard = true;
      emit(frame);
      return;
    }
    if (quiet) {
      this.#run.push(frame);
      this.#runMs += frameMs(frame);
      return;
    }
    this.#flush(shortenedPause(this.#runMs, this.#options), emit);
    emit(frame);
  }

  /** The line ended: keep a short tail of the silence after the last word. */
  end(emit: (frame: AudioFrame) => void): void {
    const keep = Math.min(this.#runMs, this.#options.tailMs);
    let kept = 0;
    for (const frame of this.#run) {
      if (kept >= keep) break;
      kept += frameMs(frame);
      emit(frame);
    }
    this.droppedMs += this.#runMs - kept;
    this.#run = [];
    this.#runMs = 0;
  }

  /** Lets out the held pause shortened to about `targetMs`: its first half and its last half, the middle dropped. */
  #flush(targetMs: number, emit: (frame: AudioFrame) => void): void {
    const run = this.#run;
    this.#run = [];
    const runMs = this.#runMs;
    this.#runMs = 0;
    if (targetMs >= runMs) {
      for (const frame of run) emit(frame);
      return;
    }
    const keep = Math.round((targetMs / runMs) * run.length);
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const kept = [...run.slice(0, head), ...run.slice(run.length - tail)];
    for (const frame of kept) emit(frame);
    this.droppedMs += runMs - kept.reduce((ms, f) => ms + frameMs(f), 0);
  }
}

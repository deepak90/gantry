/**
 * The call's subtitles, as the call bar shows them: one speaker at a time, with their consecutive lines run
 * together, so a sentence the transcriber cut in two ("Remy, can you add the lights to the plan?" … "All three
 * floors.") reads as one. Whoever starts speaking next takes over. Someone else's line that was already under way
 * when they did (Remy's voice finishing the word she was cut off in, a late transcript) doesn't take it back.
 * Someone can take the floor before any of their words are in (`floor`): the caption is theirs from then.
 *
 * Plain data in, plain data out: the call's captions (`lk.transcription`, see session.ts) go in as they grow.
 */
import type { Caption } from './session';

export interface Subtitle {
  /** Whose words: their identity on the call. */
  identity: string;
  /** Everything they have said since they took over, oldest first. */
  text: string;
  /** Their latest line alone: while it isn't final, its last words may still change. */
  last: string;
  final: boolean;
}

/**
 * A line's words as a caption shows them: no punctuation before the first word (a line handed to Remy's voice can
 * start with the stop that ended the words she said before it).
 */
export const captionWords = (text: string): string => text.replace(/^[\s.,;:!?…-]+/, '').trim();

/** How many lines' start times are remembered (a line already shown is never looked up again after a while). */
const REMEMBERED = 64;

interface Run {
  identity: string;
  /** Their lines in the order they started, by segment id. */
  lines: Map<string, { text: string; final: boolean }>;
  /** When their latest line started. */
  latest: number;
}

export class Subtitles {
  private run: Run | null = null;
  /** When each line was first heard of. */
  private readonly started = new Map<string, number>();

  /**
   * Takes a caption as it grows. Returns what the bar shows now, or null when this caption doesn't change it (an
   * older line of someone else's, still coming in after another speaker took over).
   */
  take(caption: Pick<Caption, 'segmentId' | 'identity' | 'text' | 'final'>, now = Date.now()): Subtitle | null {
    let started = this.started.get(caption.segmentId);
    if (started === undefined) {
      started = now;
      this.started.set(caption.segmentId, now);
      if (this.started.size > REMEMBERED) this.started.delete(this.started.keys().next().value!);
    }
    const line = { text: captionWords(caption.text), final: caption.final };
    const run = this.run;
    if (run && run.identity === caption.identity) {
      run.lines.set(caption.segmentId, line);
      run.latest = Math.max(run.latest, started);
    } else {
      if (run && started < run.latest) return null;
      this.run = { identity: caption.identity, lines: new Map([[caption.segmentId, line]]), latest: started };
    }
    return this.current();
  }

  /**
   * Someone started talking: the caption is theirs from now, before any of their words are in, and a line of someone
   * else's that started before now doesn't take it back.
   */
  floor(identity: string, now = Date.now()): Subtitle {
    // Half a millisecond on: a line first seen in the same millisecond was seen before the floor was taken.
    if (this.run?.identity !== identity) this.run = { identity, lines: new Map(), latest: now + 0.5 };
    return this.current()!;
  }

  /** What the bar shows now (no words yet, for someone who has just taken the floor); null before anyone spoke. */
  current(): Subtitle | null {
    const run = this.run;
    if (!run) return null;
    const lines = [...run.lines.values()];
    const last = lines.at(-1);
    return {
      identity: run.identity,
      text: lines
        .map((line) => line.text)
        .filter(Boolean)
        .join(' '),
      last: last?.text ?? '',
      final: last?.final ?? false,
    };
  }

  /** The bar went quiet: whoever speaks next starts afresh. */
  clear(): void {
    this.run = null;
  }
}

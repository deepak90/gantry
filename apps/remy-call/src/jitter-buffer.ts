/**
 * A line's sound on its way to the room. OpenAI streams a line in bursts: the first 60–200 ms, then a pause of
 * 300–500 ms, then the rest at 5–8 times real time. Played the moment it arrived, a line ran dry in that pause: in 17
 * of 24 measured lines, for up to 290 ms, often mid-word. The jitter buffer holds a line's first frames until 400 ms of
 * sound is in hand (or the whole line, when it ends sooner), then lets everything through as it comes; from there the
 * sound stays ahead of playback. In the same 24 lines it never ran dry, and her first word came about 280 ms later.
 */
import { ReadableStream } from 'node:stream/web';
import type { AudioFrame } from '@livekit/rtc-node';

const frameMs = (frame: AudioFrame) => (frame.samplesPerChannel / frame.sampleRate) * 1000;

export class JitterBuffer {
  readonly prerollMs: number;
  #held: AudioFrame[] = [];
  #heldMs = 0;
  #open = false;

  constructor(prerollMs: number) {
    this.prerollMs = prerollMs;
  }

  /** Playback may start: the preroll filled, or the line ended. */
  get open(): boolean {
    return this.#open;
  }

  /** Sound held so far, in ms (what was in hand when it opened). */
  get heldMs(): number {
    return this.#heldMs;
  }

  /** The frames to play now: none while it fills, then the held ones at once, then each as it comes. */
  push(frame: AudioFrame): AudioFrame[] {
    if (this.#open) return [frame];
    this.#held.push(frame);
    this.#heldMs += frameMs(frame);
    return this.#heldMs >= this.prerollMs ? this.#release() : [];
  }

  /** The line ended: whatever is still held. */
  end(): AudioFrame[] {
    return this.#open ? [] : this.#release();
  }

  #release(): AudioFrame[] {
    this.#open = true;
    const out = this.#held;
    this.#held = [];
    return out;
  }
}

export interface BufferedLineEvents {
  /** Playback may start, with `heldMs` of sound in hand; `whole` when the line ended before the preroll filled. */
  onOpen?(info: { heldMs: number; whole: boolean }): void;
  /** The source ended: `audioMs` of sound came; `error` when it failed (not when it was cut off). */
  onEnd?(info: { audioMs: number; error: unknown }): void;
}

/**
 * One line's frames as a stream for `session.say(text, { audio })`, behind a jitter buffer. The source runs from the
 * moment this is called, whether or not anyone reads yet. Cancelling the stream (a barge-in, a closing session) aborts
 * `abort`, which is meant to stop the source. A source that fails mid-line plays what came and ends there.
 */
export function bufferedLine(source: AsyncIterable<AudioFrame>, prerollMs: number, abort: AbortController, events: BufferedLineEvents = {}): ReadableStream<AudioFrame> {
  const buffer = new JitterBuffer(prerollMs);
  let cancelled = false;
  let opened = false;
  return new ReadableStream<AudioFrame>({
    start(controller) {
      const play = (frames: AudioFrame[], whole: boolean) => {
        if (cancelled || !frames.length) return;
        if (!opened) {
          opened = true;
          events.onOpen?.({ heldMs: buffer.heldMs, whole });
        }
        for (const frame of frames) controller.enqueue(frame);
      };
      void (async () => {
        let audioMs = 0;
        let error: unknown = null;
        try {
          for await (const frame of source) {
            if (cancelled) break;
            audioMs += frameMs(frame);
            play(buffer.push(frame), false);
          }
        } catch (caught) {
          if (!abort.signal.aborted && !cancelled) error = caught;
        }
        if (!cancelled) {
          play(buffer.end(), true);
          controller.close();
        }
        events.onEnd?.({ audioMs, error });
      })();
    },
    cancel() {
      cancelled = true;
      abort.abort();
    },
  });
}

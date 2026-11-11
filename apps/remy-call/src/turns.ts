/**
 * Turns from one person's voice activity and transcripts. The transcriber gives a final per
 * stretch of speech, and "Remy, … [pause] … can you" can arrive as two. A turn is every final
 * since the last turn, handed over once the voice detector says the person stopped, they stayed
 * quiet a little longer, and the final for their last stretch is in. A pause short enough that
 * they resume before that keeps one turn. A turn that may not be over (`holdOpen`, say "Remy,
 * you on?") waits up to TURN_CONTINUE_MS after the speech for them to go on. If a final never
 * comes, the turn goes out anyway.
 */
import { END_OF_SPEECH_MS, TURN_CONTINUE_MS, TURN_HOLD_MS, TURN_SAFETY_MS } from './config.ts';

export interface Turn {
  identity: string;
  text: string;
  /** When the voice detector heard the turn start (ms since the epoch). */
  startedAt: number;
  /** When the speech ended: the detector's end minus its silence wait. */
  endedAt: number;
  segments: number;
  reason: 'quiet' | 'final' | 'safety' | 'close';
}

export interface TurnOptions {
  holdMs: number;
  safetyMs: number;
  /** The detector's end-of-speech wait, taken off its end time. */
  endOfSpeechMs: number;
  /** How long after the speech a turn that may not be over waits for more. */
  continueMs: number;
  /** True when the turn so far may not be over. */
  holdOpen: ((text: string) => boolean) | null;
}

const DEFAULTS: TurnOptions = { holdMs: TURN_HOLD_MS, safetyMs: TURN_SAFETY_MS, endOfSpeechMs: END_OF_SPEECH_MS, continueMs: TURN_CONTINUE_MS, holdOpen: null };

export class TurnAssembler {
  #identity: string;
  #onTurn: (turn: Turn) => void;
  #options: TurnOptions;
  #speaking = false;
  #quiet = false;
  #turnStartedAt: number | null = null;
  #speechEndedAt: number | null = null;
  #lastFinalAt = 0;
  #parts: string[] = [];
  #hold: ReturnType<typeof setTimeout> | null = null;
  #safety: ReturnType<typeof setTimeout> | null = null;
  #continue: ReturnType<typeof setTimeout> | null = null;

  constructor(identity: string, onTurn: (turn: Turn) => void, options: Partial<TurnOptions> = {}) {
    this.#identity = identity;
    this.#onTurn = onTurn;
    this.#options = { ...DEFAULTS, ...options };
  }

  /** The person is talking now. */
  get speaking(): boolean {
    return this.#speaking;
  }

  /** The detector heard speech start (`at`: its event time). */
  speechStarted(at: number = Date.now()): void {
    this.#speaking = true;
    this.#quiet = false;
    this.#turnStartedAt ??= at;
    this.#clearTimers();
  }

  /** The detector heard speech end (`at`: its event time, after its silence wait). */
  speechEnded(at: number = Date.now()): void {
    if (!this.#speaking) return;
    this.#speaking = false;
    this.#speechEndedAt = at;
    this.#clearTimers();
    this.#hold = setTimeout(() => {
      this.#hold = null;
      this.#quiet = true;
      this.#maybeFlush('quiet');
    }, this.#options.holdMs);
    this.#safety = setTimeout(() => {
      this.#safety = null;
      this.flush('safety');
    }, this.#options.safetyMs);
  }

  /** A final transcript for the stretch that just ended. */
  final(text: string, at: number = Date.now()): void {
    const clean = text.trim();
    if (!clean) return;
    this.#parts.push(clean);
    this.#lastFinalAt = at;
    this.#turnStartedAt ??= at;
    // A final without the detector's start and end around it: don't let it wait forever.
    if (!this.#speaking && !this.#safety && !this.#hold) {
      this.#safety = setTimeout(() => {
        this.#safety = null;
        this.flush('safety');
      }, this.#options.safetyMs);
    }
    this.#maybeFlush('final');
  }

  /** Hands over whatever has been said, now. */
  flush(reason: Turn['reason']): void {
    this.#clearTimers();
    if (!this.#parts.length) return;
    const text = this.#parts.join(' ');
    const segments = this.#parts.length;
    const now = Date.now();
    const endedAt = this.#speechEndedAt !== null ? this.#speechEndedAt - this.#options.endOfSpeechMs : now;
    const startedAt = Math.min(this.#turnStartedAt ?? endedAt, endedAt);
    this.#parts = [];
    this.#turnStartedAt = null;
    this.#onTurn({ identity: this.#identity, text, startedAt, endedAt, segments, reason });
  }

  close(): void {
    this.flush('close');
  }

  #maybeFlush(reason: Turn['reason']): void {
    if (!(this.#quiet && !this.#speaking && this.#parts.length && this.#lastFinalAt > (this.#speechEndedAt ?? 0))) return;
    const { holdOpen, endOfSpeechMs, continueMs } = this.#options;
    if (holdOpen && this.#speechEndedAt !== null && holdOpen(this.#parts.join(' '))) {
      const waitMs = this.#speechEndedAt - endOfSpeechMs + continueMs - Date.now();
      if (waitMs > 0) {
        if (this.#continue) clearTimeout(this.#continue);
        this.#continue = setTimeout(() => {
          this.#continue = null;
          if (!this.#speaking) this.flush(reason);
        }, waitMs);
        return;
      }
    }
    this.flush(reason);
  }

  #clearTimers(): void {
    if (this.#hold) clearTimeout(this.#hold);
    if (this.#safety) clearTimeout(this.#safety);
    if (this.#continue) clearTimeout(this.#continue);
    this.#hold = null;
    this.#safety = null;
    this.#continue = null;
  }
}

/**
 * Fills the silence while the brain works. After an addressed line, if no line for Remy has come
 * 1.2 s after the person stopped talking, Remy says one short filler ("Let me look."). Never when a
 * line arrived first, never while Remy is talking or has a line queued, never two fillers without
 * a real line between them, and not over someone who is talking (it waits briefly, then lets it go).
 * Only fillers whose sound is ready are said (filler-audio.ts checks each one first); none ready, none said.
 *
 * Which one: never the one she said last, nor any of the last half of the set; of the rest, any (pickFiller). So a call
 * starts on any of them, and each comes round again only after at least half of the others.
 */
import { FILLER_AFTER_MS, FILLER_GIVE_UP_MS, FILLER_GRACE_MS, FILLERS, STILL_AFTER_MS, STILL_FILLERS } from './config.ts';

export interface FillerHooks {
  /** Remy is speaking, or a line is on its way. */
  busy(): boolean;
  /** Someone is talking right now. */
  floorTaken(): boolean;
  /** The filler's sound is ready to play; when left out, every filler is. */
  ready?(text: string): boolean;
  play(text: string): void;
}

export interface FillerOptions {
  afterMs: number;
  graceMs: number;
  giveUpMs: number;
  retryMs: number;
  texts: readonly string[];
  /** After a filler, one still-on-it line this much later when no answer has come (0: none). */
  stillAfterMs: number;
  stillTexts: readonly string[];
  /** 0 to 1, for picking among the fillers she hasn't said lately. */
  random: () => number;
}

const DEFAULTS: FillerOptions = {
  afterMs: FILLER_AFTER_MS,
  graceMs: FILLER_GRACE_MS,
  giveUpMs: FILLER_GIVE_UP_MS,
  retryMs: 100,
  texts: FILLERS,
  stillAfterMs: STILL_AFTER_MS,
  stillTexts: STILL_FILLERS,
  random: Math.random,
};

/** When the filler is due: 1.2 s after the line ended, but not before the line was heard plus a short grace. */
export function fillerDueAt(lineEndedAt: number, heardAt: number, options: Pick<FillerOptions, 'afterMs' | 'graceMs'> = DEFAULTS): number {
  return Math.max(lineEndedAt + options.afterMs, heardAt + options.graceMs);
}

/**
 * The next filler: one of those ready that isn't among the last she said (the last one always, and the last half of
 * those ready), at random. Null when every ready one was said too lately, as when only the last one is ready.
 */
export function pickFiller(ready: readonly string[], said: readonly string[], random: () => number = Math.random): string | null {
  const lately = new Set(said.slice(-Math.max(1, Math.floor(ready.length / 2))));
  const fresh = ready.filter((text) => !lately.has(text));
  if (!fresh.length) return null;
  return fresh[Math.min(fresh.length - 1, Math.floor(random() * fresh.length))] ?? null;
}

export class FillerScheduler {
  #hooks: FillerHooks;
  #options: FillerOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #giveUpAt = 0;
  #lastWasFiller = false;
  /** The fillers said on this call, oldest first (a few kept). */
  #said: string[] = [];
  /** The still-on-it line waiting for its moment after a filler, and the ones said on this call. */
  #stillTimer: ReturnType<typeof setTimeout> | null = null;
  #stillGiveUpAt = 0;
  #stillSaid: string[] = [];

  constructor(hooks: FillerHooks, options: Partial<FillerOptions> = {}) {
    this.#hooks = hooks;
    this.#options = { ...DEFAULTS, ...options };
  }

  /** A filler is waiting for its moment. */
  get armed(): boolean {
    return this.#timer !== null;
  }

  /** An addressed line was heard; it ended at `lineEndedAt`. */
  addressed(lineEndedAt: number, now: number = Date.now()): void {
    this.cancel();
    const dueAt = fillerDueAt(lineEndedAt, now, this.#options);
    this.#giveUpAt = dueAt + this.#options.giveUpMs;
    this.#arm(dueAt - now);
  }

  /** A line for Remy arrived: no filler now, and the next addressed line may get one again. */
  lineArrived(): void {
    this.cancel();
    this.#lastWasFiller = false;
  }

  cancel(): void {
    for (const timer of [this.#timer, this.#stillTimer]) if (timer) clearTimeout(timer);
    this.#timer = this.#stillTimer = null;
  }

  #arm(ms: number): void {
    this.#timer = setTimeout(() => this.#fire(), Math.max(0, ms));
  }

  #fire(): void {
    this.#timer = null;
    if (this.#lastWasFiller || this.#hooks.busy()) return;
    if (this.#hooks.floorTaken()) {
      if (Date.now() + this.#options.retryMs <= this.#giveUpAt) this.#arm(this.#options.retryMs);
      return;
    }
    const ready = this.#options.texts.filter((text) => text && (!this.#hooks.ready || this.#hooks.ready(text)));
    const text = pickFiller(ready, this.#said, this.#options.random);
    if (!text) return;
    this.#said = [...this.#said, text].slice(-this.#options.texts.length);
    this.#lastWasFiller = true;
    this.#hooks.play(text);
    // The answer may be long in coming: one more short line, later, if it still hasn't.
    const { stillAfterMs, stillTexts, giveUpMs } = this.#options;
    if (stillAfterMs > 0 && stillTexts.length > 0) {
      this.#stillGiveUpAt = Date.now() + stillAfterMs + giveUpMs;
      this.#stillTimer = setTimeout(() => this.#fireStill(), stillAfterMs);
    }
  }

  #fireStill(): void {
    this.#stillTimer = null;
    if (this.#hooks.busy()) return;
    if (this.#hooks.floorTaken()) {
      if (Date.now() + this.#options.retryMs <= this.#stillGiveUpAt) this.#stillTimer = setTimeout(() => this.#fireStill(), this.#options.retryMs);
      return;
    }
    const ready = this.#options.stillTexts.filter((text) => text && (!this.#hooks.ready || this.#hooks.ready(text)));
    const text = pickFiller(ready, this.#stillSaid, this.#options.random);
    if (!text) return;
    this.#stillSaid = [...this.#stillSaid, text].slice(-this.#options.stillTexts.length);
    this.#hooks.play(text);
  }
}

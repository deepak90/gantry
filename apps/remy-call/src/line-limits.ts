/**
 * How much the host's tab may hand Remy to say. Every line she takes is voiced, and paid for by the character, the
 * moment it is taken, so on the hosted worker (`GANTRY_HOSTED=1`) a call takes at most:
 *
 * - 400 characters a line,
 * - 2,500 characters of answers in all,
 * - 10 lines in any minute,
 * - one line waiting while one plays.
 *
 * A line over a limit is refused before any sound is made of it. Her own lines (a filler, a notice) aren't counted. On
 * a local run only a line's length is limited (SAY_MAX_CHARS).
 */

export interface LineLimitsConfig {
  /** The longest line, in characters. */
  maxLineChars: number;
  /** Characters of answers in one call; Infinity: no limit. */
  maxCallChars: number;
  /** Lines taken in any 60 seconds; Infinity: no limit. */
  linesPerMinute: number;
  /** Answers taken and not done yet (waiting or playing); Infinity: no limit. */
  maxPending: number;
}

export const HOSTED_LINE_LIMITS: Readonly<LineLimitsConfig> = { maxLineChars: 400, maxCallChars: 2500, linesPerMinute: 10, maxPending: 2 };

export function lineLimitsFromEnv(env: Record<string, string | undefined>, sayMaxChars: number): LineLimitsConfig {
  if (env.GANTRY_HOSTED?.trim() === '1') return { ...HOSTED_LINE_LIMITS };
  return { maxLineChars: sayMaxChars, maxCallChars: Infinity, linesPerMinute: Infinity, maxPending: Infinity };
}

/** Why a line wasn't taken. */
export type LineRefusal = 'too long' | 'call budget spent' | 'busy' | 'too many lines';

const MINUTE_MS = 60_000;

/** One call's count of what Remy was handed. */
export class LineBudget {
  readonly config: Readonly<LineLimitsConfig>;
  readonly #now: () => number;
  #chars = 0;
  /** When each line was taken, the last minute's. */
  #takenAt: number[] = [];

  constructor(config: LineLimitsConfig, now: () => number = () => Date.now()) {
    this.config = config;
    this.#now = now;
  }

  /** Characters of answers taken so far in this call. */
  get spent(): number {
    return this.#chars;
  }

  /** Why a line of `chars` characters can't be taken now, with `pending` answers not done yet; null when it can. */
  refusal(chars: number, pending: number): LineRefusal | null {
    const { maxLineChars, maxCallChars, maxPending, linesPerMinute } = this.config;
    if (chars > maxLineChars) return 'too long';
    if (this.#chars + chars > maxCallChars) return 'call budget spent';
    if (pending >= maxPending) return 'busy';
    this.#prune();
    if (this.#takenAt.length >= linesPerMinute) return 'too many lines';
    return null;
  }

  /** Counts a line that was taken. */
  take(chars: number): void {
    this.#chars += chars;
    this.#takenAt.push(this.#now());
    this.#prune();
  }

  #prune(): void {
    const since = this.#now() - MINUTE_MS;
    this.#takenAt = this.#takenAt.filter((at) => at > since);
  }
}

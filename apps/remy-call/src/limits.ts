/**
 * How long Remy stays on a call. Two limits, both off on a local run:
 *
 * - The call's length (`REMY_CALL_MAX_S`): she says a short wrap-up line 30 seconds before the end, and at the end she
 *   leaves and the room is deleted, which ends the call for everyone.
 * - Silence (`REMY_SILENCE_S`): when nobody has spoken for that long, she says goodbye and leaves; the people may stay.
 *
 * With `GANTRY_HOSTED=1` (the hosted worker) they default to 300 and 60 seconds; without it, to 0, which is unlimited,
 * so local runs have no limits. A value set in the environment applies either way.
 */

export interface CallLimitsConfig {
  /** The call's length; 0: unlimited. */
  maxMs: number;
  /** How long before the end the wrap-up line is said; none when the call is that short or shorter. */
  wrapUpMs: number;
  /** How long nobody may speak before she says goodbye; 0: never. */
  silenceMs: number;
}

export const HOSTED_CALL_MAX_S = 300;
export const HOSTED_SILENCE_S = 60;
export const WRAP_UP_BEFORE_MS = 30_000;

/** The limits from the environment, and any value that was set but isn't a number of seconds (it is ignored). */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): { limits: CallLimitsConfig; ignored: string[] } {
  const hosted = env.GANTRY_HOSTED?.trim() === '1';
  const ignored: string[] = [];
  const seconds = (name: string, fallback: number): number => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    ignored.push(name);
    return fallback;
  };
  return {
    limits: {
      maxMs: Math.round(seconds('REMY_CALL_MAX_S', hosted ? HOSTED_CALL_MAX_S : 0) * 1000),
      wrapUpMs: WRAP_UP_BEFORE_MS,
      silenceMs: Math.round(seconds('REMY_SILENCE_S', hosted ? HOSTED_SILENCE_S : 0) * 1000),
    },
    ignored,
  };
}

export interface CallLimitsHooks {
  /** Someone is talking, Remy is, or a line for her is on its way: it isn't silence. */
  busy(): boolean;
  /** Thirty seconds left: say the wrap-up line. */
  wrapUp(): void;
  /** The call's time is up: leave, and end the call. */
  timeUp(): void;
  /** Nobody has spoken for the silence limit: say goodbye and leave. */
  silence(): void;
}

/**
 * The clocks of one call. `start()` when Remy is ready; `activity()` whenever someone speaks or she does. At most one of
 * timeUp and silence fires, once; nothing fires after it, or after `stop()`.
 */
export class CallLimits {
  readonly #config: CallLimitsConfig;
  readonly #hooks: CallLimitsHooks;
  #wrapUpTimer: ReturnType<typeof setTimeout> | null = null;
  #endTimer: ReturnType<typeof setTimeout> | null = null;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #over = false;
  #endsAt: number | null = null;

  constructor(config: CallLimitsConfig, hooks: CallLimitsHooks) {
    this.#config = config;
    this.#hooks = hooks;
  }

  get over(): boolean {
    return this.#over;
  }

  /** When the call's time runs out (ms since the epoch), from `start()` on; null for a call without a time limit. */
  get endsAt(): number | null {
    return this.#endsAt;
  }

  start(): void {
    if (this.#started || this.#over) return;
    this.#started = true;
    const { maxMs, wrapUpMs } = this.#config;
    if (maxMs > 0) {
      this.#endsAt = Date.now() + maxMs;
      if (wrapUpMs > 0 && maxMs > wrapUpMs) {
        this.#wrapUpTimer = setTimeout(() => {
          this.#wrapUpTimer = null;
          if (!this.#over) this.#hooks.wrapUp();
        }, maxMs - wrapUpMs);
      }
      this.#endTimer = setTimeout(() => {
        this.#endTimer = null;
        this.#finish(() => this.#hooks.timeUp());
      }, maxMs);
    }
    this.#listen();
  }

  /** Someone spoke, or Remy did: the silence clock starts again. */
  activity(): void {
    if (this.#started && !this.#over) this.#listen();
  }

  stop(): void {
    this.#over = true;
    this.#clear();
  }

  #listen(): void {
    const { silenceMs } = this.#config;
    if (silenceMs <= 0) return;
    if (this.#silenceTimer) clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => {
      this.#silenceTimer = null;
      if (this.#over) return;
      // Talk under way when the clock runs out: it isn't silence, so the clock starts again.
      if (this.#hooks.busy()) this.#listen();
      else this.#finish(() => this.#hooks.silence());
    }, silenceMs);
  }

  #finish(fire: () => void): void {
    if (this.#over) return;
    this.#over = true;
    this.#clear();
    fire();
  }

  #clear(): void {
    for (const timer of [this.#wrapUpTimer, this.#endTimer, this.#silenceTimer]) if (timer) clearTimeout(timer);
    this.#wrapUpTimer = this.#endTimer = this.#silenceTimer = null;
  }
}

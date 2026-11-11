/**
 * Time for the presence layer, injectable so tests drive throttles, heartbeats and expiry by hand.
 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Throttled<T> {
  /** Sends now if the interval has passed, else once at the end of it with the latest value. */
  push(value: T): void;
  /** Sends a waiting value now. */
  flush(): void;
  /** Drops a waiting value. */
  cancel(): void;
}

/** Leading and trailing throttle: the first value goes at once, the last one is never lost. */
export function throttle<T>(intervalMs: number, send: (value: T) => void, clock: Clock = systemClock): Throttled<T> {
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let waiting: { value: T } | null = null;

  const fire = () => {
    timer = null;
    if (!waiting) return;
    const { value } = waiting;
    waiting = null;
    last = clock.now();
    send(value);
  };

  return {
    push(value) {
      waiting = { value };
      if (timer !== null) return;
      const wait = last + intervalMs - clock.now();
      if (wait <= 0) fire();
      else timer = clock.setTimeout(fire, wait);
    },
    flush() {
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      fire();
    },
    cancel() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      waiting = null;
    },
  };
}

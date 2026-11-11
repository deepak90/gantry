/**
 * The call this page is on, for the walkthrough: what Remy's ears heard
 * (`hear`), Remy's voice (`say`, the host's tab only), and whether the host's tab says Remy's answers
 * from the thread by itself. The call panel sets it while it is on screen (the dev server, with `?call`).
 */
import type { Heard, HeardMatcher } from './protocol';
import type { CallSession } from './session';

export interface LiveCall {
  session: CallSession;
  hear(identity: string | null, matcher?: HeardMatcher, options?: { signal?: AbortSignal; since?: number; timeoutMs?: number }): Promise<Heard>;
  say(text: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ id: string; interrupted: boolean }>;
  /** On by default: the host's tab hands each spoken answer in the thread to Remy's voice. */
  speakReplies(on: boolean): void;
}

let current: LiveCall | null = null;
const listeners = new Set<(call: LiveCall | null) => void>();

export const liveCall = {
  get(): LiveCall | null {
    return current;
  },
  set(call: LiveCall | null): void {
    if (call === current) return;
    current = call;
    for (const listener of [...listeners]) listener(call);
  },
  subscribe(listener: (call: LiveCall | null) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

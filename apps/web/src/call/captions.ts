/**
 * Whether the call bar shows captions: on unless this person turned them off with CC on the bar. Kept in this
 * browser (the choice is theirs, per device); a browser that keeps nothing starts with them on every time.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'collab.call.captions';

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

let on: boolean | null = null;
const listeners = new Set<() => void>();

export const captionsShown = {
  get(): boolean {
    on ??= read();
    return on;
  },
  set(next: boolean): void {
    if (next === captionsShown.get()) return;
    on = next;
    try {
      if (next) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, 'off');
    } catch {
      // Kept for this page only.
    }
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Whether captions are on, and how to change it. */
export function useCaptionsShown(): [boolean, (on: boolean) => void] {
  const shown = useSyncExternalStore(captionsShown.subscribe, captionsShown.get, () => true);
  return [shown, captionsShown.set];
}

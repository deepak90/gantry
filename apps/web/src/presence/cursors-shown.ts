/**
 * Whether other people's cursors show: their pointers and the name tags that go with them. Shown when the
 * page opens, so a plan full of people looks full of people; the View menu and Remy can put them away to
 * clear the screen. It is this screen's own choice: it isn't kept, and nobody else's screen changes.
 * Hidden cursors are a class on the page (`cursors-hidden`), which presence.css reads.
 */
import { useSyncExternalStore } from 'react';

let shown = true;
const listeners = new Set<() => void>();

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('cursors-hidden', !shown);
}

export const cursors = {
  get shown(): boolean {
    return shown;
  },
  show(on: boolean): void {
    if (on === shown) return;
    shown = on;
    apply();
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Whether others' cursors show, and a way to show or hide them. */
export function useCursorsShown(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(cursors.subscribe, () => shown);
  return [value, cursors.show];
}

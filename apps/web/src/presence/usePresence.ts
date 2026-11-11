import { useCallback, useSyncExternalStore } from 'react';
import type { PresenceSession, PresenceSnapshot } from './session';

const NOTHING = () => () => undefined;

/** The presence session's current state, re-rendering when it changes; null without a session. */
export function usePresenceSnapshot(session: PresenceSession | null): PresenceSnapshot | null {
  const subscribe = useCallback((listener: () => void) => (session ? session.subscribe(listener) : NOTHING()), [session]);
  const read = useCallback(() => session?.getSnapshot() ?? null, [session]);
  return useSyncExternalStore(subscribe, read, read);
}

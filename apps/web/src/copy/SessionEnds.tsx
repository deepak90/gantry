/**
 * "This session ends in 8 min", in the header beside the invite and Start over, in the session's last 10 minutes only.
 * The lease is kept 30 minutes ahead while someone looks at the session, up to 2 hours after it started, so this shows
 * near the 2 hours (or after the tab was hidden a long while).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { sessionEndsText, type LeaseClock } from './lease';
import '../styles/copy.css';

export function SessionEnds({ clock, now: clockNow = Date.now }: { clock: LeaseClock; now?: () => number }) {
  const until = useSyncExternalStore(clock.subscribe, clock.get);
  const [now, setNow] = useState(clockNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(clockNow()), 15_000);
    return () => clearInterval(timer);
  }, [clockNow]);
  const text = sessionEndsText(until, now);
  if (!text) return null;
  return (
    <span className="copy-ends" role="status" data-testid="session-ends">
      <i className="fa fa-clock" aria-hidden="true" />
      {text}
    </span>
  );
}

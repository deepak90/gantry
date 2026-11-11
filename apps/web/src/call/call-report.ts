/**
 * A call, as the hosted site counts it: `call_started` once this tab is on it with its people known, and
 * `call_ended` when it leaves (or the page goes), with how long it lasted, the most people on it at once and whether
 * Remy came. Remy and a recording participant aren't people. A call that couldn't start, or that dropped, is an `error`.
 */
import type { ReportProps } from '../copy/report';
import type { CallSnapshot } from './session';
import { humansOf } from './view';

export interface WatchedCall {
  subscribe(listener: () => void): () => void;
  readonly snapshot: CallSnapshot;
}

export type CallReporter = (event: 'call_started' | 'call_ended' | 'error', props: ReportProps) => void;

const onCall = (snapshot: CallSnapshot) => snapshot.status === 'connected' || snapshot.status === 'reconnecting';

/** Reports this tab's calls until the returned stop (which ends a call still going). */
export function reportCalls(call: WatchedCall, send: CallReporter, now: () => number = () => Date.now()): () => void {
  let startedAt: number | null = null;
  let most = 0;
  let remy = false;
  let failed: string | null = null;
  const end = () => {
    if (startedAt === null) return;
    send('call_ended', { duration_s: Math.max(0, Math.round((now() - startedAt) / 1000)), people: most, remy });
    startedAt = null;
    most = 0;
    remy = false;
  };
  const check = () => {
    const snapshot = call.snapshot;
    const failure = snapshot.status === 'failed' ? (snapshot.error ?? 'The call failed.') : null;
    if (failure && failure !== failed) send('error', { where: 'call', message: failure.slice(0, 160) });
    failed = failure;
    if (!onCall(snapshot)) return end();
    const people = humansOf(snapshot.people).length;
    // Just connected, the people come a moment later: this tab's own person is always one of them.
    if (people === 0) return;
    remy ||= snapshot.remy !== null;
    if (startedAt === null) {
      startedAt = now();
      most = people;
      send('call_started', { people });
      return;
    }
    most = Math.max(most, people);
  };
  const stop = call.subscribe(check);
  check();
  return () => {
    stop();
    end();
  };
}

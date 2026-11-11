/**
 * The hosted site counts a call when this tab is on it with its people known, and its end with how long it lasted,
 * the most people on it at once and whether Remy came.
 */
import { describe, expect, it } from 'vitest';
import { reportCalls, type WatchedCall } from '../../src/call/call-report';
import type { CallSnapshot } from '../../src/call/session';
import type { CallPerson } from '../../src/call/view';

const person = (identity: string, extra: Partial<CallPerson> = {}): CallPerson => ({
  identity,
  name: identity,
  color: '#2563eb',
  role: 'cm',
  sim: false,
  isRemy: false,
  isLocal: false,
  speaking: false,
  micOn: true,
  joinedAt: 1,
  ...extra,
});

function fakeCall() {
  let listener: (() => void) | null = null;
  const call = {
    snapshot: { status: 'idle', error: null, mic: 'off', micError: null, me: 'me', people: [], remy: null, remyStuck: false, host: null, captions: [], audioBlocked: false, endsAt: null } as CallSnapshot,
    subscribe(next: () => void) {
      listener = next;
      return () => {
        listener = null;
      };
    },
  } satisfies WatchedCall;
  return {
    call,
    set(patch: Partial<CallSnapshot>) {
      call.snapshot = { ...call.snapshot, ...patch };
      listener?.();
    },
  };
}

describe('reportCalls', () => {
  it('reports the start once the people are known, and the end with its length, the most people and Remy', () => {
    let now = 1_000_000;
    const sent: [string, unknown][] = [];
    const fake = fakeCall();
    const stop = reportCalls(fake.call, (event, props) => void sent.push([event, props]), () => now);

    fake.set({ status: 'joining' });
    fake.set({ status: 'connected' });
    expect(sent).toEqual([]);
    fake.set({ people: [person('me', { isLocal: true })] });
    expect(sent).toEqual([['call_started', { people: 1 }]]);

    now += 30_000;
    fake.set({ people: [person('me', { isLocal: true }), person('chris'), person('remy', { isRemy: true })], remy: 'listening' });
    fake.set({ status: 'reconnecting' });
    now += 95_400;
    fake.set({ status: 'idle', people: [], remy: null });
    expect(sent).toEqual([
      ['call_started', { people: 1 }],
      ['call_ended', { duration_s: 125, people: 2, remy: true }],
    ]);
    stop();
    expect(sent).toHaveLength(2);
  });

  it('ends a call still going when the page goes', () => {
    const sent: [string, unknown][] = [];
    const fake = fakeCall();
    const stop = reportCalls(fake.call, (event, props) => void sent.push([event, props]), () => 0);
    fake.set({ status: 'connected', people: [person('me', { isLocal: true })] });
    stop();
    expect(sent.map(([event]) => event)).toEqual(['call_started', 'call_ended']);
  });

  it('counts a call that never connected as an error, once, and not as a call', () => {
    const sent: [string, unknown][] = [];
    const fake = fakeCall();
    reportCalls(fake.call, (event, props) => void sent.push([event, props]));
    fake.set({ status: 'joining' });
    fake.set({ status: 'failed', error: 'The call isn’t available: Remy is on three calls.' });
    fake.set({ mic: 'off' });
    expect(sent).toEqual([['error', { where: 'call', message: 'The call isn’t available: Remy is on three calls.' }]]);
  });
});

import { describe, expect, it } from 'vitest';
import { throttle } from '../../src/presence/clock';
import { RemoteCursors } from '../../src/presence/cursors';
import { followTarget, followersOf, initialsOf, peersFromPresence } from '../../src/presence/peers';
import {
  cursorMessageSchema,
  fromLocalDateTime,
  peerSchema,
  presenceTopic,
  sameView,
  toLocalDateTime,
  viewFrameSchema,
} from '../../src/presence/protocol';
import { FakeClock, VIEW, peer } from './helpers';

describe('presence protocol', () => {
  it('names the private project topic the realtime policies allow', () => {
    expect(presenceTopic('00000000-0000-4000-8000-000000000001')).toBe('project:00000000-0000-4000-8000-000000000001:presence');
  });

  it('round-trips wall-clock dates without a zone', () => {
    const date = new Date(2026, 11, 11, 9, 30, 5);
    expect(toLocalDateTime(date)).toBe('2026-12-11T09:30:05');
    expect(fromLocalDateTime('2026-12-11T09:30:05')?.getTime()).toBe(date.getTime());
    expect(fromLocalDateTime('2026-02-30T00:00:00')).toBeNull();
    expect(fromLocalDateTime('2026-12-11T09:30:05Z')).toBeNull();
    expect(fromLocalDateTime('yesterday')).toBeNull();
  });

  it('accepts well-formed pointers and frames and refuses anything else', () => {
    expect(cursorMessageSchema.safeParse({ session: 's1', seq: 3, point: { kind: 'timeline', taskId: 15, date: '2026-12-11T00:00:00', dy: 0.4 } }).success).toBe(true);
    expect(cursorMessageSchema.safeParse({ session: 's1', seq: 3, point: { kind: 'grid', taskId: 15, column: 'schedule-when', dx: 0.1, dy: 1 } }).success).toBe(true);
    expect(cursorMessageSchema.safeParse({ session: 's1', seq: 4, point: null }).success).toBe(true);
    // Phantom (string) ids, pixel positions, offsets outside the row and unknown kinds are refused.
    expect(cursorMessageSchema.safeParse({ session: 's1', seq: 3, point: { kind: 'timeline', taskId: '_generated1', date: '2026-12-11T00:00:00', dy: 0.4 } }).success).toBe(false);
    expect(cursorMessageSchema.safeParse({ session: 's1', seq: 3, point: { kind: 'timeline', taskId: 15, date: '2026-12-11T00:00:00', dy: 1.4 } }).success).toBe(false);
    expect(cursorMessageSchema.safeParse({ session: 's1', seq: 3, point: { kind: 'pixels', x: 10, y: 20 } }).success).toBe(false);
    expect(viewFrameSchema.safeParse({ ...VIEW, session: 's1', seq: 0, revision: 12 }).success).toBe(true);
    expect(viewFrameSchema.safeParse({ ...VIEW, session: 's1', seq: 0 }).success).toBe(false);
    expect(viewFrameSchema.safeParse({ ...VIEW, session: 's1', seq: 0, revision: 1, selected: Array.from({ length: 51 }, (_, i) => i) }).success).toBe(false);
    expect(peerSchema.safeParse({ ...peer('a'), color: 'red' }).success).toBe(false);
    expect(peerSchema.safeParse({ ...peer('a'), role: 'admin' }).success).toBe(false);
  });

  it('treats a view as unchanged when only noise moved', () => {
    expect(sameView(VIEW, { ...VIEW, anchor: { taskId: 15, dy: 0.51 } })).toBe(true);
    expect(sameView(VIEW, { ...VIEW, anchor: { taskId: 15, dy: 0.6 } })).toBe(false);
    expect(sameView(VIEW, { ...VIEW, center: '2026-12-12T12:00:00' })).toBe(false);
    expect(sameView(VIEW, { ...VIEW, preset: 'collab-weeks' })).toBe(false);
    expect(sameView(VIEW, { ...VIEW, selected: [15, 16] })).toBe(false);
    expect(sameView(null, null)).toBe(true);
    expect(sameView(VIEW, null)).toBe(false);
  });
});

describe('peers', () => {
  it('reads one entry per tab from the presence state, skipping forged and malformed metas', () => {
    const peers = peersFromPresence({
      b: [peer('b', { since: 20 })],
      a: [peer('a', { since: 10, taskId: 1 }), peer('a', { since: 10, taskId: 2 })],
      forged: [peer('someone-else')],
      broken: [{ session: 'broken', name: 42 }],
      partly: [peer('partly', { since: 30 }), { session: 'partly' }],
    });
    expect(peers.map((p) => p.session)).toEqual(['a', 'b', 'partly']);
    // The last valid meta of a key wins.
    expect(peers[0]?.taskId).toBe(2);
  });

  it('follows the person who drives the view, never back into oneself', () => {
    const peers = [peer('me'), peer('a', { following: 'b' }), peer('b', { following: 'c' }), peer('c'), peer('d', { following: 'me' }), peer('e', { following: 'gone' })];
    expect(followTarget(peers, 'me', 'c')).toEqual({ target: peers[3] });
    expect(followTarget(peers, 'me', 'a')).toEqual({ target: peers[3] });
    expect(followTarget(peers, 'me', 'd')).toEqual({ refused: 'loop' });
    expect(followTarget(peers, 'me', 'me')).toEqual({ refused: 'self' });
    expect(followTarget(peers, 'me', 'nobody')).toEqual({ refused: 'absent' });
    // Following somebody who follows a tab that has gone: they are looking at their own view.
    expect(followTarget(peers, 'me', 'e')).toEqual({ target: peers[5] });
    expect(followersOf(peers, 'b').map((p) => p.session)).toEqual(['a']);
  });

  it('stops walking a chain that loops without this tab in it', () => {
    const peers = [peer('me'), peer('a', { following: 'b' }), peer('b', { following: 'a' })];
    expect('target' in followTarget(peers, 'me', 'a')).toBe(true);
  });

  it('makes two-letter initials', () => {
    expect(initialsOf('Chris Morgan')).toBe('CM');
    expect(initialsOf('priya')).toBe('P');
    expect(initialsOf('  Ana Maria de la Cruz ')).toBe('AM');
    expect(initialsOf('')).toBe('?');
  });
});

describe('throttle', () => {
  it('sends the first value at once and the last one at the end of the interval', () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const throttled = throttle<number>(50, (value) => sent.push(value), clock);
    throttled.push(1);
    throttled.push(2);
    throttled.push(3);
    expect(sent).toEqual([1]);
    clock.advance(49);
    expect(sent).toEqual([1]);
    clock.advance(1);
    expect(sent).toEqual([1, 3]);
    clock.advance(500);
    throttled.push(4);
    expect(sent).toEqual([1, 3, 4]);
  });

  it('keeps to the rate under a continuous stream: 20 a second at 50 ms', () => {
    const clock = new FakeClock();
    let count = 0;
    const throttled = throttle<number>(50, () => count++, clock);
    for (let ms = 0; ms < 1_000; ms += 5) {
      throttled.push(ms);
      clock.advance(5);
    }
    expect(count).toBeGreaterThanOrEqual(19);
    expect(count).toBeLessThanOrEqual(21);
  });

  it('flushes and cancels a waiting value', () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const throttled = throttle<number>(50, (value) => sent.push(value), clock);
    throttled.push(1);
    throttled.push(2);
    throttled.flush();
    expect(sent).toEqual([1, 2]);
    throttled.push(3);
    throttled.cancel();
    clock.advance(100);
    expect(sent).toEqual([1, 2]);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('remote cursors', () => {
  const at = (taskId: number) => ({ kind: 'timeline' as const, taskId, date: '2026-12-11T00:00:00', dy: 0.5 });

  it('keeps the newest position of each sender, in the order they were sent', () => {
    const cursors = new RemoteCursors();
    expect(cursors.receive({ session: 'a', seq: 2, point: at(2) }, 0)).toBe(true);
    // An older move that arrives late is ignored.
    expect(cursors.receive({ session: 'a', seq: 1, point: at(1) }, 1)).toBe(false);
    expect(cursors.receive({ session: 'b', seq: 0, point: at(9) }, 1)).toBe(true);
    expect(cursors.list().map((c) => [c.session, c.point.taskId])).toEqual([
      ['a', 2],
      ['b', 9],
    ]);
  });

  it('hides a pointer that left the plan, and does not let a late move bring it back', () => {
    const cursors = new RemoteCursors();
    cursors.receive({ session: 'a', seq: 1, point: at(1) }, 0);
    expect(cursors.receive({ session: 'a', seq: 3, point: null }, 1)).toBe(true);
    expect(cursors.receive({ session: 'a', seq: 2, point: at(2) }, 2)).toBe(false);
    expect(cursors.size).toBe(0);
  });

  it('forgets quiet pointers after the time to live and senders that left', () => {
    const cursors = new RemoteCursors();
    cursors.receive({ session: 'a', seq: 0, point: at(1) }, 0);
    cursors.receive({ session: 'b', seq: 0, point: at(2) }, 4_000);
    expect(cursors.prune(4_999, 5_000)).toBe(false);
    expect(cursors.prune(5_000, 5_000)).toBe(true);
    expect(cursors.list().map((c) => c.session)).toEqual(['b']);
    expect(cursors.retain(new Set(['a']))).toBe(true);
    expect(cursors.size).toBe(0);
    // A sender that comes back with a new tab starts over.
    expect(cursors.receive({ session: 'b', seq: 0, point: at(3) }, 6_000)).toBe(true);
  });
});

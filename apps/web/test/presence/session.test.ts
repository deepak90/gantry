/**
 * Several tabs over one in-memory presence channel, each with a fake plan and a hand-driven clock:
 * who is here, pointers, and follow mode end to end (request, frames, ordering, revision gating,
 * taking over, leaving, chains, loops, lost frames), including the absence of a feedback loop.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import { anchorTaskId, type CursorPoint } from '../../src/presence/protocol';
import { PresenceSession } from '../../src/presence/session';
import { FakeClock, FakeViewport } from './helpers';

interface Tab {
  session: PresenceSession;
  viewport: FakeViewport;
  renders: () => number;
}

let hub: InMemoryPresenceHub;
let clock: FakeClock;
let tabs: Tab[];

function open(id: string, name: string, color = '#2563eb'): Tab {
  const session = new PresenceSession({
    self: { session: id, user: `user-${id}`, name, color, role: id === 'cm' ? 'cm' : 'pm' },
    transport: hub.connect(id),
    clock,
  });
  let renders = 0;
  session.subscribe(() => renders++);
  const viewport = new FakeViewport();
  session.attachViewport(viewport);
  session.start();
  const tab = { session, viewport, renders: () => renders };
  tabs.push(tab);
  return tab;
}

/** Lets every queued message through, and the throttles' trailing sends after them. */
function settle(ms = 300) {
  for (let i = 0; i < 5; i++) {
    hub.flush();
    clock.advance(ms / 5);
  }
  hub.flush();
}

const pointer = (taskId: number): CursorPoint => ({ kind: 'timeline', taskId, date: '2026-12-11T10:00:00', dy: 0.25 });

describe('PresenceSession', () => {
  afterEach(() => {
    for (const tab of tabs) tab.session.dispose();
  });

  function setup() {
    hub = new InMemoryPresenceHub();
    clock = new FakeClock();
    tabs = [];
    const pm = open('pm', 'Priya Mehta', '#2563eb');
    clock.advance(10);
    const cm = open('cm', 'Chris Morgan', '#d97706');
    settle();
    return { pm, cm };
  }

  it('shows everyone else who is here, oldest first, and what they have selected', () => {
    const { pm, cm } = setup();
    expect(pm.session.getSnapshot().status).toBe('connected');
    expect(pm.session.getSnapshot().peers.map((p) => p.name)).toEqual(['Chris Morgan']);
    expect(cm.session.getSnapshot().peers.map((p) => p.name)).toEqual(['Priya Mehta']);
    cm.session.setSelectedTask(15);
    settle();
    expect(pm.session.getSnapshot().peers[0]?.taskId).toBe(15);
    // A third tab of the same person is a separate presence.
    open('pm-2', 'Priya Mehta');
    settle();
    expect(cm.session.getSnapshot().peers.map((p) => p.session)).toEqual(['pm', 'pm-2']);
  });

  it('carries pointers at most 20 a second, hides them when they leave the plan or go quiet', () => {
    const { pm, cm } = setup();
    for (let i = 0; i < 100; i++) {
      cm.session.moveCursor(pointer(200 + (i % 3)));
      clock.advance(5);
      hub.flush();
    }
    settle();
    // 500 ms of moves.
    expect(hub.sent.cursor).toBeGreaterThanOrEqual(9);
    expect(hub.sent.cursor).toBeLessThanOrEqual(12);
    const seen = pm.session.getSnapshot().cursors;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ session: 'cm', point: { kind: 'timeline', taskId: 200 + (99 % 3) } });

    cm.session.moveCursor(null);
    settle();
    expect(pm.session.getSnapshot().cursors).toHaveLength(0);

    cm.session.moveCursor(pointer(15));
    settle();
    expect(pm.session.getSnapshot().cursors).toHaveLength(1);
    clock.advance(5_100);
    expect(pm.session.getSnapshot().cursors).toHaveLength(0);
    // Nobody sees their own pointer.
    expect(cm.session.getSnapshot().cursors).toHaveLength(0);
  });

  it('drops the pointer of someone who closes the tab', () => {
    const { pm, cm } = setup();
    cm.session.moveCursor(pointer(15));
    settle();
    expect(pm.session.getSnapshot().cursors).toHaveLength(1);
    hub.drop('cm');
    settle();
    expect(pm.session.getSnapshot().peers).toHaveLength(0);
    expect(pm.session.getSnapshot().cursors).toHaveLength(0);
  });

  it('follows: the view arrives at once, then every move, and the follower never sends one back', () => {
    const { pm, cm } = setup();
    cm.viewport.move({ preset: 'collab-weeks', center: '2027-01-20T12:00:00', anchor: { taskId: 331, dy: 0.3 }, selected: [331] });
    expect(pm.session.startFollowing('cm')).toMatchObject({ ok: true, target: { session: 'cm' } });
    expect(pm.session.getSnapshot().following?.session).toBe('cm');
    expect(pm.session.getSnapshot().followWaiting).toBe(true);
    settle();
    expect(pm.viewport.view).toMatchObject({ preset: 'collab-weeks', center: '2027-01-20T12:00:00', anchor: { taskId: 331 }, selected: [331] });
    expect(pm.session.getSnapshot().followWaiting).toBe(false);
    expect(cm.session.getSnapshot().followers.map((p) => p.session)).toEqual(['pm']);

    for (let day = 21; day <= 28; day++) {
      cm.viewport.move({ center: `2027-01-${day}T12:00:00` });
      clock.advance(40);
      hub.flush();
    }
    settle();
    expect(pm.viewport.view?.center).toBe('2027-01-28T12:00:00');
    // Applying frames moved the follower's plan (its listeners heard it) but it sent nothing.
    expect(pm.session.getSnapshot().framesSent).toBe(0);
    expect(pm.session.getSnapshot().framesApplied).toBe(cm.session.getSnapshot().framesSent);
    expect(hub.sent.frame).toBe(cm.session.getSnapshot().framesSent);
    // ≤ 20 a second over 320 ms of moves, plus the answers to the request and to being followed.
    expect(cm.session.getSnapshot().framesSent).toBeLessThanOrEqual(2 + Math.ceil(320 / 50));

    // A still leader sends only heartbeats; the follower's counter stays flat.
    const before = hub.sent.frame;
    clock.advance(4_100);
    hub.flush();
    expect(hub.sent.frame - before).toBe(2);
    expect(pm.session.getSnapshot().framesSent).toBe(0);
  });

  it('publishes presence once however busy the person is: what they do travels in broadcasts', () => {
    const { pm, cm } = setup();
    for (let i = 0; i < 60; i++) {
      cm.session.setSelectedTask(i);
      cm.session.setCellSelection([{ taskId: i, columns: ['name'] }], { taskId: i, column: 'name' });
      cm.session.setActivity(i % 2 ? { kind: 'editing', taskId: i, column: 'name' } : null);
      clock.advance(50);
      hub.flush();
    }
    pm.session.startFollowing('cm');
    settle();
    pm.session.stopFollowing('manual');
    pm.session.startFollowing('cm');
    settle();
    // Realtime closes the channel of a client that updates its presence more than 5 times in 30 s.
    expect(hub.tracks.get('cm')).toBe(1);
    expect(hub.tracks.get('pm')).toBe(1);
    // Yet the others see it all: the selection, and who follows whom.
    expect(pm.session.getSnapshot().peers[0]).toMatchObject({ taskId: 59 });
    expect(cm.session.getSnapshot().followers.map((peer) => peer.session)).toEqual(['pm']);
  });

  it('tells somebody who joins later what everyone is doing', () => {
    const { pm, cm } = setup();
    cm.session.setSelectedTask(42);
    pm.session.startFollowing('cm');
    settle();
    const late = open('late', 'Lee Ames');
    settle();
    const seen = late.session.getSnapshot().peers;
    expect(seen.find((peer) => peer.session === 'cm')).toMatchObject({ taskId: 42 });
    expect(seen.find((peer) => peer.session === 'pm')).toMatchObject({ following: 'cm' });
  });

  it('sends the pointer inside the frames while followed, so one stream carries both', () => {
    const { pm, cm } = setup();
    pm.session.startFollowing('cm');
    settle();
    const cursorsBefore = hub.sent.cursor;
    const framesBefore = hub.sent.frame;
    for (let i = 0; i < 40; i++) {
      cm.session.moveCursor(pointer(200 + (i % 3)));
      clock.advance(5);
      hub.flush();
    }
    settle();
    // 200 ms of pointer moves: no cursor messages, frames at most 20 a second.
    expect(hub.sent.cursor).toBe(cursorsBefore);
    expect(hub.sent.frame - framesBefore).toBeGreaterThanOrEqual(3);
    expect(hub.sent.frame - framesBefore).toBeLessThanOrEqual(6);
    // The follower (and anyone else) still sees the pointer where it is.
    expect(pm.session.getSnapshot().cursors[0]).toMatchObject({ session: 'cm', point: { taskId: 200 + (39 % 3) } });

    // Once nobody follows, the pointer goes back to its own messages.
    pm.session.stopFollowing('manual');
    settle();
    cm.session.moveCursor(pointer(15));
    settle();
    expect(hub.sent.cursor).toBeGreaterThan(cursorsBefore);
    expect(pm.session.getSnapshot().cursors[0]).toMatchObject({ point: { taskId: 15 } });
  });

  it('offers the follower their own view back for a while after following ends', () => {
    const { pm, cm } = setup();
    pm.viewport.move({ center: '2026-11-20T12:00:00', anchor: { taskId: 7, dy: 0.5 } });
    cm.viewport.move({ center: '2027-02-01T12:00:00', anchor: { taskId: 331, dy: 0.5 } });
    pm.session.startFollowing('cm');
    settle();
    expect(pm.viewport.view?.center).toBe('2027-02-01T12:00:00');
    expect(pm.session.getSnapshot().canRestore).toBe(false);

    pm.session.stopFollowing('escape');
    // Stopping tells the plan to stop playing frames.
    expect(pm.viewport.resets).toBeGreaterThan(0);
    expect(pm.session.getSnapshot().canRestore).toBe(true);
    pm.session.restoreOwnView();
    expect(pm.viewport.restored.map((view) => view.center)).toEqual(['2026-11-20T12:00:00']);
    expect(pm.session.getSnapshot().canRestore).toBe(false);

    // Not taken up: the offer goes after a while.
    pm.session.startFollowing('cm');
    settle();
    pm.session.stopFollowing('navigate');
    expect(pm.session.getSnapshot().canRestore).toBe(true);
    clock.advance(12_100);
    expect(pm.session.getSnapshot().canRestore).toBe(false);
  });

  it('heals a lost frame with the next heartbeat', () => {
    const { pm, cm } = setup();
    pm.session.startFollowing('cm');
    settle();
    hub.hold();
    cm.viewport.move({ center: '2027-02-02T00:00:00' });
    clock.advance(200);
    hub.discard();
    hub.release();
    settle();
    expect(pm.viewport.view?.center).not.toBe('2027-02-02T00:00:00');
    clock.advance(2_100);
    hub.flush();
    expect(pm.viewport.view?.center).toBe('2027-02-02T00:00:00');
  });

  it('waits for the revision a frame was taken at before applying it', () => {
    const { pm, cm } = setup();
    cm.session.setRevision(12);
    pm.session.setRevision(10);
    cm.viewport.move({ anchor: { taskId: 999, dy: 0.5 }, center: '2027-03-01T00:00:00' });
    pm.session.startFollowing('cm');
    settle();
    expect(pm.viewport.applied).toHaveLength(0);
    pm.session.setRevision(12);
    expect(anchorTaskId(pm.viewport.view?.anchor)).toBe(999);
  });

  it('stops following when the follower takes the controls, and tells nobody else', () => {
    const { pm, cm } = setup();
    pm.session.startFollowing('cm');
    settle();
    pm.viewport.navigate('navigate');
    settle();
    expect(pm.session.getSnapshot().following).toBeNull();
    expect(pm.session.getSnapshot().notice).toBeNull();
    expect(cm.session.getSnapshot().followers).toHaveLength(0);
    const applied = pm.viewport.applied.length;
    cm.viewport.move({ center: '2027-03-09T00:00:00' });
    settle();
    expect(pm.viewport.applied).toHaveLength(applied);

    pm.session.startFollowing('cm');
    settle();
    pm.viewport.navigate('escape');
    expect(pm.session.getSnapshot().following).toBeNull();
  });

  it('stops with a note when the followed person leaves', () => {
    const { pm } = setup();
    pm.session.startFollowing('cm');
    settle();
    hub.drop('cm');
    settle();
    expect(pm.session.getSnapshot().following).toBeNull();
    expect(pm.session.getSnapshot().notice).toBe('Chris Morgan left, so you stopped following.');
    pm.session.dismissNotice();
    expect(pm.session.getSnapshot().notice).toBeNull();
  });

  it('follows the person at the head of a chain, and refuses to follow its own follower', () => {
    const { pm, cm } = setup();
    const third = open('x', 'Sam Okafor', '#16a34a');
    settle();
    expect(third.session.startFollowing('cm').ok).toBe(true);
    settle();
    // Priya asks to follow Sam, who follows Chris: she follows Chris.
    expect(pm.session.startFollowing('x')).toMatchObject({ ok: true, target: { session: 'cm' } });
    settle();
    expect(pm.session.getSnapshot().following?.session).toBe('cm');
    // Chris cannot follow Priya: she follows him.
    expect(cm.session.startFollowing('pm')).toEqual({ ok: false, reason: 'loop' });
    expect(cm.session.startFollowing('cm')).toEqual({ ok: false, reason: 'self' });
  });

  it('moves on when the followed person starts following somebody else', () => {
    const { pm, cm } = setup();
    const third = open('x', 'Sam Okafor', '#16a34a');
    settle();
    pm.session.startFollowing('cm');
    settle();
    cm.session.startFollowing('x');
    settle();
    expect(pm.session.getSnapshot().following?.session).toBe('x');
    expect(cm.session.getSnapshot().followers).toHaveLength(0);
    const sentByFollowers = pm.session.getSnapshot().framesSent + cm.session.getSnapshot().framesSent;
    third.viewport.move({ center: '2027-03-15T00:00:00' });
    settle();
    clock.advance(4_100);
    hub.flush();
    expect(pm.viewport.view?.center).toBe('2027-03-15T00:00:00');
    expect(cm.viewport.view?.center).toBe('2027-03-15T00:00:00');
    // Chris now follows too: neither follower sends a frame, however the view moves.
    expect(pm.session.getSnapshot().framesSent + cm.session.getSnapshot().framesSent).toBe(sentByFollowers);
    expect(pm.session.getSnapshot().framesSent).toBe(0);
  });

  it('shares the cell selection and the activity as they change, newest first', () => {
    const { pm, cm } = setup();
    cm.session.setCellSelection([{ taskId: 15, columns: ['task', 'schedule-when'] }, { taskId: 242, columns: ['task'] }], { taskId: 15, column: 'task' });
    cm.session.setActivity({ kind: 'editing', taskId: 15, column: 'task' });
    settle();
    const seen = pm.session.getSnapshot().peers[0]!;
    expect(seen.cells).toEqual([{ taskId: 15, columns: ['task', 'schedule-when'] }, { taskId: 242, columns: ['task'] }]);
    expect(seen.active).toEqual({ taskId: 15, column: 'task' });
    expect(seen.activity).toEqual({ kind: 'editing', taskId: 15, column: 'task' });
    // Broadcast at most ten a second; the presence state follows more slowly.
    expect(hub.sent.state).toBeGreaterThan(0);

    cm.session.setActivity(null);
    cm.session.setCellSelection([], null);
    settle();
    expect(pm.session.getSnapshot().peers[0]).toMatchObject({ cells: [], active: null, activity: null });
  });

  it('keeps the newest state when an older presence update arrives after a broadcast', () => {
    const { pm, cm } = setup();
    hub.hold();
    cm.session.setActivity({ kind: 'moving', taskId: 15, column: null });
    clock.advance(300);
    cm.session.setActivity(null);
    clock.advance(300);
    hub.release();
    settle();
    expect(pm.session.getSnapshot().peers[0]?.activity).toBeNull();
  });

  it('gives somebody who joins later the selection already made', () => {
    const { cm } = setup();
    cm.session.setCellSelection([{ taskId: 211, columns: ['schedule-when'] }], { taskId: 211, column: 'schedule-when' });
    settle(600);
    const late = open('late', 'Sam Okafor');
    settle(600);
    expect(late.session.getSnapshot().peers.find((peer) => peer.session === 'cm')?.cells).toEqual([{ taskId: 211, columns: ['schedule-when'] }]);
  });

  it('caps a huge selection', () => {
    const { pm, cm } = setup();
    const rows = Array.from({ length: 400 }, (_, index) => ({ taskId: index, columns: ['task'] }));
    cm.session.setCellSelection(rows, null);
    settle();
    expect(pm.session.getSnapshot().peers[0]?.cells).toHaveLength(300);
  });

  it('releases its plan and its channel on dispose', () => {
    const { pm, cm } = setup();
    expect(pm.viewport.listenerCount).toBe(2);
    pm.session.dispose();
    expect(pm.viewport.listenerCount).toBe(0);
    settle();
    expect(cm.session.getSnapshot().peers).toHaveLength(0);
    tabs = tabs.filter((tab) => tab !== pm);
  });
});

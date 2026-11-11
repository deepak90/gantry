/**
 * This page's own people (presence/local-peers.ts): a tab whose real channel is mixed with the page's
 * channel sees people on both, in one list; what page-local people do reaches it, and it alone: the
 * real channel never hears of them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import { teamSizeFrom, withLocalPeers } from '../../src/presence/local-peers';
import type { CursorPoint } from '../../src/presence/protocol';
import { PresenceSession } from '../../src/presence/session';
import { FakeClock } from './helpers';

const point = (taskId: number): CursorPoint => ({ kind: 'grid', taskId, column: 'task', dx: 0.3, dy: 0.5 });

let sessions: PresenceSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

describe('page-local people', () => {
  function setup() {
    const clock = new FakeClock();
    const realtime = new InMemoryPresenceHub();
    const page = new InMemoryPresenceHub();
    const open = (id: string, name: string, transport = realtime.connect(id), simulated = false) => {
      const session = new PresenceSession({ self: { session: id, user: `user-${id}`, name, color: '#2563eb', role: 'pm', ...(simulated ? { simulated } : {}) }, transport, clock });
      session.start();
      sessions.push(session);
      return session;
    };
    const settle = () => {
      for (let round = 0; round < 6; round++) {
        realtime.flush();
        page.flush();
        clock.advance(120);
      }
      realtime.flush();
      page.flush();
    };
    const viewer = open('viewer', 'Chris Morgan', withLocalPeers(realtime.connect('viewer'), 'viewer', page));
    const remote = open('remote', 'Priya Mehta');
    const local = open('team-lena', 'Lena Ortiz (sim)', page.connect('team-lena'), true);
    settle();
    return { clock, realtime, page, viewer, remote, local, settle };
  }

  it('shows the page’s people beside the real ones, marked simulated, and only on this page', () => {
    const { viewer, remote, settle } = setup();
    settle();
    expect(viewer.getSnapshot().peers.map((peer) => [peer.name, peer.simulated ?? false])).toEqual([
      ['Priya Mehta', false],
      ['Lena Ortiz (sim)', true],
    ]);
    expect(viewer.getSnapshot().status).toBe('connected');
    // The real channel: no trace of them.
    expect(remote.getSnapshot().peers.map((peer) => peer.name)).toEqual(['Chris Morgan']);
  });

  it('brings their pointers and selections to this page, and this page’s selection to them', () => {
    const { viewer, remote, local, realtime, settle } = setup();
    const sentBefore = { ...realtime.sent };
    local.moveCursor(point(111));
    local.setSelectedTask(112);
    local.setCellSelection([{ taskId: 112, columns: ['task'] }], { taskId: 112, column: 'task' });
    viewer.setSelectedTask(40);
    settle();
    const seen = viewer.getSnapshot();
    expect(seen.cursors.find((cursor) => cursor.session === 'team-lena')?.point).toEqual(point(111));
    expect(seen.peers.find((peer) => peer.session === 'team-lena')).toMatchObject({ taskId: 112, active: { taskId: 112, column: 'task' } });
    expect(local.getSnapshot().peers.find((peer) => peer.session === 'viewer')?.taskId).toBe(40);
    // What they do never goes out on the real channel (the viewer's own selection does, as always).
    expect(realtime.sent.cursor).toBe(sentBefore.cursor);
    expect(remote.getSnapshot().cursors).toEqual([]);
    expect(remote.getSnapshot().peers.find((peer) => peer.session === 'viewer')?.taskId).toBe(40);
  });

  it('lets them go: when they leave, their avatar, pointer and selection go with them', () => {
    const { viewer, local, settle } = setup();
    local.moveCursor(point(113));
    local.setSelectedTask(113);
    settle();
    expect(viewer.getSnapshot().peers.some((peer) => peer.session === 'team-lena')).toBe(true);
    local.dispose();
    settle();
    expect(viewer.getSnapshot().peers.map((peer) => peer.session)).toEqual(['remote']);
    expect(viewer.getSnapshot().cursors).toEqual([]);
  });

  it('reads how many teammates the address asks for', () => {
    expect(teamSizeFrom('?project=x&team=2')).toBe(2);
    expect(teamSizeFrom('?team')).toBe(2);
    expect(teamSizeFrom('?team=3')).toBe(3);
    expect(teamSizeFrom('?team=7')).toBe(3);
    expect(teamSizeFrom('?team=1')).toBe(1);
    expect(teamSizeFrom('?team=0')).toBeNull();
    expect(teamSizeFrom('?team=many')).toBeNull();
    expect(teamSizeFrom('?project=x')).toBeNull();
  });
});

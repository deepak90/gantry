/**
 * Simulated teammates on the page (crowd/in-page-team.ts), over a stand-in for the plan on screen: they
 * arrive one after the other as simulated people in the viewer's presence (and only there), their
 * pointers move over the rows they keep to, they select rows the viewer is not on, and when stopped
 * they leave without a trace.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CROWD_PEOPLE } from '@collab/shared';
import { startTeam, type Box, type PlanView, type TeamHandle } from '../../src/crowd/in-page-team';
import type { ShownRow } from '../../src/presence/gantt-adapter';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import { withLocalPeers } from '../../src/presence/local-peers';
import type { CursorPoint } from '../../src/presence/protocol';
import { PresenceSession } from '../../src/presence/session';
import { FakeClock } from '../presence/helpers';
import { flush } from './helpers';

/** A plan on screen like Harbor's opening view: four folded phases, Level 1 open, its tasks below. */
const ROW = 46;
const TOP = 150;
const TIMELINE = 420;
const RIGHT = 1500;
const IDS = [10, 40, 80, 90, 100, 111, 112, 113, 115, 114, 116, 117, 118, 200, 211];
const ROWS: ShownRow[] = IDS.map((taskId, index) => ({
  taskId,
  top: TOP + index * ROW,
  height: ROW,
  leaf: taskId > 100 && taskId !== 200,
  parents: taskId > 200 ? [200] : taskId > 100 && taskId < 200 ? [100] : [],
}));
const COLUMNS = [
  { id: 'task', left: 0, width: 290 },
  { id: 'schedule-crew', left: 290, width: 88 },
];
const DAY = 34;

function standIn(): PlanView {
  const row = (taskId: number) => ROWS.find((candidate) => candidate.taskId === taskId);
  return {
    body: () => ({ left: 0, top: TOP, width: RIGHT, height: ROWS.length * ROW }),
    timelineLeft: () => TIMELINE,
    rows: () => ROWS,
    columns: () => COLUMNS.map((column) => column.id),
    cell: (taskId, id) => {
      const found = row(taskId);
      const column = COLUMNS.find((candidate) => candidate.id === id);
      return found && column ? { left: column.left, top: found.top, width: column.width, height: ROW } : null;
    },
    // The phases' bars show in the first weeks; Level 1's are further on, out of view.
    bar: (taskId): Box | null => (taskId === 10 ? { left: TIMELINE, top: TOP + 12, width: 19 * DAY, height: 8 } : taskId === 40 ? { left: TIMELINE + 22 * DAY, top: TOP + ROW + 12, width: 30 * DAY, height: 8 } : null),
    pointAt: (x, y): CursorPoint | null => {
      const found = ROWS.find((candidate) => y >= candidate.top && y < candidate.top + ROW);
      if (!found || x < 0 || x >= RIGHT) return null;
      const dy = (y - found.top) / ROW;
      if (x >= TIMELINE) {
        const day = Math.floor((x - TIMELINE) / DAY);
        return { kind: 'timeline', taskId: found.taskId, date: `2027-01-${String(11 + Math.min(day, 19)).padStart(2, '0')}T08:00:00`, dy };
      }
      const column = COLUMNS.find((candidate) => x >= candidate.left && x < candidate.left + candidate.width);
      return column ? { kind: 'grid', taskId: found.taskId, column: column.id, dx: (x - column.left) / column.width, dy } : null;
    },
  };
}

let teams: TeamHandle[] = [];
let sessions: PresenceSession[] = [];
afterEach(() => {
  for (const team of teams.splice(0)) team.stop();
  for (const session of sessions.splice(0)) session.dispose();
});

describe('teammates on the page', () => {
  function setup() {
    const clock = new FakeClock();
    const realtime = new InMemoryPresenceHub();
    const page = new InMemoryPresenceHub();
    const viewer = new PresenceSession({ self: { session: 'viewer', user: 'cm', name: 'Chris Morgan', color: '#d97706', role: 'cm' }, transport: withLocalPeers(realtime.connect('viewer'), 'viewer', page), clock });
    const remote = new PresenceSession({ self: { session: 'remote', user: 'pm', name: 'Priya Mehta', color: '#2563eb', role: 'pm' }, transport: realtime.connect('remote'), clock });
    viewer.start();
    remote.start();
    sessions.push(viewer, remote);
    const view = standIn();
    // Everything the viewer is shown, as it is shown.
    const points: { session: string; point: CursorPoint }[] = [];
    const selected = new Map<string, Set<number>>();
    const seq = new Map<string, number>();
    viewer.subscribe(() => {
      const snapshot = viewer.getSnapshot();
      for (const cursor of snapshot.cursors) {
        if (seq.get(cursor.session) === cursor.seq) continue;
        seq.set(cursor.session, cursor.seq);
        points.push({ session: cursor.session, point: cursor.point });
      }
      for (const peer of snapshot.peers) if (peer.taskId !== null) selected.set(peer.name, (selected.get(peer.name) ?? new Set()).add(peer.taskId));
    });
    const run = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 40) {
        clock.advance(40);
        await flush();
        realtime.flush();
        page.flush();
      }
    };
    return { clock, realtime, page, viewer, remote, view, points, selected, run };
  }

  it('arrive one after the other, marked simulated, and only this page sees them', async () => {
    const { page, viewer, remote, view, clock, run } = setup();
    const team = startTeam({ people: 3, seed: 11, hub: page, clock, stage: () => ({ view }) });
    teams.push(team);
    expect(team.people.map((person) => person.name)).toEqual(CROWD_PEOPLE.slice(0, 3).map((person) => person.displayName));
    await run(1_000);
    const early = viewer.getSnapshot().peers.filter((peer) => peer.simulated).length;
    await run(4_000);
    const peers = viewer.getSnapshot().peers.filter((peer) => peer.simulated);
    expect(early).toBeLessThan(3);
    expect(peers.map((peer) => [peer.name, peer.color, peer.role])).toEqual(CROWD_PEOPLE.slice(0, 3).map((person) => [person.displayName, person.color, 'pm']));
    expect(peers.every((peer) => peer.name.endsWith('(sim)'))).toBe(true);
    expect(remote.getSnapshot().peers.map((peer) => peer.name)).toEqual(['Chris Morgan']);
  });

  it('point over the rows they keep to, select rows the viewer is not on, and pick a cell the viewer has', async () => {
    const { page, viewer, view, clock, points, selected, run } = setup();
    viewer.setSelectedTask(113);
    const team = startTeam({ people: 2, seed: 5, hub: page, clock, stage: () => ({ view }), around: [100] });
    teams.push(team);
    await run(60_000);
    const theirs = points.filter((entry) => entry.session.startsWith('team-'));
    expect(new Set(theirs.map((entry) => entry.session)).size).toBe(2);
    expect(theirs.length).toBeGreaterThan(200);
    // Over level 1 (the group and its tasks) nearly all the time, on the way between them now and then.
    const level1 = new Set([100, 111, 112, 113, 115, 114, 116, 117, 118]);
    expect(theirs.filter((entry) => level1.has(entry.point.taskId)).length / theirs.length).toBeGreaterThan(0.85);
    // Both on the names and crews and on the timeline.
    expect(theirs.some((entry) => entry.point.kind === 'grid')).toBe(true);
    expect(theirs.some((entry) => entry.point.kind === 'timeline')).toBe(true);
    // Columns the plan has, only.
    expect(theirs.filter((entry) => entry.point.kind === 'grid' && !['task', 'schedule-crew'].includes(entry.point.column))).toEqual([]);
    // Rows selected, within level 1, never the one the viewer is on.
    const picked = [...selected.entries()].filter(([name]) => name.endsWith('(sim)')).flatMap(([, ids]) => [...ids]);
    expect(picked.length).toBeGreaterThan(2);
    expect(picked.every((id) => level1.has(id))).toBe(true);
    expect(picked).not.toContain(113);
  });

  it('go when stopped: avatars, pointers and selections', async () => {
    const { page, viewer, view, clock, run } = setup();
    const team = startTeam({ people: 2, seed: 3, hub: page, clock, stage: () => ({ view }) });
    await run(20_000);
    expect(viewer.getSnapshot().peers.filter((peer) => peer.simulated)).toHaveLength(2);
    team.stop();
    await run(1_000);
    expect(viewer.getSnapshot().peers.filter((peer) => peer.simulated)).toEqual([]);
    expect(viewer.getSnapshot().cursors).toEqual([]);
    // Nothing of theirs keeps running.
    const pending = clock.pendingTimers;
    await run(5_000);
    expect(clock.pendingTimers).toBeLessThanOrEqual(pending);
  });

  it('a new team takes over from the one before', async () => {
    const { page, viewer, view, clock, run } = setup();
    teams.push(startTeam({ people: 3, seed: 1, hub: page, clock, stage: () => ({ view }) }));
    await run(6_000);
    teams.push(startTeam({ names: ['Kenji'], seed: 2, hub: page, clock, stage: () => ({ view }) }));
    await run(3_000);
    expect(viewer.getSnapshot().peers.filter((peer) => peer.simulated).map((peer) => peer.name)).toEqual(['Kenji Sato (sim)']);
  });

  it('wait while the plan is off screen, with no pointer showing', async () => {
    const { page, viewer, view, clock, run } = setup();
    let shown = false;
    teams.push(startTeam({ people: 1, seed: 9, hub: page, clock, stage: () => (shown ? { view } : null) }));
    await run(5_000);
    expect(viewer.getSnapshot().peers.filter((peer) => peer.simulated)).toHaveLength(1);
    expect(viewer.getSnapshot().cursors).toEqual([]);
    shown = true;
    await run(3_000);
    expect(viewer.getSnapshot().cursors).toHaveLength(1);
  });
});

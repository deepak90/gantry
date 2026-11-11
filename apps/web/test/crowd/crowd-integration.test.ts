/**
 * Three simulated people work in one project for a (sped-up) minute, each with their own project copy,
 * revision stream (the in-memory relay behaves like `submit_revision`) and presence (the in-memory hub),
 * while a real person keeps one task selected. They make changes without ever sharing a task, keep
 * out of the selected one, every copy ends on the same plan, and winding down brings the plan back.
 */
import type { TaskModel } from '@bryntum/gantt';
import { afterEach, describe, expect, it } from 'vitest';
import { CROWD_PEOPLE } from '@collab/shared';
import { Crowd } from '../../src/crowd/crowd';
import { PERSONAS } from '../../src/crowd/personas';
import { createProjectModel, toInlineDataPackage } from '../../src/gantt/project';
import type { Clock } from '../../src/presence/clock';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import { PresenceSession } from '../../src/presence/session';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync } from '../../src/sync/revision-sync';
import { PROJECT_ID, loadResult, settle, storeJson, type Client } from '../sync/helpers';
import { seedSnapshot, SEED } from './helpers';

const SPEED = 10;

/** Crowd time runs `factor` times faster than the wall clock (the sync layer keeps real time). */
function fastClock(factor: number): Clock {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * factor,
    setTimeout: (callback, ms) => setTimeout(callback, ms / factor),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Fields {
  name: string;
  note: string;
  progress: number;
  start: number;
  end: number;
  duration: number;
  constraint: string | null;
}

function fieldsOf(task: TaskModel): Fields {
  const record = task as TaskModel & { note?: string; constraintType?: string | null };
  return {
    name: String(task.name),
    note: String(record.note ?? ''),
    progress: Math.round(Number(task.percentDone)),
    start: (task.startDate as Date).getTime(),
    end: (task.endDate as Date).getTime(),
    duration: Number(task.duration),
    constraint: record.constraintType ?? null,
  };
}

const planOf = (client: Client) => new Map((client.project.taskStore.leaves as TaskModel[]).map((task) => [task.id as number, fieldsOf(task)]));

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

describe('a simulated minute in a busy site office', () => {
  it('three people edit without conflicts, keep off a selected task, converge, and leave the plan as they found it', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: seedSnapshot() });
    const hub = new InMemoryPresenceHub();
    const clock = fastClock(SPEED);
    const crowd = new Crowd({
      projectName: 'Riverside Clinic',
      handoverTaskId: SEED.handover_task_id,
      offLimits: () => new Set([SEED.booking.task_id]),
      clock,
      seed: 20261026,
      // Brought back within the minute, so the test sees it happen.
      ledger: { delayMs: { min: 15_000, max: 25_000 }, selfGraceMs: 10_000 },
    });
    cleanup.push(() => crowd.dispose());

    const clients: Client[] = [];
    for (const persona of PERSONAS.slice(0, 3)) {
      const sessionId = `sim-${persona.firstName.toLowerCase()}`;
      const project = createProjectModel();
      const sync = new RevisionSync(project, relay.connect(sessionId), { sessionId, projectId: PROJECT_ID, prepareSnapshot: toInlineDataPackage, backoff: { initialMs: 20, maxMs: 100 } });
      await sync.init(loadResult(seedSnapshot()));
      const presence = new PresenceSession({
        self: { session: sessionId, user: persona.person.id, name: persona.person.displayName, color: persona.person.color, role: 'pm', simulated: true },
        transport: hub.connect(sessionId),
        clock,
      });
      presence.start();
      cleanup.push(() => {
        presence.dispose();
        sync.dispose();
        project.destroy();
      });
      crowd.add({ persona, displayName: persona.person.displayName, project, sync, presence, sessionId });
      clients.push({ id: sessionId, project, sync, states: [], applied: [] });
    }
    // A real person, with one task selected the whole time.
    const human = new PresenceSession({ self: { session: 'priya', user: 'priya', name: 'Priya Mehta', color: '#2563eb', role: 'pm' }, transport: hub.connect('priya'), clock });
    human.start();
    cleanup.push(() => human.dispose());
    const baseline = planOf(clients[0]!);
    const handoverEnd = ((clients[0]!.project.taskStore.getById(SEED.handover_task_id) as TaskModel).endDate as Date).getTime();

    // Record who holds which task when, to prove no two people ever worked on one.
    const holds: { taskId: number; who: string; from: number; to: number }[] = [];
    const open = new Map<string, number>();
    const claim = crowd.claims.claim.bind(crowd.claims);
    const release = crowd.claims.release.bind(crowd.claims);
    crowd.claims.claim = (taskId, who) => {
      const ok = claim(taskId, who);
      if (ok && !open.has(`${taskId}|${who}`)) open.set(`${taskId}|${who}`, clock.now());
      return ok;
    };
    crowd.claims.release = (taskId, who) => {
      const from = open.get(`${taskId}|${who}`);
      if (from !== undefined) holds.push({ taskId, who, from, to: clock.now() });
      open.delete(`${taskId}|${who}`);
      release(taskId, who);
    };

    crowd.start();
    // The human picks a task in the first person's share and keeps it selected.
    const kept = crowd.status().people[0]!.area > 0 ? [...(crowd as unknown as { areas: Map<string, number[]> }).areas.get(CROWD_PEOPLE[0]!.id)!][0]! : -1;
    expect(kept).toBeGreaterThan(0);
    human.setSelectedTask(kept);

    await sleep(60_000 / SPEED);
    const status = crowd.status();
    // The real person sees three simulated people, marked as such, and their pointers.
    const seen = human.getSnapshot();
    expect(seen.peers.filter((peer) => peer.simulated).map((peer) => peer.name).sort()).toEqual(PERSONAS.slice(0, 3).map((persona) => persona.person.displayName).sort());
    expect(seen.cursors.length).toBeGreaterThanOrEqual(1);
    const left = await crowd.windDown(20_000);
    await settle(clients, relay);

    // Everyone did things; changes were made and some brought back within the minute.
    for (const person of status.people) expect(person.changes + person.restores).toBeGreaterThanOrEqual(1);
    expect(status.governor.applied).toBeGreaterThanOrEqual(5);
    expect(status.people.every((person) => person.pointerUpdates > 20)).toBe(true);
    // No task was ever held by two people at once.
    for (const a of holds) {
      for (const b of holds) {
        if (a !== b && a.taskId === b.taskId && a.who !== b.who) expect(a.to <= b.from || b.to <= a.from).toBe(true);
      }
    }
    // The selected task was left alone: no revision carries input for it.
    for (const row of relay.allRows()) {
      const updated = (row.changes as { tasks?: { $input?: { updated?: { id: unknown }[] } } }).tasks?.$input?.updated ?? [];
      expect(updated.some((record) => record.id === kept)).toBe(false);
    }
    // Every copy converged.
    for (const client of clients.slice(1)) expect(storeJson(client.project)).toEqual(storeJson(clients[0]!.project));
    for (const client of clients) expect(client.sync.state.status).toBe('synced');
    // Winding down brought everything back: the ledger is empty and the plan is the one they found.
    expect(left).toEqual([]);
    const after = planOf(clients[0]!);
    for (const [id, fields] of baseline) expect({ id, ...after.get(id) }).toEqual({ id, ...fields });
    expect(((clients[0]!.project.taskStore.getById(SEED.handover_task_id) as TaskModel).endDate as Date).getTime()).toBe(handoverEnd);
  }, 60_000);
});

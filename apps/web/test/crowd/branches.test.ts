/**
 * Two simulated people, each given one part of Harbor's plan (`pnpm crowd:harbor`): Marcus in Site and
 * foundations, Lena in Structure. Each changes only tasks under theirs and puts back only their own
 * changes, so "what are Marcus and Lena on?" has one answer each; the crane's booked task stays out of
 * it, and winding down leaves the plan as they found it.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectInlineData } from '@collab/shared';
import { harborOffices } from '@collab/shared/seed';
import { branchAreas, branchNamed } from '../../src/crowd/areas';
import { Crowd } from '../../src/crowd/crowd';
import { PERSONAS } from '../../src/crowd/personas';
import { createProjectModel, loadCollaborativeProject, toInlineDataPackage } from '../../src/gantt/project';
import type { Clock } from '../../src/presence/clock';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import { PresenceSession } from '../../src/presence/session';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync } from '../../src/sync/revision-sync';
import { PROJECT_ID, loadResult, settle, storeJson, type Client } from '../sync/helpers';

const harbor = (): ProjectInlineData => JSON.parse(JSON.stringify(harborOffices.inlineData)) as ProjectInlineData;
/** The crane's task and the scissor lift's: booked, so nobody in the crowd touches them. */
const BOOKED = new Set([harborOffices.booking!.task_id, ...(harborOffices.moreBookings ?? []).map((booking) => booking.task_id)]);
const [MARCUS, LENA] = PERSONAS;

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

async function loaded(): Promise<ProjectModel> {
  const project = createProjectModel();
  await loadCollaborativeProject(project, harbor(), 'branches');
  cleanup.push(() => project.destroy());
  return project;
}

/** The top part of the plan a task is in. */
function branchOf(project: ProjectModel, taskId: number): string | null {
  let node = project.taskStore.getById(taskId) as TaskModel | undefined;
  let top: TaskModel | null = null;
  while (node && !node.isRoot) {
    top = node;
    node = node.parent as TaskModel | undefined;
  }
  return top ? String(top.name) : null;
}

describe('one part of the plan each', () => {
  it('finds a part by its name or its WBS code, and gives each person the tasks under theirs', async () => {
    const project = await loaded();
    expect(branchNamed(project, 'site and foundations')?.name).toBe('Site and foundations');
    expect(branchNamed(project, '2')?.name).toBe('Structure');
    expect(branchNamed(project, 'Pour footings')).toBeNull();
    const leaves = (project.taskStore.leaves as TaskModel[]).filter((task) => !BOOKED.has(task.id as number));
    const pinned = branchAreas(project, leaves, ['marcus', 'lena'], ['Site and foundations', '2']);
    if (!('areas' in pinned)) throw new Error(`missing ${pinned.missing}`);
    expect(pinned.names).toEqual(
      new Map([
        ['marcus', 'Site and foundations'],
        ['lena', 'Structure'],
      ]),
    );
    // The footings' payment milestone (25) is in the list here; in the app the crowd's governor leaves milestones alone.
    expect(pinned.areas.get('marcus')).toEqual([11, 12, 21, 22, 23, 24, 25, 31, 32, 35, 33, 34]);
    // The steel, the crane's work, is booked: not Lena's to change.
    expect(pinned.areas.get('lena')).toEqual([51, 52, 53, 54, 61, 62, 63, 64, 71, 72, 73, 74]);
  });

  it('names a part the plan doesn’t have instead of pinning half the people', async () => {
    const project = await loaded();
    expect(branchAreas(project, project.taskStore.leaves as TaskModel[], ['marcus', 'lena'], ['Site and foundations', 'Roof garden'])).toEqual({ missing: 'Roof garden' });
  });
});

/** Crowd time runs `factor` times faster than the wall clock (the sync layer keeps real time). */
function fastClock(factor: number): Clock {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * factor,
    setTimeout: (callback, ms) => setTimeout(callback, ms / factor),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

const SPEED = 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the crowd may change on a task, as the plan shows it. */
function planOf(project: ProjectModel): Map<number, Record<string, unknown>> {
  return new Map(
    (project.taskStore.leaves as TaskModel[]).map((task) => {
      const record = task as TaskModel & { note?: string };
      return [
        task.id as number,
        { name: String(task.name), note: String(record.note ?? ''), progress: Math.round(Number(task.percentDone)), start: (task.startDate as Date).getTime(), duration: Number(task.duration) },
      ];
    }),
  );
}

describe('a pinned minute on Harbor', () => {
  it('Marcus changes only Site and foundations, Lena only Structure, and each puts back their own', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: harbor() });
    const hub = new InMemoryPresenceHub();
    const clock = fastClock(SPEED);
    const crowd = new Crowd({
      projectName: harborOffices.name,
      handoverTaskId: harborOffices.handover_task_id,
      offLimits: () => BOOKED,
      clock,
      seed: 20261106,
      branches: ['Site and foundations', 'Structure'],
      // Brought back within the minute, so the test sees who brings what back.
      ledger: { delayMs: { min: 15_000, max: 25_000 }, selfGraceMs: 5_000 },
    });
    cleanup.push(() => crowd.dispose());
    const clients: Client[] = [];
    const sessions = new Map<string, string>();
    for (const persona of [MARCUS!, LENA!]) {
      const sessionId = `sim-${persona.firstName.toLowerCase()}`;
      sessions.set(sessionId, persona.firstName);
      const project = createProjectModel();
      const sync = new RevisionSync(project, relay.connect(sessionId), { sessionId, projectId: PROJECT_ID, prepareSnapshot: toInlineDataPackage, backoff: { initialMs: 20, maxMs: 100 } });
      await sync.init(loadResult(harbor()));
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
    const reference = clients[0]!.project;
    const before = planOf(reference);
    expect([MARCUS!.firstName, LENA!.firstName]).toEqual(['Marcus', 'Lena']);

    crowd.start();
    expect(crowd.status().people.map((person) => person.area)).toEqual([11, 12]);
    await sleep(60_000 / SPEED);
    const status = crowd.status();
    const left = await crowd.windDown(20_000);
    await settle(clients, relay);

    // Every revision a person sent touches their own part of the plan only, put-backs included.
    const touched = new Map<string, Set<string>>();
    for (const row of relay.allRows()) {
      const who = sessions.get(row.client_id);
      if (!who) continue;
      const changes = row.changes as { tasks?: { $input?: { updated?: { id: unknown }[] } }; assignments?: { $input?: { added?: { event?: unknown }[] } } };
      const ids = [...(changes.tasks?.$input?.updated ?? []).map((record) => record.id), ...(changes.assignments?.$input?.added ?? []).map((record) => record.event)];
      for (const taskId of ids) {
        if (typeof taskId !== 'number') continue;
        const parts = touched.get(who) ?? new Set<string>();
        parts.add(branchOf(reference, taskId) ?? '?');
        touched.set(who, parts);
      }
    }
    expect([...(touched.get('Marcus') ?? [])]).toEqual(['Site and foundations']);
    expect([...(touched.get('Lena') ?? [])]).toEqual(['Structure']);
    expect(status.people.every((person) => person.changes + person.restores >= 1)).toBe(true);
    // Every copy converged, and winding down brought everything back, each by whoever works there.
    expect(storeJson(clients[1]!.project)).toEqual(storeJson(reference));
    expect(left).toEqual([]);
    const after = planOf(reference);
    for (const [taskId, fields] of before) expect({ taskId, ...after.get(taskId) }).toEqual({ taskId, ...fields });
  }, 60_000);
});

/**
 * Dropping a crew on a task: which rows accept the crew, and the drop itself, which puts the crew on
 * the task as one revision that every client applies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { riversideClinic, riversideClinicRecords } from '@collab/shared/seed';
import { assignCrew, crewDropVerdict, crewProxy } from '../../src/gantt/crew-drop';
import { crewOf } from '../../src/gantt/look';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, storeJson, type Client } from '../sync/helpers';

const { tasks, assignments, resources } = riversideClinicRecords;
const ELECTRICIANS = resources.find((resource) => resource.trade === 'Electrical')!.id;
const isLeaf = (id: number) => !tasks.some((task) => task.parentId === id);
/** A leaf with work to do that the electricians are not on. */
const FREE_TASK = tasks.find(
  (task) => isLeaf(task.id) && (task.duration ?? 0) > 0 && !assignments.some((assignment) => assignment.event === task.id && assignment.resource === ELECTRICIANS),
)!.id;
/** A leaf the electricians already work on. */
const BUSY_TASK = assignments.find((assignment) => assignment.resource === ELECTRICIANS)!.event;
const PHASE = tasks.find((task) => !isLeaf(task.id))!.id;

let clients: Client[] = [];

afterEach(() => {
  disposeAll(clients);
  clients = [];
});

async function twoClients(): Promise<{ relay: InMemoryRelay; a: Client; b: Client }> {
  const snapshot = structuredClone(riversideClinic.inlineData);
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
  const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
  const b = await joinClient(relay, 'client-b', loadResult(structuredClone(snapshot)));
  clients = [a, b];
  await settle(clients, relay);
  return { relay, a, b };
}

const taskOf = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel;
const crewOn = (project: ProjectModel, id: number) => crewOf(taskOf(project, id)).map((resource) => resource.id);
const electricians = (project: ProjectModel) => project.resourceStore.getById(ELECTRICIANS) as ResourceModel;

describe('crewDropVerdict', () => {
  it('accepts a task with work that the crew is not on yet, and says what a drop does', async () => {
    const { a } = await twoClients();
    const verdict = crewDropVerdict(taskOf(a.project, FREE_TASK), electricians(a.project));
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toBe(`Put Halden Electrical on “${taskOf(a.project, FREE_TASK).name}”`);
  });

  it('refuses a task the crew already works on, a group of tasks, a milestone, nothing, and a read-only plan', async () => {
    const { a } = await twoClients();
    const crew = electricians(a.project);
    expect(crewDropVerdict(taskOf(a.project, BUSY_TASK), crew)).toEqual({ ok: false, message: `Already on “${taskOf(a.project, BUSY_TASK).name}”` });
    expect(crewDropVerdict(taskOf(a.project, PHASE), crew)).toMatchObject({ ok: false, message: expect.stringMatching(/group of tasks/) });
    expect(crewDropVerdict(taskOf(a.project, riversideClinic.handover_task_id), crew)).toMatchObject({ ok: false, message: expect.stringMatching(/milestone/) });
    expect(crewDropVerdict(null, crew)).toEqual({ ok: false, message: 'Drop on a task in the plan' });
    expect(crewDropVerdict(taskOf(a.project, FREE_TASK), crew, true)).toEqual({ ok: false, message: 'The plan is read-only' });
  });
});

describe('assignCrew (a drop on the plan)', () => {
  it('puts the crew on the task as one revision that both clients apply', async () => {
    const { relay, a, b } = await twoClients();
    const before = relay.revisionCount;
    expect(await assignCrew(a.project, taskOf(a.project, FREE_TASK), electricians(a.project))).toBe(true);
    await settle(clients, relay);

    expect(relay.revisionCount - before).toBe(1);
    const row = relay.allRows().at(-1)!;
    // The only user input is the new assignment.
    expect(Object.keys(row.changes).filter((store) => row.changes[store]?.$input)).toEqual(['assignments']);
    expect(row.changes.assignments?.$input?.added).toEqual([expect.objectContaining({ event: FREE_TASK, resource: ELECTRICIANS, units: 100 })]);
    for (const client of [a, b]) {
      expect(crewOn(client.project, FREE_TASK)).toContain(ELECTRICIANS);
    }
    expect(storeJson(b.project)).toBe(storeJson(a.project));
    expect(b.sync.state.status).toBe('synced');
  });

  it('does nothing when the other person already put the crew on the task', async () => {
    const { relay, a, b } = await twoClients();
    await assignCrew(b.project, taskOf(b.project, FREE_TASK), electricians(b.project));
    await settle(clients, relay);
    const before = relay.revisionCount;
    expect(await assignCrew(a.project, taskOf(a.project, FREE_TASK), electricians(a.project))).toBe(false);
    await settle(clients, relay);
    expect(relay.revisionCount).toBe(before);
    expect(crewOn(a.project, FREE_TASK).filter((id) => id === ELECTRICIANS)).toHaveLength(1);
  });

  it('refuses, with nothing saved, when the task was deleted in the meantime', async () => {
    const { relay, a, b } = await twoClients();
    const stale = taskOf(a.project, FREE_TASK);
    taskOf(b.project, FREE_TASK).remove();
    await settle(clients, relay);
    const before = relay.revisionCount;
    await expect(assignCrew(a.project, stale, electricians(a.project))).rejects.toThrow(/deleted/);
    await settle(clients, relay);
    expect(relay.revisionCount).toBe(before);
  });
});

describe('crewProxy', () => {
  it('shows the crew logo over its icon, its name and a hint', async () => {
    const { a } = await twoClients();
    const proxy = crewProxy(electricians(a.project));
    expect(proxy.querySelector('img')?.getAttribute('src')).toBe('/crews/electricians.png');
    expect(proxy.querySelector('i')?.className).toBe('fa fa-bolt');
    expect(proxy.textContent).toBe('Halden ElectricalDrop on a task in the plan');
    expect(proxy.style.getPropertyValue('--crew')).toBe('#3e6596');
  });
});

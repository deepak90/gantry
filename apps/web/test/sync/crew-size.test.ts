/**
 * How many people a crew has on a task, as a plan change between two clients through the relay: one revision that
 * reaches everyone, in the history, and undone and redone like any other.
 */
import type { ProjectInlineData } from '@collab/shared';
import type { AssignmentModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { afterEach, describe, expect, it } from 'vitest';
import { crewSizeOn, usualCrewSize } from '../../src/gantt/look';
import type { CollabAssignment } from '../../src/gantt/project';
import { redo, undo } from '../../src/gantt/undo';
import { setCrewSize } from '../../src/inspector/task/apply';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { baseSnapshot, disposeAll, joinClient, loadResult, PROJECT_ID, settle, type Client } from './helpers';

const STEEL = 40;
const ON_TASK = 40;
const TASK = 2;

const clients: Client[] = [];
afterEach(() => disposeAll(clients.splice(0)));

async function twoClients() {
  const base = baseSnapshot();
  const snapshot = {
    ...base,
    resourcesData: [...(base.resourcesData ?? []), { id: STEEL, name: 'Summit Steel', kind: 'labor', trade: 'Structural steel' }],
    assignmentsData: [...(base.assignmentsData ?? []), { id: ON_TASK, event: TASK, resource: STEEL }],
  } as ProjectInlineData;
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
  const a = await joinClient(relay, 'a', loadResult(snapshot));
  const b = await joinClient(relay, 'b', loadResult(snapshot));
  clients.push(a, b);
  await settle(clients, relay);
  return { relay, a, b };
}

const people = (client: Client) => (client.project.assignmentStore.getById(ON_TASK) as AssignmentModel & CollabAssignment).headcount ?? null;

describe('a crew’s size on a task, as a plan change', () => {
  it('is one revision, with only the size in it, and reaches everyone', async () => {
    const { relay, a, b } = await twoClients();
    const before = relay.allRows().length;
    await setCrewSize(a.project, ON_TASK, 8);
    await settle(clients, relay);

    const rows = relay.allRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes.assignments?.$input?.updated).toEqual([{ id: ON_TASK, headcount: 8 }]);
    expect(people(b)).toBe(8);
    expect(b.sync.state.status).toBe('synced');
  });

  it('undo and redo take it back and forth for everyone', async () => {
    const { relay, a, b } = await twoClients();
    await setCrewSize(a.project, ON_TASK, 8);
    await settle(clients, relay);
    await undo(a.project);
    await settle(clients, relay);
    expect(people(b)).toBeNull();
    await redo(a.project);
    await settle(clients, relay);
    expect(people(b)).toBe(8);
  });

  it('goes back to the usual size when cleared, and takes nothing under one', async () => {
    const { relay, a, b } = await twoClients();
    await setCrewSize(a.project, ON_TASK, 8);
    await settle(clients, relay);
    await setCrewSize(a.project, ON_TASK, null);
    await settle(clients, relay);
    expect(people(b)).toBeNull();
    await setCrewSize(a.project, ON_TASK, 0);
    await settle(clients, relay);
    expect(people(b)).toBeNull();
    await setCrewSize(a.project, ON_TASK, 3.6);
    await settle(clients, relay);
    expect(people(b)).toBe(4);
  });

  it('counts what the plan says, and says so when it is only the usual size', async () => {
    const { relay, a } = await twoClients();
    const task = a.project.taskStore.getById(TASK) as TaskModel;
    const crew = a.project.resourceStore.getById(STEEL) as ResourceModel;
    expect(crewSizeOn(task, crew)).toEqual({ people: usualCrewSize('Structural steel'), usual: true });
    await setCrewSize(a.project, ON_TASK, 8);
    await settle(clients, relay);
    expect(crewSizeOn(task, crew)).toEqual({ people: 8, usual: false });
  });
});

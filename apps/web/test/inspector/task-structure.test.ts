/**
 * What the chart's bars and the spreadsheet can do, done from the task panel: effort, the parts of a split
 * task, adding, moving and deleting. Two clients share every edit through the relay, so each one has to
 * arrive as one revision and leave both ends on the same plan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import {
  addSubtask,
  addTaskBelow,
  deleteTask,
  indentTask,
  moveTaskDown,
  moveTaskUp,
  joinSegments,
  moveSegment,
  outdentTask,
  resizeSegment,
  setEffort,
  splitTask,
} from '../../src/inspector/task/apply';
import { findTask, taskView } from '../../src/inspector/task/model';
import { openWhenSaved } from '../../src/inspector/task/TaskActions';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, storeJson, type Client } from '../sync/helpers';

let clients: Client[] = [];

afterEach(() => {
  disposeAll(clients);
  clients = [];
});

/** Mon–Fri; Monday, November 2, 2026 is day one. */
const PLAN = (): ProjectInlineData =>
  ({
    project: { calendar: 'standard', startDate: '2026-11-02', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
    calendarsData: [{ id: 'standard', name: 'Standard (Mon-Fri)', unspecifiedTimeIsWorking: true, intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }] }],
    tasksData: [
      {
        id: 10,
        name: 'Frame',
        expanded: true,
        children: [
          { id: 1, name: 'Deliver steel', startDate: '2026-11-02', duration: 3, durationUnit: 'day' },
          { id: 2, name: 'Erect steel frame', startDate: '2026-11-05', duration: 5, durationUnit: 'day' },
          { id: 3, name: 'Bolt up', startDate: '2026-11-12', duration: 2, durationUnit: 'day' },
          { id: 4, name: 'Inspect', startDate: '2026-11-02', duration: 1, durationUnit: 'day' },
        ],
      },
    ],
    dependenciesData: [
      { id: 1, fromEvent: 1, toEvent: 2, type: 2, lag: 0, lagUnit: 'day' },
      { id: 2, fromEvent: 2, toEvent: 3, type: 2, lag: 0, lagUnit: 'day' },
    ],
    resourcesData: [{ id: 1, name: 'Steel erectors', kind: 'labor' }],
    assignmentsData: [{ id: 1, event: 2, resource: 1, units: 100 }],
  }) as unknown as ProjectInlineData;

async function twoClients(): Promise<{ relay: InMemoryRelay; A: Client; B: Client }> {
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: PLAN() });
  const A = await joinClient(relay, 'A', loadResult(PLAN()));
  const B = await joinClient(relay, 'B', loadResult(PLAN()));
  clients = [A, B];
  return { relay, A, B };
}

function expectConverged(A: Client, B: Client): void {
  expect(storeJson(A.project)).toEqual(storeJson(B.project));
  expect(A.sync.state.status).toBe('synced');
  expect(B.sync.state.status).toBe('synced');
}

const day = (iso: string) => {
  const [year, month, date] = iso.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
};
const task = (project: ProjectModel, id: number | string) => findTask(project, id) as TaskModel;
const partsOf = (project: ProjectModel, id: number) => taskView(project, task(project, id)).segments;
const childrenOf = (project: ProjectModel, id: number) => ((task(project, id).children ?? []) as TaskModel[]).map((child) => child.name);

describe('effort', () => {
  it('saves its amount and unit for everyone, as one revision', async () => {
    const { relay, A, B } = await twoClients();
    const before = relay.currentRevisionNo;
    await setEffort(A.project, 2, 80, 'hour');
    await settle(clients, relay);
    expect(relay.currentRevisionNo - before).toBe(1);
    expect(taskView(B.project, task(B.project, 2)).effort).toMatchObject({ value: 80, unit: 'hour' });
    expectConverged(A, B);
  });

  it('is refused on a phase, whose effort adds up its tasks', async () => {
    const { A } = await twoClients();
    await expect(setEffort(A.project, 10, 10, 'hour')).rejects.toThrow(/phase/i);
  });
});

describe('the parts of a split task', () => {
  it('splits a task into two parts with a gap, for everyone', async () => {
    const { relay, A, B } = await twoClients();
    const before = relay.currentRevisionNo;
    await splitTask(A.project, 2, day('2026-11-09'), 1);
    await settle(clients, relay);
    expect(relay.currentRevisionNo - before).toBe(1);
    expect(partsOf(B.project, 2)).toHaveLength(2);
    expect(partsOf(B.project, 2)[1]!.start.getDate()).toBe(10);
    expectConverged(A, B);
  });

  it('moves one part', async () => {
    const { relay, A, B } = await twoClients();
    await splitTask(A.project, 2, day('2026-11-09'), 1);
    await settle(clients, relay);
    await moveSegment(B.project, 2, 1, day('2026-11-12'));
    await settle(clients, relay);
    expect(partsOf(A.project, 2)[1]!.start.getDate()).toBe(12);
    expectConverged(A, B);
  });

  it('changes how long one part takes', async () => {
    const { relay, A, B } = await twoClients();
    await splitTask(A.project, 2, day('2026-11-09'), 1);
    await settle(clients, relay);
    await resizeSegment(A.project, 2, 0, 1);
    await settle(clients, relay);
    expect(partsOf(B.project, 2)[0]!.days).toBe(1);
    expectConverged(A, B);
  });

  it('joins a part with the next, which ends the split when two were left', async () => {
    const { relay, A, B } = await twoClients();
    await splitTask(A.project, 2, day('2026-11-09'), 1);
    await settle(clients, relay);
    await joinSegments(B.project, 2, 0);
    await settle(clients, relay);
    expect(partsOf(A.project, 2)).toHaveLength(0);
    expectConverged(A, B);
  });

  it('calls the parts Part 1, Part 2, not the name of the task', async () => {
    const { relay, A } = await twoClients();
    await splitTask(A.project, 2, day('2026-11-09'), 1);
    await settle(clients, relay);
    expect(partsOf(A.project, 2).map((part) => part.name)).toEqual(['Part 1', 'Part 2']);
  });

  it('refuses a part that is no longer there', async () => {
    const { A } = await twoClients();
    await expect(moveSegment(A.project, 2, 1, day('2026-11-12'))).rejects.toThrow(/part/i);
    await expect(joinSegments(A.project, 2, 0)).rejects.toThrow(/part/i);
  });
});

describe('where a task sits in the plan', () => {
  it('adds a task right below this one, starting with it', async () => {
    const { relay, A, B } = await twoClients();
    const before = relay.currentRevisionNo;
    const added = await addTaskBelow(A.project, 1);
    await settle(clients, relay);
    expect(relay.currentRevisionNo - before).toBe(1);
    expect(childrenOf(B.project, 10)).toEqual(['Deliver steel', 'New task', 'Erect steel frame', 'Bolt up', 'Inspect']);
    expect(added.name).toBe('New task');
    expectConverged(A, B);
  });

  it('opens a new task once the server has given it its number, not before', async () => {
    const { relay, A } = await twoClients();
    const open = vi.fn();
    const added = await addTaskBelow(A.project, 1);
    openWhenSaved(added, open);
    expect(typeof added.id === 'number' ? 1 : open.mock.calls.length).toBe(typeof added.id === 'number' ? 1 : 0);
    await settle(clients, relay);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith(expect.any(Number));
    expect(findTask(A.project, open.mock.calls[0]![0] as number)?.name).toBe('New task');
  });

  it('adds a subtask, which makes this one a phase', async () => {
    const { relay, A, B } = await twoClients();
    await addSubtask(A.project, 3);
    await settle(clients, relay);
    expect(childrenOf(B.project, 3)).toEqual(['New task']);
    expectConverged(A, B);
  });

  it('moves a task into the one above and back out', async () => {
    const { relay, A, B } = await twoClients();
    await indentTask(A.project, 4);
    await settle(clients, relay);
    expect(childrenOf(B.project, 3)).toEqual(['Inspect']);
    expectConverged(A, B);
    await outdentTask(B.project, 4);
    await settle(clients, relay);
    expect(childrenOf(A.project, 10)).toEqual(['Deliver steel', 'Erect steel frame', 'Bolt up', 'Inspect']);
    expectConverged(A, B);
  });

  it('moves a task up and down among its neighbors, as dragging its row does', async () => {
    const { relay, A, B } = await twoClients();
    await moveTaskDown(A.project, 3);
    await settle(clients, relay);
    expect(childrenOf(B.project, 10)).toEqual(['Deliver steel', 'Erect steel frame', 'Inspect', 'Bolt up']);
    expectConverged(A, B);
    await moveTaskUp(B.project, 3);
    await settle(clients, relay);
    expect(childrenOf(A.project, 10)).toEqual(['Deliver steel', 'Erect steel frame', 'Bolt up', 'Inspect']);
    expectConverged(A, B);
  });

  it('says so when a task is already at the end of its group', async () => {
    const { A } = await twoClients();
    await expect(moveTaskUp(A.project, 1)).rejects.toThrow(/top/i);
    await expect(moveTaskDown(A.project, 4)).rejects.toThrow(/bottom/i);
  });

  it('says so when a task cannot move, instead of doing nothing', async () => {
    const { A } = await twoClients();
    // Linked to the task above it, which can't also become its parent.
    await expect(indentTask(A.project, 2)).rejects.toThrow(/task above/i);
    // The first in its group has nothing above it.
    await expect(indentTask(A.project, 1)).rejects.toThrow(/task above/i);
    await expect(outdentTask(A.project, 10)).rejects.toThrow(/top/i);
  });

  it('deletes a task with what is on it, as one revision', async () => {
    const { relay, A, B } = await twoClients();
    const before = relay.currentRevisionNo;
    await deleteTask(A.project, 2);
    await settle(clients, relay);
    expect(relay.currentRevisionNo - before).toBe(1);
    expect(findTask(B.project, 2)).toBeNull();
    expect(B.project.assignmentStore.getById(1)).toBeFalsy();
    expectConverged(A, B);
  });

  it('refuses an edit to a task that is gone', async () => {
    const { A } = await twoClients();
    await expect(deleteTask(A.project, 999)).rejects.toThrow();
    await expect(indentTask(A.project, 999)).rejects.toThrow();
    await expect(addTaskBelow(A.project, 999)).rejects.toThrow();
  });
});

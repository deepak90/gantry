/**
 * Copying and moving whole tasks from the task menu, between two clients on the Riverside Clinic seed:
 * one revision, every client agrees, nothing is left pinned that links place, and a target or a held
 * task someone removed in the meantime stops the paste with a plain reason.
 */
import type { TaskModel } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasHeldTasks, holdTasks, pasteHeldTasks } from '../../src/gantt/task-clipboard';
import { Session } from '../library/harness';
import type { Peer } from '../sync/peers';

const [FOOTINGS, DIG, INSPECT, CEILINGS, PAINTING_TILE] = [210, 212, 213, 413, 422];

let session: Session;
let warnings: string[];

beforeEach(() => {
  session = new Session();
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  session.dispose();
  vi.restoreAllMocks();
});

const task = (peer: Peer, id: number) => peer.project.taskStore.getById(id) as TaskModel;

describe('copying whole tasks', () => {
  it('pastes a group with its tasks, links and crews, dated, in one revision', async () => {
    const { A } = await session.start();
    const before = session.relay.revisionCount;
    const tasks = (A.project.taskStore.allRecords as TaskModel[]).length;
    holdTasks(A.project, [task(A, FOOTINGS)], false);
    await pasteHeldTasks(A.project, task(A, PAINTING_TILE));
    const view = await session.converge(warnings);
    expect(session.relay.revisionCount - before).toBe(1);
    expect(view.tasks.length).toBe(tasks + 7);
    const top = view.tasks.find((row) => row.name === 'Spread footings - 2')!;
    const under = view.tasks.filter((row) => row.parentId === top.id);
    expect(under.length).toBe(6);
    for (const row of under) expect([row.name, row.start === null, row.duration === null]).toEqual([row.name, false, false]);
    // The links inside the copy came too, and what they lead to is not pinned.
    const ids = new Set<unknown>(under.map((row) => row.id));
    const inside = view.dependencies.filter((link) => ids.has(link.from) && ids.has(link.to));
    expect(inside.length).toBe(5);
    for (const link of inside) expect(view.tasks.find((row) => row.id === link.to)!.constraintType).toBeNull();
    // And it can go in again.
    expect(hasHeldTasks(A.project)).toBe(true);
  });

  it('copies a task the engine has only just reshaped, with its dates', async () => {
    const { A } = await session.start();
    await (A.project as unknown as { queue(step: () => unknown): Promise<unknown> }).queue(() => (A.project.taskStore as unknown as { indent(records: unknown): Promise<boolean> }).indent([task(A, CEILINGS)]));
    await session.settle();
    holdTasks(A.project, [task(A, 412)], false);
    await pasteHeldTasks(A.project, task(A, PAINTING_TILE));
    const view = await session.converge(warnings);
    const copies = view.tasks.filter((row) => row.name === 'Suspended ceilings');
    expect(copies.length).toBe(2);
    for (const row of copies) expect(row.start).not.toBeNull();
  });
});

describe('moving whole tasks', () => {
  it('moves a task below another, keeping its id, links and crew; the move is used up', async () => {
    const { A } = await session.start();
    holdTasks(A.project, [task(A, CEILINGS)], true);
    await pasteHeldTasks(A.project, task(A, PAINTING_TILE));
    const view = await session.converge(warnings);
    expect(view.tasks.find((row) => row.id === CEILINGS)!.parentId).toBe(420);
    expect(hasHeldTasks(A.project)).toBe(false);
  });

  it('refuses to put a group inside itself', async () => {
    const { A } = await session.start();
    holdTasks(A.project, [task(A, FOOTINGS)], true);
    await expect(pasteHeldTasks(A.project, task(A, DIG))).rejects.toThrow('inside itself');
  });
});

describe('when someone else got there first', () => {
  it('a target that is gone stops the paste, and nothing changes', async () => {
    const { A, B } = await session.start();
    const target = task(A, PAINTING_TILE);
    holdTasks(A.project, [task(A, DIG)], false);
    task(B, PAINTING_TILE).remove();
    await B.project.commitAsync();
    await session.settle();
    const count = (A.project.taskStore.allRecords as TaskModel[]).length;
    await expect(pasteHeldTasks(A.project, target)).rejects.toThrow('just removed that task');
    expect((A.project.taskStore.allRecords as TaskModel[]).length).toBe(count);
  });

  it('a cut task someone deleted stops the paste and is let go', async () => {
    const { A, B } = await session.start();
    holdTasks(A.project, [task(A, INSPECT)], true);
    task(B, INSPECT).remove();
    await B.project.commitAsync();
    await session.settle();
    await expect(pasteHeldTasks(A.project, task(A, PAINTING_TILE))).rejects.toThrow('what you were holding');
    expect(hasHeldTasks(A.project)).toBe(false);
  });
});

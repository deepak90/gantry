/**
 * Two people edit the same task from their task panels at the same time; every edit travels as a
 * revision through the in-memory relay (which behaves like `submit_revision`). Both clients end on
 * the same project, nobody falls out of sync, and each edit arrives as exactly one revision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import {
  addLink,
  assignCrew,
  removeLink,
  renameTask,
  setCalendar,
  setConstraint,
  setDeadline,
  setProgress,
  setInactive,
  setLinkActive,
  setLinkKind,
  setLinkLag,
  setManuallyScheduled,
  setScheduleField,
  setSchedulingMode,
  setTaskNote,
} from '../../src/inspector/task/apply';
import { constraintDateFor, findTask, taskView } from '../../src/inspector/task/model';
import { applyScheduleChange } from '../../src/gantt/cell-editors';
import { runProjectTransaction } from '../../src/scenario/publish';
import { PROJECT_ID, baseSnapshot, disposeAll, joinClient, loadResult, settle, storeJson, type Client } from '../sync/helpers';

let clients: Client[] = [];

afterEach(() => {
  disposeAll(clients);
  clients = [];
});

async function twoClients(snapshot: () => ProjectInlineData = baseSnapshot): Promise<{ relay: InMemoryRelay; A: Client; B: Client }> {
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: snapshot() });
  const A = await joinClient(relay, 'A', loadResult(snapshot()));
  const B = await joinClient(relay, 'B', loadResult(snapshot()));
  clients = [A, B];
  return { relay, A, B };
}

/** The small fixture with the seed's two calendars (Mon-Fri for the project, Mon-Sat on site). */
function withCalendars(): ProjectInlineData {
  return {
    ...baseSnapshot(),
    project: { calendar: 'standard', startDate: '2026-11-02', hoursPerDay: 24, daysPerWeek: 5, daysPerMonth: 20 },
    calendarsData: [
      { id: 'standard', name: 'Standard (Mon-Fri)', unspecifiedTimeIsWorking: true, intervals: [{ recurrentStartDate: 'on Sat', recurrentEndDate: 'on Mon', isWorking: false }] },
      { id: 'site', name: 'Site (Mon-Sat)', unspecifiedTimeIsWorking: true, intervals: [{ recurrentStartDate: 'on Sun', recurrentEndDate: 'on Mon', isWorking: false }] },
    ],
  } as ProjectInlineData;
}

/** What the Scheduling tab and the Links tab show for every task, for comparing clients. */
function schedulingJson(project: ProjectModel): string {
  const tasks = (project.taskStore.query(() => true) as TaskModel[])
    .map((record) => {
      const view = taskView(project, record);
      return {
        id: view.id,
        manual: view.isManual,
        inactive: view.isInactive,
        constraint: [view.constraint.type, view.constraint.date?.toISOString() ?? null],
        direction: view.direction,
        calendar: view.calendar.ownId,
        mode: view.schedulingMode,
        effort: view.effort,
        deadline: view.deadline?.toISOString() ?? null,
        links: view.waitsFor.map((link) => [link.id, link.type, link.lagValue, link.lagUnit, link.active]),
      };
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify(tasks, null, 1);
}

function expectConverged(A: Client, B: Client): void {
  expect(storeJson(A.project)).toEqual(storeJson(B.project));
  expect(schedulingJson(A.project)).toEqual(schedulingJson(B.project));
  expect(A.sync.state.status).toBe('synced');
  expect(B.sync.state.status).toBe('synced');
}

/** Revisions carrying someone's edit (input), not data corrections. */
function editsSince(relay: InMemoryRelay, revisionNo: number): number {
  return relay
    .rowsAfter(revisionNo)
    .filter((row) => Object.values(row.changes as Record<string, { $input?: Record<string, unknown[]> } | undefined>).some((store) => Object.values(store?.$input ?? {}).some((records) => records.length > 0)))
    .length;
}

const day = (iso: string) => {
  const [year, month, date] = iso.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
};

const note = (client: Client, id: number) => (findTask(client.project, id) as (TaskModel & { note?: string }) | null)?.note ?? '';

describe('task panel edits converge', () => {
  it('concurrent field edits from both panels end equal on both clients, one revision per edit', async () => {
    const { relay, A, B } = await twoClients();
    const before = relay.currentRevisionNo;

    // Priya and Chris edit at the same moment, neither having seen the other's change yet.
    await Promise.all([
      setLinkLag(A.project, 1, 2), // Foundations waits 2 working days after Site setup
      renameTask(B.project, 3, 'Crane erection (mobile crane)'),
      setTaskNote(A.project, 2, 'Pour on a dry day'),
      assignCrew(B.project, 3, 2),
    ]);
    await settle(clients, relay);

    expect(relay.currentRevisionNo - before).toBe(4);
    expect(storeJson(A.project)).toEqual(storeJson(B.project));
    expect(note(B, 2)).toBe('Pour on a dry day');
    const viewB = taskView(B.project, findTask(B.project, 2)!);
    expect(viewB.waitsFor).toEqual([expect.objectContaining({ otherName: 'Site setup', lag: 2, lagText: '+2 days wait' })]);
    expect(taskView(A.project, findTask(A.project, 3)!).crew.map((crew) => crew.name)).toEqual(['Mobile crane']);
    expect(findTask(A.project, 3)!.name).toBe('Crane erection (mobile crane)');
    expect(A.sync.state.status).toBe('synced');
    expect(B.sync.state.status).toBe('synced');
  });

  it('a link added on one side and its successor moved on the other converge', async () => {
    const { relay, A, B } = await twoClients();
    await Promise.all([
      addLink(A.project, { fromId: 2, toId: 3, type: 2, lag: 1 }),
      setScheduleField(B.project, 2, 'days', 5),
    ]);
    await settle(clients, relay);
    expect(storeJson(A.project)).toEqual(storeJson(B.project));
    const crane = taskView(B.project, findTask(B.project, 3)!);
    expect(crane.waitsFor).toEqual([expect.objectContaining({ otherName: 'Foundations', lag: 1 })]);

    // Then one removes it again: gone on both.
    const linkId = crane.waitsFor[0]!.id;
    await removeLink(B.project, linkId);
    await settle(clients, relay);
    expect(taskView(A.project, findTask(A.project, 3)!).waitsFor).toEqual([]);
    expect(storeJson(A.project)).toEqual(storeJson(B.project));
  });

  it('a popup save with dates and progress is one revision for the other person', async () => {
    const { relay, A, B } = await twoClients();
    const before = relay.currentRevisionNo;
    const foundations = findTask(A.project, 2)!;
    await applyScheduleChange(A.project, foundations, { days: 4, progress: 20 });
    await settle(clients, relay);
    expect(relay.currentRevisionNo - before).toBe(1);
    expect(storeJson(A.project)).toEqual(storeJson(B.project));
    expect(findTask(B.project, 2)!.duration).toBe(4);
    expect(findTask(B.project, 2)!.percentDone).toBe(20);
  });

  it('an edit to a task the other person just removed is refused and both stay in sync', async () => {
    const { relay, A, B } = await twoClients();
    // Chris deletes the task (the Gantt's Delete, in its own transaction).
    await runProjectTransaction(B.project, 'Delete task', () => {
      findTask(B.project, 3)!.remove();
    });
    await settle(clients, relay);
    expect(findTask(A.project, 3)).toBeNull();
    await expect(renameTask(A.project, 3, 'Too late')).rejects.toThrow('no longer in the plan');
    await settle(clients, relay);
    expect(storeJson(A.project)).toEqual(storeJson(B.project));
    expect(A.sync.state.status).toBe('synced');
  });

  it('manually scheduled on one side, a constraint on its predecessor on the other: one revision each, equal on both', async () => {
    const { relay, A, B } = await twoClients(withCalendars);
    const before = relay.currentRevisionNo;
    // Still concurrent (neither sees the other's edit before making its own), but A's reaches the server
    // first every time: in the other order the constraint moves Foundations before it turns manual.
    relay.pause();
    await setManuallyScheduled(A.project, 2, true);
    await vi.waitFor(() => expect(A.sync.state.pending).toBe(0));
    await setConstraint(B.project, 1, 'startnoearlierthan', day('2026-11-04'));
    relay.resume();
    await settle(clients, relay);
    // One revision per edit. The edits interact (the constraint would have moved the task made manual),
    // so each client may add a data correction (no input: recorded, not applied) for the project's end.
    expect(editsSince(relay, before)).toBe(2);
    expectConverged(A, B);
    // Site setup moved to Wed 4; Foundations, manually scheduled, stayed on Wed 4 (where it was).
    const foundations = taskView(B.project, findTask(B.project, 2)!);
    expect(foundations.isManual).toBe(true);
    expect(foundations.start).toEqual(day('2026-11-04'));
    expect(taskView(A.project, findTask(A.project, 1)!).constraint).toEqual(expect.objectContaining({ type: 'startnoearlierthan', day: day('2026-11-04') }));
  });

  it('constraint types and dates (a finish constraint, as late as possible) converge', async () => {
    const { relay, A, B } = await twoClients(withCalendars);
    await setConstraint(A.project, 3, 'mustfinishon', constraintDateFor('mustfinishon', day('2026-11-13')));
    await settle(clients, relay);
    expectConverged(A, B);
    expect(taskView(B.project, findTask(B.project, 3)!).lastDay).toEqual(day('2026-11-13'));
    await Promise.all([setConstraint(B.project, 3, 'aslateaspossible'), renameTask(A.project, 3, 'Crane erection (late)')]);
    await settle(clients, relay);
    expectConverged(A, B);
    expect(taskView(A.project, findTask(A.project, 3)!).direction).toEqual({ value: 'Backward', kind: 'own', source: null });
  });

  it('a calendar change and an inactive task converge', async () => {
    const { relay, A, B } = await twoClients(withCalendars);
    await Promise.all([setCalendar(A.project, 3, 'site'), setInactive(B.project, 1, true)]);
    await settle(clients, relay);
    expectConverged(A, B);
    expect(taskView(B.project, findTask(B.project, 3)!).calendar.ownId).toBe('site');
    expect(taskView(A.project, findTask(A.project, 1)!).isInactive).toBe(true);
    // Foundations no longer waits for the inactive Site setup.
    expect(findTask(A.project, 2)!.startDate).toEqual(day('2026-11-02'));
  });

  it('link type and active edited at the same time on the same link converge', async () => {
    const { relay, A, B } = await twoClients(withCalendars);
    await Promise.all([setLinkActive(A.project, 1, false), setLinkKind(B.project, 1, 0)]);
    await settle(clients, relay);
    expectConverged(A, B);
    const link = taskView(B.project, findTask(B.project, 2)!).waitsFor[0]!;
    expect([link.type, link.active]).toEqual([0, false]);
    await setLinkLag(B.project, 1, 1, 'week');
    await setLinkActive(A.project, 1, true);
    await settle(clients, relay);
    expectConverged(A, B);
    expect(taskView(A.project, findTask(A.project, 2)!).waitsFor[0]).toEqual(expect.objectContaining({ type: 0, lagValue: 1, lagUnit: 'week', active: true }));
  });

  it('a deadline, progress and a scheduling mode converge', async () => {
    const { relay, A, B } = await twoClients(withCalendars);
    const before = relay.currentRevisionNo;
    await Promise.all([setDeadline(A.project, 2, day('2026-11-06')), setProgress(B.project, 1, 40)]);
    await settle(clients, relay);
    await setSchedulingMode(A.project, 1, 'FixedEffort');
    await settle(clients, relay);
    expect(editsSince(relay, before)).toBe(3);
    expectConverged(A, B);
    expect(taskView(B.project, findTask(B.project, 2)!).deadline).toEqual(day('2026-11-06'));
    expect(findTask(A.project, 1)!.percentDone).toBe(40);
  });
});

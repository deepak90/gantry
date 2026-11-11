/**
 * A machine's dates on a task as plan changes, between two clients through the relay: new dates are one
 * revision that reaches everyone and leaves the machine's other tasks alone, undo and redo are revisions
 * too, the history tells it, and a fix puts its approved dates there in its own revision.
 */
import type { ProjectInlineData } from '@collab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssignmentModel } from '@bryntum/gantt';
import { describeEntry, type ChangelogEntry } from '../../src/changelog/model';
import { describeRevision } from '../../src/changelog/revisions';
import { ProjectShadow } from '../../src/changelog/shadow';
import { applyRentalDates } from '../../src/gantt/cell-editors';
import type { CollabAssignment } from '../../src/gantt/project';
import { redo, rentalsInNextStep, undo, undoState } from '../../src/gantt/undo';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { baseSnapshot, disposeAll, joinClient, loadResult, PROJECT_ID, settle, type Client } from './helpers';

const CRANE = 40;
/** The crane on Foundations (with dates, as a rental has) and on Crane erection (going by the task's days). */
const ON_FOUNDATIONS = 40;
const ON_ERECTION = 41;
const FOUNDATIONS = 2;
const ERECTION = 3;
const PUBLICATION = '00000000-0000-4000-8000-0000000006aa';
const rental = { assignmentId: ON_FOUNDATIONS, equipment: 'Crane', start: '2026-12-07', end: '2026-12-18' };

const clients: Client[] = [];
afterEach(() => disposeAll(clients.splice(0)));

async function twoClients() {
  const base = baseSnapshot();
  const snapshot = {
    ...base,
    resourcesData: [...(base.resourcesData ?? []), { id: CRANE, name: 'Crane', kind: 'equipment', company: 'Northgate' }],
    assignmentsData: [
      ...(base.assignmentsData ?? []),
      { id: ON_FOUNDATIONS, event: FOUNDATIONS, resource: CRANE, rentalStart: '2026-12-07', rentalEnd: '2026-12-18' },
      { id: ON_ERECTION, event: ERECTION, resource: CRANE },
    ],
  } as ProjectInlineData;
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
  const a = await joinClient(relay, 'a', loadResult(snapshot));
  const b = await joinClient(relay, 'b', loadResult(snapshot));
  clients.push(a, b);
  await settle(clients, relay);
  return { relay, a, b, snapshot };
}

const onTask = (client: Client, id: number) => client.project.assignmentStore.getById(id) as AssignmentModel & CollabAssignment;
const dates = (client: Client, id = ON_FOUNDATIONS) => [onTask(client, id).rentalStart ?? null, onTask(client, id).rentalEnd ?? null];

describe('a machine’s dates on a task, as plan changes', () => {
  it('new dates are one revision, with only the dates that changed, and reach everyone', async () => {
    const { relay, a, b } = await twoClients();
    const before = relay.allRows().length;
    await applyRentalDates(a.project, rental, { rentalEnd: '2026-12-17' });
    await settle(clients, relay);

    const rows = relay.allRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes.assignments?.$input?.updated).toEqual([{ id: ON_FOUNDATIONS, rentalEnd: '2026-12-17' }]);
    expect(dates(b)).toEqual(['2026-12-07', '2026-12-17']);
    expect(a.sync.state.status).toBe('synced');
    expect(b.sync.state.status).toBe('synced');
  });

  it('the same machine on another task keeps its own dates', async () => {
    const { relay, a, b } = await twoClients();
    await applyRentalDates(a.project, rental, { rentalEnd: '2026-12-17' });
    await settle(clients, relay);
    expect(dates(b, ON_ERECTION)).toEqual([null, null]);

    await applyRentalDates(a.project, { assignmentId: ON_ERECTION, equipment: 'Crane', start: '2026-12-01', end: '2026-12-02' }, { rentalEnd: '2026-12-05' });
    await settle(clients, relay);
    expect(dates(b, ON_ERECTION)).toEqual(['2026-12-01', '2026-12-05']);
    expect(dates(b)).toEqual(['2026-12-07', '2026-12-17']);
  });

  it('undo and redo take them back and forth for everyone, each as its own revision', async () => {
    const { relay, a, b } = await twoClients();
    await applyRentalDates(a.project, rental, { rentalStart: '2026-12-09', rentalEnd: '2026-12-17' });
    await settle(clients, relay);
    expect(undoState(a.project)).toMatchObject({ canUndo: true, undoLabel: '“Change Crane dates”' });
    const before = relay.allRows().length;

    await undo(a.project);
    await settle(clients, relay);
    expect(dates(a)).toEqual(['2026-12-07', '2026-12-18']);
    expect(dates(b)).toEqual(['2026-12-07', '2026-12-18']);
    expect(undoState(a.project)).toMatchObject({ canRedo: true, redoLabel: '“Change Crane dates”' });

    await redo(a.project);
    await settle(clients, relay);
    expect(dates(a)).toEqual(['2026-12-09', '2026-12-17']);
    expect(dates(b)).toEqual(['2026-12-09', '2026-12-17']);
    expect(relay.allRows().length).toBe(before + 2);
  });

  it('undoing the first dates on a machine puts it back on the task’s days', async () => {
    const { relay, a, b } = await twoClients();
    await applyRentalDates(a.project, { assignmentId: ON_ERECTION, equipment: 'Crane', start: '2026-12-01', end: '2026-12-02' }, { rentalEnd: '2026-12-05' });
    await settle(clients, relay);
    expect(dates(b, ON_ERECTION)).toEqual(['2026-12-01', '2026-12-05']);
    await undo(a.project);
    await settle(clients, relay);
    expect(dates(a, ON_ERECTION)).toEqual([null, null]);
    expect(dates(b, ON_ERECTION)).toEqual([null, null]);
    expect(b.sync.state.status).toBe('synced');
  });

  it('undo takes back the last change in order, plan edits and machine dates alike', async () => {
    const { relay, a } = await twoClients();
    const task = a.project.taskStore.getById(FOUNDATIONS)!;
    const name = task.getData('name') as string;
    await applyRentalDates(a.project, rental, { rentalEnd: '2026-12-17' });
    await settle(clients, relay);
    task.set('name', 'Renamed');
    await a.project.commitAsync();
    await settle(clients, relay);

    await undo(a.project);
    await settle(clients, relay);
    expect(task.getData('name')).toBe(name);
    expect(dates(a)).toEqual(['2026-12-07', '2026-12-17']);

    await undo(a.project);
    await settle(clients, relay);
    expect(dates(a)).toEqual(['2026-12-07', '2026-12-18']);
  });

  it('knows which machine on which task the next undo or redo would change, so a locked rental can stop it', async () => {
    const { relay, a } = await twoClients();
    const crane = { taskId: FOUNDATIONS, resourceId: CRANE };
    expect(rentalsInNextStep(a.project, 'undo')).toEqual([]);
    await applyRentalDates(a.project, rental, { rentalEnd: '2026-12-17' });
    await settle(clients, relay);
    expect(rentalsInNextStep(a.project, 'undo')).toEqual([crane]);
    expect(rentalsInNextStep(a.project, 'redo')).toEqual([]);

    await undo(a.project);
    await settle(clients, relay);
    expect(rentalsInNextStep(a.project, 'undo')).toEqual([]);
    expect(rentalsInNextStep(a.project, 'redo')).toEqual([crane]);
  });

  it('the history says who changed which machine on which task, with the dates before and after', async () => {
    const { relay, a, snapshot } = await twoClients();
    await applyRentalDates(a.project, rental, { rentalStart: '2026-12-09', rentalEnd: '2026-12-17' });
    await undo(a.project);
    await settle(clients, relay);

    const shadow = ProjectShadow.fromSnapshot(snapshot);
    const entries: ChangelogEntry[] = [];
    for (const row of relay.allRows()) {
      const entry = describeRevision(row, shadow.apply(row.changes), shadow, { canViewCosts: true, currency: 'USD' });
      if (entry) entries.push(entry);
    }
    const people = new Map([[null as unknown as string, { name: 'Chris Morgan', color: null }]]);
    expect(entries.map((entry) => describeEntry(entry, people).replace(/^\S+ /, ''))).toEqual(['changed the dates of Crane on Foundations', 'changed the dates of Crane on Foundations']);
    expect(entries[0]).toMatchObject({ kind: 'plan', revisionNo: 1, note: 'Now Wed, Dec 9 to Wed, Dec 16' });
    expect(entries[0]!.actions[0]?.propertyUpdates).toEqual([
      { property: 'rentalStart', before: 'Mon, Dec 7', after: 'Wed, Dec 9' },
      { property: 'rentalEnd', before: 'Thu, Dec 17', after: 'Wed, Dec 16' },
    ]);
    expect(entries[1]).toMatchObject({ revisionNo: 2, note: 'Now Mon, Dec 7 to Thu, Dec 17' });
  });
});

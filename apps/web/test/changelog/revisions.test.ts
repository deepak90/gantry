/**
 * Revision → changelog entry, with revisions the real engine produced: two clients edit through the
 * in-memory relay (the reference server), and the relay's rows are folded the way the panel folds the
 * server's.
 */
import type { ProjectInlineData, ProjectRevisionRow } from '@collab/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskModel } from '@bryntum/gantt';
import { describeEntry, type ChangelogEntry } from '../../src/changelog/model';
import { describeRevision, fieldLabel } from '../../src/changelog/revisions';
import { ProjectShadow } from '../../src/changelog/shadow';
import { runProjectTransaction } from '../../src/scenario/publish';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { disposeAll, joinClient, loadResult, localDate, settle, task, type Client } from '../sync/helpers';
import { CHRIS, PEOPLE, PRIYA, revisionRow, scheduledSnapshot } from './helpers';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000aa';

interface Fold {
  entries: ChangelogEntry[];
  sentences: string[];
}

function fold(snapshot: ProjectInlineData, rows: ProjectRevisionRow[], canViewCosts = true): Fold {
  const shadow = ProjectShadow.fromSnapshot(snapshot);
  const entries: ChangelogEntry[] = [];
  for (const row of rows) {
    const entry = describeRevision(row, shadow.apply(row.changes), shadow, { canViewCosts, currency: 'USD' });
    if (entry) entries.push(entry);
  }
  return { entries, sentences: entries.map((entry) => describeEntry(entry, PEOPLE)) };
}

const DAY = 86_400_000;
const days = (a: Date, b: Date) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);

describe('revisions as changelog entries (engine-made revisions)', () => {
  let snapshot: ProjectInlineData;
  let relay: InMemoryRelay;
  let clients: Client[];
  let priya: Client;
  let chris: Client;

  /** The relay's rows with the actor the server would record for each browser session. */
  const rows = () => relay.allRows().map((row) => ({ ...row, actor_user_id: row.client_id === 'priya' ? PRIYA : CHRIS }));

  beforeEach(async () => {
    snapshot = await scheduledSnapshot();
    relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
    priya = await joinClient(relay, 'priya', loadResult(snapshot));
    chris = await joinClient(relay, 'chris', loadResult(snapshot));
    clients = [priya, chris];
  });

  afterEach(() => disposeAll(clients));

  it('a moved task says who moved what, how far, and what moved with it', async () => {
    const steel = task(priya, 21);
    const before = new Date(steel.startDate);
    await steel.setStartDate(new Date(2026, 10, 18));
    await settle(clients, relay);
    const shift = days(before, task(chris, 21).startDate);

    const { entries, sentences } = fold(snapshot, rows());
    expect(sentences).toEqual([`Priya moved Steel delivery ${shift} days later`]);
    const [entry] = entries;
    expect(entry).toMatchObject({ id: 'rev-1', kind: 'plan', revisionNo: 1, taskId: 21, actor: { type: 'member', userId: PRIYA } });
    expect(entry!.note).toMatch(/^\d+ other tasks moved as a result · project now finishes \w{3}, \w{3} \d+ \(\d+ days? later\)$/);

    // The person's change comes first, with before and after values under the Gantt's names.
    const [own, ...followOn] = entry!.actions;
    expect(own).toMatchObject({ actionType: 'update', isUser: true, entity: { type: 'TaskModel', id: 21, name: 'Steel delivery' } });
    const start = own!.propertyUpdates!.find((update) => update.property === 'startDate');
    expect(start).toEqual({ property: 'startDate', before: 'Thu, Nov 12', after: 'Wed, Nov 18' });
    expect(fieldLabel('startDate')).toBe('Start');
    expect(fieldLabel('endDate')).toBe('Finish');
    expect(fieldLabel('duration')).toBe('Days');
    expect(fieldLabel('percentDone')).toBe('Progress');
    expect(fieldLabel('budgetMinor')).toBe('Budget');
    expect(followOn.length).toBeGreaterThan(0);
    expect(followOn.every((action) => action.isUser === false)).toBe(true);
    expect(followOn.at(-1)!.entity).toMatchObject({ type: 'ProjectModel' });
  });

  it('tasks added under a phase, a new link, a crew put on a task', async () => {
    const structure = chris.project.taskStore.getById(2) as TaskModel;
    structure.appendChild([
      { name: 'Bolt check', duration: 1 },
      { name: 'Weld inspection', duration: 1 },
      { name: 'Touch-up paint', duration: 1 },
    ] as never);
    await settle(clients, relay);
    priya.project.dependencyStore.add({ fromEvent: 21, toEvent: 31 });
    await settle(clients, relay);
    chris.project.assignmentStore.add({ event: 41, resource: 2, units: 100 });
    await settle(clients, relay);

    const { sentences, entries } = fold(snapshot, rows());
    expect(sentences).toEqual([
      'Chris added 3 tasks under Structure',
      'Priya linked Steel delivery → Electrical rough-in',
      'Chris put Electricians on Partitions',
    ]);
    expect(entries[0]!.actions.filter((action) => action.actionType === 'add')).toHaveLength(3);
    expect(entries[1]!.actions[0]).toMatchObject({
      actionType: 'add',
      entity: { type: 'DependencyModel', from: { name: 'Steel delivery' }, to: { name: 'Electrical rough-in' } },
    });
    expect(entries[2]!.actions[0]).toMatchObject({
      actionType: 'add',
      entity: { type: 'AssignmentModel', event: { name: 'Partitions' }, resource: { name: 'Electricians' } },
    });
  });

  it('a removed phase is named once (its tasks, links and crews go with it), and renames say old and new', async () => {
    (priya.project.taskStore.getById(5) as TaskModel).remove();
    await settle(clients, relay);
    task(chris, 42).name = 'Paint & floors';
    await settle(clients, relay);
    (task(priya, 41) as unknown as TaskModel).percentDone = 100;
    await settle(clients, relay);

    const { sentences, entries } = fold(snapshot, rows());
    expect(sentences).toEqual(['Priya removed Completion and the 2 tasks in it', 'Chris renamed Finishes to Paint & floors', 'Priya marked Partitions done']);
    // The removed task can no longer be opened; the renamed one can.
    expect(entries[0]!.taskId).toBeUndefined();
    expect(entries[1]!.taskId).toBe(42);
    expect(entries[1]!.actions[0]!.propertyUpdates).toEqual([{ property: 'name', before: 'Finishes', after: 'Paint & floors' }]);
  });

  it('cost figures only for viewers who may see costs', async () => {
    (chris.project.taskStore.getById(21) as unknown as { budgetMinor: number }).budgetMinor = 5_000_000;
    await settle(clients, relay);

    const withCosts = fold(snapshot, rows(), true);
    expect(withCosts.sentences).toEqual(['Chris set the budget of Steel delivery to $50,000.00']);
    expect(withCosts.entries[0]!.actions[0]!.propertyUpdates).toEqual([{ property: 'budgetMinor', before: '$42,000.00', after: '$50,000.00' }]);

    const withoutCosts = fold(snapshot, rows(), false);
    expect(withoutCosts.sentences).toEqual(['Chris updated the costs of Steel delivery']);
    expect(JSON.stringify(withoutCosts.entries)).not.toMatch(/\$\d/);
    expect(withoutCosts.entries[0]!.actions[0]!.propertyUpdates).toEqual([{ property: 'budgetMinor', before: '•••', after: '•••' }]);
  });

  it('the revision that carries out an approved fix reads as the fix applied to the plan', async () => {
    const crane = priya.project.taskStore.getById(22) as TaskModel;
    const before = new Date(crane.startDate);
    await runProjectTransaction(priya.project, 'Publish', () => {
      crane.constraintType = 'startnoearlierthan';
      crane.constraintDate = new Date(2026, 10, 23);
      crane.set('decisionRef', 'pub-1');
    });
    await settle(clients, relay);
    const shift = days(before, task(chris, 22).startDate);
    expect(localDate(task(chris, 22).startDate)).toBe('2026-11-23');

    const { sentences, entries } = fold(snapshot, rows());
    expect(sentences).toEqual([`Priya applied the approved fix: Crane erection now starts Mon, Nov 23 (${shift} days later)`]);
    expect(entries[0]).toMatchObject({ kind: 'fix', tone: 'ok', publicationId: 'pub-1', taskId: 22 });
    // The date rule the fix set is listed in plain words; the decision reference is not.
    const own = entries[0]!.actions.find((action) => action.isUser)!;
    expect(own.propertyUpdates).toEqual(
      expect.arrayContaining([
        { property: 'startDate', before: expect.any(String), after: 'Mon, Nov 23' },
        { property: 'constraintType', before: 'None', after: 'Start no earlier than' },
      ]),
    );
    expect(own.propertyUpdates!.some((update) => update.property === 'decisionRef')).toBe(false);
  });
});

describe('revisions as changelog entries (rules)', () => {
  const snapshot: ProjectInlineData = {
    tasksData: [
      { id: 1, name: 'Sitework', startDate: '2026-11-02', endDate: '2026-11-07', children: [{ id: 11, name: 'Pour spread footings', startDate: '2026-11-02', endDate: '2026-11-04', duration: 2 }] },
    ],
  };

  it('skips engine corrections and revisions without anything a person did', () => {
    const engine = revisionRow(1, { tasks: { updated: [{ id: 11, startDate: '2026-11-03T00:00:00' }] } }, { origin: 'engine' });
    const computedOnly = revisionRow(2, { tasks: { updated: [{ id: 11, startDate: '2026-11-04T00:00:00' }] } });
    expect(fold(snapshot, [engine, computedOnly]).entries).toEqual([]);
  });

  it('the assistant’s edits are its own, made for the person whose session ran it', () => {
    const row = revisionRow(
      1,
      { tasks: { $input: { updated: [{ id: 11, startDate: '2026-11-04T00:00:00' }] }, updated: [{ id: 11, startDate: '2026-11-04T00:00:00', endDate: '2026-11-06T00:00:00' }] } },
      { origin: 'agent', actor_user_id: CHRIS },
    );
    const { entries, sentences } = fold(snapshot, [row]);
    expect(sentences).toEqual(['Remy moved Pour spread footings 2 days later']);
    expect(entries[0]).toMatchObject({ actor: { type: 'assistant', userId: CHRIS }, tone: 'assistant' });
    expect(entries[0]!.actions[0]!.propertyUpdates).toEqual([
      { property: 'startDate', before: 'Mon, Nov 2', after: 'Wed, Nov 4' },
      { property: 'endDate', before: 'Tue, Nov 3', after: 'Thu, Nov 5' },
    ]);
  });

  it('re-numbering that comes with a removal is not reported as a move', () => {
    const row = revisionRow(1, {
      tasks: {
        $input: { removed: [{ id: 11 }], updated: [{ id: 12, orderedParentIndex: 0 }] },
        removed: [{ id: 11 }],
        updated: [{ id: 12, orderedParentIndex: 0, parentIndex: 0, startDate: '2026-11-02T00:00:00' }],
      },
    });
    const withNextTask: ProjectInlineData = {
      tasksData: [
        {
          id: 1,
          name: 'Sitework',
          children: [
            { id: 11, name: 'Pour spread footings', startDate: '2026-11-02', endDate: '2026-11-04' },
            { id: 12, name: 'Backfill', startDate: '2026-11-04', endDate: '2026-11-05' },
          ],
        },
      ],
    };
    const { sentences, entries } = fold(withNextTask, [row]);
    expect(sentences).toEqual(['Priya removed Pour spread footings']);
    expect(entries[0]!.note).toBe('1 other task moved as a result');
  });

  it('task names in values are kept as text (the grid encodes them)', () => {
    const row = revisionRow(1, { tasks: { $input: { updated: [{ id: 11, name: '<img src=x onerror=alert(1)>' }] }, updated: [{ id: 11, name: '<img src=x onerror=alert(1)>' }] } });
    const { entries, sentences } = fold(snapshot, [row]);
    expect(sentences).toEqual(['Priya renamed Pour spread footings to <img src=x onerror=alert(1)>']);
    expect(entries[0]!.parts).toContainEqual({ name: '<img src=x onerror=alert(1)>', taskId: 11 });
  });
});

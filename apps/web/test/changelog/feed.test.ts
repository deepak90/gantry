import type { ProjectInlineData } from '@collab/shared';
import type { ProjectModel, Store } from '@bryntum/gantt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachChangelogStores, ChangelogFeed, CHANGELOG_STORE_ID, VERSION_STORE_ID, type ChangelogStores } from '../../src/changelog/feed';
import type { CollabChangeLogTransaction } from '../../src/changelog/model';
import { createProjectModel, loadCollaborativeProject, readProjectInlineData } from '../../src/gantt/project';
import type { RevisionNotificationEvent } from '../../src/sync/revision-sync';
import { IDS, PRIYA, revisionRow, scheduledSnapshot, workflowSnapshot } from './helpers';

const records = (store: Store) => store.records as CollabChangeLogTransaction[];
const ids = (store: Store) => records(store).map((record) => String(record.id));
const settleEngine = (project: ProjectModel) => new Promise((resolve) => setTimeout(resolve, 250)).then(() => project.commitAsync());

/** Revisions moving task 21 (Steel delivery) one day at a time, each by Priya. */
function moves(snapshot: ProjectInlineData, count: number, from = 1) {
  const steel = (snapshot.tasksData as { id: number; children?: { id: number; startDate: string }[] }[])
    .flatMap((phase) => phase.children ?? [])
    .find((task) => task.id === 21)!;
  const start = new Date(`${steel.startDate.slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const no = from + index;
    const day = new Date(start.getTime() + no * 86_400_000).toISOString().slice(0, 10);
    const update = { id: 21, startDate: `${day}T00:00:00` };
    return revisionRow(no, { tasks: { $input: { updated: [update] }, updated: [update] } });
  });
}

describe('the changelog stores on the project', () => {
  let project: ProjectModel;
  let snapshot: ProjectInlineData;
  let stores: ChangelogStores | undefined;

  beforeEach(async () => {
    snapshot = await scheduledSnapshot();
    project = createProjectModel();
    await loadCollaborativeProject(project, snapshot, '00000000-0000-4000-8000-0000000000c1', '0');
  });

  afterEach(() => {
    stores?.detach();
    stores = undefined;
    project.destroy();
  });

  it('registers the same crud stores the Versions feature would, and takes them away again', () => {
    stores = attachChangelogStores(project);
    expect(project.getCrudStore(CHANGELOG_STORE_ID)).toBe(stores.changes);
    expect(project.getCrudStore(VERSION_STORE_ID)).toBe(stores.versions);
    expect((stores.changes as unknown as { isChangeLogStore: boolean }).isChangeLogStore).toBe(true);
    expect((stores.versions as unknown as { isVersionStore: boolean }).isVersionStore).toBe(true);

    // Registered by someone else already (a Versions feature): reused, and left in place on detach.
    const again = attachChangelogStores(project);
    expect(again.changes).toBe(stores.changes);
    again.detach();
    expect(project.getCrudStore(CHANGELOG_STORE_ID)).toBe(stores.changes);

    stores.detach();
    stores = undefined;
    expect(project.getCrudStore(CHANGELOG_STORE_ID)).toBeFalsy();
    expect(project.getCrudStore(VERSION_STORE_ID)).toBeFalsy();
  });

  it('filling the changelog never produces a revision, an engine run or unsaved changes', async () => {
    const notifications: RevisionNotificationEvent[] = [];
    let dataReady = 0;
    project.on({ revisionNotification: (event: RevisionNotificationEvent) => notifications.push(event) });
    project.on({ dataReady: () => dataReady++ });
    const queued = (project.stm as unknown as { queue: unknown[] }).queue.length;

    stores = attachChangelogStores(project);
    const feed = new ChangelogFeed(stores.changes, { snapshot, snapshotRevision: 0, canViewCosts: true, currency: 'USD', project });
    feed.ingestRevisions(moves(snapshot, 3));
    feed.setWorkflow(workflowSnapshot());
    await settleEngine(project);

    expect(records(stores.changes).length).toBeGreaterThan(3);
    expect(notifications).toEqual([]);
    expect(dataReady).toBe(0);
    expect((project.stm as unknown as { queue: unknown[] }).queue.length).toBe(queued);
    // Committed as written: the project has nothing to save because of the log.
    expect((project as unknown as { changes: unknown }).changes).toBeNull();

    // The log rides along in the project's inline data, and the snapshot reader ignores it.
    const inline = project.inlineData as Record<string, unknown>;
    expect(Array.isArray(inline.changelogs)).toBe(true);
    const data = readProjectInlineData(project);
    expect(Object.keys(data).sort()).toEqual(['assignmentsData', 'calendarsData', 'dependenciesData', 'project', 'resourcesData', 'tasksData']);
    expect(JSON.stringify(data)).not.toContain('changelogs');

    // Control: a real edit does notify, so the listener above was live.
    (project.taskStore.getById(21) as unknown as { name: string }).name = 'Steel delivery (late)';
    await settleEngine(project);
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('lists newest first, never twice, and appends without rewriting what is listed', () => {
    stores = attachChangelogStores(project);
    const feed = new ChangelogFeed(stores.changes, { snapshot, snapshotRevision: 0, canViewCosts: true, currency: 'USD', project });
    const rows = moves(snapshot, 4);

    feed.ingestRevisions(rows.slice(0, 2));
    expect(ids(stores.changes).sort()).toEqual(['rev-1', 'rev-2']);
    const first = stores.changes.getById('rev-1');

    // Overlapping and out-of-order batches (a re-read after a reconnect) add only what is new.
    feed.ingestRevisions([rows[3]!, rows[1]!, rows[2]!, rows[0]!]);
    feed.ingestRevisions(rows);
    expect(ids(stores.changes).sort()).toEqual(['rev-1', 'rev-2', 'rev-3', 'rev-4']);
    expect(stores.changes.getById('rev-1')).toBe(first);
    expect(feed.lastRevision).toBe(4);
    expect(feed.entries().map((entry) => entry.id)).toEqual(['rev-4', 'rev-3', 'rev-2', 'rev-1']);
    // Each revision moved the task one more day, measured against the one before.
    expect(records(stores.changes).map((record) => record.get('description'))).toEqual(Array(4).fill('Someone moved Steel delivery 1 day later'));
  });

  it('merges the workflow in by time, names people once their profiles arrive, and keeps an entry’s first time', () => {
    stores = attachChangelogStores(project);
    const feed = new ChangelogFeed(stores.changes, { snapshot, snapshotRevision: 0, canViewCosts: true, currency: 'USD', project });
    const [move] = moves(snapshot, 1);
    feed.ingestRevisions([{ ...move!, created_at: '2026-10-22T10:04:00.000Z' }]);
    expect(stores.changes.getById('rev-1')!.get('description')).toMatch(/^Someone moved Steel delivery/);

    const workflow = workflowSnapshot();
    feed.setWorkflow(workflow);
    expect(stores.changes.getById('rev-1')!.get('description')).toMatch(/^Priya moved Steel delivery/);
    // Only the payment comes through: what it rests on is written when someone presses Pay, and isn't news.
    const entries = feed.entries();
    expect(entries.map((entry) => entry.kind).filter((kind) => kind !== 'plan').every((kind) => kind === 'payment')).toBe(true);
    const order = entries.map((entry) => entry.id);
    expect(order.indexOf(`wf-pay-${IDS.payment}-paid`)).toBeLessThan(order.indexOf('rev-1'));

    // PayPal re-checked the payment later: the confirmation keeps the time it was first listed with.
    const paid = stores.changes.getById(`wf-pay-${IDS.payment}-paid`)!;
    const paidAt = (paid.get('occurredAt') as Date).getTime();
    const later = workflowSnapshot();
    later.payments[0] = { ...later.payments[0]!, last_checked_at: '2026-10-22T11:30:00+00:00', updated_at: '2026-10-22T11:30:00+00:00' };
    feed.setWorkflow(later);
    expect((stores.changes.getById(`wf-pay-${IDS.payment}-paid`)!.get('occurredAt') as Date).getTime()).toBe(paidAt);
  });

  it('keeps only the newest entries', () => {
    stores = attachChangelogStores(project);
    const feed = new ChangelogFeed(stores.changes, { snapshot, snapshotRevision: 0, canViewCosts: true, currency: 'USD', project, maxEntries: 3 });
    feed.ingestRevisions(moves(snapshot, 5));
    expect(ids(stores.changes).sort()).toEqual(['rev-3', 'rev-4', 'rev-5']);
  });
});

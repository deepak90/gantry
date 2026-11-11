import type { ChangesInfo, OutgoingRevision, ProjectRevisionRow, StoreChanges } from '@collab/shared';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionRejectedError, TransportUnavailableError, type TransportStatus } from '../../src/sync/transport';
import { PROJECT_ID, baseSnapshot, newProject } from './helpers';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function revision(clientId: string, localRevisionId: string | number, changes: ChangesInfo): OutgoingRevision {
  return { clientId, localRevisionId, changes };
}

function addWithDependency(): ChangesInfo {
  return {
    tasks: {
      added: [{ $PhantomId: 'p-task', name: 'New task', duration: 2 }],
      $input: { added: [{ $PhantomId: 'p-task', name: 'New task', duration: 2 }] },
    },
    dependencies: {
      added: [{ $PhantomId: 'p-dep', fromEvent: 2, toEvent: 'p-task', from: 2, to: 'p-task' }],
      $input: { added: [{ $PhantomId: 'p-dep', fromEvent: 2, toEvent: 'p-task' }] },
    },
    project: projectFields({ endDate: '2026-11-09T00:00:00', duration: 7 }),
  };
}

/** The `project` entry of a revision holds the project model's own fields, not store changes. */
function projectFields(fields: Record<string, unknown>): StoreChanges {
  return fields as StoreChanges;
}

function subscribeCollecting(relay: InMemoryRelay, clientId: string) {
  const rows: ProjectRevisionRow[] = [];
  const statuses: TransportStatus[] = [];
  const transport = relay.connect(clientId);
  const unsubscribe = transport.subscribe({
    onRevision: (row) => rows.push(row),
    onStatus: (status) => statuses.push(status),
  });
  return { transport, rows, statuses, unsubscribe };
}

describe('InMemoryRelay as a reference submit_revision server', () => {
  it('assigns revision numbers in arrival order and dedupes on (client_id, local_revision_id)', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot(), snapshotRevision: 10 });
    const a = relay.connect('A');
    const first = await a.submit(revision('A', 'local-1', { tasks: { updated: [{ id: 1, name: 'x' }] } }));
    const again = await a.submit(revision('A', 'local-1', { tasks: { updated: [{ id: 1, name: 'x' }] } }));
    const second = await a.submit(revision('A', 'local-2', { tasks: { updated: [{ id: 1, name: 'y' }] } }));

    expect(first.revision_no).toBe(11);
    expect(again).toEqual(first);
    expect(second.revision_no).toBe(12);
    expect(relay.revisionCount).toBe(2);
    expect(first).toMatchObject({
      project_id: PROJECT_ID,
      client_id: 'A',
      local_revision_id: 'local-1',
      conflict_resolution_for: null,
      origin: 'human',
      actor_user_id: null,
    });
    expect(typeof first.created_at).toBe('string');
    expect(relay.currentRevisionNo).toBe(12);
  });

  it('stringifies numeric local revision ids and conflict references', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID });
    const row = await relay.connect('A').submit({ clientId: 'A', localRevisionId: 7, conflictResolutionFor: 3, changes: {} });
    expect(row.local_revision_id).toBe('7');
    expect(row.conflict_resolution_for).toBe('3');
  });

  it('assigns real ids above the seeded ids and replaces phantoms everywhere except the $PhantomId key', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    const row = await relay.connect('A').submit(revision('A', 'local-1', addWithDependency()));

    const tasks = row.changes.tasks!;
    const deps = row.changes.dependencies!;
    expect(tasks.added).toEqual([{ $PhantomId: 'p-task', id: 4, name: 'New task', duration: 2 }]);
    expect(tasks.$input!.added).toEqual([{ $PhantomId: 'p-task', id: 4, name: 'New task', duration: 2 }]);
    expect(deps.added).toEqual([{ $PhantomId: 'p-dep', id: 2, fromEvent: 2, toEvent: 4, from: 2, to: 4 }]);
    expect(deps.$input!.added).toEqual([{ $PhantomId: 'p-dep', id: 2, fromEvent: 2, toEvent: 4 }]);
    expect(row.changes.project).toEqual({ endDate: '2026-11-09T00:00:00', duration: 7 });
    expect(relay.realIdFor('p-task')).toBe(4);
    expect(relay.realIdFor('p-dep')).toBe(2);
  });

  it('seeds counters from nested task children and numeric string ids', async () => {
    const relay = new InMemoryRelay({
      projectId: PROJECT_ID,
      snapshot: {
        tasksData: [{ id: 1, name: 'Phase', children: [{ id: 41, name: 'Child' }, { id: '57', name: 'Child 2' }] }],
        resourcesData: [{ id: 9, name: 'Crew' }],
      },
    });
    const row = await relay.connect('A').submit(
      revision('A', 'local-1', {
        tasks: { added: [{ $PhantomId: 'pt', name: 't' }] },
        resources: { added: [{ $PhantomId: 'pr', name: 'r' }] },
        assignments: { added: [{ $PhantomId: 'pa', event: 'pt', resource: 'pr' }] },
      }),
    );
    expect(row.changes.tasks!.added![0]!.id).toBe(58);
    expect(row.changes.resources!.added![0]!.id).toBe(10);
    expect(row.changes.assignments!.added![0]).toEqual({ $PhantomId: 'pa', id: 1, event: 58, resource: 10 });
  });

  it('reuses the mapping when the same phantom is added again in a later revision', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    const a = relay.connect('A');
    const first = await a.submit(revision('A', 'local-1', { tasks: { added: [{ $PhantomId: 'p1', name: 'Task 1' }] } }));
    const second = await a.submit(
      revision('A', 'local-2', {
        tasks: { added: [{ $PhantomId: 'p1', name: 'Task 1 (updated)' }], $input: { added: [{ $PhantomId: 'p1', name: 'Task 1 (updated)' }] } },
        dependencies: { updated: [{ id: 1, toEvent: 'p1' }], $input: { updated: [{ id: 1, toEvent: 'p1' }] } },
      }),
    );
    expect(first.changes.tasks!.added![0]!.id).toBe(4);
    expect(second.changes.tasks!.added![0]).toEqual({ $PhantomId: 'p1', id: 4, name: 'Task 1 (updated)' });
    expect(second.changes.dependencies!.updated).toEqual([{ id: 1, toEvent: 4 }]);
    expect(second.changes.dependencies!.$input!.updated).toEqual([{ id: 1, toEvent: 4 }]);
  });

  it('replaces phantom references nested in arrays and objects', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    const row = await relay.connect('A').submit(
      revision('A', 'local-1', {
        tasks: {
          added: [{ $PhantomId: 'p1', name: 'Segmented', segments: [{ event: 'p1', meta: { ref: 'p1' } }], tags: ['p1', 'other'] }],
        },
      }),
    );
    expect(row.changes.tasks!.added![0]).toEqual({
      $PhantomId: 'p1',
      id: 4,
      name: 'Segmented',
      segments: [{ event: 4, meta: { ref: 4 } }],
      tags: [4, 'other'],
    });
  });

  it('gives every object carrying a known $PhantomId its real id, like replace_phantom_ids', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    const a = relay.connect('A');
    await a.submit(revision('A', 'local-1', { tasks: { added: [{ $PhantomId: 'p-parent', name: 'Parent' }] } }));
    // A structural update of a record its client still considers new is keyed by $PhantomId.
    const row = await a.submit(
      revision('A', 'local-2', {
        tasks: {
          updated: [{ $PhantomId: 'p-parent', orderedParentIndex: 2 }],
          $input: { updated: [{ $PhantomId: 'p-parent', orderedParentIndex: 2 }] },
        },
      }),
    );
    expect(row.changes.tasks?.updated).toEqual([{ $PhantomId: 'p-parent', id: 4, orderedParentIndex: 2 }]);
    expect(row.changes.tasks?.$input?.updated).toEqual([{ $PhantomId: 'p-parent', id: 4, orderedParentIndex: 2 }]);
  });

  it('checks a registered publication like publication_revision_check, the booked task included', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    const a = relay.connect('A');
    const publicationId = '00000000-0000-4000-8000-00000000c001';
    relay.registerPublication(publicationId, { taskId: 3, newStart: '2026-11-16' });
    const publish = (localRevisionId: string, input: Record<string, unknown>[], extra: ChangesInfo = {}) =>
      a.submit({
        ...revision('A', localRevisionId, { tasks: { updated: input, $input: { updated: input } }, ...extra }),
        publicationId,
      });
    const valid = { id: 3, constraintType: 'startnoearlierthan', constraintDate: '2026-11-16T00:00:00', decisionRef: publicationId };

    await expect(publish('p-1', [valid, { id: 2, segments: [] }])).rejects.toThrow(/may only update task 3, not 2/);
    await expect(publish('p-2', [{ ...valid, segments: [] }])).rejects.toThrow(/may not change task field "segments"/);
    await expect(publish('p-3', [{ ...valid, constraintDate: '2026-11-17T00:00:00' }])).rejects.toThrow(/approved start 2026-11-16/);
    await expect(publish('p-4', [valid], { dependencies: { $input: { added: [{ $PhantomId: 'p-dep' }] } } })).rejects.toThrow(
      /input in store "dependencies"/,
    );
    expect(relay.revisionCount).toBe(0);

    await a.submit(revision('A', 'delete', { tasks: { removed: [{ id: 3 }], $input: { removed: [{ id: 3 }] } } }));
    await expect(publish('p-5', [valid])).rejects.toThrow(/task 3\) is no longer in the project/);
    await a.submit(revision('A', 'undo', { tasks: { added: [{ $PhantomId: 3, id: 3 }], $input: { added: [{ $PhantomId: 3, id: 3 }] } } }));
    const row = await publish('p-6', [valid]);
    expect(relay.publishedRevisionOf(publicationId)).toBe(row.revision_no);
    await expect(publish('p-7', [valid])).rejects.toThrow(/is published/);
  });

  it('rejects calendars and unknown stores without persisting anything', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    const a = relay.connect('A');
    await expect(a.submit(revision('A', 'local-1', { calendars: { updated: [{ id: 'general', name: 'x' }] } }))).rejects.toBeInstanceOf(
      RevisionRejectedError,
    );
    await expect(a.submit(revision('A', 'local-2', { timeRanges: { added: [{ $PhantomId: 'x' }] } }))).rejects.toMatchObject({
      code: 'STORE_NOT_ALLOWED',
    });
    expect(relay.revisionCount).toBe(0);
    expect(relay.currentRevisionNo).toBe(0);
    // A rejected submission is not remembered as accepted: resubmitting a valid payload with the same local id works.
    const row = await a.submit(revision('A', 'local-1', { tasks: { updated: [{ id: 1, name: 'ok' }] } }));
    expect(row.revision_no).toBe(1);
  });

  it('drops removal entries that carry no id', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    const row = await relay.connect('A').submit(
      revision('A', 'local-1', {
        tasks: { removed: [{ id: 3 }, { id: undefined }], $input: { removed: [{ id: 3 }, {} as { id: unknown }] } },
      }),
    );
    expect(row.changes.tasks!.removed).toEqual([{ id: 3 }]);
    expect(row.changes.tasks!.$input!.removed).toEqual([{ id: 3 }]);
  });

  it('returns rows after a revision in ascending order', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID });
    const a = relay.connect('A');
    for (let i = 1; i <= 4; i++) {
      await a.submit(revision('A', `local-${i}`, { tasks: { updated: [{ id: 1, name: `v${i}` }] } }));
    }
    const rows = await a.fetchAfter(2);
    expect(rows.map((row) => row.revision_no)).toEqual([3, 4]);
    expect(await a.fetchAfter(4)).toEqual([]);
    expect(relay.rowsAfter(0)).toHaveLength(4);
  });

  it('broadcasts every accepted row to every subscriber, including the originator, in order', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID });
    const a = subscribeCollecting(relay, 'A');
    const b = subscribeCollecting(relay, 'B');
    await flush();
    expect(a.statuses).toEqual(['connected']);
    expect(b.statuses).toEqual(['connected']);

    await a.transport.submit(revision('A', 'local-1', { tasks: { updated: [{ id: 1, name: '1' }] } }));
    await b.transport.submit(revision('B', 'local-1', { tasks: { updated: [{ id: 1, name: '2' }] } }));
    await a.transport.submit(revision('A', 'local-1', { tasks: { updated: [{ id: 1, name: '1' }] } })); // duplicate: no new broadcast
    await flush();

    expect(a.rows.map((row) => row.revision_no)).toEqual([1, 2]);
    expect(b.rows.map((row) => row.revision_no)).toEqual([1, 2]);
    expect(a.rows[1]!.client_id).toBe('B');
    expect(relay.inFlight).toBe(0);

    a.unsubscribe();
    await b.transport.submit(revision('B', 'local-2', { tasks: { updated: [{ id: 1, name: '3' }] } }));
    await flush();
    expect(a.rows).toHaveLength(2);
    expect(b.rows).toHaveLength(3);
  });

  it('pause() holds broadcasts while still answering submits; resume() delivers them in order', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID });
    const a = subscribeCollecting(relay, 'A');
    await flush();
    relay.pause();
    const first = await a.transport.submit(revision('A', 'local-1', {}));
    const second = await a.transport.submit(revision('A', 'local-2', {}));
    await flush();
    expect(first.revision_no).toBe(1);
    expect(second.revision_no).toBe(2);
    expect(a.rows).toEqual([]);
    expect(relay.heldCount).toBe(2);
    expect(relay.isPaused).toBe(true);
    relay.resume();
    await flush();
    expect(a.rows.map((row) => row.revision_no)).toEqual([1, 2]);
    expect(relay.heldCount).toBe(0);
  });

  it('disconnect() cuts one client off (submits, fetches, broadcasts) and reconnect() restores it', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID });
    const a = subscribeCollecting(relay, 'A');
    const b = subscribeCollecting(relay, 'B');
    await flush();

    relay.disconnect('B');
    await flush();
    expect(b.statuses).toEqual(['connected', 'reconnecting']);
    expect(relay.isOffline('B')).toBe(true);
    await expect(b.transport.submit(revision('B', 'local-1', {}))).rejects.toBeInstanceOf(TransportUnavailableError);
    await expect(b.transport.fetchAfter(0)).rejects.toBeInstanceOf(TransportUnavailableError);

    await a.transport.submit(revision('A', 'local-1', {}));
    await flush();
    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(0);

    relay.reconnect('B');
    await flush();
    expect(b.statuses).toEqual(['connected', 'reconnecting', 'connected']);
    expect(await b.transport.fetchAfter(0)).toHaveLength(1);
    const row = await b.transport.submit(revision('B', 'local-1', {}));
    expect(row.revision_no).toBe(2);
    expect(relay.revisionCount).toBe(2);
  });

  it('failNextSubmits() fails before or after acceptance, failNextFetches() fails fetches', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID });
    const a = relay.connect('A');

    relay.failNextSubmits(1);
    await expect(a.submit(revision('A', 'local-1', {}))).rejects.toThrow(/before the server received/);
    expect(relay.revisionCount).toBe(0);

    relay.failNextSubmits(1, 'after');
    await expect(a.submit(revision('A', 'local-1', {}))).rejects.toThrow(/after the server accepted/);
    expect(relay.revisionCount).toBe(1);
    const row = await a.submit(revision('A', 'local-1', {}));
    expect(row.revision_no).toBe(1);
    expect(relay.revisionCount).toBe(1);

    relay.failNextFetches(1);
    await expect(a.fetchAfter(0)).rejects.toBeInstanceOf(TransportUnavailableError);
    expect(await a.fetchAfter(0)).toHaveLength(1);
  });

  it('loadResultFor() snapshots a project and lists the revisions after the snapshot', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot(), name: 'Relay project' });
    const project = newProject();
    await project.loadInlineData(baseSnapshot());
    await project.commitAsync();
    const a = relay.connect('A');
    await a.submit(revision('A', 'local-1', { tasks: { updated: [{ id: 1, name: 'after snapshot' }] } }));

    const load = relay.loadResultFor(PROJECT_ID, project, 0);
    expect(load.project).toEqual({ id: PROJECT_ID, name: 'Relay project', currency: 'USD', handover_task_id: null });
    expect(load.snapshot_revision).toBe(0);
    expect(load.current_revision).toBe(1);
    expect(load.revisions.map((row) => row.revision_no)).toEqual([1]);
    expect(load.snapshot.tasksData).toHaveLength(3);
    expect(load.snapshot.dependenciesData).toHaveLength(1);
    expect(load.snapshot.resourcesData).toHaveLength(2);
    expect(load.snapshot.assignmentsData).toHaveLength(1);
    expect(load.snapshot.project).toMatchObject({ startDate: expect.stringMatching(/^2026-11-02/) });

    expect(() => relay.loadResultFor('other', project, 0)).toThrow(/serves project/);
    expect(() => relay.loadResultFor(PROJECT_ID, project, 5)).toThrow(/ahead of the relay/);
    project.destroy();
  });

  it('delivers rows asynchronously so inFlight reflects scheduled work', async () => {
    const relay = new InMemoryRelay({ projectId: PROJECT_ID });
    const a = subscribeCollecting(relay, 'A');
    await flush();
    const submit = a.transport.submit(revision('A', 'local-1', {}));
    expect(relay.inFlight).toBeGreaterThan(0);
    await submit;
    expect(a.rows).toHaveLength(0);
    await vi.waitFor(() => expect(a.rows).toHaveLength(1));
    expect(relay.inFlight).toBe(0);
  });
});

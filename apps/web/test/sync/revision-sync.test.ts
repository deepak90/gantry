import type { ChangesInfo, ProjectRevisionRow } from '@collab/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync } from '../../src/sync/revision-sync';
import type { RevisionTransport } from '../../src/sync/transport';
import {
  PROJECT_ID,
  addTask,
  baseSnapshot,
  disposeAll,
  joinClient,
  loadResult,
  localDate,
  report,
  settle,
  sleep,
  storeJson,
  task,
  type Client,
} from './helpers';

/** Holds every submit until `release()`, so a client keeps editing a record it still considers new. */
function gatedTransport(inner: RevisionTransport): RevisionTransport & { release(): void } {
  let open = false;
  const waiting: Array<() => void> = [];
  return {
    async submit(rev) {
      if (!open) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return inner.submit(rev);
    },
    fetchAfter: (revisionNo) => inner.fetchAfter(revisionNo),
    subscribe: (handlers) => inner.subscribe(handlers),
    release() {
      open = true;
      for (const resume of waiting.splice(0)) {
        resume();
      }
    },
  };
}

/** Delivers the next broadcast row only after the one following it, so revision k+1 arrives before k. */
function reorderingTransport(inner: RevisionTransport) {
  let holdNext = false;
  let held: ProjectRevisionRow | undefined;
  let fetchCalls = 0;
  const transport: RevisionTransport = {
    submit: (rev) => inner.submit(rev),
    async fetchAfter(revisionNo) {
      fetchCalls++;
      return inner.fetchAfter(revisionNo);
    },
    subscribe: (handlers) =>
      inner.subscribe({
        onStatus: handlers.onStatus,
        onRevision(row) {
          if (holdNext) {
            holdNext = false;
            held = row;
            return;
          }
          handlers.onRevision(row);
          if (held) {
            const late = held;
            held = undefined;
            handlers.onRevision(late);
          }
        },
      }),
  };
  return {
    transport,
    holdNextRow: () => {
      holdNext = true;
    },
    get fetchCalls() {
      return fetchCalls;
    },
  };
}

describe('RevisionSync through the InMemoryRelay (headless Bryntum engine)', () => {
  let relay: InMemoryRelay;
  let clients: Client[];

  beforeEach(() => {
    relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    clients = [];
  });

  afterEach(() => {
    disposeAll(clients);
  });

  async function join(id: string, transport?: RevisionTransport): Promise<Client> {
    const client = await joinClient(relay, id, loadResult(baseSnapshot()), transport);
    clients.push(client);
    return client;
  }

  it('(a) converges when A adds a task with a dependency while B moves another task', async () => {
    const A = await join('A');
    const B = await join('B');

    const [added] = addTask(A, { name: 'Build-out', duration: 2 });
    A.project.dependencyStore.add({ fromEvent: 2, toEvent: added!.id });
    await task(B, 1).setStartDate(new Date(2026, 10, 4));

    report('(a)', await settle(clients, relay));

    expect(storeJson(A.project)).toBe(storeJson(B.project));
    expect(typeof added?.id).toBe('number');
    expect(task(B, added!.id).name).toBe('Build-out');
    expect(localDate(task(A, 1).startDate)).toBe('2026-11-04');
    expect(localDate(task(B, 1).startDate)).toBe('2026-11-04');
    expect(B.project.dependencyStore.count).toBe(2);
    expect(A.sync.state).toMatchObject({ status: 'synced', pending: 0, lastRevision: relay.currentRevisionNo });
    expect(B.sync.state).toMatchObject({ status: 'synced', pending: 0, lastRevision: relay.currentRevisionNo });
  });

  it('(b) a task deleted in A disappears in B together with its dependency', async () => {
    const A = await join('A');
    const B = await join('B');

    task(A, 2).remove();
    report('(b)', await settle(clients, relay));

    expect(B.project.taskStore.getById(2)).toBeFalsy();
    expect(B.project.taskStore.count).toBe(2);
    expect(B.project.dependencyStore.count).toBe(0);
    expect(storeJson(A.project)).toBe(storeJson(B.project));
  });

  it('(c) phantom ids are replaced after the echo, and the same phantom sent twice yields one real id', async () => {
    const gate = gatedTransport(relay.connect('A'));
    const A = await join('A', gate);
    const B = await join('B');
    const notifications: ChangesInfo[] = [];
    A.project.on({
      revisionNotification: (event: { changes: ChangesInfo }) => {
        notifications.push(JSON.parse(JSON.stringify(event.changes)) as ChangesInfo);
      },
    });

    const [added] = addTask(A, { name: 'Draft', duration: 1 });
    const phantom = String(added!.id);
    expect(phantom.startsWith('_generated')).toBe(true);
    await vi.waitFor(() => expect(A.sync.state.pending).toBe(1));

    // Edit the new record before its echo: Bryntum reports it as added again, with the same phantom id.
    added!.name = 'Renamed before echo';
    await vi.waitFor(() => expect(A.sync.state.pending).toBe(2));
    expect(notifications).toHaveLength(2);
    expect(notifications[1]?.tasks?.added?.[0]?.$PhantomId).toBe(phantom);
    expect(relay.revisionCount).toBe(0);

    gate.release();
    report('(c)', await settle(clients, relay));

    const realId = relay.realIdFor(phantom);
    expect(realId).toBe(4); // counter continues above the highest seeded task id (3)
    expect(added!.id).toBe(realId);
    expect(A.project.taskStore.count).toBe(4);
    expect(B.project.taskStore.count).toBe(4);
    expect(task(B, 4).name).toBe('Renamed before echo');
    expect(storeJson(A.project)).toBe(storeJson(B.project));
  });

  it('(d) a client that joins late, built from loadResultFor(), reaches the identical state, including revisions after its snapshot', async () => {
    const A = await join('A');
    const B = await join('B');
    addTask(A, { name: 'Phase 2', duration: 4 });
    task(B, 3).duration = 2;
    await settle(clients, relay);

    const k = A.sync.state.lastRevision;
    expect(k).toBe(relay.currentRevisionNo);
    const snapshotAtK = relay.loadResultFor(PROJECT_ID, A.project, k);
    expect(snapshotAtK.snapshot_revision).toBe(k);
    expect(snapshotAtK.revisions).toEqual([]);
    expect(snapshotAtK.snapshot.tasksData).toHaveLength(4);

    task(A, 2).name = 'Foundations (revised)';
    await sleep(150);
    task(B, 1).duration = 3;
    await settle(clients, relay);
    expect(relay.currentRevisionNo).toBeGreaterThan(k);

    const C = await joinClient(relay, 'C', {
      ...snapshotAtK,
      revisions: relay.rowsAfter(k),
      current_revision: relay.currentRevisionNo,
    });
    clients.push(C);
    report('(d)', await settle(clients, relay));

    expect(C.sync.state.lastRevision).toBe(relay.currentRevisionNo);
    expect(storeJson(C.project)).toBe(storeJson(A.project));
    expect(storeJson(C.project)).toBe(storeJson(B.project));

    const D = await joinClient(relay, 'D', relay.loadResultFor(PROJECT_ID, B.project, B.sync.state.lastRevision));
    clients.push(D);
    await settle(clients, relay);
    expect(storeJson(D.project)).toBe(storeJson(A.project));
  });

  it('(e) edits made while B is offline are submitted after reconnect, without duplicates', async () => {
    const A = await join('A');
    const B = await join('B');

    relay.disconnect('B');
    await vi.waitFor(() => expect(B.sync.state.connection).toBe('reconnecting'));

    const [offlineTask] = addTask(B, { name: 'Added offline', duration: 1 });
    await sleep(150);
    task(B, 2).duration = 5;
    await vi.waitFor(() => expect(B.sync.state.pending).toBe(2));
    expect(B.sync.state.status).toBe('pending');
    expect(B.sync.state.lastFailure).toMatch(/offline/);
    expect(relay.revisionCount).toBe(0);

    task(A, 1).name = 'Edited while B was away';
    await sleep(150);
    await vi.waitFor(() => expect(A.sync.state.pending).toBe(0));
    expect(B.sync.state.lastRevision).toBe(0);

    relay.reconnect('B');
    report('(e)', await settle(clients, relay));

    expect(B.sync.state).toMatchObject({ status: 'synced', pending: 0, connection: 'connected' });
    expect(typeof offlineTask!.id).toBe('number');
    expect(A.project.taskStore.count).toBe(4);
    expect(B.project.taskStore.count).toBe(4);
    expect(task(A, 2).duration).toBe(5);
    expect(task(B, 1).name).toBe('Edited while B was away');
    expect(storeJson(A.project)).toBe(storeJson(B.project));
    const statuses = B.states.map((state) => state.status);
    expect(statuses).toContain('pending');
    expect(statuses.at(-1)).toBe('synced');
    expect(statuses).not.toContain('error');
  });

  it('(e2) a lost submit response is retried and deduplicated by the server', async () => {
    const A = await join('A');
    const B = await join('B');

    relay.failNextSubmits(1, 'after');
    task(B, 3).name = 'Lost response';
    report('(e2)', await settle(clients, relay));

    // Bryntum numbers local revisions with a process-wide counter, so match on the client only.
    const rowsFromB = relay.allRows().filter((row) => row.client_id === 'B');
    expect(rowsFromB).toHaveLength(1);
    expect(rowsFromB[0]!.changes.tasks?.updated).toEqual([{ id: 3, name: 'Lost response' }]);
    expect(task(A, 3).name).toBe('Lost response');
    expect(B.states.some((state) => state.lastFailure?.includes('after the server accepted'))).toBe(true);
    expect(storeJson(A.project)).toBe(storeJson(B.project));
  });

  it('(e3) submits failing before they reach the server are retried with backoff until accepted', async () => {
    const A = await join('A');
    const B = await join('B');

    relay.failNextSubmits(2, 'before');
    task(B, 1).duration = 4;
    await vi.waitFor(() => expect(B.sync.state.lastFailure).toMatch(/before the server received/));
    expect(B.sync.state.status).toBe('pending');

    report('(e3)', await settle(clients, relay));
    expect(B.sync.state.status).toBe('synced');
    expect(task(A, 1).duration).toBe(4);
    expect(storeJson(A.project)).toBe(storeJson(B.project));
  });

  it('(e4) broadcasts held by pause() are delivered in order on resume()', async () => {
    const A = await join('A');
    const B = await join('B');

    relay.pause();
    task(A, 1).name = 'First';
    await sleep(150);
    task(A, 2).name = 'Second';
    await sleep(150);
    await vi.waitFor(() => expect(A.sync.state.pending).toBe(0)); // the server answers the originator directly
    expect(relay.heldCount).toBeGreaterThanOrEqual(2);
    expect(B.sync.state.lastRevision).toBe(0);

    relay.resume();
    report('(e4)', await settle(clients, relay));

    expect(B.applied).toEqual(Array.from({ length: relay.currentRevisionNo }, (_, i) => i + 1));
    expect(task(B, 1).name).toBe('First');
    expect(task(B, 2).name).toBe('Second');
    expect(storeJson(A.project)).toBe(storeJson(B.project));
  });

  it('(f) a revision arriving before its predecessor is fetched and applied in order', async () => {
    const reorder = reorderingTransport(relay.connect('B'));
    const A = await join('A');
    const B = await join('B', reorder.transport);
    await settle(clients, relay);
    const fetchesBefore = reorder.fetchCalls;

    reorder.holdNextRow();
    task(A, 1).name = 'revision k';
    await sleep(150);
    task(A, 2).name = 'revision k+1';
    await sleep(150);
    report('(f)', await settle(clients, relay));

    expect(reorder.fetchCalls).toBeGreaterThan(fetchesBefore);
    expect(B.applied).toEqual(Array.from({ length: relay.currentRevisionNo }, (_, i) => i + 1));
    expect(task(B, 1).name).toBe('revision k');
    expect(task(B, 2).name).toBe('revision k+1');
    expect(storeJson(A.project)).toBe(storeJson(B.project));
  });

  it('dispose() stops submitting and receiving', async () => {
    const A = await join('A');
    const B = await join('B');

    A.sync.dispose();
    task(A, 1).name = 'never sent';
    await sleep(300);
    expect(relay.revisionCount).toBe(0);

    task(B, 2).name = 'sent by B';
    await settle([B], relay);
    expect(relay.revisionCount).toBeGreaterThan(0);
    expect(A.sync.state.lastRevision).toBe(0);
    expect(task(A, 2).name).toBe('Foundations');
  });

  it('init() refuses a project without revisionsEnabled', async () => {
    const { ProjectModel } = await import('@bryntum/gantt');
    const project = new ProjectModel({ startDate: '2026-11-02' });
    const sync = new RevisionSync(project, relay.connect('X'), { sessionId: 'X', projectId: PROJECT_ID });
    await expect(sync.init(loadResult(baseSnapshot()))).rejects.toThrow(/revisionsEnabled/);
    sync.dispose();
    project.destroy();
  });
});

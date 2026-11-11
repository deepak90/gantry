import type { ProjectModel } from '@bryntum/gantt';
import type { ChangesInfo, IncomingRevision, OutgoingRevision, ProjectRevisionRow, StoreChanges } from '@collab/shared';
import { describe, expect, it, vi } from 'vitest';
import { RevisionSync, normalizeIncomingChanges, type SyncState } from '../../src/sync/revision-sync';
import {
  RevisionRejectedError,
  TransportUnavailableError,
  type RevisionTransport,
  type TransportHandlers,
} from '../../src/sync/transport';
import { PROJECT_ID, baseSnapshot, loadResult } from './helpers';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** Records the calls RevisionSync makes, and lets tests fire `revisionNotification`. */
class FakeProject {
  calls: string[] = [];
  applied: IncomingRevision[] = [];
  isDestroyed = false;
  private handler: ((event: { localRevisionId: string; changes: ChangesInfo; clientId: string }) => void) | undefined;
  stm = {
    revisionsEnabled: true,
    disable: () => this.calls.push('stm.disable'),
    enable: () => this.calls.push('stm.enable'),
    resetQueue: () => this.calls.push('stm.resetQueue'),
    on: (config: Record<string, unknown>) => {
      this.calls.push(`stm.on(${Object.keys(config).join(',')})`);
      return () => {
        this.calls.push('stm.detach');
      };
    },
    un: () => undefined,
  };

  async commitAsync(): Promise<void> {
    this.calls.push('commitAsync');
  }

  async loadInlineData(data: object): Promise<void> {
    this.calls.push(`loadInlineData(${Object.keys(data).join(',')})`);
  }

  initRevisions(clientId: string, revisionId?: string): void {
    this.calls.push(`initRevisions(${clientId},${revisionId})`);
  }

  applyRevisions(revisions: IncomingRevision[]): Promise<unknown> {
    this.applied.push(...revisions);
    return Promise.resolve();
  }

  on(config: Record<string, unknown>): () => void {
    this.handler = config.revisionNotification as typeof this.handler;
    this.calls.push('on(revisionNotification)');
    return () => {
      this.handler = undefined;
      this.calls.push('detach');
    };
  }

  un(): void {}

  queue(fn: () => unknown): Promise<unknown> {
    return Promise.resolve().then(fn);
  }

  notify(localRevisionId: string, changes: ChangesInfo = { tasks: { updated: [{ id: 1, name: localRevisionId }] } }): void {
    this.handler?.({ localRevisionId, changes, clientId: 'S' });
  }

  asProject(): ProjectModel {
    return this as unknown as ProjectModel;
  }
}

function row(revisionNo: number, clientId = 'other', localRevisionId = `local-${revisionNo}`): ProjectRevisionRow {
  return {
    id: `r${revisionNo}`,
    project_id: PROJECT_ID,
    revision_no: revisionNo,
    client_id: clientId,
    local_revision_id: localRevisionId,
    conflict_resolution_for: null,
    changes: { tasks: { updated: [{ id: 1, name: `r${revisionNo}` }] } },
    actor_user_id: null,
    origin: 'human',
    created_at: '2026-10-21T00:00:00Z',
  };
}

class FakeTransport implements RevisionTransport {
  submitted: OutgoingRevision[] = [];
  fetches: number[] = [];
  handlers: TransportHandlers | undefined;
  unsubscribed = 0;
  nextRevisionNo = 1;
  submitImpl: (rev: OutgoingRevision) => Promise<ProjectRevisionRow> = async (rev) =>
    row(this.nextRevisionNo++, rev.clientId, String(rev.localRevisionId));
  fetchImpl: (after: number) => Promise<ProjectRevisionRow[]> = async () => [];

  submit(rev: OutgoingRevision): Promise<ProjectRevisionRow> {
    this.submitted.push(rev);
    return this.submitImpl(rev);
  }

  fetchAfter(revisionNo: number): Promise<ProjectRevisionRow[]> {
    this.fetches.push(revisionNo);
    return this.fetchImpl(revisionNo);
  }

  subscribe(handlers: TransportHandlers): () => void {
    this.handlers = handlers;
    return () => {
      this.unsubscribed++;
      this.handlers = undefined;
    };
  }
}

function setup(options: { snapshotRevision?: number; revisions?: ProjectRevisionRow[]; resyncIntervalMs?: number } = {}) {
  const project = new FakeProject();
  const transport = new FakeTransport();
  const states: SyncState[] = [];
  const sync = new RevisionSync(project.asProject(), transport, {
    sessionId: 'S',
    projectId: PROJECT_ID,
    onState: (state) => states.push(state),
    backoff: { initialMs: 5, maxMs: 20 },
    onWarning: () => undefined,
    // The periodic re-read is opted into by the tests that cover it.
    resyncIntervalMs: options.resyncIntervalMs ?? 0,
  });
  const load = loadResult(baseSnapshot(), options.snapshotRevision ?? 7, options.revisions ?? []);
  return { project, transport, sync, states, load };
}

describe('RevisionSync (fake project, protocol behavior)', () => {
  it('runs the documented init sequence, replays catch-up revisions, then subscribes', async () => {
    const { project, transport, sync, load } = setup({ revisions: [row(8), row(9)] });
    transport.nextRevisionNo = 10;
    await sync.init(load);

    expect(project.calls).toEqual([
      'stm.disable',
      'stm.resetQueue',
      'loadInlineData(tasksData,dependenciesData,resourcesData,assignmentsData)',
      'stm.enable',
      'initRevisions(S,7)',
      'on(revisionNotification)',
      'stm.on(recordingStart)',
      // Each catch-up revision waits for a queued commit, which finishes a local commit still running.
      'commitAsync',
      'commitAsync',
    ]);
    expect(project.applied.map((revision) => revision.revisionId)).toEqual(['8', '9']);
    expect(project.applied[0]).toMatchObject({ revisionId: '8', localRevisionId: 'local-8', clientId: 'other' });
    expect(transport.handlers).toBeDefined();
    expect(sync.state).toEqual({ status: 'synced', pending: 0, lastRevision: 9, connection: 'idle' });
    await expect(sync.init(load)).rejects.toThrow(/only be called once/);
  });

  it('submits revisions in order and applies its own echo through the project', async () => {
    const { project, transport, sync, load } = setup();
    transport.nextRevisionNo = 8;
    await sync.init(load);

    project.notify('local-1');
    project.notify('local-2');
    expect(sync.state).toMatchObject({ status: 'pending', pending: 2 });
    await vi.waitFor(() => expect(sync.state.pending).toBe(0));

    expect(transport.submitted.map((rev) => rev.localRevisionId)).toEqual(['local-1', 'local-2']);
    expect(transport.submitted[0]).toMatchObject({ clientId: 'S', changes: { tasks: { updated: [{ id: 1, name: 'local-1' }] } } });
    expect(project.applied.map((revision) => [revision.revisionId, revision.clientId, revision.localRevisionId])).toEqual([
      ['8', 'S', 'local-1'],
      ['9', 'S', 'local-2'],
    ]);
    expect(sync.state).toEqual({ status: 'synced', pending: 0, lastRevision: 9, connection: 'idle' });
  });

  it('gives a record re-added by an undo its id back, in submitted and in applied revisions', async () => {
    const { project, transport, sync, load } = setup();
    transport.nextRevisionNo = 8;
    await sync.init(load);
    // Bryntum lists a record whose removal the server confirmed as new again: its id is the $PhantomId.
    const readded: ChangesInfo = {
      tasks: { added: [{ $PhantomId: 21, name: 'Frame' }], $input: { added: [{ $PhantomId: 21, name: 'Frame' }] } },
      dependencies: { added: [{ $PhantomId: 'p-new', fromEvent: 21, toEvent: 3 }] },
    };
    project.notify('local-1', readded);
    await vi.waitFor(() => expect(sync.state.pending).toBe(0));
    expect(transport.submitted[0]?.changes.tasks?.added).toEqual([{ $PhantomId: 21, id: 21, name: 'Frame' }]);
    expect(transport.submitted[0]?.changes.tasks?.$input?.added).toEqual([{ $PhantomId: 21, id: 21, name: 'Frame' }]);
    expect(transport.submitted[0]?.changes.dependencies?.added).toEqual([{ $PhantomId: 'p-new', fromEvent: 21, toEvent: 3 }]);

    // Revisions stored before the fix are repaired on the way in.
    transport.handlers!.onRevision({ ...row(9), changes: readded });
    await vi.waitFor(() => expect(sync.state.lastRevision).toBe(9));
    await sync.whenApplied();
    expect(project.applied.at(-1)?.changes.tasks?.$input?.added).toEqual([{ $PhantomId: 21, id: 21, name: 'Frame' }]);
  });

  it('catchUpNow() applies what the server holds before resolving, and rejects when it cannot be reached', async () => {
    const { project, transport, sync, load } = setup();
    await sync.init(load);
    transport.fetchImpl = async (after) => [row(after + 1), row(after + 2)];
    await sync.catchUpNow();
    expect(project.applied.map((revision) => revision.revisionId)).toEqual(['8', '9']);
    expect(sync.state.lastRevision).toBe(9);

    transport.fetchImpl = async () => {
      throw new TransportUnavailableError('offline');
    };
    await expect(sync.catchUpNow()).rejects.toThrow(/offline/);
  });

  it('waits for a queued commit before each revision, so a local commit in flight finishes first', async () => {
    const { project, transport, sync, load } = setup();
    await sync.init(load);
    project.calls.length = 0;
    transport.handlers!.onRevision(row(8));
    await vi.waitFor(() => expect(sync.state.lastRevision).toBe(8));
    await sync.whenApplied();
    expect(project.calls).toEqual(['commitAsync']);
    expect(project.applied.map((revision) => revision.revisionId)).toEqual(['8']);
  });

  it('ignores duplicates and fills gaps with fetchAfter(last), applying in order', async () => {
    const { project, transport, sync, load } = setup();
    await sync.init(load);
    transport.fetchImpl = async (after) => [row(after + 1), row(after + 2)];

    transport.handlers!.onRevision(row(8));
    transport.handlers!.onRevision(row(8)); // duplicate
    transport.handlers!.onRevision(row(10)); // gap: 9 missing
    expect(sync.hasBufferedRevisions).toBe(true);
    await vi.waitFor(() => expect(sync.state.lastRevision).toBe(10));

    expect(transport.fetches).toEqual([8]);
    expect(project.applied.map((revision) => revision.revisionId)).toEqual(['8', '9', '10']);
    expect(sync.hasBufferedRevisions).toBe(false);
    transport.handlers!.onRevision(row(9)); // late arrival of the fetched row
    await flush();
    expect(project.applied).toHaveLength(3);
  });

  it('fetches after the last revision when the channel reports connected', async () => {
    const { project, transport, sync, load } = setup();
    await sync.init(load);
    transport.fetchImpl = async () => [row(8)];

    transport.handlers!.onStatus('connected');
    await vi.waitFor(() => expect(sync.state.lastRevision).toBe(8));
    expect(transport.fetches).toEqual([7]);
    expect(project.applied.map((revision) => revision.revisionId)).toEqual(['8']);
    expect(sync.state.connection).toBe('connected');
  });

  it('retries a fetch that failed, with backoff', async () => {
    const { transport, sync, load } = setup();
    await sync.init(load);
    let attempts = 0;
    transport.fetchImpl = async () => {
      attempts++;
      if (attempts === 1) {
        throw new TransportUnavailableError('offline');
      }
      return [row(8)];
    };
    transport.handlers!.onRevision(row(9));
    await vi.waitFor(() => expect(sync.state.lastRevision).toBe(9));
    expect(attempts).toBe(2);
    expect(sync.state.status).toBe('synced');
  });

  it('keeps retrying transient submit failures (status pending) and stops on a rejection (status error) until retry()', async () => {
    const { transport, sync, load, states } = setup();
    await sync.init(load);
    let attempt = 0;
    transport.submitImpl = async (rev) => {
      attempt++;
      if (attempt <= 2) {
        throw new TransportUnavailableError('network down');
      }
      return row(8, rev.clientId, String(rev.localRevisionId));
    };
    const project = (sync as unknown as { project: FakeProject }).project;
    project.notify('local-1');
    await vi.waitFor(() => expect(sync.state.status).toBe('synced'));
    expect(attempt).toBe(3);
    expect(sync.state.lastFailure).toBeUndefined();
    // The failures were reported while retrying, as 'pending' with the failure message, never as 'error'.
    expect(states.some((state) => state.status === 'pending' && state.lastFailure === 'network down')).toBe(true);
    expect(states.every((state) => state.status !== 'error')).toBe(true);

    transport.submitImpl = async () => {
      throw new RevisionRejectedError('calendars not allowed', 'STORE_NOT_ALLOWED');
    };
    project.notify('local-2');
    await vi.waitFor(() => expect(sync.state.status).toBe('error'));
    expect(sync.state.error).toMatch(/local-2 was rejected.*calendars not allowed/);
    expect(sync.state.pending).toBe(1);
    const attemptsBefore = transport.submitted.length;
    await flush();
    expect(transport.submitted.length).toBe(attemptsBefore); // no automatic retry

    transport.submitImpl = async (rev) => row(9, rev.clientId, String(rev.localRevisionId));
    sync.retry();
    await vi.waitFor(() => expect(sync.state).toMatchObject({ status: 'synced', pending: 0, lastRevision: 9 }));
  });

  it('confirms an outbox entry from its broadcast echo even before the submit response arrives', async () => {
    const { project, transport, sync, load } = setup();
    await sync.init(load);
    let resolveSubmit: ((row: ProjectRevisionRow) => void) | undefined;
    transport.submitImpl = () => new Promise((resolve) => (resolveSubmit = resolve));

    project.notify('local-1');
    await vi.waitFor(() => expect(resolveSubmit).toBeDefined());
    expect(sync.state.pending).toBe(1);

    transport.handlers!.onRevision(row(8, 'S', 'local-1'));
    expect(sync.state).toMatchObject({ status: 'synced', pending: 0, lastRevision: 8 });
    resolveSubmit!(row(8, 'S', 'local-1'));
    await flush();
    expect(project.applied).toHaveLength(1);
  });

  it('wakes a backoff sleep when the connection comes back', async () => {
    const { project, transport, sync, load } = setup();
    await sync.init(load);
    (sync as unknown as { backoff: { initialMs: number; maxMs: number; factor: number } }).backoff = {
      initialMs: 60_000,
      maxMs: 60_000,
      factor: 2,
    };
    let fail = true;
    transport.submitImpl = async (rev) => {
      if (fail) {
        throw new TransportUnavailableError('offline');
      }
      return row(8, rev.clientId, String(rev.localRevisionId));
    };
    project.notify('local-1');
    await vi.waitFor(() => expect(sync.state.lastFailure).toBe('offline'));
    fail = false;
    transport.handlers!.onStatus('connected');
    await vi.waitFor(() => expect(sync.state.status).toBe('synced'));
    expect(transport.submitted).toHaveLength(2);
  });

  it('treats a failing applyRevisions() as fatal: nothing more is applied or sent, retry() cannot clear it, a reload is needed', async () => {
    const { project, transport, sync, load, states } = setup();
    await sync.init(load);
    let rejectNext = true;
    const applied: string[] = [];
    project.applyRevisions = (revisions) => {
      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error('engine exploded'));
      }
      applied.push(...revisions.map((revision) => String(revision.revisionId)));
      return Promise.resolve();
    };
    transport.handlers!.onRevision(row(8));
    await vi.waitFor(() => expect(sync.state.status).toBe('error'));
    expect(sync.state).toMatchObject({ status: 'error', recovery: 'reload', lastRevision: 8 });
    expect(sync.state.error).toMatch(/Failed to apply revision 8: engine exploded/);

    // A later broadcast, a reconnect, a retry and a local edit change nothing: the engine is out of the protocol.
    transport.handlers!.onRevision(row(9));
    transport.handlers!.onStatus('connected');
    sync.retry();
    project.notify('local-1');
    await flush();
    expect(applied).toEqual([]);
    expect(transport.fetches).toEqual([]);
    expect(transport.submitted).toEqual([]);
    expect(sync.state).toMatchObject({ status: 'error', recovery: 'reload', lastRevision: 8, pending: 1 });
    // Once the failure is reported the badge never returns to synced or pending.
    const firstError = states.findIndex((state) => state.status === 'error');
    expect(firstError).toBeGreaterThan(0);
    expect(states.slice(firstError).every((state) => state.status === 'error' && state.recovery === 'reload')).toBe(true);
  });

  it('re-reads the log periodically while connected, so a broadcast lost by Realtime is recovered without another revision', async () => {
    const { project, transport, sync, load } = setup({ resyncIntervalMs: 15 });
    await sync.init(load);
    // The server is at 8 but the broadcast of 8 never arrived.
    transport.fetchImpl = async (after) => (after < 8 ? [row(8)] : []);
    sync.resync(); // not connected yet: nothing to do
    await flush();
    expect(transport.fetches).toEqual([]);

    transport.handlers!.onStatus('connected');
    await vi.waitFor(() => expect(sync.state.lastRevision).toBe(8));
    await vi.waitFor(() => expect(transport.fetches.length).toBeGreaterThanOrEqual(3));
    expect(transport.fetches[0]).toBe(7); // the catch-up on connect
    expect(transport.fetches.slice(1).every((after) => after === 8)).toBe(true); // the periodic re-reads
    expect(project.applied.map((revision) => revision.revisionId)).toEqual(['8']);
    expect(sync.state).toMatchObject({ status: 'synced', lastRevision: 8 });

    transport.handlers!.onStatus('reconnecting');
    const whileDisconnected = transport.fetches.length;
    sync.resync();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(transport.fetches.length).toBe(whileDisconnected); // the timer stops and resync() waits for the channel

    transport.handlers!.onStatus('connected');
    await vi.waitFor(() => expect(transport.fetches.length).toBeGreaterThan(whileDisconnected + 1));
    sync.dispose();
    const afterDispose = transport.fetches.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(transport.fetches.length).toBe(afterDispose);
  });

  it('resync() re-reads the log at once; resyncIntervalMs 0 turns the periodic check off', async () => {
    const { transport, sync, load } = setup({ resyncIntervalMs: 0 });
    await sync.init(load);
    transport.handlers!.onStatus('connected');
    await vi.waitFor(() => expect(transport.fetches).toEqual([7]));
    sync.resync();
    await vi.waitFor(() => expect(transport.fetches).toEqual([7, 7]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(transport.fetches).toEqual([7, 7]);
  });

  it('dispose() detaches the listener, unsubscribes and ignores late events', async () => {
    const { project, transport, sync, load } = setup();
    await sync.init(load);
    const handlers = transport.handlers!;
    sync.dispose();
    expect(project.calls.slice(-2)).toEqual(['detach', 'stm.detach']);
    expect(transport.unsubscribed).toBe(1);
    handlers.onRevision(row(8));
    handlers.onStatus('connected');
    project.notify('local-1');
    await flush();
    expect(project.applied).toHaveLength(0);
    expect(transport.submitted).toHaveLength(0);
    expect(sync.state).toMatchObject({ lastRevision: 7, pending: 0 });
  });

  it('normalizeIncomingChanges() drops removal entries without an id', () => {
    const changes: ChangesInfo = {
      tasks: { removed: [{ id: 1 }, { id: null }], $input: { removed: [{ id: 1 }, {} as { id: unknown }] } },
      project: { endDate: '2026-11-09' } as StoreChanges,
    };
    normalizeIncomingChanges(changes);
    expect(changes.tasks!.removed).toEqual([{ id: 1 }]);
    expect(changes.tasks!.$input!.removed).toEqual([{ id: 1 }]);
    expect(changes.project).toEqual({ endDate: '2026-11-09' });
  });
});

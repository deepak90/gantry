import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import { PresenceSession } from '../../src/presence/session';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import type { RevisionTransport } from '../../src/sync/transport';
import type { SessionRegistration } from '../../src/supabase/session';
import {
  ProjectSessionManager,
  describeBootError,
  sessionKey,
  type ProjectSessionDeps,
  type ProjectSessionHandle,
} from '../../src/app/project-session';
import { PROJECT_ID, baseSnapshot, loadResult, newProject, sleep } from '../sync/helpers';

interface Calls {
  resolve: number;
  register: number;
  load: number;
  profile: number;
  createProject: number;
  createTransport: number;
  subscribe: number;
  stop: number;
}

function fakeDeps(relay: InMemoryRelay, overrides: Partial<ProjectSessionDeps> = {}) {
  const calls: Calls = { resolve: 0, register: 0, load: 0, profile: 0, createProject: 0, createTransport: 0, subscribe: 0, stop: 0 };
  const deps: ProjectSessionDeps = {
    async resolveProjectId() {
      calls.resolve++;
      return PROJECT_ID;
    },
    async registerSession(): Promise<SessionRegistration> {
      calls.register++;
      return {
        sessionId: `00000000-0000-4000-8000-00000000000${calls.register}`,
        userId: 'user-1',
        stop: () => {
          calls.stop++;
        },
      };
    },
    async loadProject() {
      calls.load++;
      return loadResult(baseSnapshot());
    },
    async loadProfile() {
      calls.profile++;
      return { displayName: 'Priya Mehta', color: '#2563eb' };
    },
    createProject() {
      calls.createProject++;
      return newProject();
    },
    createTransport(_projectId, sessionId): RevisionTransport {
      calls.createTransport++;
      const inner = relay.connect(sessionId);
      return {
        submit: (rev) => inner.submit(rev),
        fetchAfter: (revisionNo) => inner.fetchAfter(revisionNo),
        subscribe: (handlers) => {
          calls.subscribe++;
          return inner.subscribe(handlers);
        },
      };
    },
    ...overrides,
  };
  return { deps, calls };
}

function ready(handle: ProjectSessionHandle) {
  const state = handle.state;
  if (state.phase !== 'ready') {
    throw new Error(`expected ready, got ${state.phase}`);
  }
  return state;
}

describe('ProjectSessionManager', () => {
  let relay: InMemoryRelay;
  let manager: ProjectSessionManager;
  const handles: ProjectSessionHandle[] = [];

  beforeEach(() => {
    relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: baseSnapshot() });
    manager = new ProjectSessionManager();
  });

  afterEach(() => {
    for (const handle of handles.splice(0)) {
      manager.discard(handle);
    }
  });

  it('survives the StrictMode mount/unmount/mount with one session, one subscription and one project', async () => {
    const { deps, calls } = fakeDeps(relay);
    const key = sessionKey('user-1');
    const first = manager.acquire(key, () => deps);
    handles.push(first);
    expect(first.state).toEqual({ phase: 'resolving' });
    manager.release(first); // StrictMode cleanup runs synchronously before the remount
    const second = manager.acquire(key, () => deps);
    expect(second).toBe(first);
    expect(manager.size).toBe(1);

    const phases: string[] = [];
    first.subscribe(() => phases.push(first.state.phase));
    await vi.waitFor(() => expect(first.state.phase).toBe('ready'), { timeout: 5000 });
    await sleep(20); // the disposal scheduled by the first release must not have fired
    expect(first.isDisposed).toBe(false);
    expect(calls).toMatchObject({ resolve: 1, register: 1, load: 1, profile: 1, createProject: 1, createTransport: 1, subscribe: 1, stop: 0 });
    expect(phases.slice(0, 3)).toEqual(['registering', 'loading', 'syncing']);

    const state = ready(first);
    expect(state.projectId).toBe(PROJECT_ID);
    expect(state.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    expect(state.profile).toEqual({ displayName: 'Priya Mehta', color: '#2563eb' });
    expect(state.load.project.name).toBe('Riverside Clinic build-out');
    expect(state.project.taskStore.count).toBe(3);
    await vi.waitFor(() => expect(ready(first).sync).toMatchObject({ status: 'synced', pending: 0, connection: 'connected' }));

    // Edits made through the shared project reach the server, and the badge state follows.
    (state.project.taskStore.getById(1) as unknown as { name: string }).name = 'Renamed in the shell';
    await vi.waitFor(() => expect(relay.revisionCount).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(ready(first).sync).toMatchObject({ status: 'synced', pending: 0, lastRevision: 1 }));
    expect(relay.allRows()[0]?.client_id).toBe(state.sessionId);

    // The real unmount: the last release disposes after the current task.
    manager.release(second);
    manager.release(first);
    expect(first.isDisposed).toBe(false);
    await sleep(20);
    expect(first.isDisposed).toBe(true);
    expect(manager.size).toBe(0);
    expect(calls.stop).toBe(1);
    expect(state.project.isDestroyed).toBe(true);
    handles.length = 0;
  });

  it('stops a session that finished registering after the handle was released', async () => {
    let finishRegistration: (() => void) | undefined;
    const { deps, calls } = fakeDeps(relay, {
      registerSession: () =>
        new Promise((resolve) => {
          finishRegistration = () => {
            calls.register++;
            resolve({ sessionId: '00000000-0000-4000-8000-0000000000aa', userId: 'user-1', stop: () => calls.stop++ });
          };
        }),
    });
    const handle = manager.acquire(sessionKey('user-1'), () => deps);
    await vi.waitFor(() => expect(handle.state.phase).toBe('registering'));
    manager.release(handle);
    await sleep(20);
    expect(handle.isDisposed).toBe(true);
    expect(manager.size).toBe(0);

    finishRegistration?.();
    await vi.waitFor(() => expect(calls.stop).toBe(1));
    expect(calls.load).toBe(0);
    expect(calls.createProject).toBe(0);
    expect(handle.state.phase).toBe('registering');
  });

  it('reports a failed boot with an actionable message, releases what it opened and can be discarded and rerun', async () => {
    const { deps, calls } = fakeDeps(relay, {
      loadProject: () => Promise.reject(new Error('load_project failed (42501): load_project: not a member of project x')),
    });
    const key = sessionKey('user-1', PROJECT_ID);
    const failed = manager.acquire(key, () => deps);
    handles.push(failed);
    await vi.waitFor(() => expect(failed.state.phase).toBe('error'));
    expect(failed.state).toEqual({ phase: 'error', message: 'load_project failed (42501): load_project: not a member of project x' });
    expect(calls.stop).toBe(1); // the heartbeat of the registered session is stopped
    expect(failed.isDisposed).toBe(false); // the error stays visible until the user acts

    manager.discard(failed);
    expect(failed.isDisposed).toBe(true);
    expect(manager.size).toBe(0);

    const { deps: healthy, calls: healthyCalls } = fakeDeps(relay);
    const retried = manager.acquire(key, () => healthy);
    handles.push(retried);
    expect(retried).not.toBe(failed);
    await vi.waitFor(() => expect(retried.state.phase).toBe('ready'), { timeout: 5000 });
    expect(healthyCalls.register).toBe(1);
  });

  it('re-reads the revision log when the tab becomes visible again, until the handle is discarded', async () => {
    const { deps } = fakeDeps(relay);
    let fetches = 0;
    const counting: ProjectSessionDeps = {
      ...deps,
      createTransport(projectId, sessionId) {
        const inner = deps.createTransport(projectId, sessionId);
        return {
          ...inner,
          fetchAfter(revisionNo) {
            fetches++;
            return inner.fetchAfter(revisionNo);
          },
        };
      },
    };
    const visibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const handle = manager.acquire(sessionKey('user-3'), () => counting);
    handles.push(handle);
    await vi.waitFor(() => expect(handle.state.phase).toBe('ready'), { timeout: 5000 });
    await vi.waitFor(() => expect(ready(handle).sync.connection).toBe('connected'));
    await vi.waitFor(() => expect(fetches).toBe(1)); // the catch-up on connect

    visibility('hidden');
    await sleep(20);
    expect(fetches).toBe(1);
    visibility('visible');
    await vi.waitFor(() => expect(fetches).toBe(2));

    manager.discard(handle);
    handles.length = 0;
    visibility('visible');
    await sleep(20);
    expect(fetches).toBe(2);
  });

  it('starts presence with the session, feeds it revisions and stops it with the session', async () => {
    const hub = new InMemoryPresenceHub();
    const contexts: unknown[] = [];
    let presence: PresenceSession | undefined;
    const { deps } = fakeDeps(relay, {
      createPresence(context) {
        contexts.push(context);
        presence = new PresenceSession({
          self: { session: context.sessionId, user: context.userId, name: context.profile.displayName, color: context.profile.color ?? '#64748b', role: context.role },
          transport: hub.connect(context.sessionId),
        });
        return presence;
      },
    });
    const key = sessionKey('user-3');
    // StrictMode: mount, unmount, mount: one presence for the one boot.
    const handle = manager.acquire(key, () => deps);
    manager.release(handle);
    expect(manager.acquire(key, () => deps)).toBe(handle);
    await vi.waitFor(() => expect(handle.state.phase).toBe('ready'), { timeout: 5000 });
    const state = ready(handle);
    expect(state.presence).toBe(presence);
    expect(contexts).toEqual([{ projectId: PROJECT_ID, sessionId: state.sessionId, userId: 'user-1', role: 'pm', profile: { displayName: 'Priya Mehta', color: '#2563eb' } }]);

    const watcher = new PresenceSession({ self: { session: 'watcher', user: 'user-9', name: 'Sam Okafor', color: '#16a34a', role: 'cm' }, transport: hub.connect('watcher') });
    watcher.start();
    await vi.waitFor(() => expect(watcher.getSnapshot().peers.map((peer) => peer.name)).toEqual(['Priya Mehta']));

    manager.release(handle);
    await sleep(20);
    expect(handle.isDisposed).toBe(true);
    await vi.waitFor(() => expect(watcher.getSnapshot().peers).toHaveLength(0));
    watcher.dispose();
  });

  it('follows the transport connection in the ready state', async () => {
    const { deps } = fakeDeps(relay);
    const handle = manager.acquire(sessionKey('user-2'), () => deps);
    handles.push(handle);
    await vi.waitFor(() => expect(handle.state.phase).toBe('ready'), { timeout: 5000 });
    await vi.waitFor(() => expect(ready(handle).sync.connection).toBe('connected'));

    relay.disconnect(ready(handle).sessionId);
    await vi.waitFor(() => expect(ready(handle).sync.connection).toBe('reconnecting'));
    (ready(handle).project.taskStore.getById(2) as unknown as { name: string }).name = 'Offline edit';
    await vi.waitFor(() => expect(ready(handle).sync).toMatchObject({ status: 'pending', pending: 1 }), { timeout: 5000 });

    relay.reconnect(ready(handle).sessionId);
    await vi.waitFor(() => expect(ready(handle).sync).toMatchObject({ status: 'synced', pending: 0, connection: 'connected' }), {
      timeout: 5000,
    });
    expect(relay.revisionCount).toBe(1);
  });
});

describe('describeBootError', () => {
  it('turns an RLS refusal into membership advice and passes other messages through', () => {
    expect(describeBootError(new Error('new row violates row-level security policy for table "sessions"'))).toMatch(
      /not a member of this project[\s\S]*Ask someone on the project/,
    );
    expect(describeBootError(new Error('load_project failed (42501): nope'))).toBe('load_project failed (42501): nope');
    expect(describeBootError('plain string')).toBe('plain string');
  });

  it('keys handles by user and project', () => {
    expect(sessionKey('u1')).toBe('u1:*');
    expect(sessionKey('u1', 'p1')).toBe('u1:p1');
  });
});

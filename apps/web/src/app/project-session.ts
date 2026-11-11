/**
 * Boots one collaborating client per (user, project): the browser `sessions` row, `load_project`,
 * the shared ProjectModel and its RevisionSync. Handles are reference counted
 * so React StrictMode's development mount/unmount/mount reuses the running boot instead of
 * registering two sessions and opening two Realtime subscriptions; a handle is disposed one
 * macrotask after its last release, which a synchronous remount cancels.
 */
import type { ProjectModel } from '@bryntum/gantt';
import type { LoadProjectResult, MemberRole } from '@collab/shared';
import type { PresenceSession } from '../presence/session';
import { RevisionSync, type RevisionSyncOptions, type SyncState } from '../sync/revision-sync';
import type { RevisionTransport } from '../sync/transport';
import type { SessionRegistration } from '../supabase/session';

export interface ViewerProfile {
  displayName: string;
  /** Hex color from `profiles.color`, or null when the user has no profile row yet. */
  color: string | null;
}

/** The I/O a boot performs, injectable so the sequence is testable against the in-memory relay. */
export interface ProjectSessionDeps {
  resolveProjectId(): Promise<string>;
  registerSession(projectId: string): Promise<SessionRegistration>;
  loadProject(projectId: string): Promise<LoadProjectResult>;
  loadProfile(): Promise<ViewerProfile>;
  createProject(): ProjectModel;
  createTransport(projectId: string, sessionId: string): RevisionTransport;
  prepareSnapshot?: RevisionSyncOptions['prepareSnapshot'];
  /** Who is here, pointers and follow mode; absent in tests that do not need them. */
  createPresence?(context: PresenceContext): PresenceSession;
}

export interface PresenceContext {
  projectId: string;
  sessionId: string;
  userId: string;
  role: MemberRole;
  profile: ViewerProfile;
}

export type BootPhase = 'resolving' | 'registering' | 'loading' | 'syncing';

export const BOOT_PHASE_LABELS: Readonly<Record<BootPhase, string>> = {
  resolving: 'Finding your project…',
  registering: 'Registering this browser session…',
  loading: 'Loading the project…',
  syncing: 'Applying the latest revisions…',
};

export interface ReadyProjectSession {
  phase: 'ready';
  projectId: string;
  /** The `sessions.id`, also the Bryntum clientId. */
  sessionId: string;
  project: ProjectModel;
  /** The client's revision stream; approved changes are published through it. */
  revisions: RevisionSync;
  load: LoadProjectResult;
  profile: ViewerProfile;
  sync: SyncState;
  /** Started with the session and stopped with it, so a StrictMode remount keeps one channel. */
  presence: PresenceSession | null;
}

export type ProjectSessionState = { phase: BootPhase } | { phase: 'error'; message: string } | ReadyProjectSession;

export function sessionKey(userId: string, projectId?: string): string {
  return `${userId}:${projectId ?? '*'}`;
}

/** Turns the raw failure of a boot step into a message that says what to do about it. */
export function describeBootError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/row-level security/i.test(message)) {
    return (
      'Your account is not a member of this project, so the browser session could not be registered. ' +
      'Ask someone on the project to add you.'
    );
  }
  return message;
}

export class ProjectSessionHandle {
  readonly key: string;
  /** Managed by `ProjectSessionManager`. */
  refCount = 0;
  disposeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly listeners = new Set<() => void>();
  private current: ProjectSessionState = { phase: 'resolving' };
  private registration: SessionRegistration | undefined;
  private project: ProjectModel | undefined;
  private sync: RevisionSync | undefined;
  private presence: PresenceSession | undefined;
  private detachVisibility: (() => void) | undefined;
  private disposed = false;

  constructor(key: string, deps: ProjectSessionDeps) {
    this.key = key;
    void this.boot(deps);
  }

  get state(): ProjectSessionState {
    return this.current;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Clears a sync `error` and re-attempts the outbox (the badge's "error with retry" state). */
  retrySync(): void {
    this.sync?.retry();
  }

  /** Re-reads the revision log now; a lost broadcast is caught up without waiting for the periodic check. */
  resync(): void {
    this.sync?.resync();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.teardown();
    this.listeners.clear();
  }

  private async boot(deps: ProjectSessionDeps): Promise<void> {
    try {
      const projectId = await deps.resolveProjectId();
      if (this.disposed) {
        return;
      }
      this.set({ phase: 'registering' });
      const registration = await deps.registerSession(projectId);
      if (this.disposed) {
        registration.stop();
        return;
      }
      this.registration = registration;
      this.set({ phase: 'loading' });
      const [load, profile] = await Promise.all([deps.loadProject(projectId), deps.loadProfile()]);
      if (this.disposed) {
        return;
      }
      this.set({ phase: 'syncing' });
      const project = deps.createProject();
      this.project = project;
      const sync = new RevisionSync(project, deps.createTransport(projectId, registration.sessionId), {
        sessionId: registration.sessionId,
        projectId,
        onState: (state) => this.onSyncState(state),
        prepareSnapshot: deps.prepareSnapshot,
      });
      this.sync = sync;
      await sync.init(load);
      if (this.disposed) {
        return;
      }
      this.watchVisibility();
      const presence = deps.createPresence?.({ projectId, sessionId: registration.sessionId, userId: registration.userId, role: load.membership.role, profile });
      if (presence) {
        this.presence = presence;
        presence.setRevision(sync.state.lastRevision);
        presence.start();
      }
      this.set({
        phase: 'ready',
        projectId,
        sessionId: registration.sessionId,
        project,
        revisions: sync,
        load,
        profile,
        sync: sync.state,
        presence: presence ?? null,
      });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.teardown();
      this.set({ phase: 'error', message: describeBootError(error) });
    }
  }

  private onSyncState(sync: SyncState): void {
    this.presence?.setRevision(sync.lastRevision);
    if (this.current.phase === 'ready') {
      this.set({ ...this.current, sync });
    }
  }

  private set(state: ProjectSessionState): void {
    this.current = state;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** A tab coming back to the foreground re-reads the log: broadcasts may have been lost while it was hidden. */
  private watchVisibility(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        this.resync();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    this.detachVisibility = () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  private teardown(): void {
    this.detachVisibility?.();
    this.detachVisibility = undefined;
    this.presence?.dispose();
    this.presence = undefined;
    this.sync?.dispose();
    this.sync = undefined;
    this.project?.destroy();
    this.project = undefined;
    this.registration?.stop();
    this.registration = undefined;
  }
}

export class ProjectSessionManager {
  private readonly handles = new Map<string, ProjectSessionHandle>();

  /** Starts the boot for `key`, or joins the one already running. */
  acquire(key: string, deps: () => ProjectSessionDeps): ProjectSessionHandle {
    let handle = this.handles.get(key);
    if (!handle) {
      handle = new ProjectSessionHandle(key, deps());
      this.handles.set(key, handle);
    }
    handle.refCount++;
    if (handle.disposeTimer !== undefined) {
      clearTimeout(handle.disposeTimer);
      handle.disposeTimer = undefined;
    }
    return handle;
  }

  /** Disposes the handle once nobody holds it, after the current task (so a StrictMode remount keeps it). */
  release(handle: ProjectSessionHandle): void {
    handle.refCount = Math.max(0, handle.refCount - 1);
    if (handle.refCount === 0 && handle.disposeTimer === undefined) {
      handle.disposeTimer = setTimeout(() => {
        handle.disposeTimer = undefined;
        if (handle.refCount === 0) {
          this.drop(handle);
        }
      }, 0);
    }
  }

  /** Disposes immediately, e.g. a failed boot the user wants to run again. */
  discard(handle: ProjectSessionHandle): void {
    if (handle.disposeTimer !== undefined) {
      clearTimeout(handle.disposeTimer);
      handle.disposeTimer = undefined;
    }
    this.drop(handle);
  }

  get size(): number {
    return this.handles.size;
  }

  private drop(handle: ProjectSessionHandle): void {
    if (this.handles.get(handle.key) === handle) {
      this.handles.delete(handle.key);
    }
    handle.dispose();
  }
}

/** The app-wide manager; tests construct their own. */
export const projectSessions = new ProjectSessionManager();

import type { ProjectModel } from '@bryntum/gantt';
import {
  toIncomingRevision,
  type ChangesInfo,
  type IncomingRevision,
  type LoadProjectResult,
  type OutgoingRevision,
  type ProjectInlineData,
  type ProjectRevisionRow,
  type RevisionId,
  type RevisionOrigin,
  type StoreInputChange,
} from '@collab/shared';
import { RevisionRejectedError, describeError, type RevisionTransport, type TransportStatus } from './transport';
import { withoutFilters } from '../gantt/filters';

export type SyncStatus = 'synced' | 'pending' | 'error';
export type ConnectionStatus = TransportStatus | 'idle';
/** What clears an `error`: `retry()` for a rejected submission, a fresh boot for an engine failure. */
export type SyncRecovery = 'retry' | 'reload';

export interface SyncState {
  /** `error` needs user attention (see `recovery`); `pending` retries by itself. */
  status: SyncStatus;
  /** Local revisions the server has not accepted yet. */
  pending: number;
  /** Highest revision_no handed to the project. */
  lastRevision: number;
  error?: string;
  /** Present with `status: 'error'`. `reload`: the engine rejected a revision and this client is out of sync for good. */
  recovery?: SyncRecovery;
  /** Most recent transient failure while automatic retries continue. */
  lastFailure?: string;
  connection: ConnectionStatus;
}

export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
}

export interface RevisionSyncOptions {
  /** Unique per browser tab (the `sessions.id`); becomes the Bryntum clientId. */
  sessionId: string;
  projectId: string;
  onState?: (state: SyncState) => void;
  onRevisionApplied?: (row: ProjectRevisionRow) => void;
  onWarning?: (message: string, error?: unknown) => void;
  backoff?: BackoffOptions;
  /**
   * Turns the stored snapshot into the `loadInlineData()` argument. The app passes the Gantt
   * module's package builder (modern store keys, resource `kind` normalization); by default the
   * snapshot is loaded as stored.
   */
  prepareSnapshot?: (snapshot: ProjectInlineData) => object;
  /**
   * While the channel is connected, re-read the log this often (default 30 s; 0 disables). Realtime
   * gives a joined client no delivery guarantee, and a broadcast lost while nothing else changes
   * would otherwise only be noticed when the next revision exposes the gap.
   */
  resyncIntervalMs?: number;
}

/** Application metadata a caller attaches to one of its own local revisions. */
export interface RevisionMeta {
  origin?: RevisionOrigin;
  /** `publications.id`: the server validates the revision as that publication and completes it. */
  publicationId?: string;
}

/** A local revision the caller is waiting for; see `RevisionSync.expectLocalRevision`. */
export interface ExpectedLocalRevision {
  /** Resolves with the localRevisionId once Bryntum emitted a matching revision. */
  matched: Promise<string>;
  /** Resolves with the server's row once that revision is accepted. */
  accepted: Promise<ProjectRevisionRow>;
  /** Stops waiting (before a match); the promises reject. */
  cancel(reason?: string): void;
}

interface Expectation {
  match: (changes: ChangesInfo) => boolean;
  meta: RevisionMeta;
  key: string | undefined;
  onMatched: (key: string) => void;
  onAccepted: (row: ProjectRevisionRow) => void;
  onFailed: (error: Error) => void;
}

/** The `revisionNotification` event payload (plus Bryntum's own event bookkeeping, which is ignored). */
export interface RevisionNotificationEvent {
  localRevisionId: RevisionId;
  conflictResolutionFor?: RevisionId;
  clientId?: string;
  changes: ChangesInfo;
}

/**
 * The slice of ProjectModel the sync layer drives. The public d.ts types `queue()` as `void`, but it
 * returns the step's promise (Gantt/guides/revisions/queue.md), and `on()` returns a detacher.
 */
interface RevisionProject {
  stm: {
    disable(): void;
    enable(): void;
    resetQueue(): void;
    revisionsEnabled?: boolean;
    on(config: Record<string, unknown>): unknown;
    un(config: Record<string, unknown>): unknown;
  };
  commitAsync(): Promise<void>;
  loadInlineData(data: object): Promise<void>;
  initRevisions(clientId: string, revisionId?: string): void;
  applyRevisions(revisions: IncomingRevision[]): Promise<unknown>;
  /** Ranks the rows this client's own revision moved, the way every other client ranked them. */
  settleOwnOrder?(changes: ChangesInfo): void;
  on(config: Record<string, unknown>): unknown;
  un(config: Record<string, unknown>): unknown;
  queue(fn: () => unknown): Promise<unknown>;
  isDestroyed?: boolean;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = { initialMs: 500, maxMs: 10_000, factor: 2 };
const DEFAULT_RESYNC_INTERVAL_MS = 30_000;

/**
 * Client side of the Revisions protocol: loads the snapshot, replays the catch-up
 * revisions, submits every `revisionNotification` through an ordered outbox with retry, and feeds the
 * server's ordered stream back into `project.applyRevisions()`, including the client's own revisions
 * (which is how Bryntum learns the real ids of added records). Gaps, reconnects, a periodic re-read
 * while connected and `resync()` all go through the same ordered catch-up from the server.
 */
export class RevisionSync {
  readonly sessionId: string;
  readonly projectId: string;

  private readonly project: RevisionProject;
  private readonly transport: RevisionTransport;
  private readonly options: RevisionSyncOptions;
  private readonly backoff: Required<BackoffOptions>;

  private last = 0;
  private readonly outbox = new Map<string, OutgoingRevision>();
  private readonly expectations: Expectation[] = [];
  private readonly buffered = new Map<number, ProjectRevisionRow>();
  private applying: Promise<unknown> = Promise.resolve();

  private detachNotification: (() => void) | undefined;
  private detachRecording: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private submitting = false;
  private submitAttempt = 0;
  private catchingUp = false;
  private catchUpRequested = false;
  private fetchAttempt = 0;
  private catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;

  /** A rejected submission; cleared by `retry()`. */
  private error: string | undefined;
  /** The engine rejected a revision. Nothing more is applied or submitted; only a fresh boot recovers. */
  private fatal: string | undefined;
  private lastFailure: string | undefined;
  private connection: ConnectionStatus = 'idle';
  private lastEmitted = '';
  private initialized = false;
  private disposed = false;

  constructor(project: ProjectModel, transport: RevisionTransport, options: RevisionSyncOptions) {
    this.project = project as unknown as RevisionProject;
    this.transport = transport;
    this.options = options;
    this.sessionId = options.sessionId;
    this.projectId = options.projectId;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  }

  get state(): SyncState {
    const error = this.fatal ?? this.error;
    const state: SyncState = {
      status: error !== undefined ? 'error' : this.outbox.size > 0 ? 'pending' : 'synced',
      pending: this.outbox.size,
      lastRevision: this.last,
      connection: this.connection,
    };
    if (error !== undefined) {
      state.error = error;
      state.recovery = this.fatal !== undefined ? 'reload' : 'retry';
    }
    if (this.lastFailure !== undefined) {
      state.lastFailure = this.lastFailure;
    }
    return state;
  }

  /** Rows received ahead of a gap, waiting for `fetchAfter()` to fill it. */
  get hasBufferedRevisions(): boolean {
    return this.buffered.size > 0;
  }

  async init(load: LoadProjectResult): Promise<void> {
    if (this.initialized) {
      throw new Error('RevisionSync.init() may only be called once');
    }
    this.initialized = true;
    const { project } = this;
    if (!project.stm.revisionsEnabled) {
      throw new Error('RevisionSync needs a ProjectModel configured with stm: { revisionsEnabled: true }');
    }

    project.stm.disable();
    project.stm.resetQueue();
    await project.loadInlineData(this.options.prepareSnapshot ? this.options.prepareSnapshot(load.snapshot) : load.snapshot);
    project.stm.enable();
    project.initRevisions(this.sessionId, String(load.snapshot_revision));
    this.last = load.snapshot_revision;

    const config = { revisionNotification: (event: RevisionNotificationEvent) => this.onRevisionNotification(event) };
    const detacher = project.on(config);
    this.detachNotification = typeof detacher === 'function' ? (detacher as () => void) : () => project.un(config);
    const recording = { recordingStart: () => this.commitRecordedInput() };
    const recordingDetacher = project.stm.on(recording);
    this.detachRecording =
      typeof recordingDetacher === 'function' ? (recordingDetacher as () => void) : () => project.stm.un(recording);

    for (const row of load.revisions) {
      this.ingest(row);
    }
    await this.whenApplied();

    this.unsubscribe = this.transport.subscribe({
      onRevision: (row) => this.ingest(row),
      onStatus: (status) => this.onStatus(status),
    });
    this.emit();
  }

  /** Resolves once every revision handed to the project so far has been applied. */
  async whenApplied(): Promise<void> {
    if (this.disposed || this.project.isDestroyed) {
      return;
    }
    await this.project.queue(() => undefined);
    await this.applying;
  }

  /**
   * Clears a rejected-submission `error` and re-attempts the outbox immediately. A `reload` error
   * stays: the project is missing a revision the engine refused, and later ones were refused too.
   */
  retry(): void {
    if (this.disposed || this.fatal !== undefined) {
      return;
    }
    this.error = undefined;
    this.submitAttempt = 0;
    this.wake?.();
    this.emit();
    void this.pump();
    void this.catchUp();
  }

  /**
   * Fetches and applies every revision the server has accepted so far, and resolves once they are
   * applied. Rejects when the server cannot be reached. A step that must act on the latest project (a
   * publication) calls it first, so a change another client already saved, a deletion for example,
   * is seen even when its broadcast has not arrived yet.
   */
  async catchUpNow(): Promise<void> {
    if (this.disposed || this.fatal !== undefined) {
      throw new Error(this.fatal ?? 'The project session has been closed');
    }
    const rows = await this.transport.fetchAfter(this.last);
    for (const row of rows) {
      this.ingest(row);
    }
    await this.whenApplied();
    if (this.fatal !== undefined) {
      throw new Error(this.fatal);
    }
  }

  /** Re-reads the log from the server now (the app calls it when the tab becomes visible). */
  resync(): void {
    if (this.disposed || this.fatal !== undefined || this.connection !== 'connected') {
      return;
    }
    void this.catchUp();
  }

  /**
   * Waits for one of this client's own revisions, recognized by its content when Bryntum emits it
   * (the emission is asynchronous, so timing cannot identify it), and submits it with `meta`. Used
   * to publish an approved change: the caller makes the change in a project transaction, and the
   * returned promises report the revision's local id and the server's accepted row. If the server
   * refuses the revision the client is out of sync for good (the change is applied locally and the
   * same payload can never be accepted), so the sync state becomes a `reload` error.
   */
  expectLocalRevision(match: (changes: ChangesInfo) => boolean, meta: RevisionMeta): ExpectedLocalRevision {
    const matched = deferred<string>();
    const accepted = deferred<ProjectRevisionRow>();
    const expectation: Expectation = {
      match,
      meta,
      key: undefined,
      onMatched: matched.resolve,
      onAccepted: accepted.resolve,
      onFailed: (error) => {
        matched.reject(error);
        accepted.reject(error);
      },
    };
    if (this.disposed || this.fatal !== undefined) {
      expectation.onFailed(new Error(this.fatal ?? 'The project session has been closed'));
    } else {
      this.expectations.push(expectation);
    }
    return {
      matched: matched.promise,
      accepted: accepted.promise,
      cancel: (reason = 'Stopped waiting for the revision') => {
        const index = this.expectations.indexOf(expectation);
        if (index >= 0 && expectation.key === undefined) {
          this.expectations.splice(index, 1);
          expectation.onFailed(new Error(reason));
        }
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const expectation of this.expectations.splice(0)) {
      expectation.onFailed(new Error('The project session has been closed'));
    }
    this.detachNotification?.();
    this.detachNotification = undefined;
    this.detachRecording?.();
    this.detachRecording = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.catchUpTimer !== undefined) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = undefined;
    }
    this.stopResync();
    this.wake?.();
    this.buffered.clear();
  }

  // ---- outgoing ---------------------------------------------------------------------------------

  /**
   * Edits of fields the scheduling engine does not own (a task name, for example) trigger no engine
   * commit. Without a commit before the auto-recorded transaction stops, the STM never marks the
   * transaction's actions as user input, the revision leaves without `$input`, and other clients skip it
   * because they replay `$input` only. Committing once a recording has started gives every revision its
   * input (verified against the engine in test/sync/revision-sync.test.ts). The commit is deferred: the
   * STM fires `recordingStart` in the middle of its state transition and must not be re-entered.
   */
  private commitRecordedInput(): void {
    queueMicrotask(() => {
      if (this.disposed || this.project.isDestroyed) {
        return;
      }
      this.project.commitAsync().catch((error: unknown) => this.warn('commitAsync after recordingStart failed', error));
    });
  }

  private onRevisionNotification(event: RevisionNotificationEvent): void {
    if (this.disposed) {
      return;
    }
    // Snapshot now: Bryntum keeps a reference to the object while the revision is pending.
    const changes = JSON.parse(JSON.stringify(event.changes)) as ChangesInfo;
    // The time range store is a local view of the tasks' library bands (library/bands.ts): every
    // client derives it, so it never travels (and the server does not accept it).
    delete changes.timeRanges;
    restoreReaddedIds(changes);
    const revision: OutgoingRevision = {
      clientId: event.clientId ?? this.sessionId,
      localRevisionId: event.localRevisionId,
      changes,
    };
    if (event.conflictResolutionFor != null) {
      revision.conflictResolutionFor = event.conflictResolutionFor;
    }
    const expectation = this.expectations.find((candidate) => candidate.key === undefined && candidate.match(revision.changes));
    if (expectation) {
      expectation.key = String(event.localRevisionId);
      if (expectation.meta.origin) {
        revision.origin = expectation.meta.origin;
      }
      if (expectation.meta.publicationId) {
        revision.publicationId = expectation.meta.publicationId;
      }
      expectation.onMatched(expectation.key);
    }
    this.outbox.set(String(event.localRevisionId), revision);
    this.emit();
    void this.pump();
  }

  /** Submits the outbox strictly in order; the server's dedupe makes re-submission after a lost response safe. */
  private async pump(): Promise<void> {
    if (this.submitting || this.disposed || this.error !== undefined || this.fatal !== undefined) {
      return;
    }
    this.submitting = true;
    try {
      while (!this.disposed) {
        const next = this.outbox.entries().next();
        if (next.done) {
          break;
        }
        const [key, revision] = next.value;
        try {
          const row = await this.transport.submit(revision);
          if (this.disposed) {
            break;
          }
          this.outbox.delete(key);
          this.submitAttempt = 0;
          this.lastFailure = undefined;
          this.settleExpectation(key, row);
          this.ingest(row);
          this.emit();
        } catch (error) {
          if (this.disposed) {
            break;
          }
          if (!this.outbox.has(key)) {
            // Confirmed meanwhile through its broadcast echo.
            continue;
          }
          if (error instanceof RevisionRejectedError) {
            const message = `Revision ${key} was rejected by the server: ${error.message}`;
            if (this.failExpectation(key, new RevisionRejectedError(message, error.code))) {
              this.goFatal(message);
            } else {
              this.error = message;
              this.emit();
            }
            break;
          }
          this.submitAttempt++;
          this.lastFailure = describeError(error);
          this.emit();
          await this.sleep(this.delayFor(this.submitAttempt));
        }
      }
    } finally {
      this.submitting = false;
    }
  }

  // ---- incoming ---------------------------------------------------------------------------------

  /** Single entry point for rows from any source: broadcast, submit response or catch-up fetch. */
  private ingest(row: ProjectRevisionRow): void {
    if (this.disposed || this.fatal !== undefined || row.project_id !== this.projectId) {
      return;
    }
    this.confirmOwn(row);
    if (row.revision_no <= this.last) {
      return;
    }
    this.buffered.set(row.revision_no, row);
    this.drain();
    if (this.buffered.size > 0) {
      void this.catchUp();
    }
  }

  private confirmOwn(row: ProjectRevisionRow): void {
    if (row.client_id !== this.sessionId) {
      return;
    }
    this.settleExpectation(row.local_revision_id, row);
    if (this.outbox.delete(row.local_revision_id)) {
      this.emit();
    }
  }

  private settleExpectation(key: string, row: ProjectRevisionRow): void {
    const index = this.expectations.findIndex((expectation) => expectation.key === key);
    if (index >= 0) {
      const [expectation] = this.expectations.splice(index, 1);
      expectation?.onAccepted(row);
    }
  }

  /** Rejects the expectation of revision `key`; true when there was one. */
  private failExpectation(key: string, error: Error): boolean {
    const index = this.expectations.findIndex((expectation) => expectation.key === key);
    if (index < 0) {
      return false;
    }
    const [expectation] = this.expectations.splice(index, 1);
    expectation?.onFailed(error);
    return true;
  }

  private drain(): void {
    for (let row = this.buffered.get(this.last + 1); row !== undefined; row = this.buffered.get(this.last + 1)) {
      this.buffered.delete(row.revision_no);
      this.apply(row);
    }
  }

  /**
   * A local edit recorded automatically (a field set outside a feature transaction) is committed outside
   * the project queue, by the engine's auto-commit or by `commitRecordedInput`. If `applyRevisions()`
   * started while that commit was running, it stopped the edit's transaction before the commit marked
   * the input (the revision left without `$input`, so other clients skipped it), and the commit's end
   * then re-enabled auto recording while the STM was checked out, which threw and put this client out of
   * sync for good. Every revision therefore waits for a queued commit, which finishes such a commit
   * first. Queue steps run in order, so the revisions are still applied in order.
   */
  private apply(row: ProjectRevisionRow): void {
    this.last = row.revision_no;
    const revision = toIncomingRevision(row);
    normalizeIncomingChanges(revision.changes);
    const { project } = this;
    // A change to the tree must land whole, whatever this person is searching for.
    const tasks = revision.changes.tasks;
    const bags = tasks?.$input ?? tasks;
    const reshapes = Boolean(bags?.added?.length || bags?.removed?.length || bags?.updated?.some((entry) => 'parentId' in entry || 'orderedParentIndex' in entry));
    const own = row.client_id === this.sessionId;
    this.applying = project
      .queue(() => project.commitAsync())
      .then(() => (reshapes ? withoutFilters(project as unknown as ProjectModel, () => project.applyRevisions([revision])) : project.applyRevisions([revision])))
      .then(() => {
        if (own && reshapes) project.settleOwnOrder?.(revision.changes);
      })
      .then(() => this.options.onRevisionApplied?.(row))
      .catch((error: unknown) => this.onApplyFailed(row, error));
    this.emit();
  }

  /**
   * The engine refused a revision: this project now lacks it, the STM is left mid-protocol and
   * refuses every later `applyRevisions()` as well, so the client stops here and reports that only a
   * fresh boot (load_project + catch-up into a new ProjectModel) can bring it back.
   */
  private onApplyFailed(row: ProjectRevisionRow, error: unknown): void {
    if (this.disposed) {
      return;
    }
    const message = `Failed to apply revision ${row.revision_no}: ${describeError(error)}`;
    this.warn(message, error);
    this.goFatal(message);
  }

  /** This client cannot converge any more; only a fresh boot recovers (`recovery: 'reload'`). */
  private goFatal(message: string): void {
    if (this.fatal !== undefined) {
      return;
    }
    this.fatal = message;
    this.buffered.clear();
    this.stopResync();
    for (const expectation of this.expectations.splice(0)) {
      expectation.onFailed(new Error(message));
    }
    this.emit();
  }

  /** Fills a gap (or the window since the last known revision after a reconnect) from the server, in order. */
  private async catchUp(): Promise<void> {
    if (this.disposed || this.fatal !== undefined) {
      return;
    }
    if (this.catchingUp) {
      this.catchUpRequested = true;
      return;
    }
    this.catchingUp = true;
    try {
      do {
        this.catchUpRequested = false;
        let rows: ProjectRevisionRow[];
        try {
          rows = await this.transport.fetchAfter(this.last);
        } catch (error) {
          if (this.disposed) {
            return;
          }
          this.fetchAttempt++;
          this.lastFailure = describeError(error);
          this.emit();
          this.scheduleCatchUp(this.delayFor(this.fetchAttempt));
          return;
        }
        if (this.disposed) {
          return;
        }
        this.fetchAttempt = 0;
        for (const row of rows) {
          this.confirmOwn(row);
          if (row.revision_no > this.last) {
            this.buffered.set(row.revision_no, row);
          }
        }
        this.drain();
      } while (this.catchUpRequested && !this.disposed);
    } finally {
      this.catchingUp = false;
    }
  }

  private scheduleCatchUp(delayMs: number): void {
    if (this.catchUpTimer !== undefined) {
      return;
    }
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = undefined;
      void this.catchUp();
    }, delayMs);
  }

  private onStatus(status: TransportStatus): void {
    if (this.disposed) {
      return;
    }
    this.connection = status;
    this.emit();
    if (status === 'connected') {
      this.submitAttempt = 0;
      this.fetchAttempt = 0;
      this.wake?.();
      void this.pump();
      void this.catchUp();
      this.startResync();
    } else {
      this.stopResync();
    }
  }

  // ---- plumbing ---------------------------------------------------------------------------------

  private startResync(): void {
    this.stopResync();
    const intervalMs = this.options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    if (intervalMs > 0 && this.fatal === undefined) {
      this.resyncTimer = setInterval(() => this.resync(), intervalMs);
    }
  }

  private stopResync(): void {
    if (this.resyncTimer !== undefined) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
  }

  private delayFor(attempt: number): number {
    return Math.min(this.backoff.maxMs, this.backoff.initialMs * this.backoff.factor ** Math.max(0, attempt - 1));
  }

  /** Cancelable wait; `wake()` ends it early on reconnect, `retry()` or `dispose()`. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.sleepTimer !== undefined) {
          clearTimeout(this.sleepTimer);
          this.sleepTimer = undefined;
        }
        this.wake = undefined;
        resolve();
      };
      this.wake = finish;
      this.sleepTimer = setTimeout(finish, ms);
    });
  }

  private emit(): void {
    if (!this.options.onState) {
      return;
    }
    const state = this.state;
    const serialized = JSON.stringify(state);
    if (serialized !== this.lastEmitted) {
      this.lastEmitted = serialized;
      this.options.onState(state);
    }
  }

  private warn(message: string, error?: unknown): void {
    if (this.options.onWarning) {
      this.options.onWarning(message, error);
    } else {
      console.warn(`[RevisionSync ${this.sessionId}] ${message}`, error);
    }
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

/** A promise with its settle functions; a rejection nobody awaits is not reported as unhandled. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * Defensive normalization of a server revision before `applyRevisions()`: removal entries without an
 * id cannot be matched to a record and would throw inside the engine, and a record re-added by an
 * undo needs its id (see `restoreReaddedIds`; revisions stored before outgoing changes were fixed).
 */
export function normalizeIncomingChanges(changes: ChangesInfo): void {
  restoreReaddedIds(changes);
  for (const storeChanges of Object.values(changes)) {
    dropRemovalsWithoutId(storeChanges);
    if (storeChanges.$input) {
      dropRemovalsWithoutId(storeChanges.$input);
    }
  }
}

/**
 * Once the server confirms a removal, Bryntum flags the removed record as new again. Undoing the
 * removal (or redoing an undone add) puts the same record back with its real id, but the revision
 * lists it as added with that id as `$PhantomId` and no `id`. `submit_revision` maps only the phantom
 * ids it issued (strings), so the other clients re-created the task, dependency or assignment without
 * its id: the restored subtree lost its links and children landed at the top level. A numeric
 * `$PhantomId` is such a real id and becomes the record's `id`.
 */
export function restoreReaddedIds(changes: ChangesInfo): void {
  for (const storeChanges of Object.values(changes)) {
    for (const added of [storeChanges.added, storeChanges.$input?.added]) {
      for (const record of added ?? []) {
        if (record.id == null && typeof record.$PhantomId === 'number') {
          record.id = record.$PhantomId;
        }
      }
    }
  }
}

function dropRemovalsWithoutId(changes: StoreInputChange): void {
  if (changes.removed) {
    changes.removed = changes.removed.filter((entry) => entry.id !== undefined && entry.id !== null);
  }
}

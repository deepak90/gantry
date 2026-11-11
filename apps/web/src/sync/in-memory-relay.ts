import type { ProjectModel } from '@bryntum/gantt';
import type {
  ChangesInfo,
  LoadProjectResult,
  OutgoingRevision,
  ProjectInlineData,
  ProjectMembership,
  ProjectRevisionRow,
  StoreInputChange,
} from '@collab/shared';
import {
  RevisionRejectedError,
  TransportUnavailableError,
  type RevisionTransport,
  type TransportHandlers,
  type TransportStatus,
} from './transport';

/** Record stores `submit_revision` accepts. `calendars` and anything else is rejected. */
export const RECORD_STORES = ['tasks', 'dependencies', 'assignments', 'resources'] as const;
export type RecordStore = (typeof RECORD_STORES)[number];

/**
 * Every revision also carries the project model's own fields (calculated endDate/duration/effort and,
 * when the user edited the project, a `$input`). It holds no records, so it needs no id handling.
 */
export const PROJECT_STORE = 'project';
export const PHANTOM_ID_FIELD = '$PhantomId';

const STORE_DATA_KEYS: Record<RecordStore, keyof ProjectInlineData> = {
  tasks: 'tasksData',
  dependencies: 'dependenciesData',
  assignments: 'assignmentsData',
  resources: 'resourcesData',
};

export interface InMemoryRelayOptions {
  projectId: string;
  /** Inline data the relay seeds its per-store id counters from (new ids start above the highest seeded id). */
  snapshot?: ProjectInlineData;
  /** revision_no the snapshot corresponds to; the first accepted revision gets snapshotRevision + 1. */
  snapshotRevision?: number;
  name?: string;
  currency?: string;
}

/** What `submit_revision` checks a publication revision against (the booking and the approved version). */
export interface RelayPublication {
  /** The booked task (`equipment_bookings.task_id`). */
  taskId: number;
  /** The approved start (`proposal_versions.inputs.new_start`), `YYYY-MM-DD`. */
  newStart: string;
  /** The approved end (`inputs.new_end`), when the publication also dates the machine on the task. */
  machine?: { newEnd: string };
}

/** `before`: the server never sees the submission. `after`: the server accepts it but the response is lost. */
export type SubmitFailureMode = 'before' | 'after';

interface Subscriber {
  clientId: string;
  handlers: TransportHandlers;
}

type JsonRecord = Record<string, unknown>;

/**
 * Reference server for the Revisions protocol, behaving exactly like the `submit_revision` RPC plus the
 * `project:{id}:revisions` broadcast: one revision_no sequence per project,
 * dedupe on (client_id, local_revision_id), real ids for every `$PhantomId` (the same phantom maps to
 * the same id when a client re-sends a record it still considers new), deep phantom replacement in
 * field values and `$input`, store whitelist, and broadcast of the full row to every subscriber
 * including the originator. Test hooks simulate network conditions.
 */
export class InMemoryRelay {
  readonly projectId: string;
  readonly name: string;
  readonly currency: string;

  private readonly rows: ProjectRevisionRow[] = [];
  private revisionNo: number;
  private readonly accepted = new Map<string, ProjectRevisionRow>();
  private readonly phantomToReal = new Map<string, number>();
  private readonly nextId: Record<RecordStore, number>;
  private readonly subscribers = new Set<Subscriber>();
  private readonly offline = new Set<string>();
  private paused = false;
  private readonly held: ProjectRevisionRow[] = [];
  private failBefore = 0;
  private failAfter = 0;
  private rejectNext = 0;
  private readonly publications = new Map<string, number>();
  private readonly registeredPublications = new Map<string, RelayPublication>();
  private readonly snapshot: ProjectInlineData | undefined;
  private readonly snapshotRevision: number;
  private failFetches = 0;
  private submitsInFlight = 0;
  private deliveriesInFlight = 0;

  constructor(options: InMemoryRelayOptions) {
    this.projectId = options.projectId;
    this.name = options.name ?? 'In-memory project';
    this.currency = options.currency ?? 'USD';
    this.revisionNo = options.snapshotRevision ?? 0;
    this.nextId = seedIdCounters(options.snapshot);
    this.snapshot = options.snapshot;
    this.snapshotRevision = options.snapshotRevision ?? 0;
  }

  get currentRevisionNo(): number {
    return this.revisionNo;
  }

  get revisionCount(): number {
    return this.rows.length;
  }

  /** Submissions being processed plus deliveries scheduled but not yet handed to subscribers. */
  get inFlight(): number {
    return this.submitsInFlight + this.deliveriesInFlight;
  }

  get heldCount(): number {
    return this.held.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  allRows(): ProjectRevisionRow[] {
    return this.rows.map(clone);
  }

  rowsAfter(revisionNo: number): ProjectRevisionRow[] {
    return this.rows.filter((row) => row.revision_no > revisionNo).map(clone);
  }

  realIdFor(phantomId: string): number | undefined {
    return this.phantomToReal.get(phantomId);
  }

  /** revision_no of the accepted revision that carried `publicationId`, as `submit_revision` records it. */
  publishedRevisionOf(publicationId: string): number | undefined {
    return this.publications.get(publicationId);
  }

  isOffline(clientId: string): boolean {
    return this.offline.has(clientId);
  }

  /** A transport bound to one client, so `disconnect()`/`reconnect()` can target it. */
  connect(clientId: string): RevisionTransport {
    return {
      submit: (rev) => this.submit(clientId, rev),
      fetchAfter: (revisionNo) => this.fetchAfter(clientId, revisionNo),
      subscribe: (handlers) => this.subscribe(clientId, handlers),
    };
  }

  // ---- test hooks -------------------------------------------------------------------------------

  /** Hold broadcasts (submissions are still accepted and answered) until `resume()`. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const row of this.held.splice(0)) {
      this.deliver(row);
    }
  }

  failNextSubmits(count: number, when: SubmitFailureMode = 'before'): void {
    if (when === 'before') {
      this.failBefore += count;
    } else {
      this.failAfter += count;
    }
  }

  /**
   * Validates revisions tagged with `publicationId` the way `publication_revision_check` does: input only
   * in the tasks store, only the booked task updated, exactly once, with nothing but a startnoearlierthan
   * constraint at the approved start and the decision reference, and the booked task still in the plan.
   * Unregistered publications are accepted unchecked.
   */
  registerPublication(publicationId: string, publication: RelayPublication): void {
    this.registeredPublications.set(publicationId, publication);
  }

  /** The server refuses the next submissions (as `submit_revision` refuses an invalid publication). */
  rejectNextSubmits(count: number): void {
    this.rejectNext += count;
  }

  failNextFetches(count: number): void {
    this.failFetches += count;
  }

  /** The client's submits and fetches fail and it receives no broadcasts until `reconnect()`. */
  disconnect(clientId: string): void {
    if (this.offline.has(clientId)) {
      return;
    }
    this.offline.add(clientId);
    this.notifyStatus(clientId, 'reconnecting');
  }

  reconnect(clientId: string): void {
    if (!this.offline.delete(clientId)) {
      return;
    }
    this.notifyStatus(clientId, 'connected');
  }

  /**
   * What `load_project` would return to a client that joins late: the inline data of a project that has applied
   * every revision up to `snapshotRevision` (and has no unconfirmed local changes) plus the rows after it.
   */
  loadResultFor(
    projectId: string,
    snapshotFrom: ProjectModel,
    snapshotRevision: number,
    membership?: ProjectMembership,
  ): LoadProjectResult {
    if (projectId !== this.projectId) {
      throw new Error(`InMemoryRelay serves project ${this.projectId}, not ${projectId}`);
    }
    if (snapshotRevision > this.revisionNo) {
      throw new Error(`snapshot revision ${snapshotRevision} is ahead of the relay (${this.revisionNo})`);
    }
    return {
      project: { id: this.projectId, name: this.name, currency: this.currency, handover_task_id: null },
      membership: membership ?? { role: 'pm', can_view_costs: false, approval_limit_minor: 0 },
      snapshot: snapshotInlineData(snapshotFrom),
      snapshot_revision: snapshotRevision,
      current_revision: this.revisionNo,
      revisions: this.rowsAfter(snapshotRevision),
    };
  }

  // ---- server behavior ---------------------------------------------------------------------------

  private async submit(clientId: string, rev: OutgoingRevision): Promise<ProjectRevisionRow> {
    this.submitsInFlight++;
    try {
      await networkHop();
      if (this.offline.has(clientId)) {
        throw new TransportUnavailableError(`client ${clientId} is offline`);
      }
      if (this.failBefore > 0) {
        this.failBefore--;
        throw new TransportUnavailableError('simulated network failure before the server received the revision');
      }
      if (this.rejectNext > 0) {
        this.rejectNext--;
        throw new RevisionRejectedError('simulated refusal by the server', '22023');
      }
      const row = this.accept(rev);
      if (this.failAfter > 0) {
        this.failAfter--;
        throw new TransportUnavailableError('simulated network failure after the server accepted the revision');
      }
      return clone(row);
    } finally {
      this.submitsInFlight--;
    }
  }

  private async fetchAfter(clientId: string, revisionNo: number): Promise<ProjectRevisionRow[]> {
    await networkHop();
    if (this.offline.has(clientId)) {
      throw new TransportUnavailableError(`client ${clientId} is offline`);
    }
    if (this.failFetches > 0) {
      this.failFetches--;
      throw new TransportUnavailableError('simulated network failure while fetching revisions');
    }
    return this.rowsAfter(revisionNo);
  }

  private subscribe(clientId: string, handlers: TransportHandlers): () => void {
    const subscriber: Subscriber = { clientId, handlers };
    this.subscribers.add(subscriber);
    this.schedule(() => {
      if (this.subscribers.has(subscriber)) {
        handlers.onStatus(this.offline.has(clientId) ? 'reconnecting' : 'connected');
      }
    });
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Mirrors the RPC body: dedupe, validate, assign ids, persist, bump the sequence, broadcast. */
  private accept(rev: OutgoingRevision): ProjectRevisionRow {
    const key = `${rev.clientId}\u0000${String(rev.localRevisionId)}`;
    const existing = this.accepted.get(key);
    if (existing) {
      return existing;
    }
    if (rev.publicationId) {
      this.checkPublication(rev, rev.publicationId);
    }
    const changes = this.processChanges(rev.changes);
    const revisionNo = this.revisionNo + 1;
    const row: ProjectRevisionRow = {
      id: `${this.projectId}:${revisionNo}`,
      project_id: this.projectId,
      revision_no: revisionNo,
      client_id: rev.clientId,
      local_revision_id: String(rev.localRevisionId),
      conflict_resolution_for: rev.conflictResolutionFor == null ? null : String(rev.conflictResolutionFor),
      changes,
      actor_user_id: null,
      origin: rev.origin ?? 'human',
      created_at: new Date().toISOString(),
    };
    this.revisionNo = revisionNo;
    if (rev.publicationId) {
      this.publications.set(rev.publicationId, revisionNo);
    }
    this.rows.push(row);
    this.accepted.set(key, row);
    if (this.paused) {
      this.held.push(row);
    } else {
      this.deliver(row);
    }
    return row;
  }

  /** `publication_revision_check` for a registered publication. */
  private checkPublication(rev: OutgoingRevision, publicationId: string): void {
    const publication = this.registeredPublications.get(publicationId);
    if (!publication) {
      return;
    }
    const refuse = (message: string, code = '22023'): never => {
      throw new RevisionRejectedError(`submit_revision: ${message}`, code);
    };
    if (this.publications.has(publicationId)) {
      refuse(`publication ${publicationId} is published and not held by client ${rev.clientId}`, '55000');
    }
    let count = 0;
    for (const [store, storeChanges] of Object.entries(rev.changes)) {
      const input = storeChanges?.$input;
      // Bryntum gives every store a revision mentions an `$input`, empty when nothing in it was input.
      if (input == null || Object.keys(input).length === 0) {
        continue;
      }
      if (store === 'assignments' && publication.machine && (input.added?.length ?? 0) === 0 && (input.removed?.length ?? 0) === 0) {
        for (const record of input.updated ?? []) {
          if (('rentalStart' in record && record.rentalStart !== publication.newStart) || ('rentalEnd' in record && record.rentalEnd !== publication.machine.newEnd)) {
            refuse("the machine's rental dates must be the approved dates");
          }
        }
        continue;
      }
      if (store !== 'tasks' || (input.added?.length ?? 0) > 0 || (input.removed?.length ?? 0) > 0) {
        refuse(`a publication may only update the booked task (input in store "${store}")`);
      }
      for (const record of input.updated ?? []) {
        if (String(record.id) !== String(publication.taskId)) {
          refuse(`a publication may only update task ${publication.taskId}, not ${String(record.id)}`);
        }
        for (const field of Object.keys(record)) {
          if (!['id', 'constraintType', 'constraintDate', 'decisionRef'].includes(field)) {
            refuse(`a publication may not change task field "${field}"`);
          }
        }
        if ('constraintType' in record && record.constraintType !== 'startnoearlierthan') {
          refuse('a publication sets a startnoearlierthan constraint');
        }
        if ('constraintDate' in record && String(record.constraintDate).slice(0, 10) !== publication.newStart) {
          refuse(`the constraint date must be the approved start ${publication.newStart}`);
        }
        if (record.decisionRef !== publicationId) {
          refuse(`the published task must carry decisionRef ${publicationId}`);
        }
        count++;
      }
    }
    if (count !== 1) {
      refuse(`a publication revision updates the booked task exactly once (found ${count})`);
    }
    if (!this.taskInPlan(publication.taskId)) {
      refuse(`the booked activity (task ${publication.taskId}) is no longer in the project`, '55000');
    }
  }

  /**
   * `task_in_plan`: the latest accepted revision that adds or removes the task decides; without one, the
   * snapshot's task tree.
   */
  private taskInPlan(taskId: number): boolean {
    const matches = (entries: unknown) =>
      Array.isArray(entries) && entries.some((entry) => isRecord(entry) && String(entry.id) === String(taskId));
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const row = this.rows[index]!;
      if (row.revision_no <= this.snapshotRevision) {
        break;
      }
      const tasks = row.changes.tasks;
      if (matches(tasks?.added)) {
        return true;
      }
      if (matches(tasks?.removed)) {
        return false;
      }
    }
    const inTree = (rows: unknown): boolean =>
      Array.isArray(rows) && rows.some((row) => isRecord(row) && (String(row.id) === String(taskId) || inTree(row.children)));
    return inTree(this.snapshot?.tasksData);
  }

  private processChanges(changes: ChangesInfo): ChangesInfo {
    const input = clone(changes);
    for (const store of Object.keys(input)) {
      if (store !== PROJECT_STORE && !isRecordStore(store)) {
        throw new RevisionRejectedError(`store "${store}" is not accepted by submit_revision`, 'STORE_NOT_ALLOWED');
      }
    }
    for (const store of RECORD_STORES) {
      const storeChanges = input[store];
      if (!storeChanges) {
        continue;
      }
      for (const record of [...(storeChanges.added ?? []), ...(storeChanges.$input?.added ?? [])]) {
        const phantom = record[PHANTOM_ID_FIELD];
        if (typeof phantom === 'string' && !this.phantomToReal.has(phantom)) {
          this.phantomToReal.set(phantom, this.nextId[store]++);
        }
      }
    }
    const output = this.replacePhantoms(input) as ChangesInfo;
    for (const store of RECORD_STORES) {
      const storeChanges = output[store];
      if (!storeChanges) {
        continue;
      }
      dropRemovalsWithoutId(storeChanges);
      if (storeChanges.$input) {
        dropRemovalsWithoutId(storeChanges.$input);
      }
    }
    return output;
  }

  /**
   * `replace_phantom_ids`: replaces every reference to a known phantom id (field values, nested objects,
   * arrays, `$input`), keeps the `$PhantomId` key itself, and gives every object carrying a known
   * `$PhantomId` its real `id`, wherever it sits (Bryntum also sends structural updates of a record it
   * still considers new keyed by `$PhantomId`).
   */
  private replacePhantoms(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.replacePhantoms(item));
    }
    if (isRecord(value)) {
      const out: JsonRecord = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = key === PHANTOM_ID_FIELD ? item : this.replacePhantoms(item);
      }
      const phantom = value[PHANTOM_ID_FIELD];
      const real = typeof phantom === 'string' ? this.phantomToReal.get(phantom) : undefined;
      if (real !== undefined) {
        out.id = real;
      }
      return out;
    }
    if (typeof value === 'string') {
      const real = this.phantomToReal.get(value);
      return real === undefined ? value : real;
    }
    return value;
  }

  private deliver(row: ProjectRevisionRow): void {
    this.schedule(() => {
      for (const subscriber of [...this.subscribers]) {
        if (!this.offline.has(subscriber.clientId)) {
          subscriber.handlers.onRevision(clone(row));
        }
      }
    });
  }

  private notifyStatus(clientId: string, status: TransportStatus): void {
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.clientId === clientId) {
        this.schedule(() => {
          if (this.subscribers.has(subscriber)) {
            subscriber.handlers.onStatus(status);
          }
        });
      }
    }
  }

  /** Deliveries run on a macrotask, in scheduling order, like messages arriving over a socket. */
  private schedule(fn: () => void): void {
    this.deliveriesInFlight++;
    setTimeout(() => {
      this.deliveriesInFlight--;
      fn();
    }, 0);
  }
}

function isRecordStore(store: string): store is RecordStore {
  return (RECORD_STORES as readonly string[]).includes(store);
}

function dropRemovalsWithoutId(changes: StoreInputChange): void {
  if (changes.removed) {
    changes.removed = changes.removed.filter((entry) => entry.id !== undefined && entry.id !== null);
  }
}

function seedIdCounters(snapshot: ProjectInlineData | undefined): Record<RecordStore, number> {
  const counters = { tasks: 1, dependencies: 1, assignments: 1, resources: 1 };
  if (!snapshot) {
    return counters;
  }
  for (const store of RECORD_STORES) {
    const records = snapshot[STORE_DATA_KEYS[store]];
    if (Array.isArray(records)) {
      counters[store] = highestNumericId(records) + 1;
    }
  }
  return counters;
}

function highestNumericId(records: unknown[]): number {
  let highest = 0;
  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }
    const id = typeof record.id === 'string' ? Number(record.id) : record.id;
    if (typeof id === 'number' && Number.isFinite(id)) {
      highest = Math.max(highest, id);
    }
    if (Array.isArray(record.children)) {
      highest = Math.max(highest, highestNumericId(record.children));
    }
  }
  return highest;
}

function snapshotInlineData(project: ProjectModel): ProjectInlineData {
  const data = (project as unknown as { inlineData: Record<string, unknown> }).inlineData;
  const list = (key: string): unknown[] | undefined => {
    const value = data[key];
    return Array.isArray(value) ? clone(value) : undefined;
  };
  const snapshot: ProjectInlineData = { tasksData: list('tasksData') ?? [] };
  if (isRecord(data.project)) {
    snapshot.project = clone(data.project);
  }
  for (const key of ['calendarsData', 'dependenciesData', 'resourcesData', 'assignmentsData'] as const) {
    const value = list(key);
    if (value) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON round trip: the same normalization the payload gets on its way through Postgres jsonb. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function networkHop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

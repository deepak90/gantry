/**
 * Keeps Bryntum's changelog store filled from the server. Bryntum's Versions feature records each
 * browser's own edits in memory: two people would see two different logs, a reload would empty them,
 * and revisions applied with `applyRevisions()` would be recorded as this browser's edits. So its
 * recording stays off; the project gets the same two crud stores the feature registers ('changelogs'
 * and 'versions', which VersionGrid reads), and this feed writes into them what the server says
 * happened: every revision since the loaded snapshot, the cost review's workflow and payments, and
 * what people decided about the assistant's drafted changes (declined ones included).
 *
 * Neither store is tracked by the project's state manager, so writing them creates no revision.
 * Writes are keyed by entry id (an entry is never listed twice) and committed straight away, so the
 * project never reports unsaved changes because of them.
 */
import { ChangeLogStore, VersionStore } from '@bryntum/gantt';
import type { ProjectModel, Store } from '@bryntum/gantt';
import type { AgentEditDecisionRow, CurrencyCode, ProjectInlineData, ProjectRevisionRow } from '@collab/shared';
import type { WorkflowSnapshot } from '../workflow/api';
import { CollabChangeLogTransaction, newestFirst, toTransactionData, type ChangelogEntry, type People } from './model';
import { decisionEntries } from './assistant';
import { describeRevision } from './revisions';
import { ProjectShadow, type RecordId, type RecordStoreName } from './shadow';
import { workflowEntries } from './workflow';

export const CHANGELOG_STORE_ID = 'changelogs';
export const VERSION_STORE_ID = 'versions';

/** The newest entries kept; older ones drop off the list (the server keeps everything). */
export const MAX_ENTRIES = 500;

export interface ChangelogStores {
  changes: Store;
  versions: Store;
  /** Unregisters and destroys the stores this call created (none when it found them registered). */
  detach(): void;
}

/**
 * Registers a ChangeLogStore and a VersionStore on the project as crud stores, or reuses the ones a
 * Versions feature already registered. They are not added to the state manager, so the revision
 * protocol never sees them.
 */
export function attachChangelogStores(project: ProjectModel): ChangelogStores {
  const existingChanges = project.getCrudStore(CHANGELOG_STORE_ID);
  const existingVersions = project.getCrudStore(VERSION_STORE_ID);
  const created: Store[] = [];
  const changes =
    existingChanges ?? new ChangeLogStore({ id: CHANGELOG_STORE_ID, modelClass: CollabChangeLogTransaction } as ConstructorParameters<typeof ChangeLogStore>[0]);
  const versions = existingVersions ?? new VersionStore({ id: VERSION_STORE_ID } as ConstructorParameters<typeof VersionStore>[0]);
  if (!existingChanges) created.push(changes);
  if (!existingVersions) created.push(versions);
  if (created.length > 0) project.addCrudStore(created);
  return {
    changes,
    versions,
    detach() {
      for (const store of created) {
        if (!project.isDestroyed && project.getCrudStore(store.id as string) === store) project.removeCrudStore(store);
        store.destroy();
      }
    },
  };
}

export interface ChangelogFeedOptions {
  /** The snapshot the session loaded and the revision it stands for (`load_project`). */
  snapshot: ProjectInlineData;
  snapshotRevision: number;
  canViewCosts: boolean;
  currency: CurrencyCode;
  /** The live project, to name records the folded copy has never seen. */
  project?: ProjectModel;
  maxEntries?: number;
}

const LIVE_STORES: Readonly<Record<RecordStoreName, string>> = {
  tasks: 'taskStore',
  resources: 'resourceStore',
  dependencies: 'dependencyStore',
  assignments: 'assignmentStore',
  calendars: 'calendarManagerStore',
};

export class ChangelogFeed {
  private readonly shadow: ProjectShadow;
  private readonly revisionEntries: ChangelogEntry[] = [];
  private workflow: WorkflowSnapshot | null = null;
  private decisions: readonly AgentEditDecisionRow[] = [];
  private known: People = new Map();
  private last: number;
  /** Workflow rows move their timestamps when re-checked; an entry keeps the time it first appeared with. */
  private readonly firstSeen = new Map<string, string>();
  private readonly options: ChangelogFeedOptions;
  private readonly store: Store;
  private destroyed = false;

  constructor(store: Store, options: ChangelogFeedOptions) {
    this.store = store;
    this.options = options;
    this.shadow = ProjectShadow.fromSnapshot(options.snapshot);
    this.last = options.snapshotRevision;
  }

  /** The project's members by user id, from the workflow snapshot's profiles. */
  get people(): People {
    return this.known;
  }

  /** Highest revision_no folded in. */
  get lastRevision(): number {
    return this.last;
  }

  /** Folds revisions in order; ones already folded are skipped, so overlapping batches are harmless. */
  ingestRevisions(rows: readonly ProjectRevisionRow[]): void {
    const fresh = rows.filter((row) => row.revision_no > this.last).sort((a, b) => a.revision_no - b.revision_no);
    if (fresh.length === 0 || this.destroyed) return;
    const { project } = this.options;
    const liveName = project
      ? (store: RecordStoreName, id: RecordId) => {
          const live = (project as unknown as Record<string, Store | undefined>)[LIVE_STORES[store]];
          const name = (live?.getById(id) as { name?: unknown } | undefined)?.name;
          return typeof name === 'string' && name ? name : null;
        }
      : undefined;
    for (const row of fresh) {
      try {
        const changes = this.shadow.apply(row.changes);
        const entry = describeRevision(row, changes, this.shadow, {
          canViewCosts: this.options.canViewCosts,
          currency: this.options.currency,
          ...(liveName ? { liveName } : {}),
        });
        if (entry) this.revisionEntries.push(entry);
      } catch (error) {
        // One unreadable revision must not stop the log; the project itself applied it already.
        console.warn(`[changelog] could not describe revision ${row.revision_no}`, error);
      }
      this.last = row.revision_no;
    }
    // Only the newest entries are listed; older descriptions are not needed any more.
    const keep = this.options.maxEntries ?? MAX_ENTRIES;
    if (this.revisionEntries.length > keep) this.revisionEntries.splice(0, this.revisionEntries.length - keep);
    this.sync();
  }

  /** The latest workflow snapshot (it also names the people). */
  setWorkflow(snapshot: WorkflowSnapshot | null): void {
    if (this.destroyed || snapshot === this.workflow) return;
    this.workflow = snapshot;
    if (snapshot) {
      this.known = new Map(snapshot.profiles.map((profile) => [profile.user_id, { name: profile.display_name, color: profile.color }]));
    }
    this.sync();
  }

  /** People's decisions about the assistant's drafted changes (applied, applied automatically, declined). */
  setDecisions(rows: readonly AgentEditDecisionRow[]): void {
    if (this.destroyed || rows === this.decisions) return;
    this.decisions = rows;
    this.sync();
  }

  /** Everything the log should list now, newest first. */
  entries(): ChangelogEntry[] {
    const shownPublications = new Set(this.revisionEntries.map((entry) => entry.publicationId).filter((id): id is string => id !== undefined));
    const workflow = this.workflow
      ? workflowEntries(this.workflow, {
          canViewCosts: this.options.canViewCosts,
          currency: this.options.currency,
          resourceName: (resourceId) => this.shadow.name('resources', resourceId) ?? this.liveResourceName(resourceId),
          shownPublications,
          // What a payment rests on is written when someone presses Pay: the payment is the event.
        }).filter((entry) => entry.kind === 'payment')
      : [];
    for (const entry of workflow) {
      const seen = this.firstSeen.get(entry.id);
      if (seen === undefined) this.firstSeen.set(entry.id, entry.occurredAt);
      else entry.occurredAt = seen;
    }
    return [...this.revisionEntries, ...workflow, ...decisionEntries(this.decisions)]
      .sort(newestFirst)
      .slice(0, this.options.maxEntries ?? MAX_ENTRIES);
  }

  destroy(): void {
    this.destroyed = true;
  }

  private liveResourceName(resourceId: number): string | null {
    const name = (this.options.project?.resourceStore.getById(resourceId) as { name?: unknown } | undefined)?.name;
    return typeof name === 'string' && name ? name : null;
  }

  /** Writes the difference between what is listed and what should be into the store. */
  private sync(): void {
    const store = this.store;
    if (this.destroyed || store.isDestroyed) return;
    const wanted = new Map(this.entries().map((entry) => [entry.id, entry]));
    const stale = (store.records as CollabChangeLogTransaction[]).filter((record) => !wanted.has(String(record.id)));
    const added: CollabChangeLogTransaction[] = [];
    // Plain add/remove/update events (no batching): VersionGrid replaces exactly the rows they name.
    if (stale.length > 0) store.remove(stale);
    for (const entry of wanted.values()) {
      const signature = JSON.stringify([entry, this.peopleFor(entry)]);
      const record = store.getById(entry.id) as CollabChangeLogTransaction | undefined;
      if (record?.signature === signature) continue;
      const data = toTransactionData(entry, this.people, signature);
      if (record) record.set(data);
      else added.push(new CollabChangeLogTransaction(data));
    }
    if (added.length > 0) store.add(added);
    store.commit();
  }

  /** Only the people an entry names take part in its signature, so a new profile leaves the rest alone. */
  private peopleFor(entry: ChangelogEntry): unknown {
    const userId = entry.actor.type === 'member' || entry.actor.type === 'assistant' ? entry.actor.userId : null;
    return userId ? this.known.get(userId) ?? null : null;
  }
}

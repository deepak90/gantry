/**
 * Bryntum Revisions protocol types (Bryntum Gantt docs: Gantt/guides/revisions/protocol.md) and the
 * Supabase RPC contract that carries them. Every package codes against these shapes.
 */
export type RevisionId = string | number;

export interface StoreInputChange {
  added?: Record<string, unknown>[];
  updated?: Record<string, unknown>[];
  removed?: { id: unknown }[];
}

/** Per-store changes. `$input` is what other clients replay; the rest is what the server persists. */
export type StoreChanges = StoreInputChange & { $input?: StoreInputChange };

/** Keys are Bryntum store ids: tasks, dependencies, resources, assignments, calendars, ... */
export type ChangesInfo = Record<string, StoreChanges>;

/** What `project.revisionNotification` emits and the client sends to `submit_revision`. */
export interface OutgoingRevision {
  clientId: string;
  localRevisionId: RevisionId;
  conflictResolutionFor?: RevisionId;
  changes: ChangesInfo;
  /** Application metadata the client attaches; Bryntum's event carries neither. */
  origin?: RevisionOrigin;
  /** The publication this revision carries out (`publications.id`); the server completes it atomically. */
  publicationId?: string;
}

/** What `project.applyRevisions([...])` consumes. `revisionId` is `String(revision_no)`. */
export interface IncomingRevision extends OutgoingRevision {
  revisionId: RevisionId;
}

export type RevisionOrigin = 'human' | 'agent' | 'engine';

/** One row of `project_revisions`; also the payload broadcast on `project:{id}:revisions`. */
export interface ProjectRevisionRow {
  id: string;
  project_id: string;
  revision_no: number;
  client_id: string;
  local_revision_id: string;
  conflict_resolution_for: string | null;
  changes: ChangesInfo;
  actor_user_id: string | null;
  origin: RevisionOrigin;
  created_at: string;
}

export type MemberRole = 'pm' | 'cm';

export interface ProjectMembership {
  role: MemberRole;
  can_view_costs: boolean;
  approval_limit_minor: number;
}

/** Bryntum `ProjectModel.loadInlineData()` argument / `inlineData` result. */
export interface ProjectInlineData {
  project?: Record<string, unknown>;
  calendarsData?: unknown[];
  tasksData: unknown[];
  dependenciesData?: unknown[];
  resourcesData?: unknown[];
  assignmentsData?: unknown[];
}

/** Result of the `load_project(p_project uuid)` RPC. */
export interface LoadProjectResult {
  project: { id: string; name: string; currency: string; handover_task_id: string | null };
  membership: ProjectMembership;
  snapshot: ProjectInlineData;
  snapshot_revision: number;
  current_revision: number;
  /** Revisions with revision_no > snapshot_revision, ascending. */
  revisions: ProjectRevisionRow[];
}

/** Arguments of the `submit_revision` RPC (names are the Postgres parameter names). */
export interface SubmitRevisionArgs {
  p_project: string;
  p_client_id: string;
  p_local_revision_id: string;
  p_conflict_for: string | null;
  p_changes: ChangesInfo;
  p_origin?: RevisionOrigin;
  p_publication?: string;
}

export function toIncomingRevision(row: ProjectRevisionRow): IncomingRevision {
  const revision: IncomingRevision = {
    revisionId: String(row.revision_no),
    localRevisionId: row.local_revision_id,
    clientId: row.client_id,
    changes: row.changes,
  };
  if (row.conflict_resolution_for != null) {
    revision.conflictResolutionFor = row.conflict_resolution_for;
  }
  return revision;
}

/**
 * The one factory for every Bryntum ProjectModel in the system: the Gantt UI, the sync layer,
 * headless scenario evaluation and the tests. The Revisions protocol requires all clients to
 * be isomorphic (same model classes, same store configuration), so nothing else constructs a
 * project. Headless by design: nothing in this module touches the DOM.
 */
import { CalendarModel, DependencyModel } from '@bryntum/gantt';
import type { ProjectModel, ProjectModelConfig, TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { CollabTaskStore } from './data/CollabTaskStore';
import { CollabAssignment } from './model/CollabAssignment';
import { CollabProjectModel } from './model/CollabProjectModel';
import { CollabResource, isResourceKind } from './model/CollabResource';
import { CollabSegment } from './model/CollabSegment';
import { CollabTask } from './model/CollabTask';
import { trackSplitEdits } from './revisions/split-tasks';

export { CollabTaskStore } from './data/CollabTaskStore';
export { CollabAssignment } from './model/CollabAssignment';
export { CollabBaseline } from './model/CollabBaseline';
export { CollabProjectModel } from './model/CollabProjectModel';
export { CollabResource, RESOURCE_KINDS, isResourceKind, type ResourceKind } from './model/CollabResource';
export { CollabSegment } from './model/CollabSegment';
export { COST_FIELDS, CollabTask, type CostField } from './model/CollabTask';
export { COLLAB_DATE_FORMAT } from './model/date-format';

/**
 * What a pasted copy must not inherit from its original: progress, money already incurred or paid
 * for the original's work, and the publication that last changed the original. Budget, forecast,
 * cost code, notes, dates and the copied dependencies and assignments stay.
 */
export const COPY_RESET_VALUES = { percentDone: 0, incurredMinor: 0, paidMinor: 0, decisionRef: null } as const;

/**
 * Resets the copies about to be pasted, descendants included. Call it from the Gantt's
 * `beforePaste` with `records` when `isCut` is false (a cut-paste moves the originals, which keep
 * their figures). The copies are not in the store yet, so this records nothing; the reset values
 * travel inside the paste's own revision. Summary tasks get no `percentDone`: the engine rolls it
 * up from their children.
 */
export function prepareCopiedTasks(records: Iterable<TaskModel>): void {
  for (const record of records) {
    record.traverse((node) => {
      const { percentDone, ...figures } = COPY_RESET_VALUES;
      node.set(node.isLeaf ? { ...figures, percentDone } : figures);
    });
  }
}

export interface CreateProjectModelOptions {
  /** Extra ProjectModel config (startDate, calendar, ...) layered over the collaboration defaults. */
  config?: Partial<ProjectModelConfig>;
}

export function createProjectModel(options: CreateProjectModelOptions = {}): ProjectModel {
  const project = new CollabProjectModel({
    taskModelClass: CollabTask,
    taskStoreClass: CollabTaskStore,
    resourceModelClass: CollabResource,
    dependencyModelClass: DependencyModel,
    assignmentModelClass: CollabAssignment,
    calendarModelClass: CalendarModel,
    // A runtime config (ProjectModel defaultConfig) that the typings leave out.
    ...({ segmentModelClass: CollabSegment } as Partial<ProjectModelConfig>),
    // As in Bryntum's realtime demo. By default, moving a task out a level also moves the tasks below it
    // under it, which closes a loop whenever it leads to them and asks the person what to do.
    taskStore: { useOrderedTreeForWbs: true, outdentIgnoringSiblings: true },
    stm: { revisionsEnabled: true },
    autoSetConstraints: true,
    ...options.config,
  });
  trackSplitEdits(project);
  markUncommittedInput(project);
  return project;
}

interface StoppedTransaction {
  inputGeneration: number;
  queue: unknown[];
  markCurrentTransactionContentUserInput(): void;
}

/**
 * Bryntum marks a transaction's actions as user input when a commit finalizes while it records. A
 * transaction stopped before that, typically an edit recorded automatically and then cut short by a
 * feature's own transaction (a row drop, an indent, the publication) or by `applyRevisions()`, became
 * a revision without input, which the other clients skip: the edit stayed on this client only (seen:
 * a dependency and an assignment added just before a row drag never reached anyone else). Before a
 * commit the STM holds nothing but the user's own edits, so such a transaction is marked as input
 * when it stops, before its revision is built.
 */
function markUncommittedInput(project: ProjectModel): void {
  project.stm.on({
    recordingStop: ({ transaction, reason }: { transaction?: StoppedTransaction; reason?: { stop?: boolean } }) => {
      if (reason?.stop && transaction && transaction.inputGeneration === 0 && transaction.queue.length > 0) {
        transaction.markCurrentTransactionContentUserInput();
      }
    },
  });
}

// -----------------------------------------------------------------------------------------
// Inline data
// -----------------------------------------------------------------------------------------

/** The non-deprecated `loadInlineData()` package shape (the `*Data` keys are deprecated since 6.3). */
export interface InlineDataPackage {
  project?: Record<string, unknown>;
  calendars?: unknown[];
  tasks?: unknown[];
  dependencies?: unknown[];
  resources?: unknown[];
  assignments?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Seed data written against the original contract may say `type: 'equipment'`; that would
 * land on Bryntum's engine field, so it is moved to `kind` and `type` is left to its default.
 */
export function normalizeResourceData(record: unknown): unknown {
  if (!isRecord(record) || record.kind !== undefined || !isResourceKind(record.type)) {
    return record;
  }
  const { type, ...rest } = record;
  return { ...rest, kind: type };
}

export function toInlineDataPackage(data: ProjectInlineData): InlineDataPackage {
  const pkg: InlineDataPackage = { tasks: data.tasksData };
  if (data.project) pkg.project = data.project;
  if (data.calendarsData) pkg.calendars = data.calendarsData;
  if (data.dependenciesData) pkg.dependencies = data.dependenciesData;
  if (data.resourcesData) pkg.resources = data.resourcesData.map(normalizeResourceData);
  if (data.assignmentsData) pkg.assignments = data.assignmentsData;
  return pkg;
}

/** Loads a snapshot and waits for the engine to schedule it. */
export async function loadProjectInlineData(
  project: ProjectModel,
  data: ProjectInlineData,
): Promise<void> {
  await project.loadInlineData(toInlineDataPackage(data));
  await project.commitAsync();
}

interface InlineDataSnapshot {
  project?: Record<string, unknown>;
  calendarsData?: unknown[];
  tasksData?: unknown[];
  dependenciesData?: unknown[];
  resourcesData?: unknown[];
  assignmentsData?: unknown[];
}

/** The project's current data in the shared snapshot shape (what `save_snapshot` persists). */
export function readProjectInlineData(project: ProjectModel): ProjectInlineData {
  const raw = project.inlineData as InlineDataSnapshot;
  return {
    project: raw.project,
    calendarsData: raw.calendarsData,
    tasksData: raw.tasksData ?? [],
    dependenciesData: raw.dependenciesData,
    resourcesData: raw.resourcesData,
    assignmentsData: raw.assignmentsData,
  };
}

// -----------------------------------------------------------------------------------------
// Revisions
// -----------------------------------------------------------------------------------------

/**
 * The documented initialization sequence for a collaborating client (guide "Revisions /
 * Using the Revisions Feature"): load with state tracking off so the snapshot is not recorded
 * as a change, then enable tracking and start revisions at `baseRevisionId`. Runs as one
 * project-queue step so it cannot interleave with an incoming `applyRevisions()`.
 */
export function loadCollaborativeProject(
  project: ProjectModel,
  data: ProjectInlineData,
  clientId: string,
  baseRevisionId = 'base',
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    project.queue(async () => {
      try {
        const { stm } = project;
        stm.disable();
        stm.resetQueue();
        await project.loadInlineData(toInlineDataPackage(data));
        await project.commitAsync();
        stm.enable();
        project.initRevisions(clientId, baseRevisionId);
        resolve();
      } catch (error) {
        reject(error);
      }
    }, reject);
  });
}

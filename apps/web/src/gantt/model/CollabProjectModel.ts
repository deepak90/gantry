import { ProjectModel } from '@bryntum/gantt';
import type { ModelFieldConfig } from '@bryntum/gantt';
import type { ChangesInfo } from '@collab/shared';
import { orderedPositions, rowsFollowOrderedTree, settleOrder, type OrderedNode, type OrderedTreeStore } from '../revisions/ordered-tree';
import { pendingRemovals, reconcileInput, removeOrphans } from '../revisions/reconcile';
import { clearSettledChanges, rescheduleSplitTasks, settleSplitCycle, unflagSegments, withoutSegments, type CycleIssue, type EngineTransaction } from '../revisions/split-tasks';
import { COLLAB_DATE_FORMAT, TZ_LESS_DATE_FIELDS } from './date-format';

interface ChangeHandler {
  inflateChangesWithUserInput(this: ProjectModel, changes: ChangesInfo, userInput: unknown): void;
  applyProjectChanges(this: ProjectModel, changes: ChangesInfo): Promise<void>;
  afterApplyProjectChangesCleanup(this: ProjectModel, changes: ChangesInfo): void;
  recordRevisionFromRemoteChanges(this: ProjectModel, revisionId: string, changes: ChangesInfo, conflictResolutions?: ChangesInfo[]): Promise<void>;
  onCycleSchedulingIssue(this: ProjectModel, issue: CycleIssue, transaction: EngineTransaction): unknown;
}

const changeHandler = ProjectModel.prototype as unknown as ChangeHandler;

/**
 * `autoSetConstraints` pins a task created without predecessors to its start date (a
 * startnoearlierthan constraint), so a task the user adds stays where it was put. The engine also
 * applies it to every predecessor-less task the first time it is calculated, which includes every
 * task loaded from a snapshot or added by a remote revision. A task that lost its last predecessor
 * after the snapshot a session loaded has no constraint on live clients but got one on a client
 * loading a later snapshot, and a task re-added by another client's undo got one only on the
 * receiving clients: the same project with different constraints and, once its parent or the project
 * start moves, different dates. Data from a snapshot or a revision is therefore taken as it is; only
 * tasks created by local edits are pinned, and their constraint travels in the revision.
 */
async function withoutAutoConstraints<T>(project: ProjectModel, step: () => Promise<T>): Promise<T> {
  const flags = project as unknown as { autoSetConstraints: boolean };
  const enabled = flags.autoSetConstraints;
  flags.autoSetConstraints = false;
  try {
    return await step();
  } finally {
    flags.autoSetConstraints = enabled;
  }
}

/**
 * The project's own dates (calculated endDate, configured startDate, constraintDate) in snapshots and
 * revisions, and the way snapshots and revisions are taken in (`revisions/`).
 */
export class CollabProjectModel extends ProjectModel {
  static override $name = 'CollabProjectModel';

  static override fields: ModelFieldConfig[] = [
    ...TZ_LESS_DATE_FIELDS,
    { name: 'constraintDate', type: 'date', format: COLLAB_DATE_FORMAT },
  ];

  /** Set while another client's revision is applied (rather than this client's own coming back). */
  private applyingRemote = false;

  override async loadInlineData(dataPackage: object): Promise<void> {
    await withoutAutoConstraints(this, () => super.loadInlineData(dataPackage));
    rowsFollowOrderedTree(this.taskStore as unknown as OrderedTreeStore, [this.taskStore.rootNode as unknown as OrderedNode]);
  }

  /**
   * A remote revision without input (a data correction: the result of a conflict, which every client
   * computes after applying the same revisions) is recorded but not applied. Its values were left
   * flagged as changes, so every client that had not sent its own correction, and every reload
   * replaying the log, sent one more. Fields matching the correction are unflagged like after an
   * applied revision.
   */
  async recordRevisionFromRemoteChanges(revisionId: string, changes: ChangesInfo, conflictResolutions?: ChangesInfo[]): Promise<void> {
    this.applyingRemote = true;
    try {
      await changeHandler.recordRevisionFromRemoteChanges.call(this, revisionId, changes, conflictResolutions);
    } finally {
      this.applyingRemote = false;
    }
    if (!Object.values(changes).some((storeChanges) => storeChanges && '$input' in storeChanges)) {
      clearSettledChanges(this, changes);
    }
  }

  /**
   * Bryntum unflags the fields of applied records whose value matches given changes: after applying a
   * revision, and, after redoing this client's pending revisions, with each pending revision's own
   * changes, which by then are stale. To compare `segments` it converts the given segments, and the
   * converter writes them into the task's live segment models: a pending resize, redone on top of
   * another client's link, wrote its pre-rebase segment dates into the rebased split task, which
   * collapsed it and pinned it with a constraint, on that client only. Segments are compared here
   * without converting (`unflagSegments`) and kept out of Bryntum's comparison.
   */
  afterApplyProjectChangesCleanup(changes: ChangesInfo): void {
    changeHandler.afterApplyProjectChangesCleanup.call(this, withoutSegments(changes));
    unflagSegments(this, changes);
  }

  /**
   * A merge sends `segments: null` as its input, but the merged task's duration (now the whole span,
   * gaps included) is calculated: the other clients recalculated it from the old segments, so the task
   * shrank by its gaps everywhere, the merging client included once its revision came back, and every
   * client sent a correction. The merged duration travels with the merge.
   */
  inflateChangesWithUserInput(changes: ChangesInfo, userInput: unknown): void {
    changeHandler.inflateChangesWithUserInput.call(this, changes, userInput);
    const tasks = changes.tasks;
    for (const entry of tasks?.$input?.updated ?? []) {
      const calculated = tasks?.updated?.find((candidate) => candidate.id === entry.id);
      if (entry.segments === null && !('duration' in entry) && calculated && 'duration' in calculated) {
        entry.duration = calculated.duration;
      }
    }
  }

  /**
   * The row order every client shares, as this one saw it the last time it applied someone else's
   * revision. Bryntum undoes this client's unconfirmed changes, applies the revision and redoes them, so
   * this is the order with none of those in it.
   */
  private confirmedOrder: Map<OrderedNode, number> | undefined;

  /**
   * Redone over another client's move, this client's own move lands by its place in the row list, while
   * every other client applies it by the positions it carries (`keepOrderedPositions`): two people
   * reordering one group at the same moment ended up with two orders, until a reload. Once the revision
   * is back, the same ranking from the same starting order settles it here, and all of them show one.
   */
  settleOwnOrder(changes: ChangesInfo): void {
    // A revision without input is this client's own correction, which every other client skips.
    const input = changes.tasks?.$input;
    if (this.confirmedOrder && input) settleOrder(this.taskStore as unknown as OrderedTreeStore, this.confirmedOrder, input);
  }

  /**
   * After marking what the STM recorded as the person's (`finalizeCommit`), the engine gives the screen a
   * turn to draw, then writes its results and marks whatever is unmarked as calculated. Something done in
   * that turn, a delete landing as someone else's change is drawn, counted as calculated: its revision
   * carried no input, every other client skipped it, and it stayed on this client alone. Bryntum calls this
   * at the end of that turn, just before the writes, so what is unmarked by then is still the person's.
   */
  override suspendChangeTracking(): void {
    if ((this as unknown as { isWritingData?: boolean }).isWritingData) {
      (this.stm as unknown as { markCurrentTransactionContentUserInput(): void }).markCurrentTransactionContentUserInput();
    }
    super.suspendChangeTracking();
  }

  /** Where the engine takes a cycle. Everything but a split task's own goes on as Bryntum has it: see `settleSplitCycle`. */
  onCycleSchedulingIssue(issue: CycleIssue, transaction: EngineTransaction): unknown {
    return settleSplitCycle(issue, transaction) ? 'Resume' : changeHandler.onCycleSchedulingIssue.call(this, issue, transaction);
  }

  /** `applyRevisions()` applies every revision through this method (the input of a remote revision, the ids of an own one). */
  async applyProjectChanges(changes: ChangesInfo): Promise<void> {
    const { input, orphans } = reconcileInput(this, changes, this.applyingRemote ? pendingRemovals(this) : undefined);
    await withoutAutoConstraints(this, () => changeHandler.applyProjectChanges.call(this, input));
    if (this.applyingRemote) this.confirmedOrder = orderedPositions(this.taskStore as unknown as OrderedTreeStore);
    removeOrphans(this, orphans);
    if (rescheduleSplitTasks(this, changes)) {
      await this.commitAsync();
    }
    clearSettledChanges(this, changes);
  }
}

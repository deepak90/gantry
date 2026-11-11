/**
 * Split tasks under revisions. On Bryntum's own, a split task replayed under someone else's revision can
 * collapse (0 days on one client, 3 on the other), so the engine's writes to its pieces are not recorded
 * (`recordsSplitWrite`) and what that leaves out is made up for here.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import type { ChangesInfo } from '@collab/shared';
import type { CollabProjectModel } from '../model/CollabProjectModel';

interface ChronoTask {
  $: { startDate: unknown; endDate: unknown };
  graph?: { activeTransaction?: { touch(identifier: unknown): void } };
  data: { endDate?: unknown };
}

export interface EngineTransaction {
  write(identifier: unknown, value: unknown, ...args: unknown[]): void;
  getLatestEntryFor(identifier: unknown): { proposedValue?: unknown } | undefined;
  hasResolvedSchedulingIssue?: boolean;
}

export interface CycleIssue {
  cycle: { cycle: { context?: { isEventSegment?: boolean; event?: ChronoTask } }[] };
}

/** Per commit: the pieces of split tasks `settleSplitCycle` has already answered for. */
const settledPieces = new WeakMap<object, Set<unknown>>();

/**
 * Replaying a recorded move of a split task proposes its end date again. The pieces cannot settle that:
 * each one's duration comes from its offsets and its offsets from its duration, and the engine reports
 * a cycle with no link in it. Bryntum throws on one while it applies a revision, which left the client
 * out of sync for good, and shows the cycle pop-up the rest of the time. A split task is as long as its
 * pieces, so the same end is proposed again with "keep the duration", and the engine carries on.
 */
export function settleSplitCycle(issue: CycleIssue, transaction: EngineTransaction): boolean {
  const piece = issue.cycle.cycle[0]?.context;
  const task = piece?.isEventSegment ? piece.event : undefined;
  const pieces = settledPieces.get(transaction) ?? new Set<unknown>();
  // Once for each piece and commit: a cycle that comes back is not this one.
  if (!task || pieces.has(piece)) return false;
  settledPieces.set(transaction, pieces.add(piece));
  transaction.write(task.$.endDate, transaction.getLatestEntryFor(task.$.endDate)?.proposedValue ?? task.data.endDate, true);
  transaction.hasResolvedSchedulingIssue = true;
  return true;
}

interface RecordedAction {
  model?: { isEventSegment?: boolean; event?: unknown; $originalEvent?: unknown };
  newData?: Record<string, unknown>;
}

interface EngineState {
  isWritingData?: boolean;
  replica?: { isCommitting?: boolean };
}

/** Per project: the tasks whose split the recording transaction edited before the current commit. */
const splitEdits = new WeakMap<object, Set<unknown>>();

/**
 * Notes, as each commit starts, which tasks the transaction recorded so far split, merged or edited
 * segments of. The engine finishes such an edit only in a later commit (a merged task's end date and
 * its successors moved after the revision had left, and every client then sent that result as a data
 * correction), so after the first commit of an edit the task's dates are recalculated once more while
 * the transaction is still recording, and the revision carries the whole result.
 */
export function trackSplitEdits(project: ProjectModel): void {
  const stm = project.stm as unknown as { transaction?: { queue: RecordedAction[] } | null; isRecording: boolean };
  const rescheduled = new WeakMap<object, Set<unknown>>();
  project.on({
    beforeCommit: () => {
      const tasks = new Set<unknown>();
      for (const action of stm.transaction?.queue ?? []) {
        if (action.model?.isEventSegment) {
          // A merged segment has left its task; Bryntum keeps the task as `$originalEvent`.
          const task = action.model.event ?? action.model.$originalEvent;
          if (task) {
            tasks.add(task);
          }
        } else if (action.model && action.newData && 'segments' in action.newData) {
          tasks.add(action.model);
        }
      }
      splitEdits.set(project, tasks);
    },
    dataReady: () => {
      const { transaction } = stm;
      // A user's transaction only: revisions being applied or redone are handled by `rescheduleSplitTasks`.
      if (!transaction || !stm.isRecording) {
        return;
      }
      const done = rescheduled.get(transaction) ?? new Set<unknown>();
      rescheduled.set(transaction, done);
      const tasks = [...(splitEdits.get(project) ?? [])].filter((task) => !done.has(task)) as ChronoTask[];
      for (const task of tasks) {
        done.add(task);
        task.graph?.activeTransaction?.touch(task.$.startDate);
        task.graph?.activeTransaction?.touch(task.$.endDate);
      }
      if (tasks.length > 0) {
        void project.commitAsync();
      }
    },
  });
}

/**
 * Whether the STM may record a write to a split task's segments (the task's `segments` field or a
 * segment model). When the engine reschedules a split task it rewrites the task's segments and moves
 * the segment models, and Bryntum recorded those writes as user input (every segment model update,
 * and the task's segments whenever the transaction held any user change to the task, a constraint for
 * example). A reschedule then read as if the user had moved each segment: the revision carried the
 * segments as input, which another client applied on top of its own reschedule and which a
 * publication may not contain, and the checkout Bryntum makes before applying any revision, like an
 * undo, replayed the old segment dates against a task the engine was moving back, which collapsed the
 * split (a two-segment, four-day task became one two-day task, or a zero-day one, on every client).
 * The engine's writes, made while it calculates or writes its results back, are not recorded: they
 * follow from the recorded input and the engine repeats them on undo, redo and checkout. They are
 * recorded as before when the same transaction split, merged, moved or resized segments of the task,
 * because redoing a split relies on them.
 */
export function recordsSplitWrite(task: TaskModel): boolean {
  const project = (task as unknown as { project?: ProjectModel & EngineState }).project;
  if (!project || !(project.isWritingData || project.replica?.isCommitting)) {
    return true;
  }
  return splitEdits.get(project)?.has(task) ?? false;
}

/**
 * Before Bryntum applies a client's own revision it undoes the client's pending revisions and redoes
 * them. Redoing a split restores the task's segments and its new end date without rescheduling its
 * successors, so the client that split a task kept the successors where they were while every other
 * client (which applies the split as input) moved them; applying the revision's input on top matches
 * the restored segments and changes nothing. The dates of every task whose segments a revision sets
 * are recalculated once more after it is applied (the caller commits when this returns true), which
 * moves the successors. Elsewhere the recalculation finds nothing to change.
 */
export function rescheduleSplitTasks(project: ProjectModel, changes: ChangesInfo): boolean {
  const tasks = changes.tasks;
  let touched = false;
  for (const entry of (tasks?.$input ?? tasks)?.updated ?? []) {
    if (!('segments' in entry)) {
      continue;
    }
    const task = project.taskStore.getById(entry.id as number) as unknown as ChronoTask | undefined;
    const transaction = task?.graph?.activeTransaction;
    if (task && transaction) {
      transaction.touch(task.$.startDate);
      transaction.touch(task.$.endDate);
      touched = true;
    }
  }
  return touched;
}

interface SplitTask {
  segments?: { isModel?: boolean; internalClearChanges(includeDescendants: boolean, removeFromStoreChanges: boolean): void }[] | null;
  meta: { modified: Record<string, unknown> };
  getFieldDefinition(name: string): { isEqual(a: unknown, b: unknown, record?: unknown): boolean } | undefined;
  getValue(name: string): unknown;
}

/**
 * Applying a revision ends by unflagging every applied field whose value matches the revision, then
 * commits once more. That commit re-flags split tasks (the `segments` field and the segment models)
 * and fields the engine rewrote with their old value, so every client that applied a revision touching
 * a split task, and every reload replaying one, was left with changes and sent a data-correction
 * revision repeating what the log already holds. The flags are cleared again after that commit:
 * fields matching the revision, segments matching it, and fields back at their original value.
 */
export function clearSettledChanges(project: ProjectModel, changes: ChangesInfo): void {
  (project as CollabProjectModel).afterApplyProjectChangesCleanup(changes);
  const tasks = changes.tasks;
  for (const data of [...(tasks?.updated ?? []), ...(tasks?.added ?? [])]) {
    const record = project.taskStore.getById(data.id as number) as unknown as SplitTask | undefined;
    if (!record) {
      continue;
    }
    const { modified } = record.meta;
    for (const name of Object.keys(modified)) {
      if (name !== 'segments' && record.getFieldDefinition(name)?.isEqual(modified[name], record.getValue(name))) {
        delete modified[name];
      }
    }
  }
}

/** The changes without the tasks' `segments`, for Bryntum's cleanup (see `afterApplyProjectChangesCleanup`). */
export function withoutSegments(changes: ChangesInfo): ChangesInfo {
  const tasks = changes.tasks;
  const strip = (entries: Record<string, unknown>[] | undefined) =>
    entries?.map((entry) => {
      if (!('segments' in entry)) {
        return entry;
      }
      const { segments: _segments, ...rest } = entry;
      return rest;
    });
  if (!tasks || ![...(tasks.updated ?? []), ...(tasks.added ?? [])].some((entry) => 'segments' in entry)) {
    return changes;
  }
  return { ...changes, tasks: { ...tasks, updated: strip(tasks.updated), added: strip(tasks.added) } };
}

/**
 * Unflags a split task's `segments` (the field and the segment models) when they match the given
 * changes. The segments field compares plain segment data by converting copies of its dates, so the
 * live segment models are left alone.
 */
export function unflagSegments(project: ProjectModel, changes: ChangesInfo): void {
  const tasks = changes.tasks;
  for (const data of [...(tasks?.updated ?? []), ...(tasks?.added ?? [])]) {
    if (!('segments' in data)) {
      continue;
    }
    const record = project.taskStore.getById(data.id as number) as unknown as SplitTask | undefined;
    const field = record?.getFieldDefinition('segments');
    if (!record || !field) {
      continue;
    }
    const matches = record.segments ? field.isEqual(data.segments, record.segments, record) : data.segments == null;
    if (!matches) {
      continue;
    }
    delete record.meta.modified.segments;
    for (const segment of record.segments ?? []) {
      if (segment.isModel) {
        segment.internalClearChanges(false, false);
      }
    }
  }
}

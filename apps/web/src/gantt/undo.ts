/**
 * Undo and redo of this person's own changes to the plan (Bryntum's state tracking manager, which
 * records every local transaction). Each step runs in the project queue followed by a commit, the
 * way the revision sync expects: the undo goes out as a new revision for everyone, while other
 * people's changes stay (they are not in this person's queue). The buttons say what they would undo:
 * a named transaction ("Add Exam room build-out from the library") or "your last change" for an
 * edit made in the grid or on the chart.
 */
import type { ProjectModel } from '@bryntum/gantt';
import { withoutFilters } from './filters';

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  /** What undo would take back, in words; null when there is nothing. */
  undoLabel: string | null;
  redoLabel: string | null;
}

interface Stm {
  canUndo: boolean;
  canRedo: boolean;
  isReady: boolean;
  position: number;
  queue: (string | null | undefined)[];
  rawQueue?: { queue?: { model?: { event?: { id?: unknown } | null; resource?: { id?: unknown } | null }; newData?: Record<string, unknown> }[] }[];
  undo(steps?: number): Promise<void>;
  redo(steps?: number): Promise<void>;
  on(listeners: Record<string, () => void>): (() => void) | undefined;
}

const stmOf = (project: ProjectModel) => project.stm as unknown as Stm;

/** A transaction title as a person reads it after "Undo" or "Redo". */
export function stepLabel(title: string | null | undefined): string {
  if (!title) return 'your last change';
  if (/^Publish\b/.test(title)) return 'putting the approved dates in';
  return `“${title}”`;
}

/** Where this person's history stands: how many of their steps are in, and whether it is at rest (not recording or restoring). */
export function historyAt(project: ProjectModel): { position: number; ready: boolean } {
  const stm = stmOf(project);
  return { position: stm.position, ready: stm.isReady };
}

export function undoState(project: ProjectModel): UndoState {
  const stm = stmOf(project);
  const { position, queue } = stm;
  return {
    canUndo: stm.canUndo,
    canRedo: stm.canRedo,
    undoLabel: stm.canUndo ? stepLabel(queue[position - 1]) : null,
    redoLabel: stm.canRedo ? stepLabel(queue[position]) : null,
  };
}

/** The machines, on their tasks, whose dates the next undo or redo would change. */
export function rentalsInNextStep(project: ProjectModel, direction: 'undo' | 'redo'): { taskId: number; resourceId: number }[] {
  const stm = stmOf(project);
  const step = stm.rawQueue?.[direction === 'undo' ? stm.position - 1 : stm.position];
  return (step?.queue ?? []).flatMap((action) => {
    const taskId = action.model?.event?.id;
    const resourceId = action.model?.resource?.id;
    return action.newData && ('rentalStart' in action.newData || 'rentalEnd' in action.newData) && typeof taskId === 'number' && typeof resourceId === 'number' ? [{ taskId, resourceId }] : [];
  });
}

const sameState = (a: UndoState, b: UndoState) =>
  a.canUndo === b.canUndo && a.canRedo === b.canRedo && a.undoLabel === b.undoLabel && a.redoLabel === b.redoLabel;

/**
 * Calls `onChange` with what the buttons should say whenever that changes. The manager is read only
 * once it is ready again: while it records an edit, restores one, or the revision sync checks the
 * plan out after a commit, it says there is nothing to undo, and its `ready` event comes after each.
 */
export function watchUndo(project: ProjectModel, onChange: (state: UndoState) => void): () => void {
  const stm = stmOf(project);
  let last = undoState(project);
  const check = () => {
    if (!stm.isReady) return;
    const next = undoState(project);
    if (sameState(next, last)) return;
    last = next;
    onChange(next);
  };
  return stm.on({ ready: check, queueReset: check }) ?? (() => undefined);
}

function step(project: ProjectModel, direction: 'undo' | 'redo'): Promise<void> {
  const queued = project as unknown as { queue(run: () => unknown): Promise<unknown> };
  return queued
    .queue(async () => {
      const stm = stmOf(project);
      if (direction === 'undo' ? !stm.canUndo : !stm.canRedo) return;
      // A group coming back brings the tasks a search is hiding (see `withoutFilters`).
      await withoutFilters(project, async () => {
        await (direction === 'undo' ? stm.undo() : stm.redo());
        await project.commitAsync();
      });
    })
    .then(() => undefined);
}

export const undo = (project: ProjectModel) => step(project, 'undo');
export const redo = (project: ProjectModel) => step(project, 'redo');

/**
 * Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes, except while typing: text fields and a
 * cell being edited keep their own undo.
 */
export function undoKey(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], .b-editor')) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.metaKey) return 'redo';
  return null;
}

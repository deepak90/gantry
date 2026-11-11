/**
 * Undo and redo on the toolbar: what the buttons say they would undo, the keyboard shortcuts (not
 * while typing), and an undo then a redo of a named change, each sent as its own revision.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { redo, stepLabel, undo, undoKey, undoState, watchUndo } from '../../src/gantt/undo';
import { runProjectTransaction } from '../../src/scenario/publish';
import { SAMPLE_INLINE_DATA } from '../fixtures/sample-data';

let project: ProjectModel;

afterEach(() => project?.destroy());

const key = (init: KeyboardEventInit, target?: HTMLElement) => {
  const event = new KeyboardEvent('keydown', init);
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
};

describe('undo and redo', () => {
  it('says what it would undo', () => {
    expect(stepLabel(null)).toBe('your last change');
    expect(stepLabel('Add Exam room build-out from the library')).toBe('“Add Exam room build-out from the library”');
    expect(stepLabel('Publish 7f2c')).toBe('putting the approved dates in');
  });

  it('answers Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, but not while typing', () => {
    const cell = document.createElement('div');
    const field = document.createElement('input');
    expect(undoKey(key({ key: 'z', metaKey: true }, cell))).toBe('undo');
    expect(undoKey(key({ key: 'Z', metaKey: true, shiftKey: true }, cell))).toBe('redo');
    expect(undoKey(key({ key: 'y', ctrlKey: true }, cell))).toBe('redo');
    expect(undoKey(key({ key: 'z' }, cell))).toBeNull();
    expect(undoKey(key({ key: 'z', ctrlKey: true }, field))).toBeNull();
  });

  it('undoes and redoes a named change, one revision each, and tells the buttons', async () => {
    project = createProjectModel();
    await loadCollaborativeProject(project, SAMPLE_INLINE_DATA, 'undo-test');
    const revisions: unknown[] = [];
    project.on('revisionNotification', (event: unknown) => revisions.push(event));
    const told: ReturnType<typeof undoState>[] = [];
    const stop = watchUndo(project, (state) => told.push(state));
    const task = project.taskStore.getById(2) as TaskModel;
    const before = task.name;
    expect(undoState(project)).toEqual({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });

    await runProjectTransaction(project, 'Rename the slab', () => {
      task.name = 'Renamed';
    });
    expect(undoState(project)).toMatchObject({ canUndo: true, undoLabel: '“Rename the slab”' });

    await undo(project);
    expect(task.name).toBe(before);
    expect(undoState(project)).toMatchObject({ canUndo: false, canRedo: true, redoLabel: '“Rename the slab”' });

    await redo(project);
    expect(task.name).toBe('Renamed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revisions).toHaveLength(3);
    // Told once per change, never the "nothing to undo" the manager says while the sync checks the plan out.
    expect(told.map((state) => state.canUndo)).toEqual([true, false, true]);
    expect(told.at(-1)).toMatchObject({ canRedo: false, undoLabel: '“Rename the slab”' });
    stop();
  });
});

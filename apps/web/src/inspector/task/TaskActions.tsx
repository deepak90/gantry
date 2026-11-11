/**
 * What the plan's right-click menu does to a task's place in the plan, from the panel: where there is no chart to
 * right-click (the 3D view), this is the only way. Each is one change for everyone. A new task opens here once the
 * server has given it its number. Deleting asks twice: the panel's other edits are small, and this one takes what is
 * inside the task with it.
 */
import { useRef, useState } from 'react';
import type { TaskModel } from '@bryntum/gantt';
import { useDismiss } from '../../app/useDismiss';
import { firstLockedWithin, lockMessage } from '../../gantt/payment-lock';
import { hasHeldTasks, holdTasks, pasteHeldTasks } from '../../gantt/task-clipboard';
import { addSubtask, addTaskBelow, deleteTask, indentTask, moveTaskDown, moveTaskUp, outdentTask } from './apply';
import type { TaskView } from './model';
import { usePanel } from './ui';

/** How long to wait for the server's number for a new task before giving up on opening it, and how often to look. */
const SAVE_WAIT_MS = 15_000;
const SAVE_LOOK_MS = 150;

/** Opens a task as soon as it has a number of its own, which a new one gets only once the server has it. */
export function openWhenSaved(task: TaskModel, open: ((taskId: number) => void) | undefined): void {
  if (!open) return;
  if (typeof task.id === 'number') {
    open(task.id);
    return;
  }
  const started = Date.now();
  const look = window.setInterval(() => {
    if (typeof task.id === 'number') {
      window.clearInterval(look);
      open(task.id);
    } else if (Date.now() - started > SAVE_WAIT_MS) {
      window.clearInterval(look);
    }
  }, SAVE_LOOK_MS);
}

export function TaskActions({ task, view }: { task: TaskModel; view: TaskView }) {
  const { project, run, openTask } = usePanel();
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shut = (): void => {
    setOpen(false);
    setConfirmingDelete(false);
  };
  useDismiss(open, root, shut);

  const locked = firstLockedWithin([task]);
  const lockedWhy = locked ? lockMessage(locked) : undefined;
  const hasTaskAbove = Boolean((task as unknown as { previousSibling?: unknown }).previousSibling);
  const hasTaskBelow = Boolean((task as unknown as { nextSibling?: unknown }).nextSibling);
  const atTop = Boolean((task.parent as unknown as { isRoot?: boolean } | null)?.isRoot);
  const act = (edit: () => Promise<void>): void => {
    shut();
    void run(edit);
  };
  const add = (how: typeof addTaskBelow): void =>
    act(async () => {
      openWhenSaved(await how(project, view.id), openTask);
    });

  return (
    <div className="ti-actions" ref={root}>
      <button type="button" className="button is-quiet is-icon is-sm" aria-label="More for this task" aria-haspopup="menu" aria-expanded={open} title="More for this task" data-testid="task-actions" onClick={() => (open ? shut() : setOpen(true))}>
        <i className="fa fa-ellipsis" aria-hidden="true" />
      </button>
      {open && (
        <div className="popover ti-actions-menu" role="menu" aria-label="More for this task">
          <button type="button" role="menuitem" className="menu-item" data-testid="task-add-below" onClick={() => add(addTaskBelow)}>
            <i className="fa fa-plus" aria-hidden="true" /> Add a task below
          </button>
          <button type="button" role="menuitem" className="menu-item" data-testid="task-add-subtask" disabled={view.isMilestone} onClick={() => add(addSubtask)}>
            <i className="fa fa-sitemap" aria-hidden="true" /> Add a subtask
          </button>
          <hr className="ti-actions-rule" />
          <button type="button" role="menuitem" className="menu-item" data-testid="task-move-up" disabled={!hasTaskAbove || Boolean(locked)} title={lockedWhy} onClick={() => act(() => moveTaskUp(project, view.id))}>
            <i className="fa fa-arrow-up" aria-hidden="true" /> Move up
          </button>
          <button type="button" role="menuitem" className="menu-item" data-testid="task-move-down" disabled={!hasTaskBelow || Boolean(locked)} title={lockedWhy} onClick={() => act(() => moveTaskDown(project, view.id))}>
            <i className="fa fa-arrow-down" aria-hidden="true" /> Move down
          </button>
          <button type="button" role="menuitem" className="menu-item" data-testid="task-indent" disabled={!hasTaskAbove || Boolean(locked)} title={lockedWhy} onClick={() => act(() => indentTask(project, view.id))}>
            <i className="fa fa-indent" aria-hidden="true" /> Move into the task above
          </button>
          <button type="button" role="menuitem" className="menu-item" data-testid="task-outdent" disabled={atTop || Boolean(locked)} title={lockedWhy} onClick={() => act(() => outdentTask(project, view.id))}>
            <i className="fa fa-outdent" aria-hidden="true" /> Move out one level
          </button>
          <hr className="ti-actions-rule" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-testid="task-copy"
            onClick={() => {
              shut();
              holdTasks(project, [task], false);
            }}
          >
            <i className="fa fa-copy" aria-hidden="true" /> Copy task
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-testid="task-cut"
            disabled={Boolean(locked)}
            title={lockedWhy}
            onClick={() => {
              shut();
              holdTasks(project, [task], true);
            }}
          >
            <i className="fa fa-scissors" aria-hidden="true" /> Cut task
          </button>
          <button type="button" role="menuitem" className="menu-item" data-testid="task-paste" disabled={!hasHeldTasks(project)} onClick={() => act(() => pasteHeldTasks(project, task))}>
            <i className="fa fa-paste" aria-hidden="true" /> Paste below
          </button>
          <hr className="ti-actions-rule" />
          <button
            type="button"
            role="menuitem"
            className="menu-item is-danger"
            data-testid="task-delete"
            disabled={Boolean(locked)}
            title={lockedWhy}
            onClick={() => {
              if (confirmingDelete) act(() => deleteTask(project, view.id));
              else setConfirmingDelete(true);
            }}
          >
            <i className="fa fa-trash-can" aria-hidden="true" /> {confirmingDelete ? (view.isPhase ? 'Click again: it and the tasks inside go' : 'Click again to delete') : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}

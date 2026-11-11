/**
 * The task menu's own actions. Everything else that changes the plan goes through the project queue: the
 * task panel, a paste, a library drop, and Bryntum's own features (`enableTransactionalFeatures`). Bryntum's
 * menu items write to the store as soon as they are clicked. A click landing while someone else's revision
 * was being applied was recorded inside that revision and never sent, and one landing as the engine finished
 * a calculation could take the client out of sync. In the queue, they wait their turn.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';

type Queued = { queue(step: () => unknown): Promise<unknown> };

interface MenuItem {
  onItem?: unknown;
  menu?: Record<string, unknown>;
}

interface ItemEvent {
  taskRecord?: TaskModel & { $original?: TaskModel };
}

const wrapped = new WeakSet<object>();

/** Runs an action once the engine is idle, and holds the queue until its result is calculated. */
export function runInProjectQueue(project: ProjectModel, action: () => void): Promise<unknown> {
  return (project as unknown as Queued).queue(async () => {
    await project.commitAsync();
    // Not returned or awaited: an action that queues work of its own would be waiting on this step.
    action();
    await project.commitAsync();
  });
}

/** Puts every action of these menu items, and of the menus under them, in the queue. */
export function queueMenuItems(project: ProjectModel, items: Record<string, unknown>): void {
  for (const item of Object.values(items) as (MenuItem | false | null | undefined)[]) {
    if (!item || typeof item !== 'object') continue;
    if (item.menu && typeof item.menu === 'object') queueMenuItems(project, item.menu);
    const run = item.onItem;
    if (typeof run !== 'function' || wrapped.has(run)) continue;
    const queued = function (this: unknown, event: ItemEvent) {
      void runInProjectQueue(project, () => {
        // Someone may have removed the task while this waited.
        const task = event?.taskRecord?.$original ?? event?.taskRecord;
        if (!task || project.taskStore.getById(task.id) === task) run.call(this, event);
      }).catch((error: unknown) => console.error('A menu action failed', error));
    };
    wrapped.add(queued);
    item.onItem = queued;
  }
}

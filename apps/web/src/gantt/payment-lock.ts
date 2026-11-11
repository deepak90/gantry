/**
 * Tasks locked while PayPal pays for them. From the moment the cost manager sends a payment until
 * PayPal settles it, the task the money is for must not change under it: no edits, no moves, and
 * neither it nor the group holding it may be deleted. The database refuses such revisions too
 * (supabase/migrations/20261025040000_payment_lock.sql); this module keeps people from making them.
 *
 * The lock is not a task field (nothing about it travels in revisions): the workspace registers the
 * locked task ids per project from the workflow, and CollabTask's `readOnly` reads them, so Bryntum's
 * own cell editing, dragging, resizing and row reordering leave the task alone.
 */
import { StringHelper, type ProjectModel, type TaskModel } from '@bryntum/gantt';

const locks = new WeakMap<object, ReadonlySet<number>>();

/** The project a task belongs to, as the key of the registry. */
const projectOf = (task: TaskModel): object | undefined => (task.project as unknown as object | undefined) ?? undefined;

/** Payment statuses while money is on its way: the task stays locked until PayPal settles it. */
export const MONEY_MOVING = new Set(['authorized', 'submitted', 'pending', 'unknown']);

/** Registers the locked tasks of a project; returns true when the set changed. */
export function setPaymentLocks(project: ProjectModel, taskIds: Iterable<number>): boolean {
  const next = new Set(taskIds);
  const current = locks.get(project);
  if (current && current.size === next.size && [...next].every((id) => current.has(id))) return false;
  locks.set(project, next);
  return true;
}

export function paymentLocks(project: object | null | undefined): ReadonlySet<number> {
  return (project && locks.get(project)) || EMPTY;
}

const EMPTY: ReadonlySet<number> = new Set();

/** The task itself is locked. */
export function isPaymentLocked(task: TaskModel | null | undefined): boolean {
  if (!task || typeof task.id !== 'number') return false;
  return paymentLocks(projectOf(task)).has(task.id);
}

/** The locked task at or under this one (deleting or moving this one would take it along), or null. */
export function lockedWithin(task: TaskModel | null | undefined): TaskModel | null {
  if (!task) return null;
  const locked = paymentLocks(projectOf(task));
  if (locked.size === 0) return null;
  if (typeof task.id === 'number' && locked.has(task.id)) return task;
  const descendants = (task.allChildren ?? []) as TaskModel[];
  return descendants.find((child) => typeof child.id === 'number' && locked.has(child.id)) ?? null;
}

/** The first of these tasks whose deletion or move would take a locked task with it. */
export function firstLockedWithin(tasks: readonly (TaskModel | null | undefined)[]): TaskModel | null {
  for (const task of tasks) {
    const locked = lockedWithin(task);
    if (locked) return locked;
  }
  return null;
}

/** What to tell someone who tried to change a locked task, as text (React, the task panel, errors). */
export function lockMessage(task: TaskModel): string {
  return `“${task.name}” is locked while PayPal pays the supplier. It unlocks as soon as PayPal confirms.`;
}

/**
 * The same as markup, for Bryntum, which inserts a string tooltip (a menu item's, a toast's) as HTML: the task's name
 * is the plan's, which anyone in the session can write, so it is encoded.
 */
export function lockMessageHtml(task: TaskModel): string {
  return StringHelper.encodeHtml(lockMessage(task));
}

/**
 * What to tell someone whose change would push a locked task along. The database only checks what a
 * person changed, not what the schedule moved, so the library and the assistant try a change on a copy
 * first and refuse it here.
 */
export function movedLockMessage(name: string): string {
  return `This would move “${name}”, which is locked while PayPal pays the supplier. It unlocks as soon as PayPal confirms.`;
}

/** Thrown by edit paths (the task panel, the assistant, the library) that reach a locked task. */
export class PaymentLockedError extends Error {
  constructor(readonly task: TaskModel) {
    super(lockMessage(task));
    this.name = 'PaymentLockedError';
  }
}

/** Throws a PaymentLockedError when any of these tasks, or anything under them, is locked. */
export function assertNotLocked(tasks: readonly (TaskModel | null | undefined)[]): void {
  const locked = firstLockedWithin(tasks);
  if (locked) throw new PaymentLockedError(locked);
}

/**
 * Installs the lock on a task class: its `readOnly` is true while the task is locked, whatever the
 * stored field says. Defined on the prototype (not as a class accessor) because Bryntum declares
 * `readOnly` as a field on the base model.
 */
export function installPaymentLock(taskClass: { prototype: object }): void {
  let proto: object | null = Object.getPrototypeOf(taskClass.prototype) as object | null;
  let base: PropertyDescriptor | undefined;
  while (proto && !base) {
    base = Object.getOwnPropertyDescriptor(proto, 'readOnly');
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  Object.defineProperty(taskClass.prototype, 'readOnly', {
    configurable: true,
    get(this: TaskModel) {
      return isPaymentLocked(this) || Boolean(base?.get?.call(this));
    },
    set(this: TaskModel, value: boolean) {
      base?.set?.call(this, value);
    },
  });
}

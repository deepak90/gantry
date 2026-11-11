/**
 * The lock on a task PayPal is paying for: the task reads as read-only to Bryntum's own editing
 * (cell edits, drags, row reordering) without any change to its data, and deleting or moving it or a
 * group holding it is refused with a plain message.
 */
import type { TaskModel } from '@bryntum/gantt';
import { describe, expect, it } from 'vitest';
import { assertNotLocked, firstLockedWithin, isPaymentLocked, lockMessage, PaymentLockedError, setPaymentLocks } from '../../src/gantt/payment-lock';
import { newProject } from '../sync/helpers';

async function load() {
  const project = newProject();
  await project.loadInlineData({
    tasksData: [
      { id: 1, name: 'Steel frame', children: [{ id: 2, name: 'Erect steel', duration: 2 }, { id: 3, name: 'Plumb & bolt', duration: 1 }] },
      { id: 4, name: 'Roof', duration: 1 },
    ],
  });
  await project.commitAsync();
  project.acceptChanges();
  return project;
}

const task = (project: Awaited<ReturnType<typeof load>>, id: number) => project.taskStore.getById(id) as TaskModel;

describe('payment lock', () => {
  it('makes the paid-for task read-only for Bryntum without writing to it', async () => {
    const project = await load();
    expect(setPaymentLocks(project, [2])).toBe(true);
    expect(setPaymentLocks(project, [2])).toBe(false);
    expect(isPaymentLocked(task(project, 2))).toBe(true);
    expect(task(project, 2).readOnly).toBe(true);
    expect(task(project, 2).isEditable('name')).toBe(false);
    expect(task(project, 3).readOnly).toBe(false);
    expect(project.changes).toBeNull();
    setPaymentLocks(project, []);
    expect(task(project, 2).readOnly).toBe(false);
  });

  it('keeps the stored readOnly field working', async () => {
    const project = await load();
    task(project, 4).readOnly = true;
    expect(task(project, 4).readOnly).toBe(true);
    task(project, 4).readOnly = false;
    expect(task(project, 4).readOnly).toBe(false);
  });

  it('refuses to delete or move the task or a group holding it', async () => {
    const project = await load();
    setPaymentLocks(project, [2]);
    expect(firstLockedWithin([task(project, 1)])?.id).toBe(2);
    expect(firstLockedWithin([task(project, 3), task(project, 4)])).toBeNull();
    expect(() => assertNotLocked([task(project, 1)])).toThrow(PaymentLockedError);
    expect(lockMessage(task(project, 2))).toBe('“Erect steel” is locked while PayPal pays the supplier. It unlocks as soon as PayPal confirms.');
  });

  it('locks per project, so a copy of the plan is not locked', async () => {
    const [project, copy] = [await load(), await load()];
    setPaymentLocks(project, [2]);
    expect(task(copy, 2).readOnly).toBe(false);
  });
});

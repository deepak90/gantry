/**
 * Accepting what the review card suggests about a rental, and taking it back: ordinary changes to the plan, one revision
 * each, which the toolbar's Undo also takes back. Nothing holds the dates afterward but the money moving.
 */
import type { AssignmentModel, ProjectModel, ResourceModel, TaskModel } from '@bryntum/gantt';
import { parseDateOnly, toDateOnly, type EquipmentBookingRow } from '@collab/shared';
import { setRentalDates } from '../gantt/cell-editors';
import { firstLockedWithin, lockMessage } from '../gantt/payment-lock';
import { runProjectTransaction } from '../scenario/publish';
import type { RentalFix } from './review';

interface PinnedTask {
  constraintType: string | null;
  constraintDate: Date | null;
}

function onPlan(project: ProjectModel, booking: EquipmentBookingRow): { task: TaskModel; assignment: AssignmentModel; machine: string } {
  const task = project.taskStore.getById(booking.task_id) as TaskModel | undefined;
  if (!task) throw new Error('This rental’s task is no longer in the plan.');
  const assignment = ((task.assignments ?? []) as AssignmentModel[]).find((candidate) => (candidate.resource as ResourceModel | null)?.id === booking.resource_id);
  if (!assignment) throw new Error('This machine is no longer on the task.');
  const locked = firstLockedWithin([task]);
  if (locked) throw new Error(lockMessage(locked));
  return { task, assignment, machine: (assignment.resource as ResourceModel).name };
}

const span = (booking: EquipmentBookingRow) => ({ start: booking.billable_start, end: booking.billable_end });

/** Puts a rental on new dates and, for a machine booked twice, makes the work wait for it. */
export function applyRentalFix(project: ProjectModel, booking: EquipmentBookingRow, fix: RentalFix): Promise<void> {
  const { task, assignment, machine } = onPlan(project, booking);
  const pinned = task as unknown as PinnedTask;
  return runProjectTransaction(project, `Change ${machine} dates`, [
    ...(fix.moveWorkTo
      ? [
          () => {
            pinned.constraintType = 'startnoearlierthan';
            pinned.constraintDate = parseDateOnly(fix.moveWorkTo!);
          },
        ]
      : []),
    () => setRentalDates(assignment, { start: fix.start, end: fix.end }, span(booking), booking.rental_rate_minor),
  ]);
}

/** Back to the dates as quoted, and the work back to where its links put it if a fix made it wait. */
export function undoRentalFix(project: ProjectModel, booking: EquipmentBookingRow): Promise<void> {
  const { task, assignment, machine } = onPlan(project, booking);
  const pinned = task as unknown as PinnedTask;
  const heldByRental = pinned.constraintType === 'startnoearlierthan' && pinned.constraintDate instanceof Date && toDateOnly(pinned.constraintDate) === booking.billable_start;
  const quoted = { start: booking.quoted_start ?? booking.billable_start, end: booking.quoted_end ?? booking.billable_end };
  return runProjectTransaction(project, `Change ${machine} dates`, [
    ...(heldByRental
      ? [
          () => {
            pinned.constraintType = null;
            pinned.constraintDate = null;
          },
        ]
      : []),
    () => setRentalDates(assignment, quoted, span(booking), booking.rental_rate_minor),
  ]);
}

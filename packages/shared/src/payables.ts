/**
 * What the plan owes, and to whom. Cost lines sit on tasks (a library piece brings them: what it pays
 * for, who is paid, how much and when it falls due); this totals them by payee and says which are due
 * now, which come later in the plan, and which are paid. Pure: reads plain task data, writes nothing.
 */
import { z } from 'zod';
import { CostDue } from './library';
import { nonNegativeMinorUnits } from './schemas';

/** A cost line as it lives on a task (the task field `costLines`). */
export const TaskCostLine = z.object({
  label: z.string().min(1).max(80),
  payee: z.string().min(1).max(80),
  amount_minor: nonNegativeMinorUnits,
  due: CostDue,
  /** The payment that paid it (a PayPal payout item), once paid. */
  paid_ref: z.string().min(1).max(80).nullable().optional(),
});
export type TaskCostLine = z.infer<typeof TaskCostLine>;

export interface PayableTask {
  id: number | string;
  name: string;
  /** 'YYYY-MM-DD'; null for an unscheduled task. */
  startDate: string | null;
  /** 'YYYY-MM-DD', exclusive. */
  endDate: string | null;
  percentDone: number;
  costLines: readonly TaskCostLine[] | null | undefined;
}

export type PayableState = 'paid' | 'due' | 'upcoming';

export interface PayableLine {
  taskId: number | string;
  taskName: string;
  index: number;
  label: string;
  payee: string;
  amountMinor: number;
  due: z.infer<typeof CostDue>;
  /** The day it falls due in the plan: the task's start on order, its end otherwise. */
  dueDate: string | null;
  state: PayableState;
}

export interface Payee {
  payee: string;
  dueMinor: number;
  upcomingMinor: number;
  paidMinor: number;
  lines: PayableLine[];
}

/** The day before an exclusive end: the last working day of the task. */
function lastDay(endExclusive: string): string {
  const [year, month, day] = endExclusive.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

function stateOf(task: PayableTask, line: TaskCostLine, today: string): PayableState {
  if (line.paid_ref) return 'paid';
  if (line.due === 'on_order') return task.percentDone > 0 || (task.startDate !== null && task.startDate <= today) ? 'due' : 'upcoming';
  return task.percentDone >= 100 ? 'due' : 'upcoming';
}

/** Every cost line in the plan, by payee (largest amount due first, then by name). */
export function payablesByPayee(tasks: readonly PayableTask[], today: string): Payee[] {
  const byPayee = new Map<string, Payee>();
  for (const task of tasks) {
    (task.costLines ?? []).forEach((line, index) => {
      const state = stateOf(task, line, today);
      const entry: PayableLine = {
        taskId: task.id,
        taskName: task.name,
        index,
        label: line.label,
        payee: line.payee,
        amountMinor: line.amount_minor,
        due: line.due,
        dueDate: line.due === 'on_order' ? task.startDate : task.endDate ? lastDay(task.endDate) : null,
        state,
      };
      const payee = byPayee.get(line.payee) ?? { payee: line.payee, dueMinor: 0, upcomingMinor: 0, paidMinor: 0, lines: [] };
      payee.lines.push(entry);
      if (state === 'paid') payee.paidMinor += line.amount_minor;
      else if (state === 'due') payee.dueMinor += line.amount_minor;
      else payee.upcomingMinor += line.amount_minor;
      byPayee.set(line.payee, payee);
    });
  }
  for (const payee of byPayee.values()) {
    payee.lines.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || String(a.taskId).localeCompare(String(b.taskId)) || a.index - b.index);
  }
  return [...byPayee.values()].sort((a, b) => b.dueMinor - a.dueMinor || b.upcomingMinor - a.upcomingMinor || a.payee.localeCompare(b.payee));
}

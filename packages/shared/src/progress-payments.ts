/**
 * Progress payments worked out from the plan, the way a pay application does it (AIA G702/G703): each
 * firm's work is valued by the budgets of the tasks it does, earned by their percent complete, less a
 * part kept back until handover (retainage) and less what was paid before.
 *
 * A payment gate holds back part of the plan until such a payment is made. It lives on a milestone in
 * the plan (the task field `payGate`), linked finish-to-start to the work it holds, so the scheduling
 * engine itself keeps that work from starting before the money is in: a payment made late moves it,
 * and everything after it, through weekends and holidays.
 *
 * Pure: plain task data in, integer minor units out.
 */
import { z } from 'zod';

/** The part of each progress payment kept back until handover. */
export const DEFAULT_RETAINAGE = 0.1;

/** One task's share of a progress payment, as the plan has it. */
export interface ProgressTask {
  id: number | string;
  name: string;
  /** The firm that does the work and is paid for it. Tasks without one are not part of a progress payment. */
  firm: string | null;
  /** What the work is worth (the task's budget), in minor units. */
  valueMinor: number;
  /** Percent complete, 0 to 100, as reported. */
  percentDone: number;
  /** Paid against this task so far, in minor units. */
  paidMinor: number;
}

export interface ProgressItem {
  taskId: number | string;
  taskName: string;
  valueMinor: number;
  percentDone: number;
  /** The value of the work reported done. */
  earnedMinor: number;
  /** Kept back from what was earned, until handover. */
  retainedMinor: number;
  paidBeforeMinor: number;
  /** Earned, less what is kept back, less what was paid before; never negative. */
  dueMinor: number;
}

export interface FirmProgress {
  firm: string;
  items: ProgressItem[];
  valueMinor: number;
  earnedMinor: number;
  /** Earned over value, 0 to 100. */
  percentDone: number;
  retainedMinor: number;
  paidBeforeMinor: number;
  dueMinor: number;
}

export interface ProgressPayment {
  retainage: number;
  /** Firms with work in the payment, the most due first. */
  firms: FirmProgress[];
  valueMinor: number;
  earnedMinor: number;
  retainedMinor: number;
  paidBeforeMinor: number;
  dueMinor: number;
}

const clampPercent = (percent: number): number => (Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0);

/**
 * What each firm has earned on these tasks and what is due to it now. Each task is worked out on its own
 * (earned, kept back, due) so that paying the result can be written back task by task without rounding drift.
 */
export function progressPayment(tasks: readonly ProgressTask[], retainage: number = DEFAULT_RETAINAGE): ProgressPayment {
  const kept = Math.min(0.5, Math.max(0, retainage));
  const byFirm = new Map<string, FirmProgress>();
  for (const task of tasks) {
    if (!task.firm || task.valueMinor <= 0) continue;
    const percentDone = clampPercent(task.percentDone);
    const earnedMinor = Math.round((task.valueMinor * percentDone) / 100);
    const payableMinor = Math.round(earnedMinor * (1 - kept));
    const paidBeforeMinor = Math.max(0, Math.round(task.paidMinor));
    const item: ProgressItem = {
      taskId: task.id,
      taskName: task.name,
      valueMinor: task.valueMinor,
      percentDone,
      earnedMinor,
      retainedMinor: earnedMinor - payableMinor,
      paidBeforeMinor,
      dueMinor: Math.max(0, payableMinor - paidBeforeMinor),
    };
    const firm = byFirm.get(task.firm) ?? { firm: task.firm, items: [], valueMinor: 0, earnedMinor: 0, percentDone: 0, retainedMinor: 0, paidBeforeMinor: 0, dueMinor: 0 };
    firm.items.push(item);
    firm.valueMinor += item.valueMinor;
    firm.earnedMinor += item.earnedMinor;
    firm.retainedMinor += item.retainedMinor;
    firm.paidBeforeMinor += item.paidBeforeMinor;
    firm.dueMinor += item.dueMinor;
    byFirm.set(task.firm, firm);
  }
  const firms = [...byFirm.values()]
    .map((firm) => ({ ...firm, percentDone: firm.valueMinor > 0 ? (firm.earnedMinor / firm.valueMinor) * 100 : 0 }))
    .sort((a, b) => b.dueMinor - a.dueMinor || a.firm.localeCompare(b.firm));
  const sum = (key: 'valueMinor' | 'earnedMinor' | 'retainedMinor' | 'paidBeforeMinor' | 'dueMinor') => firms.reduce((total, firm) => total + firm[key], 0);
  return {
    retainage: kept,
    firms,
    valueMinor: sum('valueMinor'),
    earnedMinor: sum('earnedMinor'),
    retainedMinor: sum('retainedMinor'),
    paidBeforeMinor: sum('paidBeforeMinor'),
    dueMinor: sum('dueMinor'),
  };
}

/**
 * What each task has been paid once this payment has gone through: its paid amount plus its share of it. `firms`, when
 * given, are the only firms paid (PayPal can pay one firm and refuse another); the others' tasks are left out.
 */
export function paidAfter(payment: ProgressPayment, firms?: ReadonlySet<string>): Map<number | string, number> {
  const paid = new Map<number | string, number>();
  for (const firm of payment.firms) {
    if (firms && !firms.has(firm.firm)) continue;
    for (const item of firm.items) paid.set(item.taskId, item.paidBeforeMinor + item.dueMinor);
  }
  return paid;
}

// ---------------------------------------------------------------------------------------------
// Payment gates
// ---------------------------------------------------------------------------------------------

/** Waiting for the payment; PayPal is paying it; paid; or PayPal refused it. */
export const PayGateState = z.enum(['waiting', 'paying', 'paid', 'failed']);
export type PayGateState = z.infer<typeof PayGateState>;

/** The task field `payGate`, on the milestone that holds the work after it. */
export const PayGate = z.object({
  /** The plan rows whose work the payment pays for (a summary row stands for everything under it). */
  pays: z.array(z.union([z.number(), z.string()])).min(1).max(50),
  retainage: z.number().min(0).max(0.5),
  state: PayGateState,
  /** PayPal's payout batch, once sent. */
  batchId: z.string().max(80).nullable(),
  /** When PayPal confirmed the payment, an ISO date-time. */
  paidAt: z.string().max(40).nullable(),
  /** What was sent, in minor units. */
  amountMinor: z.number().int().nonnegative().nullable(),
  /** PayPal's words when it refused. */
  error: z.string().max(400).nullable().optional(),
  /**
   * The last part of this payment's PayPal batch id, kept here before PayPal first hears of it. A press after an
   * answer was lost sends the same id, and PayPal refuses to pay a second batch with it. Cleared when PayPal turns the
   * batch down, so the next try is a new payment.
   */
  batchKey: z.string().max(40).nullable().optional(),
  /** Paid so far when PayPal paid only some of the firms, in minor units; the held work waits for the rest. */
  partPaidMinor: z.number().int().nonnegative().nullable().optional(),
});
export type PayGate = z.infer<typeof PayGate>;

/** A gate as it is set up: waiting for the progress payment for `pays`. */
export function newPayGate(pays: readonly (number | string)[], retainage: number = DEFAULT_RETAINAGE): PayGate {
  return { pays: [...pays], retainage, state: 'waiting', batchId: null, paidAt: null, amountMinor: null, error: null };
}

/** The gate on a task, if the field holds one; anything else reads as no gate. */
export function readPayGate(value: unknown): PayGate | null {
  const parsed = PayGate.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// Two people for a large payout
// ---------------------------------------------------------------------------------------------

/**
 * Progress payouts over this need a second person who sees costs to approve them before they go out: $25,000,
 * unless a project sets its own (`projects.second_approval_over_minor`, which the payout server enforces).
 */
export const DEFAULT_SECOND_APPROVAL_OVER_MINOR = 2_500_000;

/** A member as the rule reads them. */
export interface PayoutSigner {
  userId: string;
  name: string;
  canViewCosts: boolean;
  approvalLimitMinor: number;
}

export interface SecondApproval {
  /** Payouts over this amount need a second person. */
  overMinor: number;
  /** This payout does. */
  needed: boolean;
  /** Who may approve it: members who see costs and whose approval limit covers it, other than whoever sends it. */
  signers: PayoutSigner[];
}

/** The project's threshold, or the default when it has none (or it can't be read). */
export function secondApprovalOver(overMinor: number | null | undefined): number {
  return typeof overMinor === 'number' && Number.isSafeInteger(overMinor) && overMinor >= 0 ? overMinor : DEFAULT_SECOND_APPROVAL_OVER_MINOR;
}

/** Whether a payout of `amountMinor` needs a second person, and who could be it, for the person `senderId` sending it. */
export function secondApproval(amountMinor: number, overMinor: number | null | undefined, members: readonly PayoutSigner[], senderId?: string | null): SecondApproval {
  const over = secondApprovalOver(overMinor);
  return {
    overMinor: over,
    needed: amountMinor > over,
    signers: members.filter((member) => member.canViewCosts && member.approvalLimitMinor >= amountMinor && member.userId !== senderId),
  };
}

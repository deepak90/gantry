/**
 * Progress payments (pay to proceed): what the plan owes each firm for work reported done, held back by a payment gate
 * until it is paid. A gate is a milestone carrying `payGate` (packages/shared/src/progress-payments.ts): it names the
 * work it pays for, keeps part back until handover (retainage), and the work linked after it can't start until PayPal
 * has paid. The figures are the app's own (the payment card shows the same), worked out from the plan's budgets and
 * percent complete; nothing here pays anyone. Also the words for the app event when PayPal confirms a payment.
 *
 * Each firm's figures are its own (its share of the payout), apart from the payout's total, which is every firm in it
 * together, sent as one PayPal batch. The two-person rule comes with them: payouts over the project's threshold need
 * a second person who sees costs to approve them before they go out (the payout server enforces it).
 */
import { addDays, progressPayment, secondApproval, type PayGate, type ProgressTask } from '@collab/shared';
import { z } from 'zod';
import { day, usd } from '../plan/format';
import { findTask, type PlanSnapshot, type PlanTask } from '../plan/snapshot';
import { ToolRefusal } from './refusal';

export const PaymentToolSchemas = {
  get_progress_payments: z.object({
    firm: z.string().trim().min(1).max(120).nullish().describe('Only the payments with work by this firm (as the people call it), e.g. "Granite Ridge"'),
  }),
};
export type PaymentToolName = keyof typeof PaymentToolSchemas;

export const PAYMENT_TOOL_DESCRIPTIONS: Record<PaymentToolName, string> = {
  get_progress_payments:
    'The progress payments the plan holds work for (pay to proceed): for each, the work it pays for, the work that waits for it (and when that starts), whether it is waiting, being paid or paid, the day it falls due and the Friday it would go out with the other payments; for each firm its own share (what its work is for, worth and done, what is kept back until handover and what it is due now); the payout total (every firm together, one PayPal payout); and the two-person rule (the threshold, whether this payout needs a second person to approve it, and who can). The same figures as the payment card in the app. Use it when someone asks what is owed to a firm or on a piece of work, what a payment is for, what is waiting on a payment, or who has to approve it. Sending and approving are people’s presses (Review payment, the second person’s Approve, then Send payout); you never press either.',
};

export const isPaymentTool = (name: string): name is PaymentToolName => name in PaymentToolSchemas;

const dollars = (minor: number) => usd(minor).replace(/\.00$/, '');

/** The two-person rule for a payout, from the project's threshold and its members (see `secondApproval` in shared). */
export interface PayoutApprovalView {
  /** The rule in one sentence, as the app applies it. */
  rule: string;
  over_minor: number;
  over_text: string;
  /** This payout is over the threshold: a second person has to approve it before it can be sent. */
  needs_second_person: boolean;
  /** Who can send or approve it (members who see costs and whose approval limit covers it): one sends, another approves. */
  who_can_sign: string[];
  /** Who can approve it for the person asking: who_can_sign without them (nobody approves their own payout). */
  who_can_approve: string[];
}

function approvalView(plan: PlanSnapshot, amountMinor: number, askerId: string | null = null): PayoutApprovalView {
  const members = plan.members.map((member) => ({ userId: member.userId, name: member.name, canViewCosts: member.canViewCosts, approvalLimitMinor: member.approvalLimitMinor }));
  const rule = secondApproval(amountMinor, plan.secondApprovalOverMinor, members);
  return {
    rule: `Payouts over ${dollars(rule.overMinor)} need a second person who sees costs to approve them before they go out.`,
    over_minor: rule.overMinor,
    over_text: dollars(rule.overMinor),
    needs_second_person: rule.needed,
    who_can_sign: rule.signers.map((member) => member.name),
    who_can_approve: rule.signers.filter((member) => member.userId !== askerId).map((member) => member.name),
  };
}

/** The leaf tasks of work under these rows (a task stands for itself), each once; milestones left out. */
function workUnder(plan: PlanSnapshot, ids: readonly (number | string)[]): PlanTask[] {
  const out = new Map<number, PlanTask>();
  const visit = (task: PlanTask) => {
    if (task.isLeaf) {
      if (!task.isMilestone) out.set(task.id, task);
      return;
    }
    for (const child of plan.tasks.filter((candidate) => candidate.parentId === task.id)) visit(child);
  };
  for (const id of ids) {
    const task = typeof id === 'number' ? findTask(plan, id) : null;
    if (task) visit(task);
  }
  return [...out.values()];
}

/** The firm paid for a task: its crew's company (machines on rent are paid as rentals, not here). */
function firmOf(plan: PlanSnapshot, task: PlanTask): string | null {
  for (const assignment of plan.assignments.filter((candidate) => candidate.taskId === task.id)) {
    const resource = plan.resources.find((candidate) => candidate.id === assignment.resourceId);
    if (resource && resource.kind !== 'equipment') return resource.company || resource.name || null;
  }
  return null;
}

/** The Friday on or after a day: when a payment goes out with the week's other payments. */
function fridayFrom(date: string): string {
  const [year, month, dayOfMonth] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, dayOfMonth ?? 1)).getUTCDay();
  return addDays(date, (5 - weekday + 7) % 7);
}

export interface ProgressPaymentView {
  gate_id: number;
  name: string;
  state: PayGate['state'];
  /** The day it falls due: the gate's own date (the work it pays for is done). */
  due_on: string;
  due_text: string;
  /** The Friday it would go out with the other payments. */
  pay_run_on: string;
  pay_run_text: string;
  pays_for: string[];
  holds: { name: string; start: string; start_text: string }[];
  retainage_percent: number;
  /** Each firm's own share of the payout, the most due first: `due_text` is that firm's amount, never the payout's total. */
  firms: {
    firm: string;
    /** What this firm's money is for: its tasks in the work paid for. */
    work: string[];
    percent_done: number;
    value_minor: number;
    value_text: string;
    earned_minor: number;
    retained_minor: number;
    retained_text: string;
    paid_before_minor: number;
    due_minor: number;
    due_text: string;
  }[];
  /** Every firm together: what one PayPal payout sends if it is paid today. */
  payout_total_minor: number;
  payout_total_text: string;
  firm_count: number;
  approval: PayoutApprovalView;
  batch_id: string | null;
  paid_at: string | null;
  paid_minor: number | null;
}

/** Every payment gate in the plan, worked out the way the payment card does it. */
/** `askerId`: the person asking, left out of who may approve. */
export function progressPayments(plan: PlanSnapshot, askerId: string | null = null): ProgressPaymentView[] {
  return plan.tasks
    .filter((task): task is PlanTask & { payGate: PayGate } => Boolean(task.payGate))
    .map((gate) => {
      const work = workUnder(plan, gate.payGate.pays);
      const tasks: ProgressTask[] = work.map((task) => ({ id: task.id, name: task.name, firm: firmOf(plan, task), valueMinor: task.budgetMinor, percentDone: task.percentDone, paidMinor: task.paidMinor }));
      const payment = progressPayment(tasks, gate.payGate.retainage);
      const holds = plan.dependencies
        .filter((link) => link.from === gate.id && link.active !== false)
        .map((link) => findTask(plan, link.to))
        .filter((task): task is PlanTask => task !== null)
        .map((task) => {
          const group = task.parentId !== null ? findTask(plan, task.parentId) : null;
          return { name: group && !group.payGate ? `${group.name}: ${task.name}` : task.name, start: task.start, start_text: day(task.start) };
        });
      const paysFor = gate.payGate.pays.map((id) => (typeof id === 'number' ? findTask(plan, id)?.name : null)).filter((name): name is string => Boolean(name));
      // Due the day the work it waits on is done (the payment card's day): the last day of the work linked into it.
      const ends = plan.dependencies.filter((link) => link.to === gate.id && link.active !== false).map((link) => findTask(plan, link.from)?.end).filter((end): end is string => Boolean(end));
      const dueOn = ends.length > 0 ? addDays(ends.sort().at(-1)!, -1) : gate.start;
      return {
        gate_id: gate.id,
        name: gate.name,
        state: gate.payGate.state,
        due_on: dueOn,
        due_text: day(dueOn),
        pay_run_on: fridayFrom(dueOn),
        pay_run_text: day(fridayFrom(dueOn)),
        pays_for: paysFor,
        holds,
        retainage_percent: Math.round(payment.retainage * 100),
        firms: payment.firms.map((firm) => ({
          firm: firm.firm,
          work: firm.items.map((item) => item.taskName),
          percent_done: Math.round(firm.percentDone),
          value_minor: firm.valueMinor,
          value_text: dollars(firm.valueMinor),
          earned_minor: firm.earnedMinor,
          retained_minor: firm.retainedMinor,
          retained_text: dollars(firm.retainedMinor),
          paid_before_minor: firm.paidBeforeMinor,
          due_minor: firm.dueMinor,
          due_text: dollars(firm.dueMinor),
        })),
        payout_total_minor: payment.dueMinor,
        payout_total_text: dollars(payment.dueMinor),
        firm_count: payment.firms.filter((firm) => firm.dueMinor > 0).length,
        approval: approvalView(plan, payment.dueMinor, askerId),
        batch_id: gate.payGate.batchId,
        paid_at: gate.payGate.paidAt,
        paid_minor: gate.payGate.amountMinor,
      };
    });
}

/** The firm they named, as the plan calls it: "Granite Ridge" is Granite Ridge Concrete. */
const namesFirm = (said: string, firm: string) => {
  const a = said.toLowerCase();
  const b = firm.toLowerCase();
  return b.includes(a) || a.includes(b);
};

export function runPaymentTool(_name: PaymentToolName, rawArgs: unknown, ctx: { plan: PlanSnapshot; speaker?: { userId: string } | null }): unknown {
  const parsed = PaymentToolSchemas.get_progress_payments.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  const all = progressPayments(ctx.plan, ctx.speaker?.userId ?? null);
  const said = parsed.data.firm ?? null;
  const payments = said ? all.filter((payment) => payment.firms.some((entry) => namesFirm(said, entry.firm))) : all;
  // The firm they asked about, in each payment its work is in: its own amount, and the payout it goes out in.
  const asked = said
    ? payments.flatMap((payment) =>
        payment.firms
          .filter((entry) => namesFirm(said, entry.firm))
          .map((entry) => ({
            firm: entry.firm,
            payment: payment.name,
            due_minor: entry.due_minor,
            due_text: entry.due_text,
            work: entry.work,
            others_in_payout: payment.firms.filter((other) => other.firm !== entry.firm && other.due_minor > 0).map((other) => ({ firm: other.firm, due_text: other.due_text, work: other.work })),
            payout_total_text: payment.payout_total_text,
          })),
      )
    : [];
  return {
    ...(said ? { asked_about: asked } : {}),
    payments,
    note:
      payments.length === 0
        ? said
          ? `No progress payment has work by ${said}.`
          : 'The plan holds no work for a progress payment.'
        : 'Each firm’s due_text is that firm’s own share if it is paid today (its earned value less what is kept back until handover); payout_total_text is every firm together, sent as one PayPal payout. Asked what one firm is owed: that firm’s due_text, then the payout total when other firms are in it. The work in holds starts the working day after the money lands. approval says whether a second person has to approve the payout before it can be sent, and who can.',
  };
}

/** A payment gate PayPal has just confirmed paid: the facts for the app event the assistant answers. */
export function paymentConfirmedFacts(plan: PlanSnapshot, gateId: number): ProgressPaymentView | null {
  return progressPayments(plan).find((payment) => payment.gate_id === gateId) ?? null;
}

/**
 * Two people for a large progress payment: the records behind it (supabase/migrations/20261108010000_pay_gate_approvals.sql)
 * and the calls that change them. The person who will send a payout over the project's threshold asks for a second
 * person's approval of exactly the firms and amounts they reviewed; someone else who sees costs, and whose approval
 * limit covers it, approves or declines it on their own screen; the payout server then claims the approval before it
 * calls PayPal. Every change is announced on the project's workflow topic, so the workflow snapshot (workflow/api.ts)
 * carries the rows to every screen within a moment.
 *
 * Read tolerantly: a database without the table yet (or without the threshold column) reads as "no approvals here",
 * and the payout server refuses large payouts until it has them.
 */
import { DEFAULT_SECOND_APPROVAL_OVER_MINOR, secondApproval, type PayoutSigner, type SecondApproval } from '@collab/shared';
import { z } from 'zod';
import type { WorkflowClient, WorkflowErrorLike } from '../workflow/api';

export const PayGateApprovalStatus = z.enum(['requested', 'approved', 'declined', 'withdrawn', 'used']);
export type PayGateApprovalStatus = z.infer<typeof PayGateApprovalStatus>;

/** A firm's line as it was reviewed: what it is paid, and what for. */
export const PayGateApprovalLine = z.looseObject({
  firm: z.string(),
  amount_minor: z.number().int(),
  /** The work the money is for, in a few words. */
  for: z.string().optional(),
  percent_done: z.number().optional(),
  value_minor: z.number().int().optional(),
  retained_minor: z.number().int().optional(),
});
export type PayGateApprovalLine = z.infer<typeof PayGateApprovalLine>;

export const PayGateApprovalRow = z.object({
  id: z.string(),
  project_id: z.string(),
  gate_id: z.number().int(),
  gate_name: z.string(),
  amount_minor: z.number().int(),
  currency: z.string(),
  lines: z.array(PayGateApprovalLine),
  over_minor: z.number().int(),
  requested_by: z.string(),
  status: PayGateApprovalStatus,
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  used_at: z.string().nullable(),
  sender_batch_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PayGateApprovalRow = z.infer<typeof PayGateApprovalRow>;

/** PostgREST's and Postgres's words for a table or column that isn't there. */
const MISSING = new Set(['PGRST205', 'PGRST204', '42P01', '42703']);

/** The project's approvals, oldest first; null when this database has no such records (or they can't be read). */
export async function loadPayGateApprovals(client: Pick<WorkflowClient, 'from'>, projectId: string): Promise<PayGateApprovalRow[] | null> {
  let answer: { data: unknown[] | null; error: WorkflowErrorLike | null };
  try {
    answer = (await client.from('pay_gate_approvals').select('*').eq('project_id', projectId).order('created_at', { ascending: true })) as typeof answer;
  } catch {
    return null;
  }
  const { data, error } = answer;
  if (error) {
    if (!MISSING.has(error.code ?? '')) console.warn('[pay approvals] cannot read pay_gate_approvals', error.message);
    return null;
  }
  const rows: PayGateApprovalRow[] = [];
  for (const raw of data ?? []) {
    const parsed = PayGateApprovalRow.safeParse(raw);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/** The project's two-person threshold; null when it can't be read (the default applies). */
export async function loadSecondApprovalOver(client: Pick<WorkflowClient, 'from'>, projectId: string): Promise<number | null> {
  try {
    const { data, error } = (await client.from('projects').select('second_approval_over_minor').eq('id', projectId)) as { data: unknown[] | null; error: WorkflowErrorLike | null };
    if (error) return null;
    const value = (data?.[0] as { second_approval_over_minor?: unknown } | undefined)?.second_approval_over_minor;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** A refusal from the database, in its own words without the function's name. */
export class PayApprovalError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PayApprovalError';
    this.code = code;
  }
}

/**
 * The database counts money in cents and says so ("payouts over 2500000 minor units need a second person…"); a person
 * reads dollars ("payouts over $25,000.00 need…"). Both numbers of an approval limit are said in dollars too.
 */
export function inDollars(message: string): string {
  const usd = (minor: string) => (Number(minor) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return message
    .replace(/(\d+) minor units exceeds your approval limit of (\d+)/g, (_, amount: string, limit: string) => `${usd(amount)} exceeds your approval limit of ${usd(limit)}`)
    .replace(/(\d+) minor units/g, (_, amount: string) => usd(amount));
}

async function call(client: Pick<WorkflowClient, 'rpc'>, fn: string, args: object): Promise<PayGateApprovalRow> {
  const { data, error } = (await client.rpc(fn, args)) as { data: unknown; error: WorkflowErrorLike | null };
  if (error) {
    const missing = error.code === 'PGRST202' || error.code === '42883';
    throw new PayApprovalError(missing ? 'Second approval not set up in this database (migration not applied)' : inDollars(error.message.replace(/^[a-z_]+: /, '')), error.code);
  }
  const parsed = PayGateApprovalRow.safeParse(data);
  if (!parsed.success) throw new PayApprovalError(`${fn} answered in an unexpected shape`, 'INVALID_RESPONSE');
  return parsed.data;
}

export interface ApprovalAsk {
  projectId: string;
  gateId: number;
  gateName: string;
  amountMinor: number;
  currency: string;
  lines: PayGateApprovalLine[];
}

/** How long the loser of two asks at once waits before asking again. */
export const ASK_AGAIN_MS = 200;

/**
 * Asks for a second person's approval of this payout; the same open request comes back if it was asked already.
 * Two asks at the same moment (React runs effects twice in development; two quick opens) race to the
 * one-open-request-per-payment rule, and the loser is refused with a unique violation before the winner is
 * committed. Asking once more then returns the winner's request, if it is for the same firms and amounts.
 */
export async function requestPayGateApproval(client: Pick<WorkflowClient, 'rpc'>, ask: ApprovalAsk): Promise<PayGateApprovalRow> {
  const args = {
    p_project: ask.projectId,
    p_gate: ask.gateId,
    p_gate_name: ask.gateName,
    p_amount_minor: ask.amountMinor,
    p_currency: ask.currency,
    p_lines: ask.lines,
  };
  try {
    return await call(client, 'request_pay_gate_approval', args);
  } catch (error) {
    if (!(error instanceof PayApprovalError) || error.code !== '23505') throw error;
    await new Promise((resolve) => setTimeout(resolve, ASK_AGAIN_MS));
    return call(client, 'request_pay_gate_approval', args);
  }
}

/** The second person's answer. */
export function decidePayGateApproval(client: Pick<WorkflowClient, 'rpc'>, approvalId: string, approve: boolean): Promise<PayGateApprovalRow> {
  return call(client, 'decide_pay_gate_approval', { p_approval: approvalId, p_approve: approve });
}

/** The person who asked takes it back (they closed the review without sending). */
export function withdrawPayGateApproval(client: Pick<WorkflowClient, 'rpc'>, approvalId: string): Promise<PayGateApprovalRow> {
  return call(client, 'withdraw_pay_gate_approval', { p_approval: approvalId });
}

/** Whether lines are the same payout: the same firms and amounts, in any order. */
export function sameLines(a: readonly Pick<PayGateApprovalLine, 'firm' | 'amount_minor'>[], b: readonly Pick<PayGateApprovalLine, 'firm' | 'amount_minor'>[]): boolean {
  const key = (lines: readonly Pick<PayGateApprovalLine, 'firm' | 'amount_minor'>[]) =>
    lines
      .map((line) => `${line.firm.trim()}\u0000${line.amount_minor}`)
      .sort()
      .join('\u0001');
  return key(a) === key(b);
}

/** The open request (asked, or approved) for a gate, newest first. */
export function openApproval(rows: readonly PayGateApprovalRow[] | null | undefined, gateId: number | string): PayGateApprovalRow | null {
  const open = (rows ?? []).filter((row) => row.gate_id === Number(gateId) && (row.status === 'requested' || row.status === 'approved'));
  return open.at(-1) ?? null;
}

/** An approval is good for this long after it was given (claim_pay_gate_payout refuses older ones). */
export const APPROVAL_FRESH_MS = 30 * 60_000;

/** The rule for a payout of `amountMinor` sent by `senderId`, from what the workflow snapshot knows. */
export function payoutRule(amountMinor: number, overMinor: number | null | undefined, people: readonly PayoutSigner[], senderId: string): SecondApproval {
  return secondApproval(amountMinor, overMinor ?? DEFAULT_SECOND_APPROVAL_OVER_MINOR, people, senderId);
}

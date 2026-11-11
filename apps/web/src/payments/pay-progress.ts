/**
 * Where a progress payout stands, step by step, from what PayPal itself reports (gantt/pay-gate-payment.ts polls the
 * batch): submitted to PayPal (PayPal took the batch and gave it an id), processing (the batch is PENDING or
 * PROCESSING), paid (the batch is SUCCESS and so is every firm's payment). Each firm's payment goes by its own item
 * status. Nothing here keeps time: a step moves only when PayPal's answer does.
 */
import type { BatchStatus } from '../gantt/pay-gate-payment';
import { counted, lineTone, paypalWord, type PayoutLineTone } from './payout-sheet';

export type StepState = 'todo' | 'active' | 'done' | 'failed';
export type StepKey = 'sent' | 'processing' | 'paid';

export interface PayoutStep {
  key: StepKey;
  label: string;
  state: StepState;
  /** What PayPal said at this step, in a few words. */
  detail: string | null;
}

export interface PayoutItemView {
  firm: string;
  amountMinor: number;
  tone: PayoutLineTone;
  /** PayPal's word for the payment ("Pending", "Paid"), or null before PayPal has listed it. */
  word: string | null;
  transactionId: string | null;
  note: string | null;
}

const REFUSED_BATCH = new Set(['DENIED', 'CANCELED']);
const REFUSED_ITEM = new Set(['FAILED', 'UNCLAIMED', 'RETURNED', 'BLOCKED', 'ONHOLD', 'REFUNDED', 'REVERSED', 'DENIED']);

export interface PayoutProgressInput {
  /** The page is sending the batch to PayPal (no answer yet). */
  sending: boolean;
  /** PayPal's batch, once it took it. */
  batchId: string | null;
  /** What PayPal last said about the batch. */
  status: BatchStatus | null;
  /** Why nothing reached PayPal, or why PayPal refused. */
  error: string | null;
  /** The firms as sent, in the order sent. */
  sent: readonly { firm: string; amountMinor: number }[];
  /** Approved on PayPal's own pages (a checkout), not sent as a Payouts batch. */
  checkout?: boolean;
}

/** The item for the firm at `index` (from 0, in the order sent), by our item id's last number. */
function itemAt(status: BatchStatus | null, index: number) {
  return status?.items.find((item) => Number(item.itemId.split('-').pop()) === index + 1) ?? null;
}

export function payoutItems({ status, sent }: Pick<PayoutProgressInput, 'status' | 'sent'>): PayoutItemView[] {
  return sent.map((line, index) => {
    const item = itemAt(status, index);
    const paypalStatus = item?.status ?? (status ? status.status : null);
    const tone = lineTone({ key: line.firm, firm: line.firm, amountMinor: line.amountMinor, paypalStatus }, true);
    return { firm: line.firm, amountMinor: line.amountMinor, tone, word: paypalStatus ? paypalWord(paypalStatus) : null, transactionId: item?.transactionId ?? null, note: item?.error ?? null };
  });
}

/** The three steps, each from PayPal's own statuses. */
export function payoutSteps(input: PayoutProgressInput): PayoutStep[] {
  const { sending, batchId, status, error, checkout = false } = input;
  const items = status?.items ?? [];
  const settled = status?.status === 'SUCCESS' && items.length > 0 && items.every((item) => item.status === 'SUCCESS');
  const refused = Boolean(status && REFUSED_BATCH.has(status.status)) || items.some((item) => REFUSED_ITEM.has(item.status));
  // "2 of 2 payments completed": the payments sent, and how many of them PayPal reports paid.
  const completed = `${items.filter((item) => item.status === 'SUCCESS').length} of ${counted(Math.max(input.sent.length, items.length), 'payment')} completed`;
  const sent: PayoutStep = {
    key: 'sent',
    label: checkout ? 'Approved at PayPal' : 'Submitted to PayPal',
    state: batchId ? 'done' : error ? 'failed' : sending ? 'active' : 'todo',
    detail: batchId ? (checkout ? 'Approved in PayPal’s window' : 'Batch accepted') : error && !batchId ? error : sending ? 'Submitting batch…' : null,
  };
  const processing: PayoutStep = {
    key: 'processing',
    label: 'Processing',
    state: !batchId ? 'todo' : settled ? 'done' : refused ? 'failed' : 'active',
    detail: !batchId ? null : settled ? 'Processed' : refused ? (error ?? 'Payment not completed') : status ? `PayPal status: ${paypalWord(status.status)}` : 'Awaiting PayPal status',
  };
  const paid: PayoutStep = {
    key: 'paid',
    label: 'Paid',
    state: settled ? 'done' : refused ? 'failed' : 'todo',
    detail: settled || refused ? completed : null,
  };
  return [sent, processing, paid];
}

/** The payout as a whole: being reviewed, on its way, with PayPal, paid or refused. */
export function payoutPhase(steps: readonly PayoutStep[], started: boolean): 'review' | 'sending' | 'processing' | 'paid' | 'failed' {
  if (!started) return 'review';
  if (steps.some((step) => step.state === 'failed')) return 'failed';
  if (steps[2]!.state === 'done') return 'paid';
  return steps[0]!.state === 'done' ? 'processing' : 'sending';
}

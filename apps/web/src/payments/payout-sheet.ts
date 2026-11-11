/**
 * A payout as PayPal Payouts makes it, for the review sheet (PayoutSheet.tsx): one line per firm, PayPal's fee,
 * the PayPal balance it comes from and the total; once sent, each firm's payment in PayPal's own status words.
 *
 * PayPal Payouts sends from the sender's PayPal balance only (there is no card or bank to choose), and the firms
 * pay no fee. Until PayPal has settled a batch the fee shown is PayPal's published US Payouts API rate, and says
 * so; after that it is the fee PayPal reports.
 */
import type { ProjectModel, ResourceModel } from '@bryntum/gantt';
import type { PaymentStatus } from '@collab/shared';

/** PayPal's published fee for each payment sent with the US Payouts API: $0.25. */
export const PAYOUT_RATE_MINOR = 25;

/** What PayPal's checkout takes from the firm that receives a payment: 3.49% + $0.49, its US rate. */
export function checkoutFeeMinor(amountMinor: number): number {
  return Math.round(amountMinor * 0.0349) + 49;
}

/** Where a firm's payment stands: under review, on its way to PayPal, then as PayPal reports it; or never sent. */
export type PayoutLineTone = 'review' | 'sending' | 'pending' | 'paid' | 'held' | 'failed' | 'unsent';

export interface PayoutLine {
  key: string;
  firm: string;
  amountMinor: number;
  /** PayPal's status for this payment in PayPal's words (SUCCESS, PENDING, UNCLAIMED…); null until PayPal has one. */
  paypalStatus?: string | null;
  /** PayPal's transaction, once it has one. */
  transactionId?: string | null;
  /** PayPal's reason, when it holds or refuses the payment. */
  note?: string | null;
  /** Never sent: the payout stopped at a refusal before it (the payments go one at a time). */
  unsent?: boolean;
}

const WORDS: Readonly<Record<string, string>> = {
  SUCCESS: 'Paid',
  PENDING: 'Pending',
  PROCESSING: 'Pending',
  NEW: 'Pending',
  UNCLAIMED: 'Unclaimed',
  ONHOLD: 'On hold',
  FAILED: 'Failed',
  RETURNED: 'Returned',
  BLOCKED: 'Blocked',
  REFUNDED: 'Refunded',
  REVERSED: 'Reversed',
  DENIED: 'Denied',
  CANCELED: 'Canceled',
};

/** PayPal's status as a word: SUCCESS is "Paid", PENDING "Pending", ONHOLD "On hold". */
export function paypalWord(status: string): string {
  return WORDS[status] ?? `${status.charAt(0)}${status.slice(1).toLowerCase()}`;
}

/** How a line stands: before sending it is under review; after, it goes by PayPal's status. */
export function lineTone(line: PayoutLine, sent: boolean): PayoutLineTone {
  if (!sent) return 'review';
  const status = line.paypalStatus;
  if (!status) return line.unsent ? 'unsent' : 'sending';
  if (status === 'SUCCESS') return 'paid';
  if (status === 'PENDING' || status === 'PROCESSING' || status === 'NEW') return 'pending';
  if (status === 'UNCLAIMED' || status === 'ONHOLD') return 'held';
  return 'failed';
}

export interface PayoutFee {
  minor: number;
  /** PayPal reported it for this payout; otherwise it is PayPal's published rate. */
  reported: boolean;
}

/** PayPal's fee: what PayPal reported once the payout settled, else its published rate for this many payments. */
export function payoutFee(payments: number, reportedMinor: number | null | undefined): PayoutFee {
  return reportedMinor === null || reportedMinor === undefined ? { minor: payments * PAYOUT_RATE_MINOR, reported: false } : { minor: reportedMinor, reported: true };
}

/** A count with its noun, singular or plural from the number itself: "1 trade partner", "2 payments". */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The general contractor, whose PayPal balance pays the firms: the firm on the plan whose trade is general
 * contracting (its company, else its name). Null when the plan has none.
 */
export function balanceOwner(project: ProjectModel | null | undefined): string | null {
  const store = project?.resourceStore as unknown as { allRecords?: ResourceModel[] } | undefined;
  for (const record of store?.allRecords ?? []) {
    const firm = record as ResourceModel & { trade?: string; company?: string; kind?: string };
    if (firm.kind === 'equipment' || !/\bgeneral contract/i.test(firm.trade ?? '')) continue;
    const name = (firm.company || firm.name || '').trim();
    if (name) return name;
  }
  return null;
}

/** Whose PayPal balance a payout comes from: "Ashford Builders' PayPal balance", or "Your PayPal balance". */
export function balanceWords(owner: string | null | undefined): string {
  const name = owner?.trim();
  if (!name) return 'Your PayPal balance';
  return `${name}${/s$/i.test(name) ? "'" : "'s"} PayPal balance`;
}

/** PayPal's transaction id, from the text of a payment's receipt (supabase/functions/_shared/receipt.ts). */
export function receiptTransactionId(text: string | null | undefined): string | null {
  return /^PayPal transaction ID: ([A-Za-z0-9]{6,40})$/m.exec(text ?? '')?.[1] ?? null;
}

/**
 * A rental payment as the sheet says it. The database keeps PayPal's answer as a status of ours
 * (supabase/functions/_shared/outcomes.ts): sent or held is pending, SUCCESS succeeded, a refusal failed.
 */
export function rentalPaymentStatus(payment: { status: PaymentStatus; message: string | null } | null | undefined): Pick<PayoutLine, 'paypalStatus' | 'note'> {
  switch (payment?.status) {
    case 'submitted':
    case 'pending':
      return { paypalStatus: 'PENDING', note: payment.message };
    case 'succeeded':
      return { paypalStatus: 'SUCCESS', note: null };
    case 'failed':
      return { paypalStatus: 'FAILED', note: payment.message ?? 'PayPal could not make this payment.' };
    case 'unknown':
      return { paypalStatus: null, note: 'Awaiting PayPal status · checking again' };
    default:
      return { paypalStatus: null, note: null };
  }
}

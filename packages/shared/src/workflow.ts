/**
 * Rows of the proposal workflow tables as PostgREST returns them (supabase/migrations), validated
 * at the boundary. Timestamps keep Postgres's offset form, dates are `YYYY-MM-DD`, bigint money
 * columns arrive as JSON numbers. Unknown columns are stripped so adding one is not a breaking change.
 */
import { z } from 'zod';
import { CurrencyCodeSchema } from './money';
import {
  ActorKind,
  ApprovalScope,
  ApprovalStatus,
  Evaluation,
  PaymentStatus,
  ProposalAssumption,
  ProposalInputs,
  ProposalState,
  PublicationStatus,
  ReviewKind,
  SupplierConfirmationStatus,
  dateOnly,
  nonNegativeMinorUnits,
  revisionNo,
  timestamp,
  uuid,
} from './schemas';

export const EquipmentBookingRow = z.object({
  id: uuid,
  project_id: uuid,
  task_id: z.int(),
  resource_id: z.int(),
  supplier_name: z.string(),
  supplier_payout_email: z.string(),
  rental_rate_minor: nonNegativeMinorUnits,
  currency: CurrencyCodeSchema,
  billable_start: dateOnly,
  billable_end: dateOnly,
  /** The dates as first quoted: what a change to the rental saved is measured against. */
  quoted_start: dateOnly.nullish(),
  quoted_end: dateOnly.nullish(),
  idle_days: z.int().nonnegative(),
  evidence_path: z.string().nullable(),
});
export type EquipmentBookingRow = z.infer<typeof EquipmentBookingRow>;

export const ProposalRow = z.object({
  id: uuid,
  project_id: uuid,
  booking_id: uuid,
  state: ProposalState,
  current_version_no: z.int().nonnegative(),
  created_by: uuid.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type ProposalRow = z.infer<typeof ProposalRow>;

export const ProposalVersionRow = z.object({
  id: uuid,
  project_id: uuid,
  proposal_id: uuid,
  version_no: z.int().positive(),
  source_revision: revisionNo,
  inputs: ProposalInputs,
  assumptions: z.array(ProposalAssumption),
  evaluation: Evaluation.nullable(),
  /** The inputs changed since the last analysis; true until the version is (re-)evaluated. */
  stale: z.boolean(),
  created_by: uuid.nullable(),
  created_via: ActorKind,
  evaluated_by: uuid.nullable(),
  transcript_segment_ids: z.array(uuid),
  created_at: timestamp,
});
export type ProposalVersionRow = z.infer<typeof ProposalVersionRow>;

/** What changed in a correction: `{ field: { from, to } }` over the ProposalInputs fields. */
export const InputChanges = z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }));
export type InputChanges = z.infer<typeof InputChanges>;

export const CorrectionPayload = z.object({
  changes: InputChanges,
  answers: z.array(z.object({ key: z.string(), answer: z.string(), resolved_by: ActorKind.optional() })),
  reason: z.string(),
  created_via: ActorKind,
  next_version_no: z.int().positive(),
});
export type CorrectionPayload = z.infer<typeof CorrectionPayload>;

export const ReviewRow = z.object({
  id: uuid,
  project_id: uuid,
  proposal_version_id: uuid,
  reviewer_id: uuid.nullable(),
  kind: ReviewKind,
  /** `CorrectionPayload` for corrections, `{ text }` for comments. */
  payload: z.record(z.string(), z.unknown()),
  created_at: timestamp,
});
export type ReviewRow = z.infer<typeof ReviewRow>;

export const ApprovalRow = z.object({
  id: uuid,
  project_id: uuid,
  proposal_version_id: uuid,
  approver_id: uuid.nullable(),
  scope: ApprovalScope,
  content_hash: z.string(),
  amount_minor: nonNegativeMinorUnits.nullable(),
  currency: CurrencyCodeSchema.nullable(),
  recipient: z.string().nullable(),
  source_revision: revisionNo,
  status: ApprovalStatus,
  invalidated_reason: z.string().nullable(),
  created_at: timestamp,
  invalidated_at: timestamp.nullable(),
});
export type ApprovalRow = z.infer<typeof ApprovalRow>;

export const PaymentAuthorizationRow = z.object({
  id: uuid,
  project_id: uuid,
  approval_id: uuid,
  proposal_version_id: uuid,
  amount_minor: nonNegativeMinorUnits,
  currency: CurrencyCodeSchema,
  recipient_email: z.string(),
  status: PaymentStatus,
  paypal_batch_id: z.string().nullable(),
  paypal_item_id: z.string().nullable(),
  fee_minor: nonNegativeMinorUnits.nullable(),
  /** PayPal's reason for a failed, held or unclaimed item, or the last transport error. */
  message: z.string().nullable(),
  attempts: z.int().nonnegative(),
  submitted_at: timestamp.nullable(),
  last_checked_at: timestamp.nullable(),
  authorized_by: uuid.nullable(),
  /**
   * When the PayPal receipt was filed on the task. Every member may read it; the receipt document
   * itself is cost-sensitive. Optional for rows read before the column existed.
   */
  receipt_filed_at: timestamp.nullable().optional(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type PaymentAuthorizationRow = z.infer<typeof PaymentAuthorizationRow>;

export const PublicationRow = z.object({
  id: uuid,
  project_id: uuid,
  proposal_version_id: uuid,
  published_revision: revisionNo.nullable(),
  executor_session: uuid.nullable(),
  status: PublicationStatus,
  claimed_by: uuid.nullable(),
  claimed_at: timestamp,
  error: z.string().nullable(),
  created_at: timestamp,
  published_at: timestamp.nullable(),
});
export type PublicationRow = z.infer<typeof PublicationRow>;

export const SupplierConfirmationRow = z.object({
  proposal_id: uuid,
  project_id: uuid,
  status: SupplierConfirmationStatus,
  confirmed_by: uuid.nullable(),
  confirmed_at: timestamp.nullable(),
  note: z.string().nullable(),
  updated_at: timestamp,
});
export type SupplierConfirmationRow = z.infer<typeof SupplierConfirmationRow>;

/** `claim_publication` result: the publication plus what the executor applies. */
export const PublicationClaim = z.object({
  publication: PublicationRow,
  task_id: z.int(),
  new_start: dateOnly,
  new_end: dateOnly,
  created_via: ActorKind,
});
export type PublicationClaim = z.infer<typeof PublicationClaim>;

/** Payment statuses that PayPal will not change any more (a success can still be returned later). */
export function isPaymentSettled(status: PaymentStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

/** Statuses whose outcome is still being established with PayPal. */
export function isPaymentInFlight(status: PaymentStatus): boolean {
  return status === 'submitted' || status === 'pending' || status === 'unknown';
}

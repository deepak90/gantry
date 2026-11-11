/**
 * zod schemas plus inferred types for every record that crosses a boundary: proposal
 * inputs and assumptions, evaluation results and the enums shared with Postgres. A
 * schema and its type share a name: `ProposalInputs.parse(x)` yields a `ProposalInputs`.
 * Records we persist are strict (unknown keys fail); tool arguments, which an LLM
 * produces, strip unknown keys instead of failing.
 */
import { z } from 'zod';
import { CurrencyCodeSchema, isDecimalAmount } from './money';

// ---------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------

/** Strict `YYYY-MM-DD`; real calendar days only (no Feb 30). */
export const dateOnly = z.iso.date().describe('Calendar date as YYYY-MM-DD');

/** ISO-8601 instant with `Z` or a numeric offset, as Postgres and `Date#toISOString` emit. */
export const timestamp = z.iso
  .datetime({ offset: true })
  .describe('ISO-8601 timestamp with Z or a UTC offset');

/** Minor units (cents). `z.int()` accepts safe integers only, so floats and 2^53 fail. */
export const minorUnits = z.int().describe('Amount in minor units (cents) as a safe integer');
export const nonNegativeMinorUnits = minorUnits.nonnegative();

export const uuid = z.uuid();
export const revisionNo = z.int().nonnegative().describe('Project revision number');

/** Bryntum record ids are numbers once persisted, strings while phantom. */
export const bryntumId = z
  .union([z.int(), z.string().min(1)])
  .describe('Bryntum record id (number, or string for phantom ids)');

/** LLM-facing amounts are decimal text, parsed exactly by `fromDecimalString`. */
export const decimalAmount = z
  .string()
  .refine(isDecimalAmount, {
    message: 'Expected a decimal amount with at most two decimals, e.g. "900.00"',
  })
  .describe('Amount as decimal text, e.g. "900.00" (never a JSON number)');

// ---------------------------------------------------------------------------------------
// Enums (Postgres enum vocabularies)
// ---------------------------------------------------------------------------------------

export const ProposalState = z.enum([
  'draft',
  'evaluated',
  'in_review',
  'approved',
  'published',
  'cancelled',
]);
export type ProposalState = z.infer<typeof ProposalState>;

export const ApprovalScope = z.enum(['schedule', 'payment']);
export type ApprovalScope = z.infer<typeof ApprovalScope>;

export const ApprovalStatus = z.enum(['active', 'invalidated']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const PaymentStatus = z.enum([
  'authorized',
  'submitted',
  'pending',
  'succeeded',
  'failed',
  'unknown',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const ReviewKind = z.enum(['correction', 'comment']);
export type ReviewKind = z.infer<typeof ReviewKind>;

/**
 * Lifecycle of an `agent_commands` row: created (`pending`) → sent to the executor (`running`) →
 * settled. Settled means `succeeded`, `failed` (the executor ran it and it failed), `rejected`
 * (the executor refused it with an `AgentCommandErrorCode` such as NOT_EXECUTOR, so the agent
 * re-resolves and re-issues) or `cancelled` (abandoned before any executor ran it).
 */
export const CommandStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'rejected', 'cancelled']);
export type CommandStatus = z.infer<typeof CommandStatus>;

export const DecisionNoteKind = z.enum(['note', 'open_question', 'decision']);
export type DecisionNoteKind = z.infer<typeof DecisionNoteKind>;

/** Who produced a record or answered a question (`created_via`, `resolved_by`). */
export const ActorKind = z.enum(['human', 'agent']);
export type ActorKind = z.infer<typeof ActorKind>;

export const SupplierConfirmationStatus = z.enum(['pending', 'confirmed']);
export type SupplierConfirmationStatus = z.infer<typeof SupplierConfirmationStatus>;

/** A publication is claimed (`pending`) by one executor session until its revision is accepted. */
export const PublicationStatus = z.enum(['pending', 'published', 'failed']);
export type PublicationStatus = z.infer<typeof PublicationStatus>;

/** Runtime check for the `MemberRole` type declared in revisions.ts. */
export const MemberRoleSchema = z.enum(['pm', 'cm']);

/** The workspace areas a session can have in front. */
export const ActiveView = z.enum(['gantt', 'cost', 'history', 'dashboard']);
export type ActiveView = z.infer<typeof ActiveView>;

// ---------------------------------------------------------------------------------------
// Proposal records (proposal_versions.inputs / assumptions / evaluation)
// ---------------------------------------------------------------------------------------

/**
 * A proposal is new rental dates for a piece of equipment that is not paid for yet: shorter when it
 * would stand idle, longer when the work needs it for more days. The cost follows from the dates.
 */
export const ProposalInputs = z
  .strictObject({
    new_start: dateOnly.describe('Revised booking start (inclusive)'),
    new_end: dateOnly.describe('Revised booking end (exclusive)'),
  })
  .refine((inputs) => inputs.new_start < inputs.new_end, {
    message: 'new_end must be after new_start',
    path: ['new_end'],
  });
export type ProposalInputs = z.infer<typeof ProposalInputs>;

export const ProposalAssumption = z
  .strictObject({
    key: z.string().min(1).max(64).describe('Stable snake_case identifier, e.g. delivery_date'),
    question: z.string().min(1),
    answer: z.string().nullable(),
    resolved_by: ActorKind.nullable(),
  })
  .refine((assumption) => (assumption.answer === null) === (assumption.resolved_by === null), {
    message: 'answer and resolved_by are either both set or both null',
    path: ['resolved_by'],
  });
export type ProposalAssumption = z.infer<typeof ProposalAssumption>;

/** Keys of the assumptions that still have no answer, in their original order. */
export function unresolvedAssumptionKeys(assumptions: readonly ProposalAssumption[]): string[] {
  return assumptions.filter((assumption) => assumption.answer === null).map((a) => a.key);
}

/** Start inclusive, end exclusive. */
export const DateInterval = z.strictObject({ start: dateOnly, end: dateOnly });
export type DateInterval = z.infer<typeof DateInterval>;

export const HandoverImpact = z.strictObject({
  published_end: dateOnly,
  proposed_end: dateOnly,
  /** proposed_end − published_end in days; negative when the proposal finishes earlier. */
  delta_days: z.int(),
});
export type HandoverImpact = z.infer<typeof HandoverImpact>;

export const AffectedTask = z.strictObject({
  task_id: bryntumId,
  name: z.string(),
  published_start: dateOnly,
  published_end: dateOnly,
  proposed_start: dateOnly,
  proposed_end: dateOnly,
});
export type AffectedTask = z.infer<typeof AffectedTask>;

export const OverAllocation = z.strictObject({
  resource_id: bryntumId,
  intervals: z.array(DateInterval),
});
export type OverAllocation = z.infer<typeof OverAllocation>;

export const ScheduleImpact = z.strictObject({
  handover: HandoverImpact,
  affected_tasks: z.array(AffectedTask),
  over_allocations: z.array(OverAllocation),
});
export type ScheduleImpact = z.infer<typeof ScheduleImpact>;

/** Persisted form of `CostComparisonResult` (cost.ts): every line in minor units. */
export const CostComparison = z.strictObject({
  currency: CurrencyCodeSchema,
  /** The rental as booked: rental rate × published billable days. */
  booked_rental_minor: nonNegativeMinorUnits,
  /** The rental as revised (rental rate × revised billable days): what the supplier is paid. */
  supplier_payment_minor: nonNegativeMinorUnits,
  /** booked − revised rental; negative when the work needs the equipment for more days. */
  saving_minor: minorUnits,
});
export type CostComparison = z.infer<typeof CostComparison>;

/**
 * Billable days of the equipment booking, counted on the equipment resource's own calendar by the
 * scheduling engine. The cost comparison prices both bookings at the rental rate.
 */
export const BookingDays = z.strictObject({
  /** Billable days of the published booking (billable_start .. billable_end). */
  published_billable_days: z.int().nonnegative(),
  /** Billable days of the revised booking (new_start .. new_end). */
  revised_billable_days: z.int().nonnegative(),
  /** max(published − revised, 0): the rental the revised booking no longer pays for. */
  avoided_billable_days: z.int().nonnegative(),
  /** Billable days the equipment would still stand idle, before the activity or after it. */
  revised_idle_days: z.int().nonnegative(),
});
export type BookingDays = z.infer<typeof BookingDays>;

export const Evaluation = z.strictObject({
  source_revision: revisionNo,
  inputs: ProposalInputs,
  assumptions: z.array(ProposalAssumption),
  schedule_impact: ScheduleImpact,
  cost_comparison: CostComparison,
  booking_days: BookingDays,
  unresolved_assumptions: z.array(z.string()),
  evaluated_at: timestamp,
});
export type Evaluation = z.infer<typeof Evaluation>;

// -----------------------------------------------------------------------------------------
// Invoices: what a project bills its client (supabase/migrations/*_rules_rentals_invoices.sql)
// -----------------------------------------------------------------------------------------

export const InvoiceLine = z.object({
  label: z.string().min(1).max(200),
  amount_minor: z.int().positive(),
  /** What the line is made of, for the payer (PayPal's item description): a change order's floor lists its tasks. */
  detail: z.string().min(1).max(1000).optional(),
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

/**
 * The most one PayPal payment carries in the US ($60,000, help286): an invoice above it lets the payer
 * pay in parts. supabase/functions/_shared/invoices.ts sends it the same way (ONE_PAYMENT_LIMIT_MINOR).
 */
export const PAYPAL_PAYMENT_LIMIT_MINOR = 6_000_000;

/** When an invoice falls due: net 30 from the day PayPal sends it (`payment_term` in _shared/invoices.ts). */
export const INVOICE_DUE_DAYS = 30;

export const InvoiceStatus = z.enum(['draft', 'sent', 'paid', 'cancelled', 'failed']);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const InvoiceRow = z.object({
  id: uuid,
  project_id: uuid,
  rule_id: uuid.nullable(),
  /** The group (a floor) the invoice bills for: one invoice per group. */
  group_task_id: z.int().positive(),
  title: z.string(),
  client_name: z.string(),
  client_email: z.string(),
  lines: z.array(InvoiceLine),
  amount_minor: z.int().positive(),
  currency: z.string(),
  status: InvoiceStatus,
  paypal_invoice_id: z.string().nullable(),
  paypal_number: z.string().nullable(),
  /** Where the client views and pays it on PayPal. */
  payer_url: z.string().nullable(),
  message: z.string().nullable(),
  created_by: uuid.nullable(),
  created_at: timestamp,
  sent_at: timestamp.nullable(),
  /** Who confirmed it, from their login (paypal-invoice sets it); null for one sent before it was recorded. */
  sent_by: uuid.nullable().optional(),
  paid_at: timestamp.nullable(),
  updated_at: timestamp,
});
export type InvoiceRow = z.infer<typeof InvoiceRow>;

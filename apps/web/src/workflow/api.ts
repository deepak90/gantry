/**
 * The proposal workflow's server calls: the RPCs of supabase/migrations/*_proposal_workflow.sql,
 * the project-wide reads behind the contextual editor (RLS limits them to members; the documents
 * a member may not see, quotes, invoices and receipts without cost access, never arrive), and the
 * PayPal Edge Functions. Every response is validated against the shared row schemas.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ApprovalRow,
  EquipmentBookingRow,
  InvoiceRow,
  type InvoiceLine,
  MemberRoleSchema,
  PaymentAuthorizationRow,
  ProposalRow,
  ProposalVersionRow,
  PublicationClaim,
  PublicationRow,
  ReviewRow,
  SupplierConfirmationRow,
  type ApprovalScope,
  type Evaluation,
  type ProposalAssumption,
  type ProposalInputs,
  type ProposalState,
  type ProjectDocumentRow,
  type SupplierConfirmationStatus,
} from '@collab/shared';
import { z } from 'zod';
import { listDocuments } from '../documents/api';
import { HOSTED } from '../hosted';
import { loadPayGateApprovals, loadSecondApprovalOver, type PayGateApprovalRow } from '../payments/pay-approvals';

export interface WorkflowErrorLike {
  message: string;
  code?: string;
}

/** The slice of `SupabaseClient` the workflow uses; the real client satisfies it, tests fake it. */
export interface WorkflowClient {
  rpc(fn: string, args?: object): PromiseLike<{ data: unknown; error: WorkflowErrorLike | null }>;
  /** The real method type: a structural copy of the PostgREST builder chain is too deep for the compiler to compare. */
  from: SupabaseClient['from'];
  functions: {
    invoke(name: string, options: { body: Record<string, unknown> }): Promise<{ data: unknown; error: unknown }>;
  };
}

/** A refusal from the server. `code` is the SQLSTATE (42501 not allowed, 55000 wrong state, ...) or an HTTP-level code. */
export class WorkflowError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

/** `approve_proposal: the payment exceeds ...` reads better without the function prefix. */
export function withoutFunctionPrefix(message: string): string {
  return message.replace(/^[a-z_]+: /, '');
}

function toWorkflowError(operation: string, error: WorkflowErrorLike): WorkflowError {
  return new WorkflowError(withoutFunctionPrefix(error.message) || `${operation} failed`, error.code);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new WorkflowError(`${what} returned an unexpected shape:\n${z.prettifyError(parsed.error)}`, 'INVALID_RESPONSE');
  }
  return parsed.data;
}

async function call<T>(client: WorkflowClient, fn: string, args: object, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw toWorkflowError(fn, error);
  }
  return parse(schema, data, fn);
}

// -----------------------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------------------

export const MemberProfile = z.object({
  user_id: z.string(),
  display_name: z.string(),
  color: z.string(),
});
export type MemberProfile = z.infer<typeof MemberProfile>;

/** A member's role and what they may approve (project_members; every member can read the others'). */
export const WorkflowMember = z.object({
  user_id: z.uuid(),
  role: MemberRoleSchema,
  can_view_costs: z.boolean(),
  /** The largest payment, in minor units, the member may approve (0 for the project manager). */
  approval_limit_minor: z.int().nonnegative(),
});
export type WorkflowMember = z.infer<typeof WorkflowMember>;

/** Everything the editor shows for one project, read in one round of parallel selects. */
export interface WorkflowSnapshot {
  bookings: EquipmentBookingRow[];
  proposals: ProposalRow[];
  versions: ProposalVersionRow[];
  reviews: ReviewRow[];
  approvals: ApprovalRow[];
  payments: PaymentAuthorizationRow[];
  publications: PublicationRow[];
  confirmations: SupplierConfirmationRow[];
  profiles: MemberProfile[];
  /** Who approves what: the approval chain is project manager (dates) then cost manager (payment). */
  members: WorkflowMember[];
  /** The project's documents the viewer may see, newest first (documents/api.ts). */
  documents: ProjectDocumentRow[];
  /** What the project billed its client (cost viewers only, under RLS). */
  invoices: InvoiceRow[];
  /** Second-person approvals of large progress payouts (cost viewers only); null where the database has none yet. */
  gateApprovals?: PayGateApprovalRow[] | null;
  /** Progress payouts over this need a second person; null where it can't be read (the default applies). */
  secondApprovalOverMinor?: number | null;
}

async function select<T>(client: WorkflowClient, table: string, projectId: string, schema: z.ZodType<T>, order = 'created_at'): Promise<T[]> {
  const { data, error } = await client.from(table).select('*').eq('project_id', projectId).order(order, { ascending: true });
  if (error) {
    throw new WorkflowError(`Cannot read ${table}: ${error.message}`, error.code);
  }
  return parse(z.array(schema), data ?? [], table);
}

export async function loadWorkflow(client: WorkflowClient, projectId: string): Promise<WorkflowSnapshot> {
  const [bookings, proposals, versions, reviews, approvals, payments, publications, confirmations, profiles, members, documents, invoices, gateApprovals, secondApprovalOverMinor] =
    await Promise.all([
      select(client, 'equipment_bookings', projectId, EquipmentBookingRow, 'billable_start'),
      select(client, 'proposals', projectId, ProposalRow),
      select(client, 'proposal_versions', projectId, ProposalVersionRow),
      select(client, 'reviews', projectId, ReviewRow),
      select(client, 'approvals', projectId, ApprovalRow),
      select(client, 'payment_authorizations', projectId, PaymentAuthorizationRow),
      select(client, 'publications', projectId, PublicationRow),
      select(client, 'supplier_confirmations', projectId, SupplierConfirmationRow, 'updated_at'),
      loadProfiles(client),
      loadMembers(client, projectId),
      loadDocuments(client, projectId),
      select(client, 'invoices', projectId, InvoiceRow),
      loadPayGateApprovals(client, projectId),
      loadSecondApprovalOver(client, projectId),
    ]);
  return { bookings, proposals, versions, reviews, approvals, payments, publications, confirmations, profiles, members, documents, invoices, gateApprovals, secondApprovalOverMinor };
}

async function loadMembers(client: WorkflowClient, projectId: string): Promise<WorkflowMember[]> {
  const { data, error } = await client
    .from('project_members')
    .select('user_id, role, can_view_costs, approval_limit_minor')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) {
    throw new WorkflowError(`Cannot read project_members: ${error.message}`, error.code);
  }
  return parse(z.array(WorkflowMember), data ?? [], 'project_members');
}

/** listDocuments, with its failure reported like the other reads. */
async function loadDocuments(client: WorkflowClient, projectId: string): Promise<ProjectDocumentRow[]> {
  try {
    return await listDocuments(client, projectId);
  } catch (error) {
    const { message, code } = error as { message?: string; code?: string };
    throw new WorkflowError(message ?? String(error), code);
  }
}

/** Profiles of everyone who shares a project with the viewer (RLS). */
async function loadProfiles(client: WorkflowClient): Promise<MemberProfile[]> {
  const { data, error } = await client.from('profiles').select('user_id, display_name, color');
  if (error) {
    throw new WorkflowError(`Cannot read profiles: ${error.message}`, error.code);
  }
  return parse(z.array(MemberProfile), data ?? [], 'profiles');
}

// -----------------------------------------------------------------------------------------
// RPCs
// -----------------------------------------------------------------------------------------

const ProposalRef = z.object({
  proposal_id: z.string(),
  version_id: z.string(),
  version_no: z.number().int(),
  state: z.string(),
});
export type CreatedProposal = z.infer<typeof ProposalRef>;

export function createProposal(
  client: WorkflowClient,
  bookingId: string,
  inputs: ProposalInputs,
  assumptions: ProposalAssumption[] = [],
  /** `agent`: the assistant prepared it and a person asked for it (the proposal is still theirs). */
  createdVia: 'human' | 'agent' = 'human',
): Promise<CreatedProposal> {
  return call(
    client,
    'create_proposal',
    { p_booking: bookingId, p_inputs: inputs, p_assumptions: assumptions, p_created_via: createdVia },
    ProposalRef,
  );
}

const EvaluationRecorded = z.object({
  version_id: z.string(),
  state: z.string(),
  changed: z.boolean(),
  invalidated_approvals: z.number().int(),
});
export type EvaluationRecorded = z.infer<typeof EvaluationRecorded>;

export function recordEvaluation(client: WorkflowClient, versionId: string, evaluation: Evaluation): Promise<EvaluationRecorded> {
  return call(client, 'record_evaluation', { p_version: versionId, p_evaluation: evaluation }, EvaluationRecorded);
}

const ReviewRecorded = z.object({
  review_id: z.string(),
  version_id: z.string(),
  version_no: z.number().int(),
  state: z.string(),
  invalidated_approvals: z.number().int(),
});
export type ReviewRecorded = z.infer<typeof ReviewRecorded>;

export interface CorrectionRequest {
  changes: Partial<ProposalInputs>;
  answers?: { key: string; answer: string; resolved_by?: 'human' | 'agent' }[];
  reason: string;
}

export function correctProposal(
  client: WorkflowClient,
  versionId: string,
  correction: CorrectionRequest,
  createdVia: 'human' | 'agent' = 'human',
): Promise<ReviewRecorded> {
  return call(
    client,
    'review_proposal',
    { p_version: versionId, p_kind: 'correction', p_payload: { ...correction, created_via: createdVia } },
    ReviewRecorded,
  );
}

export function commentOnProposal(client: WorkflowClient, versionId: string, text: string): Promise<ReviewRecorded> {
  return call(client, 'review_proposal', { p_version: versionId, p_kind: 'comment', p_payload: { text } }, ReviewRecorded);
}

export function approveProposal(client: WorkflowClient, versionId: string, scope: ApprovalScope): Promise<ApprovalRow> {
  return call(client, 'approve_proposal', { p_version: versionId, p_scope: scope }, ApprovalRow);
}

/** Approves the dates and the payment of a version together (one role: the app's "Approve the fix"). */
export function approveFix(client: WorkflowClient, versionId: string): Promise<{ schedule: ApprovalRow; payment: ApprovalRow }> {
  return call(client, 'approve_fix', { p_version: versionId }, z.object({ schedule: ApprovalRow, payment: ApprovalRow }));
}

export function authorizePayment(client: WorkflowClient, versionId: string): Promise<PaymentAuthorizationRow> {
  return call(client, 'authorize_payment', { p_version: versionId }, PaymentAuthorizationRow);
}

export function claimPublication(client: WorkflowClient, versionId: string, sessionId: string): Promise<PublicationClaim> {
  return call(client, 'claim_publication', { p_version: versionId, p_session: sessionId }, PublicationClaim);
}

export function failPublication(client: WorkflowClient, publicationId: string, sessionId: string, message: string): Promise<PublicationRow> {
  return call(client, 'fail_publication', { p_publication: publicationId, p_session: sessionId, p_error: message }, PublicationRow);
}

export function cancelProposal(client: WorkflowClient, proposalId: string, reason: string): Promise<{ state: ProposalState }> {
  return call(client, 'cancel_proposal', { p_proposal: proposalId, p_reason: reason }, ProposalRow);
}

export function setSupplierConfirmation(
  client: WorkflowClient,
  proposalId: string,
  status: SupplierConfirmationStatus,
  note?: string,
): Promise<SupplierConfirmationRow> {
  return call(client, 'set_supplier_confirmation', { p_proposal: proposalId, p_status: status, p_note: note ?? null }, SupplierConfirmationRow);
}

// -----------------------------------------------------------------------------------------
// PayPal Edge Functions
// -----------------------------------------------------------------------------------------

/** The functions' 200 body: the operation as recorded, what was done, and a notice when PayPal could not be read. */
const PayoutResponse = z.object({
  authorization: PaymentAuthorizationRow,
  action: z.enum(['submit', 'check', 'wait', 'none']),
  mode: z.enum(['live', 'mock']).optional(),
  notice: z.string().nullable().optional(),
});
export type PayoutResponse = z.infer<typeof PayoutResponse>;

export const PAYMENT_SERVICE_DOWN = HOSTED
  ? 'The payment service did not answer. Nothing was sent; try again in a moment.'
  : 'The payment service is not reachable. Start the Edge Functions with `pnpm functions:serve` (docs/SETUP.md) and try again.';

interface FunctionsErrorLike {
  name?: string;
  message?: string;
  context?: { json?: () => Promise<unknown>; status?: number };
}

/** Turns a supabase-js functions error into the function's own `{ error, code }` message where there is one. */
async function functionError(name: string, error: unknown): Promise<WorkflowError> {
  const failure = (error ?? {}) as FunctionsErrorLike;
  if (failure.name === 'FunctionsFetchError' || failure.name === 'FunctionsRelayError') {
    return new WorkflowError(PAYMENT_SERVICE_DOWN, 'SERVICE_UNREACHABLE');
  }
  if (failure.context?.json) {
    try {
      const body = (await failure.context.json()) as { error?: unknown; code?: unknown; message?: unknown };
      if (typeof body.error === 'string') {
        return new WorkflowError(body.error, typeof body.code === 'string' ? body.code : String(failure.context.status ?? ''));
      }
      // Refused before the function ran (Supabase's own gateway answers { code, message }): say what it said.
      if (typeof body.message === 'string') {
        return new WorkflowError(`The payment service refused the request (${body.message}). Nothing was sent.`, String(body.code ?? failure.context.status ?? ''));
      }
    } catch {
      // Not JSON: fall through to the generic message.
    }
  }
  if (failure.context?.status === 404) {
    return new WorkflowError(PAYMENT_SERVICE_DOWN, 'SERVICE_UNREACHABLE');
  }
  return new WorkflowError(`${name} failed: ${failure.message ?? String(error)}`, 'FUNCTION_ERROR');
}

async function invokePayout(client: WorkflowClient, name: string, authorizationId: string): Promise<PayoutResponse> {
  const { data, error } = await client.functions.invoke(name, { body: { authorization_id: authorizationId } });
  if (error) {
    throw await functionError(name, error);
  }
  return parse(PayoutResponse, data, name);
}

/** The cost manager sends (or resumes) the authorized payout. */
export function executePayout(client: WorkflowClient, authorizationId: string): Promise<PayoutResponse> {
  return invokePayout(client, 'paypal-execute-payout', authorizationId);
}

/** Any member asks PayPal for the current status (and re-sends an attempt whose outcome was lost). */
export function reconcilePayout(client: WorkflowClient, authorizationId: string): Promise<PayoutResponse> {
  return invokePayout(client, 'paypal-reconcile', authorizationId);
}

// ---- invoices ----------------------------------------------------------------------------------

/** Prepares the invoice for a finished group (a floor), or returns the one it already has. */
export async function prepareInvoice(client: WorkflowClient, args: { projectId: string; groupTaskId: number; ruleId: string | null; title: string; lines: InvoiceLine[] }): Promise<InvoiceRow> {
  const { data, error } = await client.rpc('prepare_invoice', { p_project: args.projectId, p_group_task: args.groupTaskId, p_rule: args.ruleId, p_title: args.title, p_lines: args.lines });
  if (error) throw new WorkflowError(error.message.replace(/^[a-z_]+: /, ''), error.code);
  return parse(InvoiceRow, data, 'prepare_invoice');
}

/** Sends a prepared invoice through PayPal, or (`refresh`) asks PayPal where a sent one stands, or (`cancel`) cancels it. */
export async function invoiceAction(client: WorkflowClient, invoiceId: string, action: 'send' | 'refresh' | 'cancel'): Promise<InvoiceRow> {
  const { data, error } = await client.functions.invoke('paypal-invoice', { body: { invoice_id: invoiceId, action } });
  if (error) {
    const failure = error as { name?: string; message?: string; context?: Response };
    if (failure.name === 'FunctionsFetchError' || failure.name === 'FunctionsRelayError') throw new WorkflowError(PAYMENT_SERVICE_DOWN, 'SERVICE_UNREACHABLE');
    const body = (await failure.context?.json?.().catch(() => null)) as { error?: string; code?: string | number; message?: string } | null;
    // The function's own { error, code }; else what Supabase's gateway said ({ code, message }) before the function ran.
    const said = body?.error ?? (body?.message ? `The payment service refused the request (${body.message}). Nothing was sent.` : null);
    throw new WorkflowError(said ?? failure.message ?? 'PayPal could not take the invoice.', body?.code !== undefined ? String(body.code) : 'INVOICE_FAILED');
  }
  return parse(InvoiceRow, (data as { invoice: unknown }).invoice, 'paypal-invoice');
}

/**
 * Who an invoice comes from, as PayPal shows it to the payer (null when PayPal uses the account's own name), and on the
 * hosted demo the address it bills, which is always the tenant's sandbox account (null where the project's client is billed).
 */
export async function invoiceSeller(client: WorkflowClient, projectId: string): Promise<{ seller: string | null; billTo: string | null }> {
  const { data, error } = await client.functions.invoke('paypal-invoice', { body: { project_id: projectId, action: 'seller' } });
  if (error) throw new WorkflowError('PayPal could not say whose invoice this is.', 'INVOICE_FAILED');
  const said = data as { seller?: string | null; bill_to?: string | null } | null;
  return { seller: said?.seller ?? null, billTo: said?.bill_to ?? null };
}

/** Who the project bills, if anyone. */
export async function projectClient(client: WorkflowClient, projectId: string): Promise<{ name: string; email: string | null } | null> {
  const { data, error } = await client.rpc('project_client', { p_project: projectId });
  if (error) throw new WorkflowError(error.message, error.code);
  return (data as { name: string; email: string | null } | null) ?? null;
}

/**
 * Workflow snapshots of the crane fix at every stage it can reach, for the tracker tests. Rows follow the shapes PostgREST returns.
 */
import type {
  ApprovalRow,
  Evaluation,
  PaymentAuthorizationRow,
  PaymentStatus,
  ProposalRow,
  ProposalVersionRow,
  PublicationRow,
} from '@collab/shared';
import type { WorkflowSnapshot } from '../../src/workflow/api';

export const PROJECT = '00000000-0000-4000-8000-000000000001';
export const BOOKING = '00000000-0000-4000-8000-000000000101';
export const PROPOSAL = '00000000-0000-4000-8000-0000000002aa';
export const V1 = '00000000-0000-4000-8000-0000000003a1';
export const V2 = '00000000-0000-4000-8000-0000000003a2';
export const PM = '00000000-0000-4000-8000-000000000011';
export const CM = '00000000-0000-4000-8000-000000000012';
const SESSION = '00000000-0000-4000-8000-00000000a011';

const at = (minute: number) => `2026-11-10T14:${String(minute).padStart(2, '0')}:00+00:00`;

export const STAGES = [
  'draft',
  'checked',
  'open-questions',
  'one-approval',
  'reapprove',
  'stale',
  'approved',
  'plan-failed',
  'published',
  'authorized',
  'submitted',
  'pending',
  'unknown',
  'succeeded',
  'send-failed',
  'paypal-failed',
  'cancelled',
] as const;
export type Stage = (typeof STAGES)[number];

function evaluation(unresolved: string[] = []): Evaluation {
  return {
    source_revision: 3,
    inputs: { new_start: '2026-12-11', new_end: '2026-12-18' },
    assumptions: [],
    schedule_impact: {
      handover: { published_end: '2027-04-28', proposed_end: '2027-04-28', delta_days: 0 },
      affected_tasks: [],
      over_allocations: [],
    },
    cost_comparison: {
      currency: 'USD',
      booked_rental_minor: 600_000,
      supplier_payment_minor: 360_000,
      saving_minor: 240_000,
    },
    booking_days: { published_billable_days: 10, revised_billable_days: 6, avoided_billable_days: 4, revised_idle_days: 0 },
    unresolved_assumptions: unresolved,
    evaluated_at: at(4),
  };
}

function version(id: string, versionNo: number, evaluated: Evaluation | null, stale = false): ProposalVersionRow {
  return {
    id,
    project_id: PROJECT,
    proposal_id: PROPOSAL,
    version_no: versionNo,
    source_revision: 3,
    inputs: { new_start: '2026-12-11', new_end: versionNo > 1 ? '2026-12-18' : '2026-12-19' },
    assumptions: [],
    evaluation: evaluated,
    stale,
    created_by: CM,
    created_via: 'human',
    evaluated_by: evaluated ? CM : null,
    transcript_segment_ids: [],
    created_at: at(versionNo === 1 ? 1 : 10),
  };
}

function approval(id: string, versionId: string, scope: 'schedule' | 'payment', status: 'active' | 'invalidated' = 'active'): ApprovalRow {
  return {
    id,
    project_id: PROJECT,
    proposal_version_id: versionId,
    approver_id: scope === 'schedule' ? PM : CM,
    scope,
    content_hash: 'hash',
    amount_minor: scope === 'payment' ? 360_000 : null,
    currency: scope === 'payment' ? 'USD' : null,
    recipient: scope === 'payment' ? 'payee@test.local' : null,
    source_revision: 3,
    status,
    invalidated_reason: status === 'invalidated' ? 'The transport charge changed' : null,
    created_at: at(scope === 'schedule' ? 6 : 8),
    invalidated_at: status === 'invalidated' ? at(10) : null,
  };
}

function publication(status: PublicationRow['status']): PublicationRow {
  return {
    id: '00000000-0000-4000-8000-0000000006aa',
    project_id: PROJECT,
    proposal_version_id: V1,
    published_revision: status === 'published' ? 7 : null,
    executor_session: SESSION,
    status,
    claimed_by: PM,
    claimed_at: at(9),
    error: status === 'failed' ? 'The plan changed underneath; try again' : null,
    created_at: at(9),
    published_at: status === 'published' ? at(9) : null,
  };
}

function payment(status: PaymentStatus, batch = status !== 'authorized'): PaymentAuthorizationRow {
  return {
    id: '00000000-0000-4000-8000-0000000005aa',
    project_id: PROJECT,
    approval_id: '00000000-0000-4000-8000-0000000004b1',
    proposal_version_id: V1,
    amount_minor: 360_000,
    currency: 'USD',
    recipient_email: 'payee@test.local',
    status,
    paypal_batch_id: batch ? 'BATCH-1' : null,
    paypal_item_id: batch ? 'ITEM-1' : null,
    fee_minor: status === 'succeeded' ? 2_400 : null,
    message: status === 'failed' ? (batch ? 'RECEIVER_UNREGISTERED' : 'The payment service is not reachable') : null,
    attempts: 1,
    submitted_at: batch ? at(12) : null,
    last_checked_at: status === 'authorized' ? null : at(14),
    authorized_by: CM,
    created_at: at(11),
    updated_at: at(14),
  };
}

const PROPOSAL_STATES: Readonly<Record<Stage, ProposalRow['state']>> = {
  draft: 'draft',
  checked: 'evaluated',
  'open-questions': 'evaluated',
  'one-approval': 'in_review',
  reapprove: 'in_review',
  stale: 'in_review',
  approved: 'approved',
  'plan-failed': 'approved',
  published: 'published',
  authorized: 'published',
  submitted: 'published',
  pending: 'published',
  unknown: 'published',
  succeeded: 'published',
  'send-failed': 'published',
  'paypal-failed': 'published',
  cancelled: 'cancelled',
};

/** The workflow snapshot of the crane fix at a stage. */
export function snapshotAt(stage: Stage): WorkflowSnapshot {
  const twoVersions = stage === 'reapprove' || stage === 'stale';
  const versions =
    stage === 'draft'
      ? [version(V1, 1, null)]
      : twoVersions
        ? [version(V1, 1, evaluation()), version(V2, 2, stage === 'stale' ? null : evaluation(), stage === 'stale')]
        : [version(V1, 1, evaluation(stage === 'open-questions' ? ['charge_basis'] : []))];
  const approvals: ApprovalRow[] = [];
  if (twoVersions) {
    approvals.push(approval('00000000-0000-4000-8000-0000000004a1', V1, 'schedule', 'invalidated'));
  } else if (stage === 'one-approval') {
    approvals.push(approval('00000000-0000-4000-8000-0000000004a1', V1, 'schedule'));
  } else if (!['draft', 'checked', 'open-questions', 'cancelled'].includes(stage)) {
    approvals.push(approval('00000000-0000-4000-8000-0000000004a1', V1, 'schedule'), approval('00000000-0000-4000-8000-0000000004b1', V1, 'payment'));
  }
  const publications = stage === 'approved' ? [publication('pending')] : stage === 'plan-failed' ? [publication('failed')] : PROPOSAL_STATES[stage] === 'published' ? [publication('published')] : [];
  const payments: PaymentAuthorizationRow[] =
    stage === 'authorized' || stage === 'submitted' || stage === 'pending' || stage === 'unknown' || stage === 'succeeded'
      ? [payment(stage)]
      : stage === 'send-failed'
        ? [payment('failed', false)]
        : stage === 'paypal-failed'
          ? [payment('failed', true)]
          : [];
  return {
    invoices: [],
    bookings: [
      {
        id: BOOKING,
        project_id: PROJECT,
        task_id: 15,
        resource_id: 4,
        supplier_name: 'Northgate Equipment Rental',
        supplier_payout_email: 'payee@test.local',
        rental_rate_minor: 60_000,
        currency: 'USD',
        billable_start: '2026-12-07',
        billable_end: '2026-12-18',
        idle_days: 4,
        evidence_path: null,
      },
    ],
    proposals: [
      {
        id: PROPOSAL,
        project_id: PROJECT,
        booking_id: BOOKING,
        state: PROPOSAL_STATES[stage],
        current_version_no: versions.length,
        created_by: CM,
        created_at: at(1),
        updated_at: at(14),
      },
    ],
    versions,
    reviews: [],
    approvals,
    payments,
    publications,
    confirmations: [],
    profiles: [
      { user_id: PM, display_name: 'Priya Mehta', color: '#2563eb' },
      { user_id: CM, display_name: 'Sam Okafor', color: '#059669' },
    ],
    members: [
      { user_id: PM, role: 'pm', can_view_costs: false, approval_limit_minor: 0 },
      { user_id: CM, role: 'cm', can_view_costs: true, approval_limit_minor: 500_000 },
    ],
    documents: [],
  };
}

export const NAMES: Readonly<Record<string, string>> = { [PM]: 'Priya Mehta', [CM]: 'Sam Okafor' };
export const nameOf = (userId: string | null): string | null => (userId === null ? null : NAMES[userId] ?? null);

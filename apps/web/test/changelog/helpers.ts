import type { ProjectInlineData, ProjectRevisionRow } from '@collab/shared';
import type { WorkflowSnapshot } from '../../src/workflow/api';
import { createProjectModel, loadProjectInlineData, readProjectInlineData } from '../../src/gantt/project';
import { SAMPLE_INLINE_DATA } from '../fixtures/sample-data';

export const PRIYA = '00000000-0000-4000-8000-000000000011';
export const CHRIS = '00000000-0000-4000-8000-000000000012';
export const PROJECT = '00000000-0000-4000-8000-0000000000aa';

/** The fixture as the server stores it: every date the engine works out is filled in. */
export async function scheduledSnapshot(): Promise<ProjectInlineData> {
  const project = createProjectModel({ config: { startDate: '2026-11-02' } });
  await loadProjectInlineData(project, SAMPLE_INLINE_DATA);
  const data = JSON.parse(JSON.stringify(readProjectInlineData(project))) as ProjectInlineData;
  project.destroy();
  return data;
}

let sequence = 0;

/** A hand-made revision row (most tests use real ones from the engine). */
export function revisionRow(revisionNo: number, changes: ProjectRevisionRow['changes'], extra: Partial<ProjectRevisionRow> = {}): ProjectRevisionRow {
  sequence += 1;
  return {
    id: `00000000-0000-4000-9000-${String(sequence).padStart(12, '0')}`,
    project_id: PROJECT,
    revision_no: revisionNo,
    client_id: '00000000-0000-4000-8000-0000000000c1',
    local_revision_id: `local-${sequence}`,
    conflict_resolution_for: null,
    changes,
    actor_user_id: PRIYA,
    origin: 'human',
    created_at: new Date(Date.UTC(2026, 9, 22, 9, 0, revisionNo)).toISOString(),
    ...extra,
  };
}

export const IDS = {
  booking: '00000000-0000-4000-8000-000000000101',
  proposal: '00000000-0000-4000-8000-000000000201',
  version1: '00000000-0000-4000-8000-000000000301',
  version2: '00000000-0000-4000-8000-000000000302',
  review: '00000000-0000-4000-8000-000000000401',
  approvalSchedule: '00000000-0000-4000-8000-000000000501',
  approvalPayment: '00000000-0000-4000-8000-000000000502',
  approvalOld: '00000000-0000-4000-8000-000000000503',
  publication: '00000000-0000-4000-8000-000000000601',
  payment: '00000000-0000-4000-8000-000000000701',
} as const;

const at = (minute: number) => `2026-10-22T10:${String(minute).padStart(2, '0')}:00+00:00`;

/** The crane: booked 10 days at $600; version 1 keeps it 7 days, version 2 six. */
function evaluation(versionNo: number, revisedDays: number) {
  return {
    source_revision: 3,
    inputs: { new_start: '2026-12-14', new_end: revisedDays === 6 ? '2026-12-19' : '2026-12-21' },
    assumptions: [],
    schedule_impact: {
      handover: { published_end: '2027-04-28', proposed_end: '2027-04-28', delta_days: 0 },
      affected_tasks: [],
      over_allocations: [],
    },
    cost_comparison: {
      currency: 'USD' as const,
      booked_rental_minor: 600_000,
      supplier_payment_minor: revisedDays * 60_000,
      saving_minor: (10 - revisedDays) * 60_000,
    },
    booking_days: { published_billable_days: 10, revised_billable_days: revisedDays, avoided_billable_days: 10 - revisedDays, revised_idle_days: 0 },
    unresolved_assumptions: [],
    evaluated_at: at(versionNo === 1 ? 2 : 6),
  };
}

/** The whole story of one fix: proposed, checked, corrected, approved twice, applied, paid, confirmed. */
export function workflowSnapshot(): WorkflowSnapshot {
  return {
    invoices: [],
    bookings: [
      {
        id: IDS.booking,
        project_id: PROJECT,
        task_id: 22,
        resource_id: 4,
        supplier_name: 'Northgate Equipment Rental',
        supplier_payout_email: 'payouts@northgate.example',
        rental_rate_minor: 60_000,
        currency: 'USD',
        billable_start: '2026-12-07',
        billable_end: '2026-12-18',
        idle_days: 4,
        evidence_path: null,
      },
    ],
    proposals: [
      { id: IDS.proposal, project_id: PROJECT, booking_id: IDS.booking, state: 'published', current_version_no: 2, created_by: CHRIS, created_at: at(1), updated_at: at(20) },
    ],
    versions: [
      {
        id: IDS.version1,
        project_id: PROJECT,
        proposal_id: IDS.proposal,
        version_no: 1,
        source_revision: 3,
        inputs: evaluation(1, 7).inputs,
        assumptions: [],
        evaluation: evaluation(1, 7),
        stale: false,
        created_by: CHRIS,
        created_via: 'human',
        evaluated_by: CHRIS,
        transcript_segment_ids: [],
        created_at: at(1),
      },
      {
        id: IDS.version2,
        project_id: PROJECT,
        proposal_id: IDS.proposal,
        version_no: 2,
        source_revision: 3,
        inputs: evaluation(2, 6).inputs,
        assumptions: [],
        evaluation: evaluation(2, 6),
        stale: false,
        created_by: CHRIS,
        created_via: 'human',
        evaluated_by: CHRIS,
        transcript_segment_ids: [],
        created_at: at(5),
      },
    ],
    reviews: [
      {
        id: IDS.review,
        project_id: PROJECT,
        proposal_version_id: IDS.version1,
        reviewer_id: CHRIS,
        kind: 'correction',
        payload: { changes: { new_end: { from: '2026-12-21', to: '2026-12-19' } }, answers: [], reason: 'The steel arrives a day earlier', created_via: 'human', next_version_no: 2 },
        created_at: at(5),
      },
    ],
    approvals: [
      {
        id: IDS.approvalOld,
        project_id: PROJECT,
        proposal_version_id: IDS.version1,
        approver_id: PRIYA,
        scope: 'schedule',
        content_hash: 'a',
        amount_minor: null,
        currency: null,
        recipient: null,
        source_revision: 3,
        status: 'invalidated',
        invalidated_reason: 'The fix changed (version 2)',
        created_at: at(3),
        invalidated_at: at(5),
      },
      {
        id: IDS.approvalSchedule,
        project_id: PROJECT,
        proposal_version_id: IDS.version2,
        approver_id: PRIYA,
        scope: 'schedule',
        content_hash: 'b',
        amount_minor: null,
        currency: null,
        recipient: null,
        source_revision: 3,
        status: 'active',
        invalidated_reason: null,
        created_at: at(8),
        invalidated_at: null,
      },
      {
        id: IDS.approvalPayment,
        project_id: PROJECT,
        proposal_version_id: IDS.version2,
        approver_id: CHRIS,
        scope: 'payment',
        content_hash: 'c',
        amount_minor: 360_000,
        currency: 'USD',
        recipient: 'payouts@northgate.example',
        source_revision: 3,
        status: 'active',
        invalidated_reason: null,
        created_at: at(9),
        invalidated_at: null,
      },
    ],
    payments: [
      {
        id: IDS.payment,
        project_id: PROJECT,
        approval_id: IDS.approvalPayment,
        proposal_version_id: IDS.version2,
        amount_minor: 360_000,
        currency: 'USD',
        recipient_email: 'payouts@northgate.example',
        status: 'succeeded',
        paypal_batch_id: 'BATCH-7XK2',
        paypal_item_id: 'ITEM-91QF',
        fee_minor: 25,
        message: null,
        attempts: 1,
        submitted_at: at(11),
        last_checked_at: at(12),
        authorized_by: CHRIS,
        created_at: at(11),
        updated_at: at(12),
      },
    ],
    publications: [
      {
        id: IDS.publication,
        project_id: PROJECT,
        proposal_version_id: IDS.version2,
        published_revision: 4,
        executor_session: null,
        status: 'published',
        claimed_by: CHRIS,
        claimed_at: at(9),
        error: null,
        created_at: at(9),
        published_at: at(10),
      },
    ],
    confirmations: [
      { proposal_id: IDS.proposal, project_id: PROJECT, status: 'confirmed', confirmed_by: PRIYA, confirmed_at: at(13), note: null, updated_at: at(13) },
    ],
    profiles: [
      { user_id: PRIYA, display_name: 'Priya Mehta', color: '#2563eb' },
      { user_id: CHRIS, display_name: 'Chris Morgan', color: '#d97706' },
    ],
    members: [
      { user_id: PRIYA, role: 'pm', can_view_costs: false, approval_limit_minor: 0 },
      { user_id: CHRIS, role: 'cm', can_view_costs: true, approval_limit_minor: 500_000 },
    ],
    documents: [],
  };
}

export const PEOPLE = new Map([
  [PRIYA, { name: 'Priya Mehta', color: '#2563eb' }],
  [CHRIS, { name: 'Chris Morgan', color: '#d97706' }],
]);

/** jsdom has no FontFaceSet; Bryntum widgets wait for `document.fonts.ready` before measuring. */
export function shimFonts(): void {
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} } });
  }
}

export const nextFrame = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

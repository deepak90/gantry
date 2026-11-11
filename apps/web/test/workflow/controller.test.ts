/**
 * WorkflowController orchestration against a fake Supabase client and a fake engine: which RPCs paying
 * calls in which order, evaluation on a caught-up project, failure reporting, and the payout path
 * through the Edge Function.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import type { Evaluation, ProposalInputs } from '@collab/shared';
import { PAYMENT_SERVICE_DOWN, type WorkflowClient } from '../../src/workflow/api';
import { WorkflowController, type WorkflowDeps } from '../../src/workflow/controller';
import type { RevisionSync } from '../../src/sync/revision-sync';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const BOOKING = '00000000-0000-4000-8000-000000000101';
const PROPOSAL = '00000000-0000-4000-8000-0000000002aa';
const V1 = '00000000-0000-4000-8000-0000000003a1';
const SESSION = '00000000-0000-4000-8000-00000000a011';
const USER = '00000000-0000-4000-8000-000000000011';
const AUTHORIZATION = '00000000-0000-4000-8000-0000000005aa';
const AT = '2026-11-10T14:00:00+00:00';

const inputs: ProposalInputs = { new_start: '2026-12-11', new_end: '2026-12-18' };

const booking = {
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
};

function version(id: string, versionNo: number, sourceRevision: number) {
  return {
    id,
    project_id: PROJECT,
    proposal_id: PROPOSAL,
    version_no: versionNo,
    source_revision: sourceRevision,
    inputs,
    assumptions: [],
    evaluation: null,
    stale: versionNo > 1,
    created_by: USER,
    created_via: 'human',
    evaluated_by: null,
    transcript_segment_ids: [],
    created_at: AT,
  };
}

function proposal(state: string, currentVersionNo = 1) {
  return { id: PROPOSAL, project_id: PROJECT, booking_id: BOOKING, state, current_version_no: currentVersionNo, created_by: USER, created_at: AT, updated_at: AT };
}

type Tables = Record<string, unknown[]>;
type RpcHandler = (args: Record<string, unknown>) => unknown;

interface Fake {
  client: WorkflowClient;
  tables: Tables;
  calls: { fn: string; args: Record<string, unknown> }[];
  invokes: { name: string; body: Record<string, unknown> }[];
}

/** A PostgREST builder that is both chainable and awaitable, answering from `tables`. */
function fakeClient(tables: Tables, rpcs: Record<string, RpcHandler>, invoke?: (name: string) => { data: unknown; error: unknown }): Fake {
  const calls: Fake['calls'] = [];
  const invokes: Fake['invokes'] = [];
  const builder = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      then: (resolve: (value: typeof result) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  const client = {
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      const handler = rpcs[fn];
      if (!handler) {
        return Promise.resolve({ data: null, error: { message: `${fn}: not faked`, code: 'XX000' } });
      }
      try {
        return Promise.resolve({ data: handler(args), error: null });
      } catch (error) {
        const { message, code } = error as { message: string; code?: string };
        return Promise.resolve({ data: null, error: { message, code } });
      }
    },
    from: builder as unknown as WorkflowClient['from'],
    functions: {
      invoke: async (name: string, options: { body: Record<string, unknown> }) => {
        invokes.push({ name, body: options.body });
        return invoke ? invoke(name) : { data: null, error: { name: 'FunctionsFetchError', message: 'fetch failed' } };
      },
    },
  };
  return { client, tables, calls, invokes };
}

const evaluation = (sourceRevision: number): Evaluation => ({
  source_revision: sourceRevision,
  inputs,
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
  unresolved_assumptions: [],
  evaluated_at: '2026-11-10T14:00:00.000Z',
});

function revisionsStub() {
  return { whenApplied: vi.fn(async () => undefined), resync: vi.fn() } as unknown as RevisionSync & { resync: ReturnType<typeof vi.fn> };
}

let controller: WorkflowController | undefined;

afterEach(() => {
  controller?.dispose();
  controller = undefined;
});

function makeController(fake: Fake, overrides: Partial<WorkflowDeps> = {}): WorkflowController {
  controller = new WorkflowController({
    client: fake.client,
    projectId: PROJECT,
    sessionId: SESSION,
    project: { stm: {} } as unknown as ProjectModel,
    revisions: revisionsStub(),
    handoverTaskId: 42,
    subscribe: () => () => undefined,
    capture: async () => ({ data: { tasksData: [] }, revision: 3 }),
    evaluate: vi.fn(async (options) => evaluation(options.sourceRevision)),
    pollMs: 0,
    refreshMs: 0,
    ...overrides,
  });
  return controller;
}

describe('WorkflowController', () => {
  const approval = (scope: string) => ({ id: `00000000-0000-4000-8000-0000000004${scope === 'payment' ? 'aa' : 'bb'}`, project_id: PROJECT, proposal_version_id: V1, approver_id: USER, scope, content_hash: 'h', amount_minor: scope === 'payment' ? 360_000 : null, currency: scope === 'payment' ? 'USD' : null, recipient: null, source_revision: 3, status: 'active', created_at: AT, invalidated_at: null, invalidated_reason: null });
  const authorization = {
    id: AUTHORIZATION, project_id: PROJECT, approval_id: '00000000-0000-4000-8000-0000000004aa', proposal_version_id: V1,
    amount_minor: 360_000, currency: 'USD', recipient_email: 'payee@test.local', status: 'authorized', paypal_batch_id: null,
    paypal_item_id: null, fee_minor: null, message: null, attempts: 0, submitted_at: null, last_checked_at: null,
    authorized_by: USER, created_at: AT, updated_at: AT,
  };
  const succeeded = { ...authorization, status: 'succeeded', paypal_batch_id: 'B', paypal_item_id: 'I', fee_minor: 25 };
  const paysFine = () => ({ data: { authorization: succeeded, action: 'submit', mode: 'mock' }, error: null });

  /** The record of what is approved, as the database writes it step by step. */
  const recording = (tables: Tables) => ({
    create_proposal: () => {
      tables.proposals = [proposal('draft')];
      tables.proposal_versions = [version(V1, 1, 3)];
      return { proposal_id: PROPOSAL, version_id: V1, version_no: 1, state: 'draft' };
    },
    record_evaluation: () => ({ version_id: V1, state: 'evaluated', changed: true, invalidated_approvals: 0 }),
    approve_fix: () => ({ schedule: approval('schedule'), payment: approval('payment') }),
    authorize_payment: () => authorization,
  });

  it('payRentals: writes the record for the dates as they stand, checks it, approves it and pays', async () => {
    const tables: Tables = { equipment_bookings: [{ ...booking, billable_start: '2026-12-10', billable_end: '2026-12-19' }] };
    const fake = fakeClient(tables, recording(tables), paysFine);
    const workflow = makeController(fake);
    await workflow.reload();
    await workflow.payRentals([booking as never]);
    expect(workflow.state.failure?.message).toBeUndefined();
    expect(fake.calls.map((call) => call.fn)).toEqual(['create_proposal', 'record_evaluation', 'approve_fix', 'authorize_payment']);
    // The dates the plan has by now, not the ones the button was drawn with.
    expect(fake.calls[0]?.args.p_inputs).toEqual({ new_start: '2026-12-10', new_end: '2026-12-19' });
    expect(fake.invokes).toEqual([{ name: 'paypal-execute-payout', body: { authorization_id: AUTHORIZATION } }]);
  });

  it('payRentals: measures what it pays against the quote', async () => {
    const tables: Tables = { equipment_bookings: [{ ...booking, quoted_start: '2026-12-01', quoted_end: '2026-12-18', billable_start: '2026-12-10', billable_end: '2026-12-19' }] };
    const evaluate = vi.fn(async (_options: Parameters<NonNullable<WorkflowDeps['evaluate']>>[0]) => evaluation(3));
    const workflow = makeController(fakeClient(tables, recording(tables), paysFine), { evaluate });
    await workflow.reload();
    await workflow.payRentals([booking as never]);
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ booking: { billableStart: '2026-12-01', billableEnd: '2026-12-18' } });
  });

  it('payRentals: pays again on the same record when the dates are the same, after a payment that failed', async () => {
    const tables: Tables = {
      equipment_bookings: [booking],
      proposals: [proposal('approved')],
      proposal_versions: [{ ...version(V1, 1, 3), inputs: { new_start: booking.billable_start, new_end: booking.billable_end } }],
      approvals: [approval('schedule'), approval('payment')],
    };
    const fake = fakeClient(tables, recording(tables), paysFine);
    const workflow = makeController(fake);
    await workflow.reload();
    await workflow.payRentals([booking as never]);
    expect(fake.calls.map((call) => call.fn)).toEqual(['authorize_payment']);
  });

  it('payRentals: replaces a record for other dates', async () => {
    const tables: Tables = {
      equipment_bookings: [booking],
      proposals: [proposal('approved')],
      proposal_versions: [version(V1, 1, 3)],
      approvals: [approval('schedule'), approval('payment')],
    };
    const fake = fakeClient(tables, { ...recording(tables), cancel_proposal: () => proposal('cancelled') }, paysFine);
    const workflow = makeController(fake);
    await workflow.reload();
    await workflow.payRentals([booking as never]);
    expect(fake.calls.map((call) => call.fn)).toEqual(['cancel_proposal', 'create_proposal', 'record_evaluation', 'approve_fix', 'authorize_payment']);
  });

  it('payRentals: an unreachable payment service is explained', async () => {
    const tables: Tables = { equipment_bookings: [booking] };
    const workflow = makeController(fakeClient(tables, recording(tables)));
    await workflow.reload();
    await workflow.payRentals([booking as never]);
    expect(workflow.state.failure).toEqual({ action: 'pay', message: PAYMENT_SERVICE_DOWN, code: 'SERVICE_UNREACHABLE', bookingIds: [booking.id] });
  });

  it('refuses a second step while one is running', async () => {
    const tables: Tables = { equipment_bookings: [booking] };
    let release: (() => void) | undefined;
    const fake = fakeClient(tables, recording(tables), paysFine);
    const workflow = makeController(fake, {
      evaluate: () =>
        new Promise<Evaluation>((resolve) => {
          release = () => resolve(evaluation(3));
        }),
    });
    await workflow.reload();
    const first = workflow.payRentals([booking as never]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(workflow.state.busy).toBe('pay');
    await workflow.refreshPayment(AUTHORIZATION);
    expect(workflow.state.failure?.action).toBe('refresh-payment');
    release?.();
    await first;
  });
});

/**
 * loadWorkflow against a fake Supabase client: one parallel round of reads, every row validated,
 * and the members (who approves what) and documents (what the viewer may see) in the snapshot.
 */
import { describe, expect, it } from 'vitest';
import { loadWorkflow, WorkflowError, type WorkflowClient } from '../../src/workflow/api';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const PM = '00000000-0000-4000-8000-000000000011';
const CM = '00000000-0000-4000-8000-000000000012';
const AT = '2026-11-02T09:00:00+00:00';

type Answer = { data: unknown; error: { message: string; code?: string } | null };

function fakeClient(tables: Record<string, Answer>) {
  const queries: { table: string; steps: [string, ...unknown[]][] }[] = [];
  const from = (table: string) => {
    const query = { table, steps: [] as [string, ...unknown[]][] };
    queries.push(query);
    const result = tables[table] ?? { data: [], error: null };
    const chain = {
      select: (...args: unknown[]) => (query.steps.push(['select', ...args]), chain),
      eq: (...args: unknown[]) => (query.steps.push(['eq', ...args]), chain),
      order: (...args: unknown[]) => (query.steps.push(['order', ...args]), chain),
      then: (resolve: (value: Answer) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  const client: WorkflowClient = {
    rpc: async () => ({ data: null, error: { message: 'not faked' } }),
    from: from as unknown as WorkflowClient['from'],
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  return { client, queries };
}

const members = [
  { user_id: PM, role: 'pm', can_view_costs: false, approval_limit_minor: 0 },
  { user_id: CM, role: 'cm', can_view_costs: true, approval_limit_minor: 500000 },
];

const quote = {
  id: '00000000-0000-4000-8000-000000000201',
  project_id: PROJECT,
  task_id: 15,
  kind: 'quote',
  name: 'Northgate Equipment Rental - Quotation NER-Q-26-0412.pdf',
  mime_type: 'application/pdf',
  size_bytes: 4448,
  storage_path: `${PROJECT}/00000000-0000-4000-8000-000000000201/northgate-quote.pdf`,
  cost_sensitive: true,
  text_content: 'NORTHGATE EQUIPMENT RENTAL — QUOTATION',
  summary: 'Northgate Equipment Rental quotation: crane re-booking',
  payment_authorization_id: null,
  created_by: null,
  created_via: 'system',
  created_at: AT,
};

describe('loadWorkflow', () => {
  it('loads the members and the documents with the workflow rows', async () => {
    const { client, queries } = fakeClient({
      project_members: { data: members, error: null },
      project_documents: { data: [quote], error: null },
    });
    const snapshot = await loadWorkflow(client, PROJECT);
    expect(snapshot.members).toEqual(members);
    expect(snapshot.documents).toEqual([quote]);
    expect(snapshot.proposals).toEqual([]);

    const byTable = new Map(queries.map((query) => [query.table, query.steps]));
    expect(byTable.get('project_members')).toEqual([
      ['select', 'user_id, role, can_view_costs, approval_limit_minor'],
      ['eq', 'project_id', PROJECT],
      ['order', 'created_at', { ascending: true }],
    ]);
    expect(byTable.get('project_documents')).toEqual([
      ['select', '*'],
      ['eq', 'project_id', PROJECT],
      ['order', 'created_at', { ascending: false }],
    ]);
    expect([...byTable.keys()].sort()).toEqual([
      'approvals', 'equipment_bookings', 'invoices', 'pay_gate_approvals', 'payment_authorizations', 'profiles', 'project_documents', 'project_members',
      'projects', 'proposal_versions', 'proposals', 'publications', 'reviews', 'supplier_confirmations',
    ]);
  });

  it('reads the second-person approvals of large payouts and the project’s threshold with them', async () => {
    const approval = {
      id: '00000000-0000-4000-8000-0000000007aa',
      project_id: PROJECT,
      gate_id: 25,
      gate_name: 'Footings paid',
      amount_minor: 3_780_000,
      currency: 'USD',
      lines: [{ firm: 'Granite Ridge Concrete', amount_minor: 3_132_000, for: 'Form footings' }, { firm: 'Pinecrest Sitework', amount_minor: 648_000 }],
      over_minor: 2_500_000,
      requested_by: CM,
      status: 'approved',
      decided_by: PM,
      decided_at: AT,
      used_at: null,
      sender_batch_id: null,
      created_at: AT,
      updated_at: AT,
    };
    const { client } = fakeClient({ pay_gate_approvals: { data: [approval], error: null }, projects: { data: [{ second_approval_over_minor: 2_500_000 }], error: null } });
    const snapshot = await loadWorkflow(client, PROJECT);
    expect(snapshot.gateApprovals).toEqual([approval]);
    expect(snapshot.secondApprovalOverMinor).toBe(2_500_000);
  });

  it('reads a database without those records as having none, and loads the rest', async () => {
    const { client } = fakeClient({
      project_members: { data: members, error: null },
      pay_gate_approvals: { data: null, error: { message: 'Could not find the table', code: 'PGRST205' } },
      projects: { data: null, error: { message: 'column projects.second_approval_over_minor does not exist', code: '42703' } },
    });
    const snapshot = await loadWorkflow(client, PROJECT);
    expect(snapshot.members).toEqual(members);
    expect(snapshot.gateApprovals).toBeNull();
    expect(snapshot.secondApprovalOverMinor).toBeNull();
  });

  it('refuses a member row of an unexpected shape', async () => {
    const { client } = fakeClient({ project_members: { data: [{ ...members[0], role: 'owner' }], error: null } });
    await expect(loadWorkflow(client, PROJECT)).rejects.toMatchObject({ name: 'WorkflowError', code: 'INVALID_RESPONSE' });
  });

  it('reports a document read failure as a WorkflowError', async () => {
    const { client } = fakeClient({ project_documents: { data: null, error: { message: 'permission denied', code: '42501' } } });
    const failure = loadWorkflow(client, PROJECT);
    await expect(failure).rejects.toBeInstanceOf(WorkflowError);
    await expect(failure).rejects.toMatchObject({ message: 'Cannot read the documents: permission denied', code: '42501' });
  });
});

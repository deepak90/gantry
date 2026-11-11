/**
 * The hosted site pays a gate through its paypal-progress-payout function, not the dev server's route: the progress
 * payment goes with the sender's login and the project's public key, a refusal before PayPal leaves the plan as it is,
 * and PayPal's batch is followed as a member of the project until it settles, then written to the plan as paid.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ProjectModel, type TaskModel } from '@bryntum/gantt';
import { HARBOR_FOOTINGS_PAID, harborOffices } from '@collab/shared/seed';
import { readPayGate } from '@collab/shared';
import { payGateNow, PayoutRefused, resumeGatePayments } from '../../src/gantt/pay-gate-payment';
import { gateFor } from '../../src/gantt/pay-gates';
import { runProjectTransaction } from '../../src/scenario/publish';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, type Client } from '../sync/helpers';

vi.mock('../../src/hosted', async (original) => ({ ...(await original<typeof import('../../src/hosted')>()), HOSTED: true }));
vi.mock('../../src/supabase/client', async (original) => ({
  ...(await original<typeof import('../../src/supabase/client')>()),
  readSupabaseConfig: () => ({ url: 'https://project.supabase.test/', anonKey: 'public-anon-key' }),
}));

const FOOTINGS = 20;
const FUNCTION = 'https://project.supabase.test/functions/v1/paypal-progress-payout';
let clients: Client[] = [];
let relay: InMemoryRelay;

afterEach(() => {
  disposeAll(clients);
  clients = [];
  vi.unstubAllGlobals();
});

async function harbor(): Promise<ProjectModel> {
  const snapshot = structuredClone(harborOffices.inlineData) as never;
  relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
  const client = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
  clients = [client];
  await settle(clients, relay);
  const { project } = client;
  await runProjectTransaction(project, 'Report the footings done', () => {
    for (const task of (project.taskStore.getById(FOOTINGS) as TaskModel).children as TaskModel[]) if (task.isLeaf && !task.isMilestone) task.set({ percentDone: 100 });
  });
  return project;
}

const gateOf = (project: ProjectModel) => gateFor(project, project.taskStore.getById(HARBOR_FOOTINGS_PAID) as TaskModel)!;
const stateOf = (project: ProjectModel) => readPayGate((project.taskStore.getById(HARBOR_FOOTINGS_PAID) as unknown as { payGate?: unknown }).payGate);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const auth = { projectId: PROJECT_ID, token: 'deepak-token', approvalId: '00000000-0000-4000-8000-0000000007aa' };
const reader = { projectId: PROJECT_ID, token: async () => 'deepak-fresh-token' };

/** The function as the test says it answers, keeping every call. */
function fn(answers: { send: () => Response; status?: (batchId: string) => Response }) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, headers: new Headers(init?.headers), body });
    if (body.action === 'status') return answers.status?.(String(body.batchId)) ?? json(200, { batchId: body.batchId, status: 'PROCESSING', feeMinor: null, items: [] });
    return answers.send();
  });
  return calls;
}

describe('a progress payment on the hosted site', () => {
  it('goes to the function with the sender’s login, is followed as a member, and is written to the plan once PayPal pays', async () => {
    const project = await harbor();
    const calls = fn({
      send: () => json(201, { batchId: 'BATCH-1', status: 'PENDING', feeMinor: null, items: [], mode: 'live', approvalId: auth.approvalId }),
      status: (batchId) =>
        json(200, {
          batchId,
          status: 'SUCCESS',
          feeMinor: 50,
          items: [1, 2].map((n) => ({ itemId: `${String(calls[0]!.body.batchId)}-${n}`, status: 'SUCCESS', transactionId: `TX${n}`, feeMinor: 25, error: null })),
        }),
    });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth, reader })).resolves.toBe('paid');
    const [sent, asked] = calls;
    expect(sent!.url).toBe(FUNCTION);
    expect(sent!.headers.get('apikey')).toBe('public-anon-key');
    expect(sent!.headers.get('authorization')).toBe('Bearer deepak-token');
    expect(sent!.body).toMatchObject({ projectId: PROJECT_ID, gateId: HARBOR_FOOTINGS_PAID, approvalId: auth.approvalId, currency: 'USD' });
    expect((sent!.body.items as { firm: string }[]).map((item) => item.firm)).toEqual(['Granite Ridge Concrete', 'Pinecrest Sitework']);
    expect(asked!.url).toBe(FUNCTION);
    expect(asked!.body).toEqual({ action: 'status', projectId: PROJECT_ID, batchId: 'BATCH-1' });
    expect(asked!.headers.get('authorization')).toBe('Bearer deepak-fresh-token');
    expect(stateOf(project)).toMatchObject({ state: 'paid', batchId: 'BATCH-1' });
  }, 20_000);

  it('leaves the plan as it is when the function refuses before PayPal', async () => {
    const project = await harbor();
    fn({ send: () => json(429, { error: 'This demo has reached its limit on payouts, for this copy or for the site today. Nothing was sent.', code: 'QUOTA_REACHED', refused: true }) });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth, reader })).rejects.toThrow(PayoutRefused);
    await settle(clients, relay);
    expect(stateOf(project)?.state).toBe('waiting');
  });

  it('leaves the plan as it is when Supabase’s gateway answers instead of the function', async () => {
    const project = await harbor();
    fn({ send: () => json(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }) });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth, reader })).rejects.toThrow('The payment service did not take the payout (Requested function was not found). Nothing was sent.');
    await settle(clients, relay);
    expect(stateOf(project)?.state).toBe('waiting');
  });

  it('records PayPal’s own refusal on the gate', async () => {
    const project = await harbor();
    fn({ send: () => json(502, { error: 'Sender does not have sufficient funds.', code: 'PAYPAL_REFUSED' }) });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth, reader })).resolves.toBe('failed');
    await settle(clients, relay);
    expect(stateOf(project)).toMatchObject({ state: 'failed', error: 'Sender does not have sufficient funds.' });
  });

  it('picks up a payout still being paid only as a member who can ask', async () => {
    const project = await harbor();
    const calls = fn({ send: () => json(500, {}) });
    await runProjectTransaction(project, 'Paying', () => {
      const gate = project.taskStore.getById(HARBOR_FOOTINGS_PAID) as TaskModel;
      gate.set({ payGate: { ...stateOf(project)!, state: 'paying', batchId: 'BATCH-9', batchKey: 'k' } });
    });
    resumeGatePayments(project);
    await new Promise((resolve) => setTimeout(resolve, 2_700));
    expect(calls).toEqual([]);
  }, 10_000);
});

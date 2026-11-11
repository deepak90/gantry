/**
 * Sending a progress payment to PayPal: a press after a lost answer repeats the batch id, so PayPal refuses to pay a
 * second batch; a batch PayPal turned down gets a new id, so the next press is a new payment.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ProjectModel, type TaskModel } from '@bryntum/gantt';
import { HARBOR_FOOTINGS_PAID, harborOffices } from '@collab/shared/seed';
import { payGateNow } from '../../src/gantt/pay-gate-payment';
import { gateFor } from '../../src/gantt/pay-gates';
import { runProjectTransaction } from '../../src/scenario/publish';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, type Client } from '../sync/helpers';

const FOOTINGS = 20;
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
const auth = { projectId: PROJECT_ID, token: null, approvalId: null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** PayPal's route as the test says it answers, keeping every batch id the page sent. */
function route(answers: { post: () => Response | Promise<Response>; batch?: unknown }) {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent.push((JSON.parse(String(init.body)) as { batchId: string }).batchId);
      return answers.post();
    }
    return json(200, answers.batch);
  });
  return sent;
}

describe('sending a progress payment', () => {
  it('sends the same batch id when pressed again after the answer was lost', async () => {
    const project = await harbor();
    const sent = route({ post: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth })).rejects.toThrow();
    await expect(payGateNow(project, gateOf(project), 'USD', { auth })).rejects.toThrow();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^PG-/);
    expect(sent[1]).toBe(sent[0]);
  });

  it('keeps the id when PayPal or the route could not answer, and takes a new one once PayPal turned the batch down', async () => {
    const project = await harbor();
    const sent = route({ post: () => json(502, { error: 'PayPal could not be reached' }) });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth })).resolves.toBe('failed');
    await settle(clients, relay);
    const turnedDown = route({ post: () => json(201, { batchId: 'BATCH1', status: 'PENDING' }), batch: { batchId: 'BATCH1', status: 'DENIED', feeMinor: null, items: [] } });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth })).resolves.toBe('failed');
    expect(turnedDown[0]).toBe(sent[0]);
    await settle(clients, relay);
    const again = route({ post: () => json(201, { batchId: 'BATCH2', status: 'PENDING' }), batch: { batchId: 'BATCH2', status: 'DENIED', feeMinor: null, items: [] } });
    await expect(payGateNow(project, gateOf(project), 'USD', { auth })).resolves.toBe('failed');
    expect(again[0]).not.toBe(sent[0]);
  }, 20_000);
});

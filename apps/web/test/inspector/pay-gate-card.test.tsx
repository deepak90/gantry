/**
 * Paying Harbor's footings from the task panel, with the dev server's PayPal route and the database stubbed (nothing
 * leaves the test). The card offers our own Review payment button, no PayPal look; it opens the payment window in the
 * middle of the screen with every firm's line, the total, the PayPal balance it comes from and what it releases. The
 * payout is over $25,000, so opening the window asks the second person, and Send payout stays locked until their
 * approval arrives; the payout then carries the sender's login and that approval for the route's check, and the steps
 * follow PayPal's statuses to Paid, the firm lines kept as sent. A refusal from the route sends nothing and leaves the
 * plan as it was.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HARBOR_FOOTINGS_PAID, harborOffices } from '@collab/shared/seed';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import { gateFor } from '../../src/gantt/pay-gates';
import { TaskInspector } from '../../src/inspector/TaskInspector';
import { closePayWindow, PayWindowHost } from '../../src/payments/PayModal';
import type { PayGateApprovalRow } from '../../src/payments/pay-approvals';
import { PayApprovalsProvider, type PayApprovalsValue } from '../../src/payments/pay-approvals-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} } });
}

const BATCH = 'B-TEST-1';
const ROUTE = '/__paypal/progress-payouts';
const HARBOR = '00000000-0000-4000-8000-000000000002';
const DEEPAK = '00000000-0000-4000-8000-000000000012';
const CHRIS = '00000000-0000-4000-8000-000000000011';
const APPROVAL = '00000000-0000-4000-8000-0000000007aa';
/** When the request was made: a minute before the test. */
const AT = new Date(Date.now() - 60_000).toISOString();

interface Sent {
  batchId: string;
  projectId: string;
  gateId: number;
  approvalId: string | null;
  items: { itemId: string; firm: string; amountMinor: number }[];
}

/** The dev route as PayPal answers through it: the batch is taken, then (on the first look) every payment has gone through. */
function stubRoute(refuse: string | null = null): { posts: Sent[]; headers: Record<string, string>[]; reads: string[] } {
  const posts: Sent[] = [];
  const headers: Record<string, string>[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/config')) return new Response(JSON.stringify({ live: false, clientId: null, rehearsal: false }), { status: 200 });
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)) as Sent);
        headers.push(init.headers as Record<string, string>);
        if (refuse) return new Response(JSON.stringify({ error: refuse, refused: true }), { status: 403 });
        return new Response(JSON.stringify({ batchId: BATCH, status: 'PENDING', feeMinor: null, items: [], mode: 'mock' }), { status: 201 });
      }
      reads.push(url);
      const sent = posts[0]!;
      return new Response(
        JSON.stringify({
          batchId: BATCH,
          status: 'SUCCESS',
          feeMinor: 50,
          items: sent.items.map((item, index) => ({ itemId: item.itemId, status: 'SUCCESS', transactionId: `TX${index + 1}AB12345678`, feeMinor: 25, error: null })),
        }),
        { status: 200 },
      );
    }),
  );
  return { posts, headers, reads };
}

const approvalRow = (status: PayGateApprovalRow['status'], lines: PayGateApprovalRow['lines']): PayGateApprovalRow => ({
  id: APPROVAL,
  project_id: HARBOR,
  gate_id: HARBOR_FOOTINGS_PAID,
  gate_name: 'Footings paid',
  amount_minor: 3_780_000,
  currency: 'USD',
  lines,
  over_minor: 2_500_000,
  requested_by: DEEPAK,
  status,
  decided_by: status === 'requested' ? null : CHRIS,
  decided_at: status === 'requested' ? null : new Date().toISOString(),
  used_at: null,
  sender_batch_id: null,
  created_at: AT,
  updated_at: status === 'requested' ? AT : new Date().toISOString(),
});

describe('the footings’ progress payment, paid from the payment window', () => {
  let host: HTMLDivElement;
  let root: Root;
  let project: ProjectModel;
  let version = 0;
  let approvals: PayGateApprovalRow[];
  let calls: { fn: string; args: Record<string, unknown> }[];

  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'request_pay_gate_approval') return { data: approvalRow('requested', args.p_lines as PayGateApprovalRow['lines']), error: null };
      if (fn === 'withdraw_pay_gate_approval') return { data: { ...approvals.at(-1)!, status: 'withdrawn' }, error: null };
      return { data: null, error: { message: 'not faked' } };
    }),
    auth: { getSession: async () => ({ data: { session: { access_token: 'deepak-token' } } }) },
  } as unknown as SupabaseClient;

  const inDocument = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const words = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  /** Each firm's line, cell by cell: firm, what for, PayPal's word once sent, done, value, kept back, amount. */
  const lines = () => [...document.querySelectorAll('[data-testid="pay-modal-line"]')].map((row) => [...row.querySelectorAll('.pay-line-firm, .pay-line-for, .pay-line-status, .pay-line-tx, td')].map(words).join(' '));
  const render = async () => {
    version += 1;
    const value: PayApprovalsValue = {
      client,
      projectId: HARBOR,
      userId: DEEPAK,
      people: [
        { userId: DEEPAK, name: 'Deepak Jayaram', canViewCosts: true, approvalLimitMinor: 25_000_000, role: 'cm' },
        { userId: CHRIS, name: 'Chris Hale', canViewCosts: true, approvalLimitMinor: 25_000_000, role: 'pm' },
      ],
      overMinor: 2_500_000,
      approvals,
      reload: () => {},
    };
    await act(async () => {
      root.render(
        <PayApprovalsProvider value={value}>
          <TaskInspector project={project} taskId={HARBOR_FOOTINGS_PAID} dataVersion={version} canViewCosts currency="USD" />
          <PayWindowHost project={project} currency="USD" dataVersion={version} />
        </PayApprovalsProvider>,
      );
    });
  };
  const until = async (check: () => boolean, what: string, timeout = 10_000) => {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      await render();
    }
  };
  const gate = () => gateFor(project, project.taskStore.getById(HARBOR_FOOTINGS_PAID) as never)!;

  beforeEach(async () => {
    approvals = [];
    calls = [];
    project = createProjectModel();
    await loadCollaborativeProject(project, structuredClone(harborOffices.inlineData) as never, '00000000-0000-4000-8000-0000000000c2', '0');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => closePayWindow());
    act(() => root.unmount());
    host.remove();
    project.destroy();
    vi.unstubAllGlobals();
  });

  it('reviews, waits for the second person, sends one Payouts batch with the approval, and follows PayPal to Paid', async () => {
    const route = stubRoute();
    await render();
    const review = inDocument('pay-gate-pay') as HTMLButtonElement;
    expect(words(review)).toBe('Review payment');
    expect(review.className).toBe('button is-primary');
    expect(review.querySelector('img, svg')).toBeNull();
    expect(document.querySelector('.paypal-button')).toBeNull();

    // The card counts its payees in the trade's terms, never "firms".
    expect(words(inDocument('pay-gate-card'))).toContain('Total · 2 trade partners');
    expect(words(inDocument('pay-gate-card'))).not.toMatch(/\bfirms?\b/i);

    // The window, in the middle of the screen, as a pay application: each trade partner, its scope, % complete,
    // scheduled value, retainage and the amount due.
    await act(async () => review.click());
    const modal = inDocument('pay-modal')!;
    expect(modal.parentElement?.className).toBe('pay-modal-scrim');
    expect(modal.dataset.phase).toBe('review');
    expect(words(modal.querySelector('.pay-modal-sub'))).toBe('Progress payment · Footings · 2 trade partners');
    expect([...modal.querySelectorAll('.pay-lines thead th')].map(words)).toEqual(['Trade partner', '% complete', 'Scheduled value', 'Retainage', 'Amount due']);
    expect(lines()).toEqual([
      'Granite Ridge Concrete Scope: Form footings · Rebar, footings · Pour footings 100% $34,800 $3,480 $31,320',
      'Pinecrest Sitework Scope: Strip forms and backfill 100% $7,200 $720 $6,480',
    ]);
    expect(words(modal.querySelector('.pay-lines tfoot th'))).toBe('Due this period2 trade partners · net of 10% retainage');
    expect(words(inDocument('pay-modal-total'))).toBe('$37,800.50');
    // Harbor's plan names no general contractor: the balance is yours.
    expect(words(inDocument('pay-modal-from'))).toMatch(/^Your PayPal balance/);
    expect(words(inDocument('pay-modal-releases'))).toBe('Slab on grade · can start Wed, Nov 11');
    expect(words(modal)).not.toMatch(/\bfirms?\b/i);

    // Over $25,000: opening the window asked Chris, with exactly these amounts; Send payout waits for him.
    await until(() => inDocument('pay-approval-status')?.dataset.state === 'asking' || calls.length > 0, 'the request');
    expect(calls[0]).toMatchObject({ fn: 'request_pay_gate_approval', args: { p_project: HARBOR, p_gate: HARBOR_FOOTINGS_PAID, p_amount_minor: 3_780_000, p_currency: 'USD' } });
    expect((calls[0]!.args.p_lines as { firm: string; amount_minor: number }[]).map((line) => [line.firm, line.amount_minor])).toEqual([
      ['Granite Ridge Concrete', 3_132_000],
      ['Pinecrest Sitework', 648_000],
    ]);
    approvals = [approvalRow('requested', calls[0]!.args.p_lines as PayGateApprovalRow['lines'])];
    await render();
    // Labels, not sentences: the rule, the approver by name and title, then the status.
    expect(words(document.querySelector('.pay-approval-title'))).toBe('Second approval required · payouts over $25,000');
    expect(words(inDocument('pay-approval-approver'))).toBe('Approver: Chris Hale');
    expect(inDocument('pay-approval-status')!.dataset.state).toBe('requested');
    expect(words(inDocument('pay-approval-status'))).toMatch(/^Pending · requested \d{1,2}:\d{2} (AM|PM)$/);
    expect((inDocument('pay-modal-send') as HTMLButtonElement).disabled).toBe(true);
    expect(route.posts).toHaveLength(0);

    // Chris approves on his screen; the snapshot brings it here: Send payout unlocks.
    approvals = [approvalRow('approved', approvals[0]!.lines)];
    await render();
    expect(inDocument('pay-approval-status')!.dataset.state).toBe('approved');
    expect(words(inDocument('pay-approval-status'))).toMatch(/^Approved by Chris Hale · \d{1,2}:\d{2} (AM|PM)$/);
    expect((inDocument('pay-modal-send') as HTMLButtonElement).disabled).toBe(false);
    expect(gate().payGate.state).toBe('waiting');

    await act(async () => inDocument('pay-modal-send')!.click());
    await until(() => inDocument('pay-progress-sent')?.dataset.state === 'done', 'PayPal to take the batch');
    expect(route.posts).toHaveLength(1);
    expect(route.posts[0]).toMatchObject({ projectId: HARBOR, gateId: HARBOR_FOOTINGS_PAID, approvalId: APPROVAL });
    expect(route.headers[0]).toMatchObject({ Authorization: 'Bearer deepak-token' });
    expect(route.posts[0]!.items.map((item) => [item.firm, item.amountMinor])).toEqual([
      ['Granite Ridge Concrete', 3_132_000],
      ['Pinecrest Sitework', 648_000],
    ]);
    expect(inDocument('pay-progress-processing')!.dataset.state).toBe('active');
    expect(words(inDocument('pay-modal-batch'))).toBe(`PayPal batch ID ${BATCH}`);

    await until(() => inDocument('pay-progress-paid')?.dataset.state === 'done', 'PayPal to settle the batch');
    expect(route.reads[0]).toBe(`${ROUTE}?batch=${BATCH}`);
    expect(inDocument('pay-modal')!.dataset.phase).toBe('paid');
    // The firms as sent, each paid with its transaction (the plan now counts the work as paid).
    expect(lines()).toEqual([
      'Granite Ridge Concrete Scope: Form footings · Rebar, footings · Pour footings PayPal: Paid Transaction ID TX1AB12345678 100% $34,800 $3,480 $31,320',
      'Pinecrest Sitework Scope: Strip forms and backfill PayPal: Paid Transaction ID TX2AB12345678 100% $7,200 $720 $6,480',
    ]);
    expect(words(inDocument('pay-progress-paid'))).toContain('2 of 2 payments completed');
    expect(words(inDocument('pay-modal-released'))).toBe('Slab on grade released · can start Wed, Nov 11');
    expect(gate().payGate).toMatchObject({ state: 'paid', batchId: BATCH, amountMinor: 3_780_000 });
    expect(gate().holding).toBe(false);
    expect(words(inDocument('pay-gate-batch'))).toBe(`PayPal ID ${BATCH}`);

    await act(async () => inDocument('pay-modal-done')!.click());
    expect(inDocument('pay-modal')).toBeNull();
    expect(inDocument('pay-gate-pay')).toBeNull();
  }, 30_000);

  it('sends nothing, and changes nothing in the plan, when the route refuses the payout', async () => {
    const route = stubRoute('The approval is requested, not approved');
    approvals = [approvalRow('approved', [
      { firm: 'Granite Ridge Concrete', amount_minor: 3_132_000 },
      { firm: 'Pinecrest Sitework', amount_minor: 648_000 },
    ])];
    await render();
    await act(async () => inDocument('pay-gate-pay')!.click());
    // The open approval came back from asking again.
    calls.length = 0;
    await act(async () => inDocument('pay-modal-send')!.click());
    await until(() => words(inDocument('pay-modal')).includes('The approval is requested, not approved'), 'the refusal');
    expect(route.posts).toHaveLength(1);
    expect(inDocument('pay-modal')!.dataset.phase).toBe('review');
    expect(gate().payGate.state).toBe('waiting');
  }, 30_000);

  it('takes the request back when the window is closed without sending', async () => {
    const route = stubRoute();
    await render();
    await act(async () => inDocument('pay-gate-pay')!.click());
    await until(() => calls.some((call) => call.fn === 'request_pay_gate_approval'), 'the request');
    approvals = [approvalRow('requested', calls[0]!.args.p_lines as PayGateApprovalRow['lines'])];
    await render();
    await act(async () => inDocument('pay-modal-cancel')!.click());
    expect(inDocument('pay-modal')).toBeNull();
    expect(calls.map((call) => call.fn)).toContain('withdraw_pay_gate_approval');
    expect(words(inDocument('pay-gate-pay'))).toBe('Review payment');
    expect(route.posts).toHaveLength(0);
  });
});

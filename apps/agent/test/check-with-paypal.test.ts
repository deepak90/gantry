/**
 * check_with_paypal on Harbor Street Offices: Remy asks PayPal itself, read only, whether the tenant paid the change
 * order's invoice and whether the footings payout and the crane rental's payment went through. Only the PayPal ids this
 * project's own records hold are read: never an id the model typed, never another project's, never one made while
 * PayPal was mocked. What PayPal never saw is said from the app's records. Without PayPal connected it says so, and
 * Remy answers from the app's records.
 */
import type { InvoiceRow, PaymentAuthorizationRow, ProposalRow, ProposalVersionRow } from '@collab/shared';
import { harborOffices, HARBOR_IDS } from '@collab/shared/seed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_CONNECTED } from '../src/agent/paypal-tool';
import { describeConfig, readConfig, readPayPalAccess } from '../src/env';
import { DataToolSchemas, runDataTool, ToolRefusal, type ToolContext } from '../src/agent/tools';
import type { PayPalAnswer, PayPalInvoice, PayPalPayout, PayPalReader } from '../src/paypal/reader';
import { planFromRows, type PlanRows } from '../src/plan/rows';

const INVOICE_ID = '1a2b3c4d-0000-4000-8000-0000000009c1';
const PAYPAL_INVOICE = 'INV2-AAAA-BBBB-CCCC-DDDD';
const FOOTINGS_BATCH = '5UXD2E8A7EBQJ';
const CRANE_BATCH = 'K7XQ2N4P8R6TA';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000010009';

const harborPlan = planFromRows({
  project: { id: HARBOR_IDS.project, name: harborOffices.name, currency: 'USD', current_revision: 0, handover_task_id: harborOffices.handover_task_id, snapshot: harborOffices.inlineData as unknown as PlanRows['project']['snapshot'] },
  revisions: [],
  bookings: [],
  members: [],
  profiles: [],
});
const GATE = harborPlan.tasks.find((task) => task.payGate)!;

/** Harbor with the crane's rental, and the footings payment as the plan has it (waiting, or sent to PayPal as `batchId`). */
function harbor(gate: { state: 'waiting' | 'paying' | 'paid' | 'failed'; batchId: string | null; error?: string } = { state: 'waiting', batchId: null }): PlanRows {
  return {
    project: { id: HARBOR_IDS.project, name: harborOffices.name, currency: 'USD', current_revision: 1, handover_task_id: harborOffices.handover_task_id, client_name: 'Larkspur Analytics', snapshot: harborOffices.inlineData as unknown as PlanRows['project']['snapshot'] },
    revisions: [{ revision_no: 1, changes: { tasks: { updated: [{ id: GATE.id, payGate: { ...GATE.payGate!, state: gate.state, batchId: gate.batchId, paidAt: gate.state === 'paid' ? '2026-11-10T15:04:31.000Z' : null, error: gate.error ?? null } }] } } }],
    bookings: [{ id: HARBOR_IDS.booking, ...harborOffices.booking! }],
    members: [],
    profiles: [],
  };
}

function invoiceRow(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: INVOICE_ID,
    project_id: HARBOR_IDS.project,
    rule_id: null,
    group_task_id: 5001,
    title: 'Harbor Street Offices · Change order: New light fixtures, levels 1 to 3',
    client_name: 'Larkspur Analytics',
    client_email: 'tenant@example.com',
    lines: [{ label: 'Order light fixtures, levels 1 to 3', amount_minor: 10_500_000 }],
    amount_minor: 12_540_000,
    currency: 'USD',
    status: 'sent',
    paypal_invoice_id: PAYPAL_INVOICE,
    paypal_number: 'CO-1A2B3C4D',
    payer_url: null,
    message: null,
    created_by: null,
    created_at: '2026-11-10T14:40:00.000Z',
    sent_at: '2026-11-10T14:40:05.000Z',
    paid_at: null,
    updated_at: '2026-11-10T14:40:05.000Z',
    ...overrides,
  };
}

/** The crane rental's payment, sent to PayPal as `batchId`, through its proposal as the app links them. */
function cranePayment(batchId: string | null, status: PaymentAuthorizationRow['status'] = 'succeeded') {
  const proposal = { id: '00000000-0000-4000-8000-0000000007a1', project_id: HARBOR_IDS.project, booking_id: HARBOR_IDS.booking, created_at: '2026-11-09T10:00:00.000Z' } as ProposalRow;
  const version = { id: '00000000-0000-4000-8000-0000000007b1', proposal_id: proposal.id } as ProposalVersionRow;
  const payment = { id: '00000000-0000-4000-8000-0000000007c1', project_id: HARBOR_IDS.project, proposal_version_id: version.id, status, paypal_batch_id: batchId, created_at: '2026-11-09T10:05:00.000Z', submitted_at: '2026-11-09T10:05:01.000Z' } as PaymentAuthorizationRow;
  return { proposals: [proposal], versions: [version], payments: [payment] };
}

/** PayPal, faked: answers from what it is given, and logs every id it was asked about. */
class FakePayPal implements PayPalReader {
  readonly asked: string[] = [];
  constructor(
    private readonly invoices: Record<string, PayPalAnswer<PayPalInvoice>> = {},
    private readonly payouts: Record<string, PayPalAnswer<PayPalPayout>> = {},
  ) {}
  async invoice(id: string) {
    this.asked.push(`invoice ${id}`);
    return this.invoices[id] ?? { kind: 'not_found' as const };
  }
  async payout(id: string) {
    this.asked.push(`payout ${id}`);
    return this.payouts[id] ?? { kind: 'not_found' as const };
  }
}

const sentInvoice = (overrides: Partial<PayPalInvoice> = {}): PayPalAnswer<PayPalInvoice> => ({
  kind: 'found',
  value: { id: PAYPAL_INVOICE, status: 'SENT', number: 'CO-1A2B3C4D', amount_minor: 12_540_000, paid_minor: null, due_minor: 12_540_000, due_on: '2026-12-10', paid_on: null, ...overrides },
});

const paidBatch = (payments: PayPalPayout['payments'] = [
  { status: 'SUCCESS', amount_minor: 3_132_000, error: null },
  { status: 'SUCCESS', amount_minor: 648_000, error: null },
]): PayPalAnswer<PayPalPayout> => ({ kind: 'found', value: { via: 'payouts', id: FOOTINGS_BATCH, status: 'SUCCESS', amount_minor: 3_780_000, fee_minor: 50, completed_on: '2026-11-10', payments } });

function context(rows: PlanRows, workflow: Partial<ToolContext['workflow']>, paypal: PayPalReader | null): ToolContext & { refreshed: () => number } {
  let refreshed = 0;
  return {
    plan: planFromRows(rows),
    workflow: { proposals: [], versions: [], reviews: [], approvals: [], payments: [], publications: [], confirmations: [], documents: [], invoices: [], ...workflow },
    issues: new Map(),
    speaker: null,
    present: [],
    library: { folders: [], snippets: [] },
    drafts: new Map(),
    edits: new Map(),
    history: { rows: null, decisions: [] },
    watch: { rules: [], open: [] },
    refresh: async () => {
      refreshed += 1;
    },
    paypal,
    refreshed: () => refreshed,
  };
}

const check = (ctx: ToolContext, args: Record<string, unknown> = {}) => runDataTool('check_with_paypal', args, ctx) as Promise<Record<string, any>>;

describe('check_with_paypal', () => {
  it('is one of Remy’s tools, and asks for the app’s own references only', () => {
    expect(Object.keys(DataToolSchemas)).toHaveLength(45);
    expect(Object.keys(DataToolSchemas.check_with_paypal.shape)).toEqual(['invoice', 'progress_payment', 'rental']);
  });

  it('says PayPal isn’t connected here, without asking anything, when the assistant has no PayPal', async () => {
    const ctx = context(harbor(), { invoices: [invoiceRow()] }, null);
    expect(await check(ctx)).toEqual(NOT_CONNECTED);
    expect(NOT_CONNECTED.note).toMatch(/get_payment_status/);
    expect(ctx.refreshed()).toBe(0);
  });

  it('reads everything this project sent through PayPal, and nothing else', async () => {
    const paypal = new FakePayPal({ [PAYPAL_INVOICE]: sentInvoice() }, { [FOOTINGS_BATCH]: paidBatch(), [CRANE_BATCH]: { kind: 'found', value: { via: 'payouts', id: CRANE_BATCH, status: 'PENDING', amount_minor: 420_000, fee_minor: null, completed_on: null, payments: [{ status: 'PENDING', amount_minor: 420_000, error: null }] } } });
    const ctx = context(
      harbor({ state: 'paid', batchId: FOOTINGS_BATCH }),
      {
        ...cranePayment(CRANE_BATCH, 'pending'),
        invoices: [
          invoiceRow(),
          // Not sent yet; made while PayPal was mocked; another project's (the sandbox account holds every session's).
          invoiceRow({ id: '2b3c4d5e-0000-4000-8000-0000000009c2', title: 'Level 2 finished', status: 'draft', paypal_invoice_id: null, paypal_number: null, created_at: '2026-11-10T14:50:00.000Z' }),
          invoiceRow({ id: '3c4d5e6f-0000-4000-8000-0000000009c3', paypal_invoice_id: 'MOCK-INV-3c4d5e6f', paypal_number: null }),
          invoiceRow({ id: '4d5e6f70-0000-4000-8000-0000000009c4', project_id: OTHER_PROJECT, paypal_invoice_id: 'INV2-ZZZZ-YYYY-XXXX-WWWW', paypal_number: 'CO-4D5E6F70' }),
        ],
      },
      paypal,
    );
    const answer = await check(ctx);
    expect(ctx.refreshed()).toBe(1);
    expect(paypal.asked.sort()).toEqual([`invoice ${PAYPAL_INVOICE}`, `payout ${FOOTINGS_BATCH}`, `payout ${CRANE_BATCH}`]);
    expect(answer).toMatchObject({ connected: true, from: 'PayPal’s sandbox, read just now' });
    expect(answer.invoices).toEqual([
      expect.objectContaining({ invoice: 'CO-1A2B3C4D', to: 'Larkspur Analytics', app_record: 'sent', paypal: expect.objectContaining({ status: 'SENT', amount_minor: 12_540_000, due_on: '2026-12-10' }) }),
    ]);
    expect(answer.payouts.map((payout: { payment: string }) => payout.payment)).toEqual(['the payout for Footings', 'the Tower crane rental from Northgate Equipment Rental']);
    expect(answer.not_at_paypal).toEqual([
      'The invoice to Larkspur Analytics (CO-2B3C4D5E) has not been sent, so PayPal has nothing on it yet.',
      'The invoice to Larkspur Analytics (CO-3C4D5E6F) was made while PayPal was mocked, so PayPal never saw it.',
    ]);
    expect(answer.note).toMatch(/say the answer comes from PayPal/);
  });

  it('reads only what was named, by the app’s own references', async () => {
    const paypal = new FakePayPal({ [PAYPAL_INVOICE]: sentInvoice() }, { [FOOTINGS_BATCH]: paidBatch() });
    const ctx = context(harbor({ state: 'paid', batchId: FOOTINGS_BATCH }), { ...cranePayment(CRANE_BATCH), invoices: [invoiceRow()] }, paypal);
    expect((await check(ctx, { invoice: 'co-1a2b3c4d' })).payouts).toEqual([]);
    expect(paypal.asked).toEqual([`invoice ${PAYPAL_INVOICE}`]);
    const footings = await check(ctx, { progress_payment: GATE.id });
    expect(footings.invoices).toEqual([]);
    expect(footings.payouts).toEqual([expect.objectContaining({ payment: 'the payout for Footings', progress_payment: GATE.id, app_record: 'paid' })]);
    await check(ctx, { rental: HARBOR_IDS.booking });
    expect(paypal.asked).toEqual([`invoice ${PAYPAL_INVOICE}`, `payout ${FOOTINGS_BATCH}`, `payout ${CRANE_BATCH}`]);
  });

  it('refuses a PayPal id typed in, or anything this project doesn’t have, without asking PayPal', async () => {
    const paypal = new FakePayPal();
    const ctx = context(harbor({ state: 'paid', batchId: FOOTINGS_BATCH }), { invoices: [invoiceRow(), invoiceRow({ id: '4d5e6f70-0000-4000-8000-0000000009c4', project_id: OTHER_PROJECT, paypal_invoice_id: 'INV2-ZZZZ-YYYY-XXXX-WWWW', paypal_number: 'CO-4D5E6F70' })] }, paypal);
    await expect(check(ctx, { invoice: PAYPAL_INVOICE })).rejects.toThrow(ToolRefusal);
    await expect(check(ctx, { invoice: 'CO-4D5E6F70' })).rejects.toThrow('This project has no invoice numbered CO-4D5E6F70.');
    await expect(check(ctx, { progress_payment: 999_999 })).rejects.toThrow('No progress payment in this plan has gate_id 999999.');
    await expect(check(ctx, { rental: '00000000-0000-4000-8000-000000015101' })).rejects.toThrow(/No rental in this plan has booking_id/);
    await expect(check(ctx, { progress_payment: 'FOOTINGS' })).rejects.toThrow(/Invalid arguments/);
    expect(paypal.asked).toEqual([]);
  });

  it('says what PayPal says about the invoice, in PayPal’s words, with the amount, the due date and when it was paid', async () => {
    const say = async (answer: PayPalAnswer<PayPalInvoice>, row: Partial<InvoiceRow> = {}) => (await check(context(harbor(), { invoices: [invoiceRow(row)] }, new FakePayPal({ [PAYPAL_INVOICE]: answer })))).invoices[0];
    expect((await say(sentInvoice())).text).toBe('PayPal shows the invoice to Larkspur Analytics (CO-1A2B3C4D), $125,400, as SENT, due Thu, Dec 10, nothing paid yet.');
    const paid = await say(sentInvoice({ status: 'PAID', paid_minor: 12_540_000, due_minor: 0, paid_on: '2026-11-12' }));
    expect(paid.text).toBe('PayPal shows the invoice to Larkspur Analytics (CO-1A2B3C4D), $125,400, as PAID, paid Thu, Nov 12. The app’s record still says sent.');
    expect(paid.app_record_behind).toBe(true);
    expect((await say(sentInvoice({ status: 'PAID', paid_on: '2026-11-12' }), { status: 'paid' })).text).toBe('PayPal shows the invoice to Larkspur Analytics (CO-1A2B3C4D), $125,400, as PAID, paid Thu, Nov 12.');
    expect((await say(sentInvoice({ status: 'PARTIALLY_PAID', paid_minor: 6_000_000, due_minor: 6_540_000, paid_on: '2026-11-11' }))).text).toBe(
      'PayPal shows the invoice to Larkspur Analytics (CO-1A2B3C4D), $125,400, as PARTIALLY_PAID: $60,000 paid so far, last on Wed, Nov 11, $65,400 still due, due Thu, Dec 10.',
    );
    expect((await say({ kind: 'failed', message: 'PayPal could not be reached (no answer within 10 s).' })).text).toBe(
      'PayPal couldn’t be asked about the invoice to Larkspur Analytics (CO-1A2B3C4D): PayPal could not be reached (no answer within 10 s). The app’s record says sent.',
    );
  });

  it('says what each payment in a payout came to, from a batch or from an order', async () => {
    const say = async (answer: PayPalAnswer<PayPalPayout>, state: 'paying' | 'paid' = 'paid') =>
      (await check(context(harbor({ state, batchId: FOOTINGS_BATCH }), {}, new FakePayPal({}, { [FOOTINGS_BATCH]: answer })), { progress_payment: GATE.id })).payouts[0];
    expect((await say(paidBatch())).text).toBe('PayPal shows the payout for Footings as SUCCESS, finished Tue, Nov 10: 2 payments, $31,320 SUCCESS and $6,480 SUCCESS.');
    expect((await say(paidBatch(), 'paying')).text).toBe(
      'PayPal shows the payout for Footings as SUCCESS, finished Tue, Nov 10: 2 payments, $31,320 SUCCESS and $6,480 SUCCESS. The app’s record still says being paid.',
    );
    const unclaimed = await say(paidBatch([
      { status: 'SUCCESS', amount_minor: 3_132_000, error: null },
      { status: 'UNCLAIMED', amount_minor: 648_000, error: 'Receiver is unregistered' },
    ]));
    expect(unclaimed.text).toBe('PayPal shows the payout for Footings as SUCCESS, finished Tue, Nov 10: 2 payments, $31,320 SUCCESS and $6,480 UNCLAIMED (Receiver is unregistered).');
    const order: PayPalAnswer<PayPalPayout> = {
      kind: 'found',
      value: { via: 'order', id: '5O190127TN364715T', status: 'COMPLETED', amount_minor: 3_780_000, fee_minor: 132_020, completed_on: '2026-11-10', payments: [{ status: 'COMPLETED', amount_minor: 3_132_000, error: null }, { status: 'COMPLETED', amount_minor: 648_000, error: null }] },
    };
    expect((await say(order)).text).toBe('PayPal shows the payout for Footings, one order paid with PayPal’s button, as COMPLETED, finished Tue, Nov 10: 2 payments, $31,320 COMPLETED and $6,480 COMPLETED.');
    expect((await say({ kind: 'not_found' })).text).toBe('PayPal has no payout or order by the id the app holds for the payout for Footings.');
  });

  it('says so from the app’s records when a payout hasn’t gone to PayPal, and leaves unpaid rentals out of everything', async () => {
    const paypal = new FakePayPal();
    const ctx = context(harbor(), {}, paypal);
    const everything = await check(ctx);
    expect(everything).toMatchObject({
      from: 'the app’s records only: nothing here has gone to PayPal, so PayPal was not asked',
      invoices: [],
      payouts: [],
      not_at_paypal: ['There is no invoice to Larkspur Analytics in the app yet.', 'The payout for Footings has not been sent to PayPal (the app’s record says not paid).'],
    });
    expect(everything.note).toBe('PayPal was not asked: by the app’s records, nothing here has gone to PayPal yet. Say that is the app’s record, never that PayPal said it.');
    expect((await check(ctx, { rental: HARBOR_IDS.booking })).not_at_paypal).toEqual(['The Tower crane rental from Northgate Equipment Rental has not been sent to PayPal (the app’s record says not paid).']);
    expect((await check(context(harbor({ state: 'paid', batchId: 'MOCK-M-USD-S3132000.S648000-PG-25-ab' }), {}, paypal), { progress_payment: GATE.id })).not_at_paypal).toEqual([
      'The payout for Footings was paid while PayPal was mocked, so PayPal never saw it.',
    ]);
    // PayPal turned the batch down when it was sent (the sandbox balance ran short), so it never became a payout.
    const refused = harbor({ state: 'failed', batchId: null, error: 'Sender does not have sufficient funds. Please add funds and retry.' });
    expect((await check(context(refused, {}, paypal), { progress_payment: GATE.id })).not_at_paypal).toEqual([
      'The payout for Footings failed when it was sent and never became a PayPal payout, so there is nothing at PayPal to look up. The app recorded why: Sender does not have sufficient funds. Please add funds and retry.',
    ]);
    expect(paypal.asked).toEqual([]);
  });
});

describe('PayPal for the assistant', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is connected only with PAYPAL_MODE=live, the sandbox and both halves of the key', () => {
    const key = { PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: 'client-secret' };
    expect(readPayPalAccess({ ...key, PAYPAL_MODE: 'live' } as NodeJS.ProcessEnv)).toEqual({ access: { clientId: 'client-id', clientSecret: 'client-secret' }, why: null });
    expect(readPayPalAccess({ ...key, PAYPAL_MODE: 'live', PAYPAL_ENV: 'sandbox' } as NodeJS.ProcessEnv).access).not.toBeNull();
    expect(readPayPalAccess({ ...key } as NodeJS.ProcessEnv)).toEqual({ access: null, why: 'PAYPAL_MODE is not live' });
    expect(readPayPalAccess({ ...key, PAYPAL_MODE: 'mock' } as NodeJS.ProcessEnv)).toEqual({ access: null, why: 'PAYPAL_MODE is not live' });
    expect(readPayPalAccess({ ...key, PAYPAL_MODE: 'live', PAYPAL_ENV: 'live' } as NodeJS.ProcessEnv)).toEqual({ access: null, why: 'PAYPAL_ENV is not sandbox' });
    expect(readPayPalAccess({ PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'client-id', PAYPAL_CLIENT_SECRET: ' ' } as NodeJS.ProcessEnv)).toEqual({ access: null, why: 'PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not set' });
  });

  it('is named in the startup line without its key', () => {
    vi.stubEnv('PAYPAL_MODE', 'live');
    vi.stubEnv('PAYPAL_CLIENT_ID', 'pp-client-id-value');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'pp-client-secret-value');
    const line = describeConfig(readConfig({ SUPABASE_SERVICE_ROLE_KEY: 'service-secret' } as NodeJS.ProcessEnv));
    expect(line).toContain('paypal=read-only (sandbox)');
    expect(line).not.toMatch(/pp-client-id-value|pp-client-secret-value/);
    vi.stubEnv('PAYPAL_MODE', 'mock');
    expect(describeConfig(readConfig({} as NodeJS.ProcessEnv))).toContain('paypal=not connected (PAYPAL_MODE is not live)');
  });
});

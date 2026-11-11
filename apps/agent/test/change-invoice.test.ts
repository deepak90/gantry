/**
 * Billing the tenant for a change (a change order) on Harbor Street Offices, as in the film: new light
 * fixtures on levels 1 to 3, one order for the building at $105,000 and each floor's delivery, install and
 * test. Remy drafts the invoice from the plan's own costs (the order, then a line per floor with its tasks
 * under it), billed to the project's client, net 30, in parts over $60,000; the card carries what the tool
 * drafted, never what the model typed; a change already billed keeps its invoice; an invoice is not shown
 * where someone reading may not see costs; and nothing here sends it.
 */
import { CARD_PROPS, type InvoiceRow, type WatchRuleRow } from '@collab/shared';
import { harborOffices, HARBOR_IDS } from '@collab/shared/seed';
import { describe, expect, it } from 'vitest';
import { groundCard } from '../src/agent/grounding';
import { runDataTool, ToolRefusal, type ToolContext } from '../src/agent/tools';
import { FakeBrowser, FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { makeClient } from '../src/llm/client';
import { silentLogger } from '../src/log';
import { workPhrase } from '../src/plan/invoice';
import { planFromRows, type PlanRows } from '../src/plan/rows';
import { ProjectAgent } from '../src/project-agent';
import type { TurnResult } from '../src/agent/brain';

const LIGHTS = 'snippet-light-fixtures';
const TENANT = 'Larkspur Analytics';

/** A task the change added, as a revision carries it: dated, priced, and marked with the library piece it came from. */
const added = (id: number, name: string, parentId: number, order: number, dollars: number, libraryRef = LIGHTS) => ({
  id,
  name,
  parentId,
  orderedParentIndex: order,
  startDate: '2027-03-09',
  endDate: '2027-03-10',
  budgetMinor: dollars * 100,
  forecastMinor: dollars * 100,
  libraryRef,
  costLines: [{ label: name, payee: 'Halden Electrical', amount_minor: dollars * 100, due: 'on_completion', paid_ref: null }],
});

/** The light fixtures change: one order for the building on level 1, then each floor's delivery, install and test. */
function fixtures(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [added(5001, 'Order light fixtures, levels 1 to 3', 100, 5, 105_000)];
  [100, 200, 300].forEach((floor, index) => {
    const base = 5002 + index * 10;
    rows.push(added(base, 'Deliver light fixtures', floor, 6, 900), added(base + 1, 'Install light fixtures', floor, 7, 6_200), added(base + 2, 'Test light fixtures', floor, 8, 1_400));
  });
  return rows;
}

function harborRows(extra: Record<string, unknown>[] = [], client: string | null = TENANT): PlanRows {
  return {
    project: {
      id: HARBOR_IDS.project,
      name: harborOffices.name,
      currency: 'USD',
      current_revision: 1,
      handover_task_id: harborOffices.handover_task_id,
      client_name: client,
      snapshot: harborOffices.inlineData as unknown as PlanRows['project']['snapshot'],
    },
    revisions: [{ revision_no: 1, changes: { tasks: { added: [...fixtures(), ...extra] } } }],
    bookings: [],
    members: [],
    profiles: [],
  };
}

function context(rows = harborRows(), invoices: InvoiceRow[] = []): ToolContext {
  const plan = planFromRows(rows);
  return {
    plan,
    workflow: { proposals: [], versions: [], reviews: [], approvals: [], payments: [], publications: [], confirmations: [], documents: [], invoices },
    issues: new Map(),
    speaker: null,
    present: [],
    library: { folders: [], snippets: [] },
    drafts: new Map(),
    edits: new Map(),
    invoices: new Map(),
    history: { rows: null, decisions: [] },
    watch: { rules: [], open: [] },
    refresh: async () => undefined,
  };
}

const run = (ctx: ToolContext, args: unknown) => runDataTool('draft_change_invoice', args, ctx) as Promise<Record<string, any>>;

function invoiceRow(groupTaskId: number, status: InvoiceRow['status']): InvoiceRow {
  return {
    id: '00000000-0000-4000-8000-0000000009c1',
    project_id: HARBOR_IDS.project,
    rule_id: null,
    group_task_id: groupTaskId,
    title: 'Harbor Street Offices · Change order: Light fixtures, levels 1 to 3',
    client_name: TENANT,
    client_email: 'tenant@example.com',
    lines: [{ label: 'Order light fixtures, levels 1 to 3', amount_minor: 10_500_000 }],
    amount_minor: 13_050_000,
    currency: 'USD',
    status,
    paypal_invoice_id: 'INV2-TEST',
    paypal_number: '0044',
    payer_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST',
    message: null,
    created_by: null,
    created_at: '2026-11-07T18:00:00.000Z',
    sent_at: '2026-11-07T18:00:05.000Z',
    paid_at: null,
    updated_at: '2026-11-07T18:00:05.000Z',
  };
}

describe('the invoice for a change', () => {
  it('bills the order once, then each floor’s own work, at the plan’s costs, to the tenant, net 30, in parts over $60,000', async () => {
    const ctx = context();
    const result = await run(ctx, {});
    expect(result.to).toBe(TENANT);
    expect(result.lines.map((line: { label: string; text: string }) => [line.label, line.text])).toEqual([
      ['Order light fixtures, levels 1 to 3', '$105,000'],
      ['Deliver, install and test light fixtures, level 1', '$8,500'],
      ['Deliver, install and test light fixtures, level 2', '$8,500'],
      ['Deliver, install and test light fixtures, level 3', '$8,500'],
    ]);
    expect(result.total_minor).toBe(13_050_000);
    expect(result.text).toMatchObject({ total: '$130,500', terms: 'net 30: due 30 days after it is sent' });
    expect(result.text.in_parts).toContain('$60,000');
    expect(result.payment_limit_minor).toBe(6_000_000);
    expect(result.already_invoiced).toBeNull();

    // The card carries the draft exactly: what is shown is what the person sends.
    const card = ctx.invoices!.get(result.invoice_id)!;
    expect(CARD_PROPS.show_change_invoice.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({
      change: 'Light fixtures, levels 1 to 3',
      title: 'Harbor Street Offices · Change order: Light fixtures, levels 1 to 3',
      recipient: TENANT,
      total_minor: 13_050_000,
      currency: 'USD',
      due_days: 30,
      partial_payments: true,
      // Recorded on the change's first task, the order.
      record_task_id: 5001,
    });
    expect(card.lines[1]).toEqual({
      label: 'Deliver, install and test light fixtures, level 1',
      amount_minor: 850_000,
      detail: 'Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400',
      task_ids: [5002, 5003, 5004],
    });
    expect(card.lines[0]!.detail).toBeNull();
    expect([...card.task_ids].sort((a, b) => a - b)).toEqual([5001, 5002, 5003, 5004, 5012, 5013, 5014, 5022, 5023, 5024]);
  });

  it('names the change as the people do, takes the piece’s name from the library, and bills only the tasks named', async () => {
    const named = await run(context(), { change: 'New light fixtures, levels 1 to 3' });
    expect(named.change).toBe('New light fixtures, levels 1 to 3');

    const ctx = context();
    ctx.library = { folders: [], snippets: [{ id: LIGHTS, name: 'Light fixtures package' } as never] };
    expect((await run(ctx, {})).change).toBe('Light fixtures package, levels 1 to 3');

    const floor = await run(context(), { task_ids: [5012, 5013, 5014] });
    expect(floor.lines).toEqual([expect.objectContaining({ label: 'Deliver, install and test light fixtures, level 2', amount_minor: 850_000 })]);
    expect(floor.change).toBe('Light fixtures, level 2');
    expect(floor.text.in_parts).toBeNull();
  });

  it('finds the floor of a piece dropped as a group of its own', async () => {
    const group = { id: 6000, name: 'Light fixtures', parentId: 200, orderedParentIndex: 9, startDate: '2027-03-09', endDate: '2027-03-11', libraryRef: 'snippet-grouped' };
    const install = { ...added(6001, 'Install light fixtures', 6000, 0, 6_200), libraryRef: null };
    const test = { ...added(6002, 'Test light fixtures', 6000, 1, 1_400), libraryRef: null };
    const result = await run(context(harborRows([group, install, test])), {});
    expect(result.lines).toEqual([expect.objectContaining({ label: 'Install and test light fixtures, level 2', amount_minor: 760_000 })]);
    expect(result.change).toBe('Light fixtures, level 2');
  });

  it('takes the library piece added most recently, and leaves an older one out', async () => {
    const older = added(4001, 'Install signage', 400, 3, 2_500, 'snippet-signage');
    const ctx = context(harborRows([older]));
    const result = await run(ctx, {});
    expect(result.lines.some((line: { label: string }) => /signage/i.test(line.label))).toBe(false);
    // Named, the older piece is billed on its own: one task, its own name.
    const signage = await run(ctx, { task_ids: [4001] });
    expect(signage.lines).toEqual([expect.objectContaining({ label: 'Install signage (Completion)', amount_minor: 250_000 })]);
  });

  it('keeps the invoice a change already has, so it is never billed twice', async () => {
    const sent = await run(context(harborRows(), [invoiceRow(5001, 'sent')]), {});
    expect(sent.already_invoiced).toEqual({ status: 'sent', number: '0044', total_minor: 13_050_000, sent_on: '2026-11-07', paid_on: null });
    // Recorded on another task of the change: the card follows that one.
    const ctx = context(harborRows(), [invoiceRow(5013, 'sent')]);
    const result = await run(ctx, {});
    expect(ctx.invoices!.get(result.invoice_id)!.record_task_id).toBe(5013);
    // A canceled one is no invoice.
    expect((await run(context(harborRows(), [invoiceRow(5001, 'cancelled')]), {})).already_invoiced).toBeNull();
  });

  it('says which billing rules would bill the same work again when it is finished', async () => {
    const rule = (name: string, scope: WatchRuleRow['scope'], action: WatchRuleRow['action'], enabled = true): WatchRuleRow => ({
      id: `00000000-0000-4000-8000-0000000007${String(name.length).padStart(2, '0')}`,
      project_id: HARBOR_IDS.project,
      name,
      scope,
      condition: { kind: 'all_done' },
      trigger: { kind: 'change' },
      action,
      enabled,
      created_by: null,
      thread_id: null,
      created_at: '2026-11-07T18:00:00.000Z',
      updated_at: '2026-11-07T18:00:00.000Z',
    });
    const ctx = context();
    ctx.watch = {
      rules: [
        rule('Bill the tenant when the light fixtures are finished', { kind: 'tasks', task_ids: [200] }, { kind: 'prepare_invoice' }),
        rule('Tell me when level 3 is done', { kind: 'tasks', task_ids: [5022] }, { kind: 'alert' }),
        rule('An old billing rule, off', { kind: 'plan' }, { kind: 'prepare_invoice' }, false),
      ],
      open: [],
    };
    expect((await run(ctx, {})).also_billed_when_finished).toEqual(['Bill the tenant when the light fixtures are finished']);
    expect((await run(context(), {})).also_billed_when_finished).toEqual([]);
  });

  it('refuses a project with nobody to bill, a change with no cost, unknown tasks, and a line PayPal cannot take', async () => {
    await expect(run(context(harborRows([], null)), {})).rejects.toThrow(/nobody to bill/);
    await expect(run(context(), { task_ids: [999_999] })).rejects.toThrow(ToolRefusal);
    const free = added(4002, 'Walk the floors with the tenant', 400, 4, 0, 'snippet-walk');
    await expect(run(context(harborRows([{ ...free, id: 9001 }])), {})).rejects.toThrow(/nothing to bill/);
    const huge = added(9002, 'Order curtain wall glass, all floors', 80, 3, 1_200_000, 'snippet-glass');
    await expect(run(context(harborRows([huge])), {})).rejects.toThrow(/at most \$1,000,000 a line/);
    const plain: PlanRows = { ...harborRows(), revisions: [] };
    await expect(run(context(plain), {})).rejects.toThrow(/Nothing in the plan came from the library/);
  });

  it('shows only an invoice the tool drafted', async () => {
    const ctx = context();
    const result = await run(ctx, {});
    const grounding = { issues: new Map(), knownMinor: new Set<number>(), invoices: new Set(ctx.invoices!.keys()) };
    expect(groundCard('show_change_invoice', { invoice_id: result.invoice_id }, grounding)).toEqual([]);
    expect(groundCard('show_change_invoice', { invoice_id: 'invoice-99' }, grounding)).toEqual(['invoice_id invoice-99 was not returned by draft_change_invoice']);
  });
});

describe('the work of a floor in one phrase', () => {
  it('says the words the tasks share once', () => {
    expect(workPhrase(['Deliver light fixtures', 'Install light fixtures', 'Test light fixtures'])).toBe('Deliver, install and test light fixtures');
    expect(workPhrase(['Install light fixtures', 'Test light fixtures'])).toBe('Install and test light fixtures');
    expect(workPhrase(['Install light fixtures'])).toBe('Install light fixtures');
    expect(workPhrase(['Deliver light fixtures', 'Test and aim lighting'])).toBe('Deliver light fixtures and test and aim lighting');
    expect(workPhrase(['Paint', 'Paint'])).toBe('Paint');
  });
});

describe('“Remy, bill the tenant.”', () => {
  function setup() {
    const db = new FakeDb();
    const harbor = harborRows();
    db.plan = { ...db.plan, project: harbor.project, revisions: harbor.revisions, bookings: [] };
    const transport = new FakeTransport();
    const browser = new FakeBrowser(db, transport, { commandDelayMs: 5 });
    const turns: TurnResult[] = [];
    const agent = new ProjectAgent({
      projectId: db.projectId,
      store: db,
      transport,
      client: makeClient('mock', { delayMs: 0 }),
      models: { analysis: 'claude-opus-5-5', chat: 'claude-sonnet-5-5' },
      log: silentLogger,
      debounce: { presence: 0, workflow: 5, plan: 5 },
      openingDelayMs: 0,
      onTurn: (result) => turns.push(result),
    });
    return { db, transport, browser, agent, turns };
  }

  it('drafts the invoice and shows it to send, filled in from the plan; nothing is sent', async () => {
    const { agent, browser, transport, db, turns } = setup();
    await agent.start();
    transport.presence(db.projectId, presenceOf('pm', 'cm'));
    await agent.idle();
    browser.say('pm', 'Remy, bill the tenant.');
    await agent.idle();
    const turn = turns.at(-1)!;
    expect(turn.toolCalls.map((call) => call.name)).toEqual(['draft_change_invoice', 'reply', 'show_change_invoice']);
    expect(turn.say).toBe('Here’s the PayPal invoice for the change. Send it?');
    const card = turn.cards.find((candidate) => candidate.component === 'show_change_invoice')!;
    expect(CARD_PROPS.show_change_invoice.parse(card.props)).toMatchObject({ recipient: TENANT, total_minor: 13_050_000, partial_payments: true, record_task_id: 5001 });
    // Every browser draws the stored card; the assistant wrote no invoice anywhere.
    expect(db.messages.at(-1)?.cards[0]?.props).toMatchObject({ lines: expect.any(Array), title: 'Harbor Street Offices · Change order: Light fixtures, levels 1 to 3' });
    expect(db.workflow.invoices ?? []).toEqual([]);
    await agent.stop();
  });

  it('leaves the card out where someone reading may not see costs', async () => {
    const { agent, browser, transport, db, turns } = setup();
    db.addMember({ display_name: 'Sam Ortiz', can_view_costs: false });
    await agent.start();
    transport.presence(db.projectId, presenceOf('pm', 'cm'));
    await agent.idle();
    browser.say('pm', 'Remy, bill the tenant.');
    await agent.idle();
    const turn = turns.at(-1)!;
    expect(turn.cards.some((card) => card.component === 'show_change_invoice')).toBe(false);
    expect(turn.toolCalls.find((call) => call.name === 'show_change_invoice')).toMatchObject({ ok: false, summary: expect.stringContaining('may not see costs') });
    await agent.stop();
  });
});

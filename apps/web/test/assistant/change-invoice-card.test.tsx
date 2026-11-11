/**
 * The PayPal invoice for a change (a change order), as the thread draws it: the lines priced from the
 * plan, the total, who it bills and when it falls due; Review invoice opens the window, and only Confirm
 * and send there records the invoice on the change's first task and sends it through paypal-invoice, under
 * the viewer's own login, and only for someone who sees costs; once sent, the card and any open window
 * follow the record (Sent by whom, with its number and PayPal's page, later Paid, or Canceled).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_PROPS, type ChangeInvoiceCard, type InvoiceRow } from '@collab/shared';
import { ChangeInvoiceCardView, type ChangeInvoiceEnv } from '../../src/assistant/change-invoice-card';
import type { WorkflowClient } from '../../src/workflow/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CARD: ChangeInvoiceCard = {
  invoice_id: 'invoice-1',
  change: 'New light fixtures, levels 1 to 3',
  title: 'Harbor Street Offices · Change order: New light fixtures, levels 1 to 3',
  recipient: 'Larkspur Analytics',
  lines: [
    { label: 'Order light fixtures, levels 1 to 3', amount_minor: 10_500_000, detail: null, task_ids: [5001] },
    { label: 'Deliver, install and test light fixtures, level 1', amount_minor: 850_000, detail: 'Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400', task_ids: [5002, 5003, 5004] },
    { label: 'Deliver, install and test light fixtures, level 2', amount_minor: 850_000, detail: 'Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400', task_ids: [5012, 5013, 5014] },
  ],
  total_minor: 12_200_000,
  currency: 'USD',
  due_days: 30,
  partial_payments: true,
  task_ids: [5001, 5002, 5003, 5004, 5012, 5013, 5014],
  record_task_id: 5001,
};

const CHRIS = '00000000-0000-4000-8000-000000000013';
const PROFILES = [
  { user_id: CHRIS, display_name: 'Chris Hale', color: '#336699' },
  { user_id: '00000000-0000-4000-8000-000000000012', display_name: 'Deepak Jayaram', color: '#996633' },
];

function row(status: InvoiceRow['status'], extra: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: '00000000-0000-4000-8000-0000000009c1',
    project_id: '00000000-0000-4000-8000-000000000002',
    rule_id: null,
    group_task_id: 5001,
    title: CARD.title,
    client_name: 'Larkspur Analytics',
    client_email: 'tenant@example.com',
    lines: CARD.lines.map(({ label, amount_minor, detail }) => (detail ? { label, amount_minor, detail } : { label, amount_minor })),
    amount_minor: CARD.total_minor,
    currency: 'USD',
    status,
    paypal_invoice_id: status === 'draft' || status === 'failed' ? null : 'INV2-TEST',
    paypal_number: status === 'draft' || status === 'failed' ? null : '0044',
    payer_url: status === 'draft' || status === 'failed' ? null : 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST',
    message: null,
    created_by: null,
    created_at: '2026-11-07T18:00:00.000Z',
    sent_at: status === 'sent' || status === 'paid' || status === 'cancelled' ? '2026-11-07T18:00:05.000Z' : null,
    sent_by: status === 'sent' || status === 'paid' || status === 'cancelled' ? CHRIS : null,
    paid_at: status === 'paid' ? '2026-11-09T15:00:00.000Z' : null,
    updated_at: '2026-11-07T18:00:05.000Z',
    ...extra,
  };
}

function setup(invoices: InvoiceRow[] = [], options: { canSend?: boolean; partial?: boolean; costs?: Record<number, number>; drawnAt?: string } = {}) {
  const rpc = vi.fn(async (fn: string, _args?: object) => (fn === 'project_client' ? { data: { name: 'Larkspur Analytics', email: 'ap@larkspur.example' }, error: null } : { data: row('draft'), error: null }));
  const invoke = vi.fn(async (_name: string, call: { body: Record<string, unknown> }): Promise<{ data: unknown; error: unknown }> => {
    if (call.body.action === 'seller') return { data: { seller: 'Aldermere Construction' }, error: null };
    if (call.body.action === 'cancel') return { data: { invoice: row('cancelled', { updated_at: '2026-11-07T18:30:00.000Z' }) }, error: null };
    return { data: { invoice: row('sent') }, error: null };
  });
  const reload = vi.fn(async () => undefined);
  const showTasks = vi.fn();
  const env = {
    currency: 'USD',
    canViewCosts: true,
    active: true,
    partial: options.partial ?? false,
    client: { rpc, functions: { invoke }, from: () => undefined } as unknown as WorkflowClient,
    projectId: '00000000-0000-4000-8000-000000000002',
    workflow: { status: 'ready', snapshot: { invoices, profiles: PROFILES }, loadError: null, busy: null, failure: null, notice: null },
    controller: { reload },
    showTasks,
    canSend: options.canSend ?? true,
    watching: false,
    ...(options.costs ? { liveCost: (ids: readonly number[]) => ids.reduce((sum, id) => sum + (options.costs![id] ?? 0), 0) } : {}),
    ...(options.drawnAt ? { drawnAt: options.drawnAt } : {}),
  } as unknown as ChangeInvoiceEnv;
  return { env, rpc, invoke, reload, showTasks };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const mounted: { root: Root; host: HTMLElement }[] = [];

function draw(element: ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mounted.push({ root, host });
  act(() => root!.render(element));
  return host;
}

/** A card kept mounted so the workflow snapshot can change under it, as the realtime broadcasts do. */
function live(env: ChangeInvoiceEnv) {
  const drawn = draw(<ChangeInvoiceCardView card={CARD} env={env} />);
  const mine = root!;
  return {
    drawn,
    env,
    /** The workflow snapshot arrives with these invoices (the broadcast's re-read). */
    arrive(invoices: InvoiceRow[]) {
      act(() => mine.render(<ChangeInvoiceCardView card={CARD} env={{ ...env, workflow: { ...env.workflow, snapshot: { ...env.workflow.snapshot!, invoices } } }} />));
    },
  };
}

afterEach(() => {
  act(() => {
    for (const each of mounted) each.root.unmount();
  });
  for (const each of mounted) each.host.remove();
  mounted.length = 0;
  root = null;
  host = null;
});

const text = (element: Element | Document, testId: string) => element.querySelector(`[data-testid="${testId}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
const windows = () => [...document.querySelectorAll('[data-testid="invoice-modal"]')];
const inWindow = <T extends HTMLElement = HTMLElement>(testId: string, index = 0) => windows()[index]?.querySelector<T>(`[data-testid="${testId}"]`) ?? null;
const press = (element: HTMLElement | null) => act(async () => element!.click());
const review = (drawn: HTMLElement) => press(drawn.querySelector<HTMLElement>('[data-testid="change-invoice-review"]'));

describe('the invoice for a change', () => {
  it('is a card the thread can store: the schema takes it whole', () => {
    expect(CARD_PROPS.show_change_invoice.safeParse(CARD).success).toBe(true);
  });

  it('shows what it bills, from the plan: each line, what a floor’s line is made of, the total, the tenant and the terms', () => {
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={setup().env} />);
    const lines = [...drawn.querySelectorAll('[data-testid="change-invoice-line"]')].map((line) => line.textContent);
    expect(lines).toEqual([
      'Order light fixtures, levels 1 to 3$105,000',
      'Deliver, install and test light fixtures, level 1Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400$8,500',
      'Deliver, install and test light fixtures, level 2Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400$8,500',
    ]);
    expect(text(drawn, 'change-invoice-total')).toBe('$122,000');
    expect(text(drawn, 'change-invoice-to')).toBe('Larkspur Analytics');
    // Labels in the trade's terms, no chat: the terms as "Net 30", the parts rule as a label, Review invoice alone.
    expect(drawn.textContent).toContain('TermsNet 30');
    expect(text(drawn, 'change-invoice-parts')).toBe('Partial payments allowed · payer limits apply');
    expect(drawn.querySelector('[data-testid="change-invoice-status"]')?.getAttribute('data-status')).toBe('unsent');
    expect(text(drawn, 'change-invoice-status')).toBe('Draft');
    expect(drawn.querySelector<HTMLButtonElement>('[data-testid="change-invoice-review"]')?.disabled).toBe(false);
    expect(text(drawn, 'change-invoice-review')).toBe('Review invoice');
    expect(drawn.querySelector('[data-testid="change-invoice-send"]')).toBeNull();
    expect(drawn.textContent).not.toContain('until you press');
  });

  it('sends only when confirmed in the window: the invoice is recorded on the change’s first task, then PayPal sends it', async () => {
    const { env, rpc, invoke, reload } = setup();
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={env} />);
    expect(rpc).not.toHaveBeenCalled();
    await review(drawn);
    // Opening the window records and sends nothing.
    expect(rpc).not.toHaveBeenCalledWith('prepare_invoice', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('paypal-invoice', { body: expect.objectContaining({ action: 'send' }) });
    await press(inWindow('invoice-modal-send'));
    expect(rpc).toHaveBeenCalledWith('prepare_invoice', {
      p_project: env.projectId,
      p_group_task: 5001,
      p_rule: null,
      p_title: CARD.title,
      p_lines: [
        { label: 'Order light fixtures, levels 1 to 3', amount_minor: 10_500_000 },
        { label: 'Deliver, install and test light fixtures, level 1', amount_minor: 850_000, detail: CARD.lines[1]!.detail },
        { label: 'Deliver, install and test light fixtures, level 2', amount_minor: 850_000, detail: CARD.lines[2]!.detail },
      ],
    });
    expect(invoke).toHaveBeenCalledWith('paypal-invoice', { body: { invoice_id: row('draft').id, action: 'send' } });
    expect(reload).toHaveBeenCalled();
  });

  it('follows the invoice once it is sent: its number, PayPal’s page for the tenant, and no second Send', () => {
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={setup([row('sent')]).env} />);
    expect(text(drawn, 'change-invoice-status')).toBe('Sent');
    expect(text(drawn, 'change-invoice-number')).toBe('0044');
    expect(text(drawn, 'change-invoice-sent')).toMatch(/^Sent (Mon|Tue|Wed|Thu|Fri|Sat|Sun), Nov [78] · Awaiting payment\s?View in PayPal$/);
    expect(drawn.querySelector<HTMLAnchorElement>('[data-testid="change-invoice-view"]')?.href).toBe('https://www.sandbox.paypal.com/invoice/p/#INV2-TEST');
    expect(drawn.querySelector('[data-testid="change-invoice-review"]')).toBeNull();
    // Due 30 days from the day it went.
    expect(drawn.textContent).toMatch(/Due(Mon|Tue|Wed|Thu|Fri|Sat|Sun), Dec [67]/);
  });

  it('says when the tenant has paid, and offers a second try when PayPal refused it', () => {
    expect(text(draw(<ChangeInvoiceCardView card={CARD} env={setup([row('paid')]).env} />), 'change-invoice-paid')).toContain('Paid by Larkspur Analytics');
    act(() => root?.unmount());
    const failed = draw(<ChangeInvoiceCardView card={CARD} env={setup([row('failed', { message: 'PayPal could not send the invoice: try again.' })]).env} />);
    expect(text(failed, 'change-invoice-review')).toBe('Review invoice');
    expect(failed.textContent).toContain('PayPal could not send the invoice');
  });

  it('holds the review when the plan’s costs moved since it was drafted, and offers it when they still match', () => {
    const now = { 5001: 10_500_000, 5002: 90_000, 5003: 620_000, 5004: 140_000, 5012: 90_000, 5013: 620_000, 5014: 140_000 };
    const same = draw(<ChangeInvoiceCardView card={CARD} env={setup([], { costs: now }).env} />);
    expect(same.querySelector('[data-testid="change-invoice-stale"]')).toBeNull();
    expect(same.querySelector<HTMLButtonElement>('[data-testid="change-invoice-review"]')?.disabled).toBe(false);
    act(() => root?.unmount());
    const moved = draw(<ChangeInvoiceCardView card={CARD} env={setup([], { costs: { ...now, 5001: 9_000_000 } }).env} />);
    expect(moved.querySelector('[data-testid="change-invoice-stale"]')).not.toBeNull();
    expect(moved.querySelector<HTMLButtonElement>('[data-testid="change-invoice-review"]')?.disabled).toBe(true);
  });

  it('leaves the review to someone who sees costs, and draws a card still being written without one', () => {
    const viewer = draw(<ChangeInvoiceCardView card={CARD} env={setup([], { canSend: false }).env} />);
    expect(viewer.querySelector<HTMLButtonElement>('[data-testid="change-invoice-review"]')?.disabled).toBe(true);
    expect(viewer.textContent).toContain('Requires cost access');
    act(() => root?.unmount());
    const writing = draw(<ChangeInvoiceCardView card={{ invoice_id: 'invoice-1' }} env={setup([], { partial: true }).env} />);
    expect(writing.querySelector('[data-testid="assistant-change-invoice"]')).not.toBeNull();
    expect(writing.querySelector('[data-testid="change-invoice-review"]')).toBeNull();
  });
});

describe('the invoice window', () => {
  it('names the address the hosted demo bills, the tenant’s sandbox account, rather than the project’s', async () => {
    const { env, invoke } = setup();
    invoke.mockImplementationOnce(async () => ({ data: { seller: 'Aldermere Construction', bill_to: 'tenant@personal.example.com' }, error: null }));
    await review(draw(<ChangeInvoiceCardView card={CARD} env={env} />));
    expect(text(windows()[0]!, 'invoice-modal-to')).toBe('Larkspur Analyticstenant@personal.example.com');
  });

  it('shows the whole invoice and asks plainly: nothing moves until Confirm and send', async () => {
    const { env, rpc, invoke } = setup();
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={env} />);
    await review(drawn);
    expect(windows()).toHaveLength(1);
    expect(windows()[0]!.getAttribute('role')).toBe('dialog');
    expect(text(windows()[0]!, 'invoice-modal-status')).toBe('Draft');
    expect(windows()[0]!.textContent).toContain('Send this invoice to Larkspur Analytics?');
    expect(text(windows()[0]!, 'invoice-modal-from')).toBe('Aldermere Construction');
    expect(text(windows()[0]!, 'invoice-modal-to')).toBe('Larkspur Analyticsap@larkspur.example');
    expect([...windows()[0]!.querySelectorAll('[data-testid="invoice-modal-line"]')].map((line) => line.textContent)).toEqual([
      'Order light fixtures, levels 1 to 3$105,000',
      'Deliver, install and test light fixtures, level 1Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400$8,500',
      'Deliver, install and test light fixtures, level 2Deliver light fixtures $900 · Install light fixtures $6,200 · Test light fixtures $1,400$8,500',
    ]);
    expect(text(windows()[0]!, 'invoice-modal-total')).toBe('$122,000');
    expect(windows()[0]!.textContent).toContain('TermsNet 30');
    expect(text(windows()[0]!, 'invoice-modal-number')).toBe('Assigned on sending');
    expect(text(windows()[0]!, 'invoice-modal-send')).toBe('Confirm and send');
    expect(text(windows()[0]!, 'invoice-modal-cancel')).toBe('Cancel');
    // Cancel: gone, and nothing recorded or sent.
    await press(inWindow('invoice-modal-cancel'));
    expect(windows()).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalledWith('prepare_invoice', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('paypal-invoice', { body: expect.objectContaining({ action: 'send' }) });
  });

  it('after Confirm and send turns to Sent: the number, who sent it and when, PayPal’s page and Done', async () => {
    const { env, invoke } = setup();
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={env} />);
    await review(drawn);
    await press(inWindow('invoice-modal-send'));
    expect(invoke).toHaveBeenCalledWith('paypal-invoice', { body: { invoice_id: row('draft').id, action: 'send' } });
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('sent');
    expect(text(windows()[0]!, 'invoice-modal-status')).toBe('Sent');
    expect(windows()[0]!.textContent).toContain('Invoice sent');
    expect(text(windows()[0]!, 'invoice-modal-number')).toBe('0044');
    expect(text(windows()[0]!, 'invoice-modal-sent-by')).toMatch(/^Sent by Chris Hale · \d{1,2}:\d{2}\s?[AP]M$/);
    expect(inWindow('invoice-modal-view')?.getAttribute('href')).toBe('https://www.sandbox.paypal.com/invoice/p/#INV2-TEST');
    expect(inWindow('invoice-modal-send')).toBeNull();
    // The card behind it says the same; what the film’s walkthrough reads stays where it was.
    expect(drawn.querySelector<HTMLElement>('[data-testid="change-invoice-status"]')?.dataset.status).toBe('sent');
    expect(text(drawn, 'change-invoice-number')).toBe('0044');
    expect(text(drawn, 'change-invoice-total')).toBe('$122,000');
    expect(text(drawn, 'change-invoice-sent-by')).toMatch(/^Sent by Chris Hale · \d{1,2}:\d{2}\s?[AP]M$/);
    await press(inWindow('invoice-modal-done'));
    expect(windows()).toHaveLength(0);
  });

  it('two people with it open: when either confirms, both windows turn to Sent from the record', async () => {
    const mine = live(setup().env);
    const theirs = live(setup().env);
    await review(mine.drawn);
    await review(theirs.drawn);
    expect(windows()).toHaveLength(2);
    expect(inWindow('invoice-modal-status', 1)?.dataset.status).toBe('unsent');
    // The other person confirms: the broadcast brings the record to both screens.
    await press(inWindow('invoice-modal-send', 0));
    const sent = row('sent');
    mine.arrive([sent]);
    theirs.arrive([sent]);
    for (const index of [0, 1]) {
      expect(inWindow('invoice-modal-status', index)?.dataset.status).toBe('sent');
      expect(text(windows()[index]!, 'invoice-modal-sent-by')).toMatch(/^Sent by Chris Hale ·/);
      expect(text(windows()[index]!, 'invoice-modal-number')).toBe('0044');
      expect(inWindow('invoice-modal-done', index)).not.toBeNull();
      expect(inWindow('invoice-modal-send', index)).toBeNull();
    }
    // Done closes only the window it is in.
    await press(inWindow('invoice-modal-done', 1));
    expect(windows()).toHaveLength(1);
  });

  it('follows the record from a window that never pressed anything: refused, paid, or canceled', async () => {
    const mine = live(setup([], { drawnAt: '2026-11-07T17:59:00.000Z' }).env);
    await review(mine.drawn);
    mine.arrive([row('failed', { message: 'PayPal could not send the invoice: try again.' })]);
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('failed');
    expect(text(windows()[0]!, 'invoice-modal-error')).toBe('PayPal could not send the invoice: try again.');
    expect(inWindow('invoice-modal-send')).not.toBeNull();
    mine.arrive([row('paid')]);
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('paid');
    expect(windows()[0]!.textContent).toContain('paid by Larkspur Analytics');
    expect(inWindow('change-invoice-revoke')).toBeNull();
    expect(inWindow('invoice-modal-send')).toBeNull();
    mine.arrive([row('cancelled', { updated_at: '2026-11-08T00:00:00.000Z' })]);
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('cancelled');
    expect(windows()[0]!.textContent).toContain('Invoice canceled');
    expect(inWindow('invoice-modal-done')).not.toBeNull();
  });

  it('keeps a failure in the window and lets it be tried again', async () => {
    const { env, invoke } = setup();
    invoke.mockImplementationOnce(async () => ({ data: { seller: null }, error: null }));
    invoke.mockImplementationOnce(async () => ({ data: null, error: { message: 'x', context: new Response(JSON.stringify({ error: 'PayPal could not send the invoice: try again.', code: 'PAYPAL_REFUSED' }), { status: 502 }) } as unknown as null }));
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={env} />);
    await review(drawn);
    // PayPal uses the account's own name when none is configured: the window says so rather than guessing.
    expect(text(windows()[0]!, 'invoice-modal-from')).toBe('PayPal business account');
    await press(inWindow('invoice-modal-send'));
    expect(text(windows()[0]!, 'invoice-modal-error')).toBe('PayPal could not send the invoice: try again.');
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('unsent');
    expect(inWindow('invoice-modal-send')).not.toBeNull();
    await press(inWindow('invoice-modal-send'));
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('sent');
    expect(inWindow('invoice-modal-error')).toBeNull();
  });

  it('holds Confirm and send and says why when the plan’s costs move while it is open', async () => {
    const now = { 5001: 10_500_000, 5002: 90_000, 5003: 620_000, 5004: 140_000, 5012: 90_000, 5013: 620_000, 5014: 140_000 };
    const { env } = setup([], { costs: now });
    const mine = live(env);
    await review(mine.drawn);
    expect(inWindow<HTMLButtonElement>('invoice-modal-send')?.disabled).toBe(false);
    act(() => root!.render(<ChangeInvoiceCardView card={CARD} env={{ ...env, liveCost: () => 1 }} />));
    expect(inWindow('invoice-modal-stale')?.textContent).toContain('Out of date');
    expect(inWindow<HTMLButtonElement>('invoice-modal-send')?.disabled).toBe(true);
  });

  it('closes on Escape, unless the answer is still on its way', async () => {
    const { env, invoke } = setup();
    let release: () => void = () => {};
    invoke.mockImplementationOnce(async () => ({ data: { seller: null }, error: null }));
    invoke.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ data: { invoice: row('sent') }, error: null });
    }));
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={env} />);
    await review(drawn);
    await act(async () => inWindow('invoice-modal-send')!.click());
    expect(text(windows()[0]!, 'invoice-modal-send')).toBe('Sending…');
    expect(inWindow<HTMLButtonElement>('invoice-modal-cancel')?.disabled).toBe(true);
    act(() => windows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(windows()).toHaveLength(1);
    await act(async () => release());
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('sent');
    act(() => windows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(windows()).toHaveLength(0);
  });
});

describe('canceling a sent invoice', () => {
  it('the card names who sent it, and offers Cancel invoice to someone who sees costs', () => {
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={setup([row('sent')]).env} />);
    expect(text(drawn, 'change-invoice-sent-by')).toMatch(/^Sent by Chris Hale · \d{1,2}:\d{2}\s?[AP]M$/);
    expect(text(drawn, 'change-invoice-revoke')).toBe('Cancel invoice');
    act(() => root?.unmount());
    const viewer = draw(<ChangeInvoiceCardView card={CARD} env={setup([row('sent')], { canSend: false }).env} />);
    expect(viewer.querySelector('[data-testid="change-invoice-revoke"]')).toBeNull();
  });

  it('asks first, in the window: Keep leaves it sent, and Cancel invoice cancels it through PayPal', async () => {
    const { env, invoke } = setup([row('sent')]);
    const drawn = draw(<ChangeInvoiceCardView card={CARD} env={env} />);
    await press(drawn.querySelector<HTMLElement>('[data-testid="change-invoice-revoke"]'));
    // The window opens on its own "Are you sure?"; the card’s button steps aside while it is open.
    expect(windows()).toHaveLength(1);
    expect(windows()[0]!.textContent).toContain('Cancel this invoice?');
    expect(inWindow('invoice-modal-revoke-ask')?.textContent).toContain('Are you sure?');
    expect(drawn.querySelector('[data-testid="change-invoice-revoke"]')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('paypal-invoice', { body: expect.objectContaining({ action: 'cancel' }) });
    await press(inWindow('invoice-modal-revoke-keep'));
    expect(windows()).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith('paypal-invoice', { body: expect.objectContaining({ action: 'cancel' }) });

    await press(drawn.querySelector<HTMLElement>('[data-testid="change-invoice-revoke"]'));
    await press(inWindow('invoice-modal-revoke-confirm'));
    expect(invoke).toHaveBeenCalledWith('paypal-invoice', { body: { invoice_id: row('sent').id, action: 'cancel' } });
    expect(inWindow('invoice-modal-status')?.dataset.status).toBe('cancelled');
    expect(text(windows()[0]!, 'invoice-modal-status')).toBe('Canceled');
    expect(drawn.querySelector<HTMLElement>('[data-testid="change-invoice-status"]')?.dataset.status).toBe('cancelled');
    expect(drawn.querySelector('[data-testid="change-invoice-revoke"]')).toBeNull();
    await press(inWindow('invoice-modal-done'));
    expect(windows()).toHaveLength(0);
  });

  it('the sent window has its own Cancel invoice, and Keep returns to the sent invoice', async () => {
    const mine = live(setup().env);
    await review(mine.drawn);
    await press(inWindow('invoice-modal-send'));
    mine.arrive([row('sent')]);
    expect(text(windows()[0]!, 'change-invoice-revoke')).toBe('Cancel invoice');
    expect(mine.drawn.querySelector('[data-testid="change-invoice-revoke"]')).toBeNull();
    await press(inWindow('change-invoice-revoke'));
    expect(inWindow('invoice-modal-revoke-ask')).not.toBeNull();
    await press(inWindow('invoice-modal-revoke-keep'));
    expect(inWindow('invoice-modal-revoke-ask')).toBeNull();
    expect(inWindow('invoice-modal-done')).not.toBeNull();
  });

  it('stops asking once the invoice has moved on under it', async () => {
    const mine = live(setup([row('sent')]).env);
    await press(mine.drawn.querySelector<HTMLElement>('[data-testid="change-invoice-revoke"]'));
    expect(inWindow('invoice-modal-revoke-ask')).not.toBeNull();
    mine.arrive([row('paid', { updated_at: '2026-11-08T00:00:00.000Z' })]);
    expect(inWindow('invoice-modal-revoke-ask')).toBeNull();
    expect(inWindow('invoice-modal-revoke-confirm')).toBeNull();
    expect(windows()[0]!.textContent).toContain('Invoice paid');
  });

  it('leaves the card it went out from Canceled, and starts a new draft on a card drawn after that', () => {
    const canceled = row('cancelled', { updated_at: '2026-11-07T18:30:00.000Z' });
    const before = draw(<ChangeInvoiceCardView card={CARD} env={setup([canceled], { drawnAt: '2026-11-07T17:59:00.000Z' }).env} />);
    expect(before.querySelector<HTMLElement>('[data-testid="change-invoice-status"]')?.dataset.status).toBe('cancelled');
    expect(text(before, 'change-invoice-status')).toBe('Canceled');
    expect(before.querySelector('[data-testid="change-invoice-canceled"]')).not.toBeNull();
    expect(before.querySelector('[data-testid="change-invoice-review"]')).toBeNull();
    expect(before.querySelector('[data-testid="change-invoice-revoke"]')).toBeNull();
    act(() => root?.unmount());
    const after = draw(<ChangeInvoiceCardView card={CARD} env={setup([canceled], { drawnAt: '2026-11-07T19:00:00.000Z' }).env} />);
    expect(after.querySelector<HTMLElement>('[data-testid="change-invoice-status"]')?.dataset.status).toBe('unsent');
    expect(after.querySelector('[data-testid="change-invoice-review"]')).not.toBeNull();
  });
});

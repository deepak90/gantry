/**
 * "Try these" on the hosted site: eight items in order, short enough for the counter in the header, each listed only
 * when it can be done here (calls on, Remy, payments, the 3D view, costs, paying); each ticked once, kept in this
 * browser in the order done and counted once; ticked by the session's own data (a library piece on level 1, the tenant
 * invoice sent, a payment hold paid with PayPal), by a teammate in the session and by the 3D view coming up. The
 * crane's rental stays off the list until its suppliers have sandbox accounts of their own. The item at hand is the one
 * picked with Show me, then the next one left after it; the counter counts the items as they are done, whichever they
 * were, and its name stays put when another item was done.
 */
import type { ProjectModel } from '@bryntum/gantt';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/hosted', () => ({ HOSTED: true, FILM_URL: '/#film', readHostedConfig: () => ({ turnstileSiteKey: null, livekitUrl: null }) }));
vi.mock('../../src/analytics', () => ({ track: vi.fn() }));

import { track } from '../../src/analytics';
import { FLAGS_OFF, type AppFlags } from '../../src/copy/rpc';
import { StoryRail } from '../../src/onboarding/StoryRail';
import {
  cranePaid,
  currentItem,
  holdPaid,
  holdToPay,
  invoiceSent,
  pieceOnLevelOne,
  railOrder,
  triedBy,
  tryItemsFor,
  TryTheseTracker,
  TRY_GOAL,
  TRY_PITCH,
  type TryContext,
  type TryItemView,
  type TryKey,
  type TryStorage,
} from '../../src/onboarding/try-these';
import { useTryThese, type TryThese as TryTheseState } from '../../src/onboarding/useTryThese';
import type { PresenceSession, PresenceSnapshot } from '../../src/presence/session';
import type { WorkflowSnapshot } from '../../src/workflow/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const ALL_ON: AppFlags = { live_ai: true, live_calls: true, live_payments: true };
const EVERYTHING: TryContext = { flags: ALL_ON, calls: true, assistant: true, site: true, seesCosts: true, pays: true };
const keys = (context: TryContext) => tryItemsFor(context).map((item) => item.key);
const views = (done: readonly TryKey[] = []): TryItemView[] => tryItemsFor(EVERYTHING).map((item) => ({ ...item, done: done.includes(item.key) }));

// ---- fakes ---------------------------------------------------------------------------------------

interface FakeTask {
  id: number;
  name: string;
  libraryRef?: string | null;
  payGate?: unknown;
  children?: FakeTask[];
}

function fakeProject(tops: FakeTask[], resources: Record<number, string> = {}): ProjectModel {
  return {
    taskStore: { rootNode: { children: tops } },
    resourceStore: { getById: (id: number) => (resources[id] ? { name: resources[id] } : undefined) },
  } as unknown as ProjectModel;
}

type HoldState = 'waiting' | 'paying' | 'paid' | 'failed';

/** The payment hold after the footings, as the plan keeps it (the task field `payGate`). */
const footingsPaid = (state: HoldState): FakeTask => ({
  id: 25,
  name: 'Footings paid',
  payGate: { pays: [20], retainage: 0.1, state, batchId: state === 'paid' ? 'B-TEST-1' : null, paidAt: state === 'paid' ? '2026-11-10T18:00:00.000Z' : null, amountMinor: null, error: null },
});

const harbor = (piece: { under: string; deep?: boolean } | null, hold: HoldState | null = null) =>
  fakeProject(
    ['Site and foundations', 'Level 1 build-out', 'Level 2 build-out'].map((name, index) => ({
      id: (index + 1) * 100,
      name,
      children: [
        { id: (index + 1) * 100 + 11, name: `Lay out partitions, ${name}` },
        ...(index === 0 && hold ? [{ id: 20, name: 'Footings', children: [{ id: 21, name: 'Pour footings' }] }, footingsPaid(hold)] : []),
        ...(piece?.under === name
          ? piece.deep
            ? [{ id: 9001, name: 'Group', children: [{ id: 9002, name: 'Light fixtures', libraryRef: 'snippet-1' }] }]
            : [{ id: 9001, name: 'Light fixtures', libraryRef: 'snippet-1' }]
          : []),
      ],
    })),
    { 1: 'Tower crane', 2: 'Scissor lift' },
  );

function snapshotWith({ paid = [] as number[], invoices = [] as string[] } = {}): WorkflowSnapshot {
  const booking = (id: string, resource: number) => ({
    id,
    project_id: 'p',
    task_id: 1,
    resource_id: resource,
    supplier_name: 'Northgate Equipment Rental',
    supplier_payout_email: 'rentals@example.com',
    rental_rate_minor: 60_000,
    currency: 'USD',
    billable_start: '2026-11-02',
    billable_end: '2026-11-20',
    quoted_start: null,
    quoted_end: null,
    idle_days: 0,
    evidence_path: null,
  });
  const bookings = [booking('crane', 1), booking('lift', 2)];
  return {
    bookings,
    proposals: bookings.map((entry) => ({ id: `proposal-${entry.id}`, booking_id: entry.id })),
    versions: bookings.map((entry) => ({ id: `version-${entry.id}`, proposal_id: `proposal-${entry.id}` })),
    payments: paid.map((resource) => {
      const which = resource === 1 ? 'crane' : 'lift';
      return { id: `payment-${which}`, proposal_version_id: `version-${which}`, status: 'succeeded' };
    }),
    invoices: invoices.map((status, index) => ({ id: `invoice-${index}`, status })),
  } as unknown as WorkflowSnapshot;
}

function memoryStorage(): TryStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

// ---- the list ------------------------------------------------------------------------------------

describe('tryItemsFor', () => {
  it('lists the eight things to try, in order, when everything is on', () => {
    expect(keys(EVERYTHING)).toEqual(['call', 'invite', 'drop', 'site', 'ask', 'odds', 'invoice', 'pay']);
    expect(tryItemsFor(EVERYTHING).map((item) => item.label)).toEqual([
      'Call Remy',
      'Invite a teammate',
      'Drag a package onto level 1',
      'Open the 3D site view',
      'Ask Remy about paying on Friday',
      'Check the on-time odds',
      'Send the tenant invoice',
      'Pay the footings with PayPal',
    ]);
  });

  it('pays the footings through their payment hold, a second person approving, and points at Review payment first', () => {
    const pay = tryItemsFor(EVERYTHING).find((item) => item.key === 'pay')!;
    expect(pay.hint).toBe('Open the payment hold after the footings and press Review payment. Over $25,000 needs a second person: open a teammate in a new tab to approve, then Send payout.');
    expect(pay.targets[0]).toBe('[data-testid="pay-gate-pay"]');
    expect(pay.targets.slice(1).join(' ')).toContain('look-gate-label');
    expect(pay.panel).toBe('task');
  });

  it('keeps the crane’s rental off the list until its suppliers have sandbox accounts of their own', () => {
    expect(keys(EVERYTHING)).not.toContain('rental');
    expect(keys({ ...EVERYTHING, flags: { ...ALL_ON, live_ai: false } })).not.toContain('rental');
  });

  it('keeps each name short enough for the counter in the header', () => {
    for (const item of tryItemsFor(EVERYTHING)) expect(item.label.length).toBeLessThanOrEqual(32);
  });

  it('says how to invite a teammate and how to talk to Remy with others on the call', () => {
    const hint = (key: TryKey) => tryItemsFor(EVERYTHING).find((item) => item.key === key)?.hint;
    expect(hint('invite')).toBe('Press Invite, then share the session code, or open a teammate in a new tab.');
    expect(hint('call')).toBe('Press Call Remy and talk. With others on the call, start with “Remy, …” so she knows it’s for her.');
    expect(hint('odds')).toContain('Press On-time odds above the chart.');
    expect(tryItemsFor(EVERYTHING).find((item) => item.key === 'invite')?.targets).toEqual(['[data-testid="invite-open"]']);
  });

  it('reads like the real thing, in the session’s words', () => {
    const words = [TRY_PITCH, TRY_GOAL, ...tryItemsFor(EVERYTHING).flatMap((item) => [item.label, item.hint, item.ask ?? ''])].join(' ');
    expect(words).not.toMatch(/\b(demo|sandbox|tour|copy)\b/i);
  });

  it('leaves out what is switched off on the site', () => {
    expect(keys({ ...EVERYTHING, flags: FLAGS_OFF, calls: false })).toEqual(['invite', 'drop', 'site', 'odds']);
    expect(keys({ ...EVERYTHING, calls: false })).not.toContain('call');
    expect(keys({ ...EVERYTHING, flags: { ...ALL_ON, live_ai: false } })).toEqual(['call', 'invite', 'drop', 'site', 'odds', 'pay']);
    expect(keys({ ...EVERYTHING, flags: { ...ALL_ON, live_payments: false } })).toEqual(['call', 'invite', 'drop', 'site', 'ask', 'odds']);
  });

  it('leaves out what this person can’t do here', () => {
    expect(keys({ ...EVERYTHING, pays: false })).not.toContain('pay');
    expect(keys({ ...EVERYTHING, seesCosts: false })).not.toContain('invoice');
    expect(keys({ ...EVERYTHING, site: false })).not.toContain('site');
    expect(keys({ ...EVERYTHING, assistant: false })).toEqual(['call', 'invite', 'drop', 'site', 'odds', 'pay']);
  });

  it('points every item at controls the app has', () => {
    for (const item of tryItemsFor(EVERYTHING)) expect(item.targets.length).toBeGreaterThan(0);
    expect(tryItemsFor(EVERYTHING).find((item) => item.key === 'ask')?.ask).toBe('What happens if we wait until Friday to pay?');
  });

  it('knows which of Remy’s commands stand for an item', () => {
    expect(triedBy('late_payment_effect')).toBe('ask');
    expect(triedBy('schedule_odds')).toBe('odds');
    expect(triedBy('propose_fix')).toBeNull();
  });
});

// ---- the item at hand, and the counter's order ----------------------------------------------------

describe('the item at hand', () => {
  it('is the first one left, with none picked', () => {
    expect(currentItem(views(), null)?.key).toBe('call');
    expect(currentItem(views(['call', 'invite']), null)?.key).toBe('drop');
  });

  it('is the one picked with Show me, then the next one left after it, going round', () => {
    expect(currentItem(views(), 'odds')?.key).toBe('odds');
    expect(currentItem(views(['odds']), 'odds')?.key).toBe('invoice');
    expect(currentItem(views(['odds', 'invoice']), 'odds')?.key).toBe('pay');
    expect(currentItem(views(['odds', 'invoice', 'pay']), 'odds')?.key).toBe('call');
  });

  it('is none once every item is done', () => {
    expect(currentItem(views(['call', 'invite', 'drop', 'site', 'ask', 'odds', 'invoice', 'pay']), 'odds')).toBeNull();
  });
});

describe('the counter’s order', () => {
  const order = (done: TryKey[], current: TryKey | null) => railOrder(views(done), done, current).map((item) => item.key);

  it('puts what is done first, as it was done, then the item at hand, then the rest going on from it', () => {
    expect(order([], 'call')).toEqual(['call', 'invite', 'drop', 'site', 'ask', 'odds', 'invoice', 'pay']);
    expect(order(['site', 'odds'], 'call')).toEqual(['site', 'odds', 'call', 'invite', 'drop', 'ask', 'invoice', 'pay']);
    expect(order(['site'], 'ask')).toEqual(['site', 'ask', 'odds', 'invoice', 'pay', 'call', 'invite', 'drop']);
  });

  it('puts the footings’ payment last, right after the invoice, and among what is done once it is paid', () => {
    expect(order([], 'call').at(-1)).toBe('pay');
    expect(order([], 'invoice')).toEqual(['invoice', 'pay', 'call', 'invite', 'drop', 'site', 'ask', 'odds']);
    expect(order(['pay'], 'call')).toEqual(['pay', 'call', 'invite', 'drop', 'site', 'ask', 'odds', 'invoice']);
    expect(order(['site', 'pay'], 'call').slice(0, 3)).toEqual(['site', 'pay', 'call']);
  });

  it('stands on the item at hand: the number done is its place', () => {
    const items = views(['site', 'odds']);
    const rail = railOrder(items, ['site', 'odds'], currentItem(items, null)!.key);
    expect(rail.findIndex((item) => !item.done)).toBe(2);
    expect(rail[2]?.key).toBe('call');
  });

  it('keeps an item done without a record of when at the end of what is done', () => {
    expect(railOrder(views(['drop', 'site']), ['site'], 'call').map((item) => item.key).slice(0, 3)).toEqual(['site', 'drop', 'call']);
  });
});

// ---- the session's own data ----------------------------------------------------------------------

describe('what the session shows done', () => {
  it('finds a library piece on level 1, at any depth, and only there', () => {
    expect(pieceOnLevelOne(harbor(null))).toBe(false);
    expect(pieceOnLevelOne(harbor({ under: 'Level 1 build-out' }))).toBe(true);
    expect(pieceOnLevelOne(harbor({ under: 'Level 1 build-out', deep: true }))).toBe(true);
    expect(pieceOnLevelOne(harbor({ under: 'Level 2 build-out' }))).toBe(false);
  });

  it('only reads the plan: level 1 keeps every task after the check, however often it runs', () => {
    for (const piece of [null, { under: 'Level 1 build-out' }, { under: 'Level 1 build-out', deep: true }] as const) {
      const project = harbor(piece);
      const tops = (project.taskStore as unknown as { rootNode: { children: FakeTask[] } }).rootNode.children;
      const level = tops.find((task) => task.name === 'Level 1 build-out')!;
      const before = JSON.stringify(level);
      pieceOnLevelOne(project);
      pieceOnLevelOne(project);
      expect(JSON.stringify(level)).toBe(before);
    }
  });

  it('counts the crane’s rental paid, not the lift’s', () => {
    const project = harbor(null);
    expect(cranePaid(project, null)).toBe(false);
    expect(cranePaid(project, snapshotWith())).toBe(false);
    expect(cranePaid(project, snapshotWith({ paid: [2] }))).toBe(false);
    expect(cranePaid(project, snapshotWith({ paid: [1] }))).toBe(true);
  });

  it('counts the tenant billed once an invoice has gone out', () => {
    expect(invoiceSent(snapshotWith({ invoices: ['draft'] }))).toBe(false);
    expect(invoiceSent(snapshotWith({ invoices: ['draft', 'sent'] }))).toBe(true);
    expect(invoiceSent(snapshotWith({ invoices: ['paid'] }))).toBe(true);
  });

  it('counts the footings paid once their payment hold shows Paid, and not before', () => {
    expect(holdPaid(harbor(null))).toBe(false);
    for (const state of ['waiting', 'paying', 'failed'] as const) expect(holdPaid(harbor(null, state))).toBe(false);
    expect(holdPaid(harbor(null, 'paid'))).toBe(true);
  });

  it('knows which payment hold Show me opens: the first one not paid yet', () => {
    expect(holdToPay(harbor(null, 'waiting'))).toBe(25);
    expect(holdToPay(harbor(null, 'failed'))).toBe(25);
    expect(holdToPay(harbor(null, 'paid'))).toBeNull();
    expect(holdToPay(harbor(null))).toBeNull();
  });

  it('only reads the plan: the walk for payment holds leaves every list as it was', () => {
    const project = harbor({ under: 'Level 1 build-out', deep: true }, 'waiting');
    const before = JSON.stringify((project.taskStore as unknown as { rootNode: { children: FakeTask[] } }).rootNode.children);
    holdPaid(project);
    holdToPay(project);
    expect(JSON.stringify((project.taskStore as unknown as { rootNode: { children: FakeTask[] } }).rootNode.children)).toBe(before);
  });
});

// ---- ticking -------------------------------------------------------------------------------------

describe('TryTheseTracker', () => {
  it('ticks each item once, tells once, and keeps it in this browser', () => {
    const storage = memoryStorage();
    const done = vi.fn();
    const tracker = new TryTheseTracker({ storageKey: 'gantry.try:p:tok:u', storage, onDone: done });
    const seen = vi.fn();
    tracker.subscribe(seen);
    tracker.mark('odds');
    tracker.mark('odds');
    expect(done.mock.calls).toEqual([['odds']]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data.get('gantry.try:p:tok:u')!)).toEqual(['odds']);

    // A reload brings the ticks back without telling them again.
    const again = vi.fn();
    const reloaded = new TryTheseTracker({ storageKey: 'gantry.try:p:tok:u', storage, onDone: again });
    expect(reloaded.has('odds')).toBe(true);
    reloaded.mark('odds');
    expect(again).not.toHaveBeenCalled();
  });

  it('keeps the order the items were done in, through a reload', () => {
    const storage = memoryStorage();
    const tracker = new TryTheseTracker({ storageKey: 'k', storage });
    tracker.mark('site');
    tracker.mark('call');
    tracker.mark('odds');
    expect([...new TryTheseTracker({ storageKey: 'k', storage }).getSnapshot()]).toEqual(['site', 'call', 'odds']);
  });

  it('ticks what the session shows done', () => {
    const tracker = new TryTheseTracker({ storageKey: null, storage: null });
    tracker.sync({ drop: true, invoice: false, pay: true, rental: false });
    expect([...tracker.getSnapshot()]).toEqual(['drop', 'pay']);
  });

  it('keeps nothing from storage that isn’t an item, and each item once', () => {
    const storage = memoryStorage();
    storage.setItem('k', JSON.stringify(['call', 'nonsense', 3, 'call', 'follow']));
    expect([...new TryTheseTracker({ storageKey: 'k', storage }).getSnapshot()]).toEqual(['call']);
    storage.setItem('k', '{broken');
    expect([...new TryTheseTracker({ storageKey: 'k', storage }).getSnapshot()]).toEqual([]);
  });
});

// ---- on the page ---------------------------------------------------------------------------------

function fakePresence() {
  let snapshot = { peers: [], following: null, followers: [] } as unknown as PresenceSnapshot;
  const listeners = new Set<() => void>();
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as PresenceSession;
  return {
    session,
    set(patch: Partial<PresenceSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of [...listeners]) listener();
    },
  };
}

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.fx3d;
  window.localStorage.clear();
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe('useTryThese', () => {
  beforeEach(() => vi.mocked(track).mockClear());

  function mountHook(props: { project: ProjectModel; snapshot: WorkflowSnapshot | null; presence: PresenceSession | null }) {
    const state: { current: TryTheseState | null } = { current: null };
    function Probe(next: typeof props) {
      state.current = useTryThese({ enabled: true, storageKey: 'gantry.try:p:tok:u', dataVersion: 0, context: EVERYTHING, ...next });
      return null;
    }
    mount(<Probe {...props} />);
    return {
      state,
      rerender: (next: typeof props) => act(() => root!.render(<Probe {...next} />)),
      done: () => state.current!.items.filter((item) => item.done).map((item) => item.key),
      rail: () => state.current!.rail.map((item) => item.key),
    };
  }

  it('ticks a teammate in the session, the 3D view coming up and the session’s own data, and counts each', async () => {
    const presence = fakePresence();
    const page = mountHook({ project: harbor(null), snapshot: snapshotWith(), presence: presence.session });
    expect(page.done()).toEqual([]);
    expect(page.state.current!.current?.key).toBe('call');

    act(() => presence.set({ peers: [{ session: 's2', user: 'chris' }] as unknown as PresenceSnapshot['peers'] }));
    expect(page.done()).toEqual(['invite']);

    document.documentElement.dataset.fx3d = 'building';
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(page.done()).toEqual(['invite', 'site']);

    // The footings' payment hold still waiting: nothing to tick for it yet.
    page.rerender({ project: harbor(null, 'waiting'), snapshot: snapshotWith(), presence: presence.session });
    expect(page.done()).toEqual(['invite', 'site']);

    page.rerender({ project: harbor({ under: 'Level 1 build-out' }, 'paid'), snapshot: snapshotWith({ invoices: ['sent'] }), presence: presence.session });
    expect(page.done()).toEqual(['invite', 'drop', 'site', 'invoice', 'pay']);

    act(() => page.state.current!.mark('call'));
    act(() => page.state.current!.mark('call'));
    expect(page.state.current!.current?.key).toBe('ask');
    expect(page.rail()).toEqual(['invite', 'site', 'drop', 'invoice', 'pay', 'call', 'ask', 'odds']);
    expect(vi.mocked(track).mock.calls).toEqual([
      ['try_item_done', { item: 'invite' }],
      ['try_item_done', { item: 'site' }],
      ['try_item_done', { item: 'drop' }],
      ['try_item_done', { item: 'invoice' }],
      ['try_item_done', { item: 'pay' }],
      ['try_item_done', { item: 'call' }],
    ]);
  });

  it('ticks following someone, or being followed, too', () => {
    for (const patch of [{ following: { user: 'deepak' } }, { followers: [{ user: 'chris' }] }]) {
      const presence = fakePresence();
      const page = mountHook({ project: harbor(null), snapshot: null, presence: presence.session });
      act(() => presence.set(patch as unknown as Partial<PresenceSnapshot>));
      expect(page.done()).toEqual(['invite']);
      act(() => root!.unmount());
      window.localStorage.clear();
    }
    root = null;
  });

  it('makes the item picked with Show me the one at hand, and goes on from it once it is done', () => {
    const page = mountHook({ project: harbor(null), snapshot: null, presence: null });
    act(() => page.state.current!.pick('odds'));
    expect(page.state.current!.current?.key).toBe('odds');
    expect(page.rail().slice(0, 2)).toEqual(['odds', 'invoice']);
    act(() => page.state.current!.mark('odds'));
    expect(page.state.current!.current?.key).toBe('invoice');
    expect(page.rail().slice(0, 2)).toEqual(['odds', 'invoice']);
  });
});

// ---- the counter in the header -----------------------------------------------------------------

describe('the counter in the header, with the things to try', () => {
  const story = (rail: readonly TryItemView[]) => ({ pitch: TRY_PITCH, goal: TRY_GOAL, steps: rail });
  const railFor = (done: TryKey[], picked: TryKey | null = null) => {
    const items = views(done);
    return railOrder(items, done, currentItem(items, picked)?.key ?? null);
  };
  const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-testid="story-rail-button"]')!;

  it('shows where you are and the item at hand, and opens on its hint with Show me', () => {
    const onShow = vi.fn();
    const host = mount(<StoryRail<TryItemView> story={story(railFor([]))} anyOrder onShow={onShow} onHide={() => undefined} />);
    expect(button(host).getAttribute('aria-label')).toBe('Step 1 of 8: Call Remy');
    expect(host.querySelector('.story-rail-of')?.textContent).toBe('/8');

    act(() => button(host).click());
    expect(host.querySelector('.story-rail-pitch')?.textContent).toBe(TRY_PITCH);
    expect(host.querySelector('[data-testid="story-hint"]')?.textContent).toContain('With others on the call, start with “Remy, …”');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="story-show"]')!.click());
    expect(onShow.mock.calls[0]![0]).toMatchObject({ key: 'call' });
    // The sheet closes (it fades out on its way).
    expect(button(host).getAttribute('aria-expanded')).toBe('false');
  });

  it('offers Show me on any item left, wherever the drum is turned, and none on one done', () => {
    const onShow = vi.fn();
    const host = mount(<StoryRail<TryItemView> story={story(railFor(['site']))} anyOrder onShow={onShow} onHide={() => undefined} />);
    act(() => button(host).click());
    const drum = host.querySelector<HTMLElement>('.story-drum')!;
    // Up one row: the 3D view, done.
    act(() => void drum.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, cancelable: true })));
    expect(host.querySelector('[data-testid="story-hint"]')?.textContent).toContain('Press Site view');
    expect(host.querySelector('[data-testid="story-show"]')).toBeNull();
    // Down four rows from there: the question about paying on Friday.
    act(() => void drum.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, cancelable: true })));
    expect(host.querySelector('[data-testid="story-hint"]')?.textContent).toContain('waiting until Friday');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="story-show"]')!.click());
    expect(onShow.mock.calls[0]![0]).toMatchObject({ key: 'ask' });
  });

  it('only shows the step at hand when the steps go in order', () => {
    const host = mount(<StoryRail<TryItemView> story={story(railFor([]))} onShow={() => undefined} onHide={() => undefined} />);
    act(() => button(host).click());
    act(() => void host.querySelector<HTMLElement>('.story-drum')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, cancelable: true })));
    expect(host.querySelector('[data-testid="story-show"]')).toBeNull();
  });

  it('turns a notch for each item done, whichever it was, and keeps the name of the item at hand', () => {
    const props = { anyOrder: true, onShow: () => undefined, onHide: () => undefined };
    const host = mount(<StoryRail<TryItemView> story={story(railFor([]))} {...props} />);
    // The 3D view, out of order: one done, still on calling Remy.
    act(() => root!.render(<StoryRail<TryItemView> story={story(railFor(['site']))} {...props} />));
    expect(button(host).getAttribute('aria-label')).toBe('Step 2 of 8: Call Remy');
    expect(host.querySelector('.story-rail-label .story-rail-sizer')?.textContent).toBe('Call Remy');
    // Then the call itself: on to inviting a teammate.
    act(() => root!.render(<StoryRail<TryItemView> story={story(railFor(['site', 'call']))} {...props} />));
    expect(button(host).getAttribute('aria-label')).toBe('Step 3 of 8: Invite a teammate');
    // Every one: a check, and what done looks like.
    const all: TryKey[] = ['site', 'call', 'invite', 'drop', 'ask', 'odds', 'invoice', 'pay'];
    act(() => root!.render(<StoryRail<TryItemView> story={story(railFor(all))} {...props} />));
    expect(button(host).getAttribute('aria-label')).toBe(TRY_GOAL);
    expect(host.querySelector('.story-rail-count')?.classList.contains('is-complete')).toBe(true);
  });

  it('carries a cue beside the counter, such as Start here', () => {
    const host = mount(<StoryRail<TryItemView> story={story(railFor([]))} anyOrder onShow={() => undefined} onHide={() => undefined} cue={<span data-testid="cue">Start here</span>} />);
    expect(host.querySelector('[data-testid="story-rail"] [data-testid="cue"]')?.textContent).toBe('Start here');
  });
});

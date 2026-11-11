/**
 * Remy's screen actions in the tab of the person who asked: each is checked against the shared schema, then carried
 * out through the chart's own API (here a stand-in for the Gantt, which jsdom can't draw), the side panel and the
 * openers of a payment and an invoice. Her cursor is a picture that goes where it presses and takes no clicks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Gantt, TaskModel } from '@bryntum/gantt';
import type { UiPanel } from '@collab/shared';
import { RemyCursor, curvePoint, moveSeconds } from '../../src/assistant/remy-cursor';
import { createRemyUi, remyUiExecutor, type RemyScreen } from '../../src/assistant/remy-ui';
import type { GanttScreen } from '../../src/gantt/GanttWorkspace';
import type { SiteControl, Theater } from '../../src/gantt/fx3d';
import { libraryHands, type LibraryHands } from '../../src/inspector/LibraryPanel';
import { readScreen } from '../../src/assistant/screen-context';

interface FakeTask {
  id: number;
  name: string;
  isLeaf: boolean;
  wbsCode: string;
  readOnly: boolean;
  children?: FakeTask[];
}

const task = (id: number, name: string, extra: Partial<FakeTask> = {}): FakeTask => ({ id, name, isLeaf: true, wbsCode: `2.${id}`, readOnly: false, ...extra });

/** A chart of these tasks, some of them kept off it by a filter, with the calls Remy makes kept. */
function setup(tasks: FakeTask[], options: { hidden?: number[]; visible?: number; panels?: UiPanel[]; site?: Partial<Theater>; odds?: boolean; panel?: string | null } = {}) {
  const hidden = new Set(options.hidden ?? []);
  const shown = () => tasks.filter((each) => !hidden.has(each.id));
  const store = {
    getById: (id: number) => tasks.find((each) => each.id === id),
    find: () => undefined,
    indexOf: (record: FakeTask) => shown().indexOf(record),
    getAt: (index: number) => shown()[index],
    get count() {
      return shown().length;
    },
  };
  const columns: Record<string, { hidden: boolean }> = { task: { hidden: false }, duration: { hidden: false }, 'schedule-when': { hidden: false }, start: { hidden: true }, notes: { hidden: true } };
  const gantt = {
    isDestroyed: false,
    readOnly: false,
    project: { taskStore: { getById: store.getById } },
    store,
    columns: { getById: (id: string) => columns[id] },
    expandTo: vi.fn(async () => undefined),
    scrollTaskIntoView: vi.fn(async () => undefined),
    scrollColumnIntoView: vi.fn(async () => undefined),
    getCell: vi.fn(() => null),
    getElementFromTaskRecord: vi.fn(() => null),
    selectCell: vi.fn(),
    highlightTasks: vi.fn(),
    unhighlightTasks: vi.fn(),
    // A day's place on the time axis, on the page (off screen: -1).
    getCoordinateFromDate: vi.fn(() => 640),
  };
  let open = false;
  // The building's days and levels, as the 3D view's controls work them: Nov 1, 2026 to Mar 31, 2027.
  const days = { first: new Date(2026, 10, 1, 12).getTime(), last: new Date(2027, 2, 31, 12).getTime() };
  const siteState = { day: '2026-11-10', playing: false, riding: false, level: null as string | null };
  const control: SiteControl = {
    state: () => ({ ...siteState }),
    levels: () => [
      { name: 'Foundations', short: 'F' },
      { name: 'Ground floor', short: 'G' },
      { name: 'Level 2', short: 'L2' },
    ],
    span: () => [days.first, days.last],
    play: vi.fn((from: number | null, to: number | null) => {
      if (to !== null && from !== null && to <= from) return false;
      siteState.playing = true;
      return true;
    }),
    pause: vi.fn(() => {
      siteState.playing = false;
    }),
    goTo: vi.fn(() => true),
    level: vi.fn((name: string | null) => {
      siteState.level = name;
      return true;
    }),
  };
  const site: Theater = {
    planChanged: () => undefined,
    show: vi.fn(),
    destroy: () => undefined,
    openSite: vi.fn(async () => {
      open = true;
      return true;
    }),
    closeSite: vi.fn(() => {
      open = false;
    }),
    siteOpen: () => open,
    siteSettled: () => open,
    crane: vi.fn(() => true),
    siteControl: () => (open ? control : null),
    ...options.site,
  };
  let odds = options.odds ?? false;
  let panel: string | null = options.panel ?? null;
  const chart: GanttScreen = {
    instance: () => gantt as unknown as Gantt,
    site: () => site,
    setView: vi.fn(async (change) => {
      if (change.filter === null && change.search === '') hidden.clear();
    }),
    counts: () => ({ visible: options.visible ?? shown().length, total: tasks.length, filtered: (options.visible ?? shown().length) < tasks.length }),
    zoom: vi.fn(async () => undefined),
    zoomToDates: vi.fn(),
    expand: vi.fn(async () => undefined),
    history: vi.fn(async () => ({ done: true as const, label: 'Rename task' })),
    editCell: vi.fn(async () => true),
    select: vi.fn(),
    addColumn: vi.fn((id: string) => {
      columns[id] = { hidden: false };
      return true;
    }),
    view: () => ({ search: '', quickFilter: 'all' as const, filter: null, from: new Date(2026, 10, 16), to: new Date(2026, 11, 4), zoom: 'weeks', odds }),
    setOdds: vi.fn((next: boolean) => {
      odds = next;
    }),
    scrollToDate: vi.fn(async () => undefined),
  };
  const screen: RemyScreen = {
    chart: () => chart,
    panels: () => options.panels ?? ['task', 'assistant', 'library'],
    openPanel: vi.fn((next: UiPanel) => {
      panel = next;
    }),
    editTask: vi.fn(),
    openPayment: vi.fn(),
    openInvoice: vi.fn(() => true),
    panel: () => panel,
    closePanel: vi.fn(() => {
      panel = null;
    }),
    closePayment: vi.fn(),
    closeInvoice: vi.fn(() => true),
  };
  const cursor = new RemyCursor({ speed: 0, lingerMs: 0 });
  const run = remyUiExecutor(createRemyUi(() => screen, cursor));
  const act = (args: unknown) => run('ui_action', args) as Promise<{ ok: boolean; result: { ui?: { did: string; matches?: number | null; at?: number | null }; message?: string } }>;
  return { gantt, chart, site, control, siteState, screen, cursor, act, hidden };
}

/** An element jsdom can call on screen. */
function drawn<E extends HTMLElement>(element: E): E {
  element.getBoundingClientRect = () => ({ left: 20, top: 20, width: 120, height: 24, right: 140, bottom: 44, x: 20, y: 20, toJSON: () => ({}) });
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('a screen action', () => {
  it('is refused when it isn’t one this screen knows', async () => {
    const { act } = setup([]);
    expect(await act({ action: 'pay_now' })).toMatchObject({ ok: false });
    expect(await act({ action: 'zoom', how: 'sideways' })).toMatchObject({ ok: false });
  });

  it('opens and closes the site view, and shows the crane once it stands still', async () => {
    const { act, site } = setup([]);
    expect((await act({ action: 'site_view', open: true })).result.ui?.did).toMatch(/^Opened the site view/);
    expect(site.openSite).toHaveBeenCalledTimes(1);
    expect((await act({ action: 'site_view', open: true, look: 'crane' })).result.ui?.did).toMatch(/tower crane/);
    expect(site.openSite).toHaveBeenCalledTimes(1);
    expect(site.crane).toHaveBeenCalledWith('days');
    expect((await act({ action: 'site_view', open: false })).result.ui?.did).toBe('Closed the site view: back on the chart.');
    expect(site.closeSite).toHaveBeenCalled();
  });

  it('says so when there is no crane to show', async () => {
    const { act } = setup([], { site: { crane: () => false } });
    expect(await act({ action: 'site_view', open: true, look: 'from_crane' })).toMatchObject({ ok: false, result: { message: 'No tower crane is up in this plan to ride.' } });
  });

  it('goes to a row as it is shown, its bar brought into view too, and selects it', async () => {
    const tasks = [task(1, 'Layout'), task(2, 'Frame walls'), task(3, 'Paint')];
    const { act, gantt, chart } = setup(tasks);
    const shown = await act({ action: 'go_to_task', target: { row: 2 } });
    expect(shown.result.ui).toMatchObject({ did: 'Showing “Frame walls” (2.2), row 2.', task: { id: 2, name: 'Frame walls', wbs: '2.2' } });
    expect(gantt.scrollTaskIntoView).toHaveBeenCalledWith(tasks[1], expect.objectContaining({ block: 'center' }));
    expect(chart.select).toHaveBeenCalledWith(tasks[1]);
    expect(await act({ action: 'go_to_task', target: { row: 9 } })).toMatchObject({ ok: false, result: { message: 'The chart shows 3 rows now; there is no row 9.' } });
  });

  it('clears a filter that hides the task, and says so', async () => {
    const tasks = [task(1, 'Layout'), task(2, 'Frame walls')];
    const { act, chart } = setup(tasks, { hidden: [2] });
    const shown = await act({ action: 'go_to_task', target: { task_id: 2 } });
    expect(chart.setView).toHaveBeenCalledWith({ search: '', quickFilter: 'all', filter: null });
    expect(shown.result.ui?.did).toBe('Showing “Frame walls” (2.2), on row 2. The filter was hiding it, so it’s off now.');
  });

  it('opens the task editor the way a double-click does', async () => {
    const { act, screen } = setup([task(4, 'Pour slab')]);
    expect((await act({ action: 'open_editor', target: { task_id: 4 } })).result.ui?.did).toBe('Opened “Pour slab” in the task editor.');
    expect(screen.editTask).toHaveBeenCalledWith(4);
  });

  it('finds a cell by its column in plain words, and opens its editor when asked', async () => {
    const { act, gantt, chart } = setup([task(4, 'Pour slab')]);
    expect((await act({ action: 'focus_cell', target: { task_id: 4 }, column: 'days', edit: false })).result.ui?.did).toBe('Showing the Days of “Pour slab”.');
    expect(gantt.selectCell).toHaveBeenCalledWith(expect.objectContaining({ column: 'duration' }));
    // Start isn't on this chart by itself: its date is edited where Schedule shows it.
    expect((await act({ action: 'focus_cell', target: { task_id: 4 }, column: 'start date', edit: true })).result.ui?.did).toBe('Opened the Schedule of “Pour slab” for editing.');
    expect(chart.editCell).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }), 'schedule-when');
    expect(await act({ action: 'focus_cell', target: { task_id: 4 }, column: 'weather', edit: false })).toMatchObject({ ok: false, result: { message: 'The chart has no column like “weather”.' } });
  });

  it('adds a column the chart doesn’t show, as the column picker does, and says so', async () => {
    const { act, chart } = setup([task(4, 'Pour slab')]);
    expect((await act({ action: 'focus_cell', target: { task_id: 4 }, column: 'notes', edit: true })).result.ui?.did).toBe('Opened the Notes of “Pour slab” for editing. The Notes column is on the chart now.');
    expect(chart.addColumn).toHaveBeenCalledWith('notes');
  });

  it('filters to a crew, named on the chip, and puts the plan back when nothing fits', async () => {
    const some = setup([task(1, 'Rough-in'), task(2, 'Paint')], { visible: 1 });
    const kept = await some.act({ action: 'filter', clear: false, crew_ids: [7], crew_label: 'Volt Electric' });
    expect(some.chart.setView).toHaveBeenCalledWith({ search: '', quickFilter: 'all', filter: { crewIds: [7], from: null, to: null, label: 'Volt Electric' } });
    expect(kept.result.ui).toMatchObject({ did: 'Showing 1 of 2 tasks: Volt Electric’s work. It can be cleared above the chart.', matches: 1 });
    // The groups that hold what is kept are opened.
    expect(some.chart.expand).toHaveBeenCalledWith(true);

    const none = setup([task(1, 'Rough-in')], { visible: 0 });
    const empty = await none.act({ action: 'filter', clear: false, text: 'zzz' });
    expect(empty.result.ui).toMatchObject({ matches: 0 });
    expect(none.chart.setView).toHaveBeenLastCalledWith({ search: '', quickFilter: 'all', filter: null });
  });

  it('highlights every match of a search and steps through them, round again at the end', async () => {
    const tasks = [task(1, 'Drywall, level 1'), task(2, 'Drywall, level 2'), task(3, 'Paint')];
    const { act, gantt } = setup(tasks);
    const first = await act({ action: 'search', text: 'drywall', task_ids: [1, 2], step: 'first' });
    expect(first.result.ui).toMatchObject({ matches: 2, at: 1, task: { id: 1 } });
    expect(gantt.highlightTasks).toHaveBeenCalledWith(expect.objectContaining({ tasks: [tasks[0], tasks[1]], unhighlightOthers: true }));
    expect((await act({ action: 'search', step: 'next' })).result.ui).toMatchObject({ did: '2 of 2 for “drywall”: “Drywall, level 2”.', at: 2 });
    expect((await act({ action: 'search', step: 'next' })).result.ui).toMatchObject({ at: 1 });
    expect((await act({ action: 'search', step: 'previous' })).result.ui).toMatchObject({ at: 2 });
    await act({ action: 'search', clear: true });
    expect(gantt.unhighlightTasks).toHaveBeenCalled();
    expect(await act({ action: 'search', step: 'next' })).toMatchObject({ ok: false, result: { message: 'There’s no search to step through yet.' } });
  });

  it('zooms with the toolbar’s steps, and to a span of days', async () => {
    const { act, chart } = setup([]);
    expect((await act({ action: 'zoom', how: 'fit' })).result.ui?.did).toBe('The whole project fits on screen.');
    expect(chart.zoom).toHaveBeenCalledWith('fit');
    expect((await act({ action: 'zoom', how: 'dates', first_day: '2027-06-01', last_day: '2027-06-30' })).result.ui?.did).toBe('The timeline now runs Tue, Jun 1 to Wed, Jun 30.');
    expect(chart.zoomToDates).toHaveBeenCalledWith(new Date(2027, 5, 1), new Date(2027, 5, 30));
  });

  it('opens or closes one group, or all of them', async () => {
    const group = task(10, 'Level 2 build-out', { isLeaf: false, children: [task(11, 'Paint, level 2')] });
    const { act, chart } = setup([group]);
    expect((await act({ action: 'expand', open: false })).result.ui?.did).toBe('Closed every group: the plan’s main parts are on screen.');
    expect(chart.expand).toHaveBeenCalledWith(false);
    expect((await act({ action: 'expand', open: true, task_id: 10 })).result.ui?.did).toBe('Opened “Level 2 build-out”: 1 item inside.');
  });

  it('brings a side panel forward, only one this person has', async () => {
    const { act, screen } = setup([], { panels: ['library'] });
    expect((await act({ action: 'open_panel', panel: 'library' })).result.ui?.did).toBe('Opened the task library.');
    expect(screen.openPanel).toHaveBeenCalledWith('library');
    expect(await act({ action: 'open_panel', panel: 'rentals' })).toMatchObject({ ok: false, result: { message: 'There is no rentals panel here.' } });
  });

  it('undoes this person’s own steps with the toolbar’s button, naming each, and says why when there is none', async () => {
    const { act, chart } = setup([]);
    expect((await act({ action: 'history', direction: 'undo', steps: 2 })).result.ui?.did).toBe('Undid Rename task; then Rename task.');
    expect(chart.history).toHaveBeenCalledTimes(2);
    vi.mocked(chart.history).mockResolvedValue({ done: false, why: 'There is nothing to redo.' });
    expect(await act({ action: 'history', direction: 'redo', steps: 1 })).toMatchObject({ ok: false, result: { message: 'There is nothing to redo.' } });
  });

  it('brings a payment up for review, never more, and only when there is one to review', async () => {
    const gate = task(30, 'Footings paid');
    const { act, screen } = setup([gate]);
    const card = drawn(document.createElement('section'));
    card.dataset.testid = 'pay-gate-card';
    const review = drawn(document.createElement('button'));
    review.dataset.testid = 'pay-gate-pay';
    card.append(review);
    expect((await act({ action: 'open_payment', task_id: 30 })).result.ui?.did).toBe('The Footings paid payment is up for review: every firm and what each is due. Send payout is theirs to press.');
    expect(screen.editTask).toHaveBeenCalledWith(30);
    expect(screen.openPayment).toHaveBeenCalledWith(30);

    review.disabled = true;
    review.title = 'No amount due yet';
    vi.mocked(screen.openPayment).mockClear();
    expect((await act({ action: 'open_payment', task_id: 30 })).result.ui?.did).toMatch(/nothing to review yet: No amount due yet/);
    expect(screen.openPayment).not.toHaveBeenCalled();
  });

  it('brings the newest invoice up for review through its own card', async () => {
    const { act, screen } = setup([]);
    expect(await act({ action: 'open_invoice' })).toMatchObject({ ok: false, result: { message: 'There is no invoice for the tenant in this conversation yet.' } });
    const older = drawn(document.createElement('button'));
    older.dataset.testid = 'change-invoice-review';
    const newest = drawn(document.createElement('button'));
    newest.dataset.testid = 'change-invoice-review';
    expect((await act({ action: 'open_invoice' })).result.ui?.did).toMatch(/up for review/);
    expect(screen.openInvoice).toHaveBeenCalledWith(newest);
  });
});

/** The library panel's hands, as the panel lends them while it is open. */
function library(): LibraryHands & { dropped: unknown[] } {
  let open: string | null = null;
  let dropping: string | null = null;
  const dropped: unknown[] = [];
  const card = drawn(document.createElement('li'));
  card.dataset.snippetId = 'lights';
  const grab = drawn(document.createElement('div'));
  grab.className = 'library-grab';
  card.append(grab);
  const hands = {
    dropped,
    openCard: (id: string) => {
      if (id !== 'lights') return null;
      open = 'Light fixtures';
      return card;
    },
    grabOf: (id: string) => (id === 'lights' ? grab : null),
    openName: () => open,
    dropOn: (snippetId: string, taskId: number, zone: 'after' | 'inside', at: { x: number; y: number }) => {
      dropped.push({ snippetId, taskId, zone, at });
      dropping = 'Light fixtures';
      return true;
    },
    dropCard: () => dropping,
    closeDropCard: () => {
      const was = dropping !== null;
      dropping = null;
      return was;
    },
    closeCard: () => true,
  };
  libraryHands.current = hands;
  return hands;
}

describe('closing what is open', () => {
  afterEach(() => {
    libraryHands.current = null;
  });

  it('closes the payment review with its own X, never while PayPal is paying', async () => {
    const { act, screen } = setup([]);
    const modal = drawn(document.createElement('section'));
    modal.dataset.testid = 'pay-modal';
    const x = drawn(document.createElement('button'));
    x.dataset.testid = 'pay-modal-close';
    modal.append(x);
    expect((await act({ action: 'close', what: 'modal' })).result.ui?.did).toBe('Closed the payment review. Nothing was paid.');
    expect(screen.closePayment).toHaveBeenCalled();
    x.disabled = true;
    expect(await act({ action: 'close', what: 'modal' })).toMatchObject({ ok: false, result: { message: expect.stringMatching(/on its way to PayPal/) } });
  });

  it('closes an invoice, then the drop card, then the side panel, whatever is on top', async () => {
    const { act, screen } = setup([], { panel: 'library' });
    const invoice = drawn(document.createElement('section'));
    invoice.dataset.testid = 'invoice-modal';
    expect((await act({ action: 'close', what: 'modal' })).result.ui?.did).toBe('Closed the invoice. Nothing was sent.');
    expect(screen.closeInvoice).toHaveBeenCalled();
    invoice.remove();
    const hands = library();
    hands.dropOn('lights', 1, 'after', { x: 0, y: 0 });
    expect((await act({ action: 'close', what: 'modal' })).result.ui?.did).toBe('Closed the card for “Light fixtures”: nothing was added to the plan.');
    expect((await act({ action: 'close', what: 'modal' })).result.ui?.did).toBe('Closed the task library.');
    expect(screen.closePanel).toHaveBeenCalled();
    expect((await act({ action: 'close', what: 'panel' })).result.ui?.did).toBe('No side panel is open.');
  });

  it('closes the odds panel', async () => {
    const { act, chart } = setup([], { odds: true });
    expect((await act({ action: 'close', what: 'odds' })).result.ui?.did).toBe('Closed the odds panel.');
    expect(chart.setOdds).toHaveBeenCalledWith(false);
  });

  it('closes the panel they named only when it is the one open', async () => {
    const chat = setup([], { panel: 'assistant' });
    expect((await chat.act({ action: 'close', what: 'panel', panel: 'library' })).result.ui).toEqual({ did: 'The task library isn’t open: our conversation is. Nothing was closed.', nothing: true });
    expect(chat.screen.closePanel).not.toHaveBeenCalled();
    const shelf = setup([], { panel: 'library' });
    expect((await shelf.act({ action: 'close', what: 'panel', panel: 'library' })).result.ui?.did).toBe('Closed the task library.');
    expect(shelf.screen.closePanel).toHaveBeenCalled();
  });
});

describe('the library', () => {
  afterEach(() => {
    libraryHands.current = null;
  });

  it('opens a package’s card in the library panel', async () => {
    const { act, screen } = setup([]);
    library();
    expect((await act({ action: 'open_snippet', snippet_id: 'lights' })).result.ui?.did).toBe('Opened “Light fixtures” in the library: its tasks, how long it runs and the crews on it.');
    expect(screen.openPanel).toHaveBeenCalledWith('library');
    expect(await act({ action: 'open_snippet', snippet_id: 'nothing' })).toMatchObject({ ok: false, result: { message: 'That package isn’t in the library.' } });
  });

  it('carries a package from its card onto a row, where the card asking how to tie it in opens', async () => {
    const level2 = task(20, 'Level 2 build-out', { isLeaf: false, children: [task(21, 'Paint, level 2')] });
    const { act, cursor } = setup([level2]);
    const hands = library();
    const carried: (string | null)[] = [];
    const carry = cursor.carry.bind(cursor);
    cursor.carry = (label) => {
      carried.push(label);
      carry(label);
    };
    const outcome = await act({ action: 'drag_snippet', snippet_id: 'lights', task_id: 20 });
    expect(outcome.result.ui?.did).toMatch(/^Carried “Light fixtures” onto “Level 2 build-out”\. The card that asks how to tie it in is open there/);
    expect(carried).toEqual(['Light fixtures', null]);
    expect(hands.dropped).toEqual([expect.objectContaining({ snippetId: 'lights', taskId: 20, zone: 'after' })]);
    expect(hands.dropCard()).toBe('Light fixtures');
  });
});

describe('the chart’s days', () => {
  it('scrolls to a day and points at a task’s bar', async () => {
    const { act, chart } = setup([task(4, 'Pour slab')]);
    expect((await act({ action: 'scroll_to_date', date: '2026-12-03' })).result.ui?.did).toBe('The chart is on Thu, Dec 3.');
    expect(chart.scrollToDate).toHaveBeenCalledWith(new Date(2026, 11, 3));
    expect((await act({ action: 'show_bar', target: { task_id: 4 } })).result.ui?.did).toBe('Showing the bar of “Pour slab”.');
  });
});

describe('the 3D site view’s days and levels', () => {
  it('opens the view and plays the days asked for: a span in about eight seconds, or on to the end', async () => {
    const { act, site, control } = setup([]);
    expect((await act({ action: 'site_play', from: '2026-11-16', to: '2026-12-04' })).result.ui?.did).toBe('Playing the site’s days from Mon, Nov 16 to Fri, Dec 4: the building goes up as the plan has it.');
    expect(site.openSite).toHaveBeenCalled();
    expect(control.play).toHaveBeenCalledWith(new Date(2026, 10, 16, 12).getTime(), new Date(2026, 11, 4, 12).getTime(), 8);
    vi.mocked(control.play).mockClear();
    await act({ action: 'site_play' });
    expect(control.play).toHaveBeenCalledWith(null, null, null);
  });

  it('plays a length from the day on show', async () => {
    const { act, control } = setup([]);
    expect((await act({ action: 'site_play', days: 14 })).result.ui?.did).toBe('Playing the site’s days from Tue, Nov 10 to Tue, Nov 24: the building goes up as the plan has it.');
    expect(control.play).toHaveBeenCalledWith(null, new Date(2026, 10, 24, 12).getTime(), 8);
  });

  it('pauses, shows a day, and looks into a level or the whole site', async () => {
    const { act, control, siteState } = setup([]);
    await act({ action: 'site_play' });
    expect((await act({ action: 'site_pause' })).result.ui?.did).toBe('Paused on Tue, Nov 10.');
    expect(siteState.playing).toBe(false);
    expect((await act({ action: 'site_pause' })).result.ui).toEqual({ did: 'It isn’t playing: the site view is on Tue, Nov 10.', nothing: true });
    expect((await act({ action: 'site_day', date: '2026-11-25' })).result.ui?.did).toBe('The site view is on Wed, Nov 25.');
    expect(control.goTo).toHaveBeenCalledWith(new Date(2026, 10, 25, 12).getTime());
    expect((await act({ action: 'site_level', level: 'l2' })).result.ui?.did).toBe('Looking at Level 2.');
    expect((await act({ action: 'site_level', level: null })).result.ui?.did).toBe('Looking at the whole site.');
    expect(await act({ action: 'site_level', level: 'the moon' })).toMatchObject({ ok: false, result: { message: expect.stringMatching(/no level like “the moon”: its levels are Foundations, Ground floor, Level 2/) } });
  });
});

describe('what is on this screen', () => {
  afterEach(() => {
    libraryHands.current = null;
  });

  it('reads the chart’s dates and zoom, the side panel and the call', () => {
    const { chart } = setup([]);
    expect(readScreen({ chart: () => chart, panel: () => 'library', call: () => 'host' })).toEqual({ view: 'chart', panel: 'library', from: '2026-11-16', to: '2026-12-04', zoom: 'weeks', call: 'host' });
  });

  it('reads the 3D view’s day, what is open over the page and the library card', async () => {
    const { chart, site } = setup([]);
    await site.openSite!();
    const modal = drawn(document.createElement('section'));
    modal.dataset.testid = 'pay-modal';
    const sub = document.createElement('p');
    sub.className = 'pay-modal-sub';
    sub.textContent = 'Progress payment · Footings · 2 trade partners';
    modal.append(sub);
    library().openCard('lights');
    expect(readScreen({ chart: () => chart, panel: () => null, call: () => null })).toEqual({
      view: 'site',
      site_day: '2026-11-10',
      playing: false,
      crane_ride: false,
      modal: 'payment_review',
      modal_about: 'Progress payment · Footings · 2 trade partners',
      snippet: 'Light fixtures',
    });
  });

  it('is nothing without a plan on screen', () => {
    expect(readScreen({ chart: () => null, panel: () => null, call: () => null })).toBeNull();
  });
});

describe('Remy’s cursor', () => {
  it('bends its way from one spot to the next and is quick about it', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    expect(curvePoint(from, to, 0)).toEqual(from);
    expect(curvePoint(from, to, 1)).toEqual(to);
    // Halfway along, it is off to one side of the straight line.
    expect(curvePoint(from, to, 0.5).y).not.toBe(0);
    expect(moveSeconds(10)).toBeCloseTo(0.32);
    expect(moveSeconds(5000)).toBe(0.9);
  });

  it('is a picture with her name, goes where it presses, ripples, and fades once done', async () => {
    vi.useFakeTimers();
    const cursor = new RemyCursor({ speed: 0, lingerMs: 1000 });
    const button = drawn(document.createElement('button'));
    expect(await cursor.press(button)).toBe(true);
    const root = document.querySelector<HTMLElement>('[data-testid="remy-cursor"]')!;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.textContent).toBe('Remy');
    expect(cursor.position).toEqual({ x: 80, y: 32 });
    expect(document.querySelector('.remy-cursor-ripple')).not.toBeNull();
    cursor.rest();
    vi.advanceTimersByTime(1000);
    expect(cursor.shown).toBe(false);
    vi.advanceTimersByTime(700);
    expect(document.querySelector('.remy-cursor-ripple')).toBeNull();
    cursor.destroy();
    expect(document.querySelector('[data-testid="remy-cursor"]')).toBeNull();
  });

  it('with reduced motion, it shows where it presses without travelling', async () => {
    const cursor = new RemyCursor({ speed: 1, reducedMotion: () => true });
    const button = drawn(document.createElement('button'));
    await cursor.moveTo(button);
    expect(cursor.position).toEqual({ x: 80, y: 32 });
    cursor.destroy();
  });

  it('has nowhere to go when its target isn’t there, and says so instead of throwing', async () => {
    const cursor = new RemyCursor({ speed: 0 });
    expect(await cursor.press(() => null)).toBe(false);
    cursor.destroy();
  });
});

// The stand-in records are what `original` reads: no linked copies here.
void ({} as TaskModel);

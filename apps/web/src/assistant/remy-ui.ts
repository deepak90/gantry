/**
 * Remy's screen actions (`ui_action` commands, filed by apps/agent/src/agent/screen-tools.ts), carried out in the tab
 * of the person who asked. Each is checked against the shared schema first. Then her cursor goes to the real control
 * and presses it, and the app does the rest through its own code and Bryntum's API: the 3D view's own open and close,
 * the toolbar's filters and zoom, the chart's rows and cells, the side panel's tabs, undo and redo.
 *
 * The answer says what happened, in a line Remy can say. Nothing here changes the plan, approves, pays or bills: undo
 * and redo are the person's own steps, and a payment or an invoice only comes up for them to review.
 */
import type { Gantt, TaskModel } from '@bryntum/gantt';
import { UiAction, type AgentCommandResult, type AgentCommandType, type UiActionOutcome, type UiPanel, type UiTaskTarget } from '@collab/shared';
import type { GanttScreen } from '../gantt/GanttWorkspace';
import { TASK_COLUMN_ID } from '../gantt/column-layout';
import { original } from '../gantt/look';
import { barOf, cellOf, columnMeant, filterLabel, revealTask, rowAt, rowOf, shownRecord, type PlanFilter } from '../gantt/screen';
import type { CommandExecutor } from './agent-commands';
import { aimAt, onScreen, type CursorTarget, type RemyCursor } from './remy-cursor';
import { libraryHands } from '../inspector/LibraryPanel';
import type { SiteControl } from '../gantt/fx3d';

/** What the executor reaches in the workspace: the chart, the side panel, and the openers of a payment and an invoice. */
export interface RemyScreen {
  /** The chart (null while it is not on screen). */
  chart(): GanttScreen | null;
  /** The side panel's tabs this person has. */
  panels(): readonly UiPanel[];
  openPanel(panel: UiPanel): void;
  /** A task in the side panel's task tab: what a double-click does. */
  editTask(taskId: number): void;
  /** The payment window for a payment hold, as its Review payment button opens it. */
  openPayment(gateId: number): void;
  /** Review invoice on an invoice card, as its button opens it; false when that card has nothing to review. */
  openInvoice(button: HTMLElement): boolean;
  /** The side panel's open tab, if any. */
  panel(): string | null;
  closePanel(): void;
  /** Closes the payment window, as its X does. */
  closePayment(): void;
  /** Closes an open invoice window, as its Cancel does; false when none is open. */
  closeInvoice(): boolean;
}

/** Something this screen can't show, said plainly for Remy to pass on. */
export class NotShown extends Error {}

const PANEL_WORDS: Readonly<Record<UiPanel, string>> = {
  task: 'the task panel',
  library: 'the task library',
  rentals: 'the rentals',
  documents: 'the documents',
  assistant: 'our conversation',
  crews: 'the crews',
  alerts: 'the alerts',
  history: 'the plan’s history',
};

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const dateOf = (iso: string) => new Date(`${iso}T00:00:00`);
const dayWords = (iso: string) => DAY.format(dateOf(iso));

const find = (selector: string, within: ParentNode = document): HTMLElement | null => {
  for (const element of within.querySelectorAll<HTMLElement>(selector)) if (onScreen(element)) return element;
  return null;
};
const findLast = (selector: string): HTMLElement | null => {
  const all = [...document.querySelectorAll<HTMLElement>(selector)];
  for (let index = all.length - 1; index >= 0; index -= 1) if (onScreen(all[index]!)) return all[index]!;
  return null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | undefined | false, timeout: number, every = 80): Promise<T | null> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = probe();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(every);
  }
}

/** The task's words for an answer: its name, and where it is. */
function taskOf(record: TaskModel): NonNullable<UiActionOutcome['task']> {
  const task = original(record);
  const wbs = (task as TaskModel & { wbsCode?: unknown }).wbsCode;
  return { id: Number(task.id), name: (task.name ?? 'Untitled task').slice(0, 200), wbs: wbs == null || wbs === '' ? null : String(wbs).slice(0, 40) };
}

const quoted = (record: TaskModel) => `“${original(record).name ?? 'the task'}”`;

/** Where the cursor goes for a row: its name, else its bar. */
const rowSpot = (gantt: Gantt, record: TaskModel) => (): Element | null => cellOf(gantt, record, TASK_COLUMN_ID) ?? barOf(gantt, record);

/** Keeps the person's view of searches between commands: the last search, to step through. */
interface SearchState {
  text: string;
  ids: number[];
  index: number;
}

export interface RemyUi {
  run(action: UiAction): Promise<UiActionOutcome>;
  /** The cursor goes to the first of these tasks as the chart brings it into view (a change just applied), and rests. */
  pointAt(taskIds: readonly number[]): Promise<void>;
}

export function createRemyUi(screen: () => RemyScreen | null, cursor: RemyCursor): RemyUi {
  let search: SearchState | null = null;

  const here = (): { at: RemyScreen; chart: GanttScreen; gantt: Gantt } => {
    const at = screen();
    const chart = at?.chart() ?? null;
    const gantt = chart?.instance();
    if (!at || !chart || !gantt || gantt.isDestroyed) throw new NotShown('The plan isn’t open in this tab.');
    return { at, chart, gantt };
  };

  /** The task they mean, brought into view: its groups opened, the chart scrolled to it. A filter hiding it is cleared, and said. */
  async function reveal(chart: GanttScreen, gantt: Gantt, target: UiTaskTarget): Promise<{ record: TaskModel; cleared: boolean }> {
    if ('row' in target) {
      const record = rowAt(gantt, target.row);
      if (!record) throw new NotShown(`The chart shows ${(gantt.store as unknown as { count: number }).count} rows now; there is no row ${target.row}.`);
      // Its bar too, not only its row.
      await gantt.scrollTaskIntoView(record, { block: 'center', animate: true } as never);
      return { record, cleared: false };
    }
    let found = await revealTask(gantt, target.task_id);
    let cleared = false;
    if ('missing' in found && found.missing === 'filtered') {
      await chart.setView({ search: '', quickFilter: 'all', filter: null });
      cleared = true;
      found = await revealTask(gantt, target.task_id);
    }
    if ('missing' in found) throw new NotShown(found.missing === 'gone' ? 'That task is no longer in the plan.' : 'A filter keeps that task off the chart.');
    chart.site()?.show([target.task_id]);
    return { record: found.record, cleared };
  }

  const clearedWords = (cleared: boolean) => (cleared ? ' The filter was hiding it, so it’s off now.' : '');

  async function goToTask(target: UiTaskTarget): Promise<UiActionOutcome> {
    const { chart, gantt } = here();
    const { record, cleared } = await reveal(chart, gantt, target);
    await cursor.press(rowSpot(gantt, record));
    chart.select(record);
    const row = rowOf(gantt, record);
    const task = taskOf(record);
    return { did: `Showing ${quoted(record)}${task.wbs ? ` (${task.wbs})` : ''}${'row' in target ? `, row ${target.row}` : row ? `, on row ${row}` : ''}.${clearedWords(cleared)}`, task };
  }

  async function focusCell(target: UiTaskTarget, words: string, edit: boolean): Promise<UiActionOutcome> {
    const { chart, gantt } = here();
    const column = columnMeant(gantt, words);
    if (!column) throw new NotShown(`The chart has no column like “${words}”.`);
    // A column this chart doesn't show is added to it, as the + at the end of the headers does, and said.
    const added = !column.shown;
    if (added) {
      await cursor.press(() => find('.b-grid-header[data-column-id="column-picker"]') ?? find(`.b-grid-header[data-column-id="${TASK_COLUMN_ID}"]`));
      if (!chart.addColumn(column.id)) throw new NotShown(`The ${column.label} column can’t be shown on this chart.`);
    }
    const addedWords = added ? ` The ${column.label} column is on the chart now.` : '';
    const { record, cleared } = await reveal(chart, gantt, target);
    await gantt.scrollColumnIntoView(column.id, { block: 'nearest', animate: true } as never);
    const cell = await waitFor(() => cellOf(gantt, record, column.id), 1500);
    await cursor.press(cell ?? rowSpot(gantt, record));
    gantt.selectCell({ record, column: column.id } as never);
    const task = taskOf(record);
    if (!edit) return { did: `Showing the ${column.label} of ${quoted(record)}.${addedWords}${clearedWords(cleared)}`, task };
    if (!(await chart.editCell(record, column.id))) {
      const why = original(record).readOnly ? ': it is locked while PayPal pays for it' : gantt.readOnly ? ': the plan is read only here' : '';
      throw new NotShown(`The ${column.label} of ${quoted(record)} can’t be edited here${why}.`);
    }
    return { did: `Opened the ${column.label} of ${quoted(record)} for editing.${addedWords}${clearedWords(cleared)}`, task };
  }

  async function openEditor(target: UiTaskTarget): Promise<UiActionOutcome> {
    const { at, chart, gantt } = here();
    const { record, cleared } = await reveal(chart, gantt, target);
    // A double-click on the row is what opens it.
    await cursor.press(rowSpot(gantt, record), 2);
    chart.select(record);
    const id = Number(original(record).id);
    at.editTask(id);
    await waitFor(() => document.querySelector(`[data-testid="task-inspector"][data-task-id="${id}"]`), 3000);
    return { did: `Opened ${quoted(record)} in the task editor.${clearedWords(cleared)}`, task: taskOf(record) };
  }

  async function siteView(action: Extract<UiAction, { action: 'site_view' }>): Promise<UiActionOutcome> {
    const { chart } = here();
    const site = chart.site();
    if (!site?.openSite || !site.siteOpen) throw new NotShown('This plan has no 3D site view here.');
    if (!action.open) {
      if (!site.siteOpen()) return { did: 'The site view isn’t open: the chart is on screen.' };
      await cursor.press(() => find('[data-testid="site-view-close"]') ?? find('[data-testid="view-chart"]'));
      site.closeSite?.();
      await waitFor(() => !site.siteOpen!(), 8000);
      return { did: 'Closed the site view: back on the chart.' };
    }
    const wasOpen = site.siteOpen();
    if (!wasOpen) {
      await cursor.press(() => find('[data-testid="view-site"]'));
      if (!(await site.openSite())) throw new NotShown('The site view didn’t open.');
    }
    if (!action.look) return { did: wasOpen ? 'The site view is open.' : 'Opened the site view: the building on its lot as the plan has it, with the rows beside it.' };
    // Flying in from the chart first: the crane is shown once the view stands still.
    await waitFor(() => site.siteSettled?.() ?? true, 9000);
    if (action.look === 'crane') {
      await cursor.press(() => find('[data-testid="site-view-rental-days"]') ?? find('[data-testid="view-site"]'));
      if (!site.crane?.('days')) throw new NotShown('No tower crane is on rent in this plan to show.');
      const tag = await waitFor(() => find('.fxb-calendar-tag'), 3000);
      const words = tag?.innerText.replace(/\s*\n\s*/g, ': ').trim();
      return { did: `Showing the tower crane and its days on rent on the lot${words ? ` (${words})` : ''}.` };
    }
    await cursor.press(() => find('[data-testid="site-view-ride"]') ?? find('[data-testid="view-site"]'));
    if (!site.crane?.('ride')) throw new NotShown('No tower crane is up in this plan to ride.');
    const tag = await waitFor(() => find('.fxb-machine'), 2500);
    const words = tag?.textContent?.replace(/\s+/g, ' ').trim();
    return { did: `The view is up on the tower crane, looking down at the hook over the lot${words ? ` (${words})` : ''}.` };
  }

  async function filter(action: Extract<UiAction, { action: 'filter' }>): Promise<UiActionOutcome> {
    const { chart } = here();
    if (action.clear) {
      await cursor.press(() => find('[data-testid="gantt-plan-filter-clear"]') ?? find('[data-testid="gantt-search"]'));
      await chart.setView({ search: '', quickFilter: 'all', filter: null });
      return { did: `Showing the whole plan again: ${chart.counts().total} tasks.`, matches: chart.counts().total };
    }
    const planFilter: PlanFilter | null =
      (action.crew_ids && action.crew_ids.length > 0) || action.from || action.to
        ? { crewIds: action.crew_ids ?? null, from: action.from ?? null, to: action.to ?? null, label: filterLabel(action.crew_label, action.from, action.to) }
        : null;
    await cursor.press(() => find('[data-testid="gantt-search"]'));
    await chart.setView({ search: action.text ?? '', quickFilter: 'all', filter: planFilter });
    const { visible, total } = chart.counts();
    const dates = action.from && action.to ? `work from ${dayWords(action.from)} to ${dayWords(action.to)}` : action.from ? `work from ${dayWords(action.from)} on` : action.to ? `work until ${dayWords(action.to)}` : null;
    const named = [action.text ? `tasks with “${action.text}”` : null, action.crew_label ? `${action.crew_label}’s work` : null, dates].filter(Boolean).join(', ');
    if (visible === 0) {
      await chart.setView({ search: '', quickFilter: 'all', filter: null });
      return { did: `No tasks fit ${named}, so the whole plan is shown as it was.`, matches: 0 };
    }
    // Only the groups that hold what is kept are left: open them, so the tasks themselves are on screen.
    await chart.expand(true);
    await cursor.moveTo(() => find('[data-testid="gantt-plan-filter"]') ?? find('[data-testid="gantt-count"]'));
    return { did: `Showing ${visible} of ${total} tasks: ${named}. It can be cleared above the chart.`, matches: visible };
  }

  async function step(chart: GanttScreen, gantt: Gantt, state: SearchState): Promise<TaskModel> {
    const id = state.ids[state.index]!;
    const { record } = await reveal(chart, gantt, { task_id: id });
    gantt.highlightTasks({ tasks: state.ids.map((each) => shownRecord(gantt, each)).filter((each): each is TaskModel => each !== null), scroll: false, unhighlightOnClick: true, unhighlightOthers: true });
    await cursor.press(rowSpot(gantt, record));
    chart.select(record);
    return record;
  }

  async function searchPlan(action: Extract<UiAction, { action: 'search' }>): Promise<UiActionOutcome> {
    const { chart, gantt } = here();
    if (action.clear) {
      gantt.unhighlightTasks();
      search = null;
      return { did: 'Took the search highlight off.' };
    }
    if (action.text && action.task_ids) {
      const ids = action.task_ids.filter((id) => shownRecord(gantt, id) !== null);
      if (ids.length === 0) throw new NotShown(`Nothing on this chart is called anything like “${action.text}”.`);
      search = { text: action.text, ids, index: 0 };
      const record = await step(chart, gantt, search);
      return {
        did: ids.length === 1 ? `Found ${quoted(record)}.` : `Found ${ids.length} tasks for “${action.text}”, highlighted on the chart; showing the first, ${quoted(record)}.`,
        task: taskOf(record),
        matches: ids.length,
        at: 1,
      };
    }
    if (!search) throw new NotShown('There’s no search to step through yet.');
    const total = search.ids.length;
    search.index = (search.index + (action.step === 'previous' ? total - 1 : action.step === 'first' ? -search.index : 1)) % total;
    const record = await step(chart, gantt, search);
    return { did: `${search.index + 1} of ${total} for “${search.text}”: ${quoted(record)}.`, task: taskOf(record), matches: total, at: search.index + 1 };
  }

  async function expand(action: Extract<UiAction, { action: 'expand' }>): Promise<UiActionOutcome> {
    const { chart, gantt } = here();
    if (typeof action.task_id !== 'number') {
      await cursor.press(() => find(`.b-grid-header[data-column-id="${TASK_COLUMN_ID}"]`) ?? find('[data-testid="gantt-view"]'));
      await chart.expand(action.open);
      return { did: action.open ? 'Opened every group of the plan.' : 'Closed every group: the plan’s main parts are on screen.' };
    }
    const { record } = await reveal(chart, gantt, { task_id: action.task_id });
    if (original(record).isLeaf) throw new NotShown(`${quoted(record)} has no tasks inside it.`);
    await cursor.press(() => cellOf(gantt, record, TASK_COLUMN_ID)?.querySelector('.b-tree-expander') ?? cellOf(gantt, record, TASK_COLUMN_ID));
    await chart.expand(action.open, record);
    const inside = ((original(record).children as TaskModel[] | undefined) ?? []).length;
    return { did: action.open ? `Opened ${quoted(record)}: ${inside} ${inside === 1 ? 'item' : 'items'} inside.` : `Closed ${quoted(record)}.`, task: taskOf(record) };
  }

  async function zoom(action: Extract<UiAction, { action: 'zoom' }>): Promise<UiActionOutcome> {
    const { chart } = here();
    if (action.how === 'dates') {
      if (!action.first_day || !action.last_day) throw new NotShown('Which days to zoom to didn’t come through.');
      await cursor.press(() => find('.b-sch-timeaxiscolumn') ?? find('.b-grid-header-scroller-normal') ?? find('[data-testid="zoom-fit"]'));
      chart.zoomToDates(dateOf(action.first_day), dateOf(action.last_day));
      return { did: `The timeline now runs ${dayWords(action.first_day)} to ${dayWords(action.last_day)}.` };
    }
    const selector = action.how === 'fit' ? '[data-testid="zoom-fit"]' : `.gt-zoom button[aria-label="${action.how === 'in' ? 'Zoom in' : 'Zoom out'}"]`;
    await cursor.press(() => find(selector));
    await chart.zoom(action.how);
    return { did: action.how === 'fit' ? 'The whole project fits on screen.' : action.how === 'in' ? 'Zoomed in a step.' : 'Zoomed out a step.' };
  }

  async function openPanel(panel: UiPanel): Promise<UiActionOutcome> {
    const { at } = here();
    if (!at.panels().includes(panel)) throw new NotShown(`There is no ${PANEL_WORDS[panel].replace(/^the /, '')} panel here.`);
    await cursor.press(() => find(`[data-testid="inspector-tab-${panel}"]`) ?? find('[data-testid="inspector-more"]'));
    at.openPanel(panel);
    return { did: `Opened ${PANEL_WORDS[panel]}.` };
  }

  async function openPayment(taskId: number): Promise<UiActionOutcome> {
    const { at, chart, gantt } = here();
    const { record } = await reveal(chart, gantt, { task_id: taskId });
    await cursor.press(rowSpot(gantt, record), 2);
    chart.select(record);
    at.editTask(taskId);
    const card = await waitFor(() => find('[data-testid="pay-gate-card"]'), 3000);
    if (!card) throw new NotShown(`${quoted(record)} has no payment to review.`);
    const review = card.querySelector<HTMLButtonElement>('[data-testid="pay-gate-pay"]');
    if (!review) {
      const paid = card.querySelector('[data-testid="pay-gate-paid"]');
      return { did: paid ? `${quoted(record)} is paid; its card is open in the task panel.` : `The payment card for ${quoted(record)} is open in the task panel; only someone who sees costs can review the payment.`, task: taskOf(record) };
    }
    if (review.disabled) return { did: `The payment card for ${quoted(record)} is open, with nothing to review yet: ${review.title || 'it isn’t ready'}.`, task: taskOf(record) };
    await cursor.press(review);
    at.openPayment(taskId);
    return { did: `The ${original(record).name} payment is up for review: every firm and what each is due. Send payout is theirs to press.`, task: taskOf(record) };
  }

  async function openInvoice(): Promise<UiActionOutcome> {
    const { at } = here();
    if (!at.panels().includes('assistant')) throw new NotShown('The conversation with the invoice isn’t here.');
    at.openPanel('assistant');
    const button = await waitFor(() => findLast('[data-testid="change-invoice-review"]'), 2500);
    if (!button) {
      const sent = findLast('[data-testid="change-invoice-sent"]');
      if (sent) return { did: `The newest invoice was sent already: ${sent.textContent?.replace(/\s+/g, ' ').trim() ?? 'its card says where it stands'}.` };
      throw new NotShown('There is no invoice for the tenant in this conversation yet.');
    }
    if ((button as HTMLButtonElement).disabled) throw new NotShown('The invoice can only be reviewed by someone who sees costs, and only while it matches the plan.');
    await cursor.press(button);
    if (!at.openInvoice(button)) throw new NotShown('The invoice didn’t open.');
    return { did: 'The invoice for the tenant is up for review: its lines and total. Sending it is theirs to press.' };
  }

  async function history(direction: 'undo' | 'redo', steps: number): Promise<UiActionOutcome> {
    const { chart } = here();
    const done: string[] = [];
    for (let count = 0; count < steps; count += 1) {
      await cursor.press(() => find(`[data-testid="gantt-${direction}"]`));
      const outcome = await chart.history(direction);
      if (!outcome.done) {
        if (done.length === 0) throw new NotShown(outcome.why);
        break;
      }
      done.push(outcome.label);
    }
    const verb = direction === 'undo' ? 'Undid' : 'Redid';
    return { did: `${verb} ${done.join('; then ')}.` };
  }

  /** Closes what is on top: a window or sheet over the page, else the side panel; or the odds panel when asked. */
  async function close(what: 'modal' | 'panel' | 'odds', named: UiPanel | null): Promise<UiActionOutcome> {
    const { at, chart } = here();
    if (what === 'odds') {
      if (!chart.view().odds) return { did: 'The odds panel isn’t open.', nothing: true };
      await cursor.press(() => find('[data-testid="gantt-odds"]'));
      chart.setOdds(false);
      return { did: 'Closed the odds panel.' };
    }
    if (what === 'modal') {
      const pay = document.querySelector<HTMLElement>('[data-testid="pay-modal"]');
      if (pay) {
        const x = pay.querySelector<HTMLButtonElement>('[data-testid="pay-modal-close"]');
        if (x?.disabled) throw new NotShown('The payment is on its way to PayPal: its window stays open until PayPal answers.');
        await cursor.press(x ?? pay);
        at.closePayment();
        return { did: 'Closed the payment review. Nothing was paid.' };
      }
      if (document.querySelector('[data-testid="invoice-modal"]')) {
        await cursor.press(() => find('[data-testid="invoice-modal-close"]'));
        if (!at.closeInvoice()) throw new NotShown('The invoice window didn’t close.');
        return { did: 'Closed the invoice. Nothing was sent.' };
      }
      const hands = libraryHands.current;
      const dropping = hands?.dropCard() ?? null;
      if (hands && dropping) {
        await cursor.press(() => find('[data-testid="library-choice"]'));
        hands.closeDropCard();
        return { did: `Closed the card for “${dropping}”: nothing was added to the plan.` };
      }
      const editor = document.querySelector('[data-testid="snippet-builder"]');
      if (editor) {
        // The editor's own X: it asks first when there are changes not saved.
        const x = editor.querySelector<HTMLButtonElement>('[data-testid="builder-close"]');
        if (x) {
          await cursor.press(x);
          x.click();
        }
        const closed = await waitFor(() => !document.querySelector('[data-testid="snippet-builder"]'), 1500);
        return { did: closed ? 'Closed the package editor.' : 'The package editor has changes that aren’t saved: it asks whether to keep them.' };
      }
    }
    const panel = at.panel();
    if (!panel) return { did: what === 'modal' ? 'Nothing is open over the page.' : 'No side panel is open.', nothing: true };
    // The panel they named isn't the one showing: nothing to close (their message box is in our conversation).
    if (named && named !== panel) return { did: `${capital(PANEL_WORDS[named])} isn’t open: ${PANEL_WORDS[panel as UiPanel] ?? 'another panel'} is. Nothing was closed.`, nothing: true };
    await cursor.press(() => find(`[data-testid="inspector-tab-${panel}"]`) ?? find('.inspector-panel'));
    at.closePanel();
    return { did: `Closed ${PANEL_WORDS[panel as UiPanel] ?? 'the side panel'}.` };
  }

  /** The library panel open on a piece's card. */
  async function openSnippetCard(snippetId: string): Promise<{ card: HTMLElement; name: string }> {
    const { at } = here();
    if (!at.panels().includes('library')) throw new NotShown('There is no task library here.');
    if (at.panel() !== 'library') {
      await cursor.press(() => find('[data-testid="inspector-tab-library"]') ?? find('[data-testid="inspector-more"]'));
      at.openPanel('library');
    }
    const card = await waitFor(() => libraryHands.current?.openCard(snippetId) ?? null, 3000);
    if (!card) throw new NotShown('That package isn’t in the library.');
    // The card opens and comes into view.
    await sleep(350);
    return { card, name: libraryHands.current?.openName() ?? card.querySelector('strong')?.textContent?.trim() ?? 'the package' };
  }

  async function openSnippet(snippetId: string): Promise<UiActionOutcome> {
    const { card, name } = await openSnippetCard(snippetId);
    await cursor.press(() => find(`[data-snippet-id="${CSS.escape(snippetId)}"] .library-card-text`) ?? card);
    return { did: `Opened “${name}” in the library: its tasks, how long it runs and the crews on it.` };
  }

  /** Carries a library piece from its card onto a row, as a person drags it; the card that asks how to tie it in opens there. */
  async function dragSnippet(snippetId: string, taskId: number, zone: 'after' | 'inside'): Promise<UiActionOutcome> {
    const { chart, gantt } = here();
    const { card, name } = await openSnippetCard(snippetId);
    const { record } = await reveal(chart, gantt, { task_id: taskId });
    const grab = libraryHands.current?.grabOf(snippetId) ?? card;
    // Picked up by its handle, carried over at a careful pace, let go on the row.
    await cursor.press(grab);
    cursor.carry(name);
    try {
      await cursor.moveTo(rowSpot(gantt, record), { pace: 2.2 });
      await cursor.pause(260);
    } finally {
      cursor.carry(null);
    }
    cursor.ripple();
    const spot = rowSpot(gantt, record)();
    const point = cursor.position ?? (spot ? aimAt(spot) : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    if (!libraryHands.current?.dropOn(snippetId, taskId, zone, point)) throw new NotShown('The library isn’t open to drag from.');
    return {
      did: `Carried “${name}” onto ${quoted(record)}. The card that asks how to tie it in is open there: the person picks a way and presses it. Nothing is in the plan until then.`,
      task: taskOf(record),
    };
  }

  async function scrollToDate(date: string): Promise<UiActionOutcome> {
    const { chart, gantt } = here();
    await cursor.press(() => find('.b-sch-timeaxiscolumn') ?? find('.b-grid-header-scroller-normal'));
    await chart.scrollToDate(dateOf(date));
    // Then on to that day's column in the header.
    await cursor.moveTo(() => {
      const x = gantt.getCoordinateFromDate(dateOf(date).getTime() + 43_200_000, false);
      const header = find('.b-sch-timeaxiscolumn');
      return x >= 0 && header ? { x, y: header.getBoundingClientRect().bottom - 12 } : null;
    });
    return { did: `The chart is on ${dayWords(date)}.` };
  }

  async function showBar(target: UiTaskTarget): Promise<UiActionOutcome> {
    const { chart, gantt } = here();
    const { record, cleared } = await reveal(chart, gantt, target);
    await cursor.moveTo(() => barOf(gantt, record) ?? rowSpot(gantt, record)());
    chart.select(record);
    return { did: `Showing the bar of ${quoted(record)}.${clearedWords(cleared)}`, task: taskOf(record) };
  }

  /** The 3D site view open and still, and its control; it is opened first when it is closed. */
  async function siteReady(): Promise<SiteControl> {
    const { chart } = here();
    const site = chart.site();
    if (!site?.openSite || !site.siteOpen) throw new NotShown('This plan has no 3D site view here.');
    if (!site.siteOpen()) {
      await cursor.press(() => find('[data-testid="view-site"]'));
      if (!(await site.openSite())) throw new NotShown('The site view didn’t open.');
    }
    await waitFor(() => site.siteSettled?.() ?? true, 9000);
    const control = site.siteControl?.() ?? null;
    if (!control) throw new NotShown('This site view has no days to play.');
    return control;
  }

  const middayOf = (iso: string) => dateOf(iso).getTime() + 43_200_000;
  const isoOf = (at: number) => {
    const day = new Date(at);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  };
  const spanWords = (control: SiteControl) => {
    const span = control.span();
    return span ? ` The plan’s days run from ${dayWords(isoOf(span[0]))} to ${dayWords(isoOf(span[1]))}.` : '';
  };

  /** A point on the date rail for a day, for the cursor. */
  const railAt = (control: SiteControl, day: number) => (): { x: number; y: number } | null => {
    const rail = find('.fxb-rail');
    const span = control.span();
    if (!rail || !span) return null;
    const rect = rail.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (day - span[0]) / Math.max(1, span[1] - span[0])));
    return { x: rect.left + rect.width * share, y: rect.top + rect.height / 2 };
  };

  async function sitePlay(action: Extract<UiAction, { action: 'site_play' }>): Promise<UiActionOutcome> {
    const control = await siteReady();
    const from = action.from ? middayOf(action.from) : null;
    // "The next two weeks": that many days on from where it starts.
    const shownDay = control.state().day;
    const startAt = from ?? (shownDay ? middayOf(shownDay) : null);
    const to = action.to ? middayOf(action.to) : action.days && startAt !== null ? startAt + action.days * 86_400_000 : null;
    await cursor.press(() => find('.fxb-play') ?? find('.fxb-rail'));
    // A span of days plays in about eight seconds unless asked otherwise; to the end, at the view's own pace.
    const seconds = action.seconds ?? (to !== null ? 8 : null);
    if (!control.play(from, to, seconds)) throw new NotShown(`Those days can’t be played from here.${spanWords(control)}`);
    const start = action.from ? dayWords(action.from) : shownDay ? dayWords(shownDay) : 'the day on show';
    const end = action.to ? dayWords(action.to) : to !== null ? dayWords(isoOf(to)) : 'the end of the plan';
    return { did: `Playing the site’s days from ${start} to ${end}: the building goes up as the plan has it.` };
  }

  async function sitePause(): Promise<UiActionOutcome> {
    const { chart } = here();
    const control = chart.site()?.siteControl?.() ?? null;
    if (!control) return { did: 'The site view isn’t open.', nothing: true };
    const shown = control.state().day;
    if (!control.state().playing) return { did: `It isn’t playing: the site view is on ${shown ? dayWords(shown) : 'its day'}.`, nothing: true };
    await cursor.press(() => find('.fxb-play'));
    control.pause();
    const stopped = control.state().day;
    return { did: `Paused on ${stopped ? dayWords(stopped) : 'the day on show'}.` };
  }

  async function siteDay(date: string): Promise<UiActionOutcome> {
    const control = await siteReady();
    const day = middayOf(date);
    await cursor.press(railAt(control, day));
    if (!control.goTo(day)) throw new NotShown(`The site view can’t show that day now.${spanWords(control)}`);
    return { did: `The site view is on ${dayWords(date)}.` };
  }

  async function siteLevel(level: string | null): Promise<UiActionOutcome> {
    const control = await siteReady();
    if (level === null) {
      await cursor.press(() => find('.fxb-chip') ?? find('.fxb-play'));
      control.level(null);
      return { did: 'Looking at the whole site.' };
    }
    const wanted = level.trim().toLowerCase();
    const levels = control.levels();
    const match = levels.find((each) => each.name.toLowerCase() === wanted || each.short.toLowerCase() === wanted) ?? levels.find((each) => each.name.toLowerCase().includes(wanted));
    if (!match) throw new NotShown(`The building has no level like “${level}”: its levels are ${levels.map((each) => each.name).join(', ')}.`);
    await cursor.press(() => {
      for (const item of document.querySelectorAll<HTMLElement>('.fxb-floors li button')) if (item.querySelector('.fxb-name')?.textContent?.trim() === match.name && onScreen(item)) return item;
      return find('[data-testid="site-view-floors"]');
    });
    if (!control.level(match.name)) throw new NotShown(`The view can’t go to ${match.name} now.`);
    return { did: `Looking at ${match.name}.` };
  }

  async function carryOut(action: UiAction): Promise<UiActionOutcome> {
    switch (action.action) {
          case 'site_view':
            return await siteView(action);
          case 'go_to_task':
            return await goToTask(action.target);
          case 'focus_cell':
            return await focusCell(action.target, action.column, action.edit);
          case 'open_editor':
            return await openEditor(action.target);
          case 'filter':
            return await filter(action);
          case 'search':
            return await searchPlan(action);
          case 'expand':
            return await expand(action);
          case 'zoom':
            return await zoom(action);
          case 'open_panel':
            return await openPanel(action.panel);
          case 'open_payment':
            return await openPayment(action.task_id);
          case 'open_invoice':
            return await openInvoice();
          case 'history':
            return await history(action.direction, action.steps);
          case 'close':
            return await close(action.what, action.panel ?? null);
          case 'open_snippet':
            return await openSnippet(action.snippet_id);
          case 'drag_snippet':
            return await dragSnippet(action.snippet_id, action.task_id, action.zone ?? 'after');
          case 'scroll_to_date':
            return await scrollToDate(action.date);
          case 'show_bar':
            return await showBar(action.target);
          case 'site_play':
            return await sitePlay(action);
          case 'site_pause':
            return await sitePause();
          case 'site_day':
            return await siteDay(action.date);
          case 'site_level':
            return await siteLevel(action.level ?? null);
    }
  }

  return {
    async run(action) {
      try {
        const outcome = await carryOut(action);
        return { ...outcome, did: outcome.did.slice(0, 600) };
      } finally {
        cursor.rest();
      }
    },
    async pointAt(taskIds) {
      try {
        const { gantt } = here();
        const record = taskIds.map((id) => shownRecord(gantt, id)).find((each): each is TaskModel => each !== null);
        if (!record) return;
        // The chart is scrolling there already: once the row is drawn, the cursor goes to it.
        const spot = rowSpot(gantt, record);
        if (await waitFor(() => spot(), 2500)) await cursor.moveTo(spot);
      } catch {
        // Nothing on screen to point at.
      } finally {
        cursor.rest();
      }
    },
  };
}

/** The executor for `ui_action`: the arguments checked against the shared schema, then carried out by `ui`. */
export function remyUiExecutor(ui: RemyUi): CommandExecutor {
  return async (type: AgentCommandType, args: unknown): Promise<{ ok: boolean; result: AgentCommandResult }> => {
    if (type !== 'ui_action') return { ok: false, result: { message: 'That isn’t something to show on screen.' } };
    const parsed = UiAction.safeParse(args);
    if (!parsed.success) return { ok: false, result: { message: 'Remy asked this screen for something it can’t do.' } };
    try {
      return { ok: true, result: { ui: await ui.run(parsed.data) } };
    } catch (error) {
      const message = error instanceof NotShown ? error.message : `It didn’t work on this screen: ${error instanceof Error ? error.message : String(error)}`;
      return { ok: false, result: { message: message.slice(0, 500) } };
    }
  };
}

export type { CursorTarget };

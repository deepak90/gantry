/**
 * Two browsers, two members, one project: both are offered the money columns and the Costs tab (one
 * role: everyone sees costs), a concurrent add-task + move-task (with the engine rescheduling the
 * successor chain) converging through submit_revision + Realtime, a reload that rebuilds from
 * snapshot + catch-up, and an offline edit that is queued and delivered after reconnect. Then, in one
 * browser, the crew panes under the plan (View menu) and the project switcher (project menu).
 * Runs against the local Supabase stack with the seeded demo accounts (docs/SETUP.md).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetDemoProject } from './demo-reset';
import { HARBOR_IDS, CEDAR_IDS, SEED_IDS } from '../../packages/shared/src/seed/index.ts';

interface Credentials {
  email: string;
  password: string;
}

const PM: Credentials = { email: process.env.E2E_PM_EMAIL ?? 'pm@demo.local', password: process.env.E2E_PM_PASSWORD ?? 'demo-pm-2026' };
const CM: Credentials = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? path.join('test-results', 'screenshots');

const COST_COLUMNS = ['Budget · Forecast', 'Spent · Paid'];
/** A change made in one browser must show in the other within about two seconds. */
const PROPAGATION_MS = 3_000;
/** Reconnect backoff (realtime-js steps up to 10 s, the outbox up to 10 s) bounds recovery. */
const RECOVERY_MS = 30_000;
const BOOT_MS = 90_000;

const badge = (page: Page) => page.getByTestId('sync-badge');
/** Header text as written; the theme upper-cases it on screen. */
const ganttHeaders = (page: Page) => page.locator('.b-gantt .b-grid-header-text');
/** Grid cells live in the locked sub-grid of the Gantt only; the histogram below has rows of its own. */
const nameCell = (page: Page, id: string | number) =>
  page.locator(`.b-gantt .b-grid-row[data-id="${id}"] .b-grid-cell[data-column="name"]`);
/** The Schedule cell (one cell for start → finish, working days and progress) and its start date. */
const scheduleCell = (page: Page, id: string | number) =>
  page.locator(`.b-gantt .b-grid-row[data-id="${id}"] .b-grid-cell[data-column-id="schedule-when"]`);
const startCell = (page: Page, id: string | number) => scheduleCell(page, id).locator('.look-when-start');

/** Checks or clears columns in the column selector (the "+" at the right end of the grid's header row), then closes it. */
async function setColumns(page: Page, ids: string[], shown: boolean): Promise<void> {
  await page.getByTestId('column-picker-button').click();
  await expect(page.getByTestId('column-picker')).toBeVisible();
  for (const id of ids) {
    const option = page.getByTestId(`column-option-${id}`);
    if ((await option.getAttribute('aria-checked')) !== String(shown)) await option.click();
    await expect(page.getByTestId(`column-option-${id}`)).toHaveAttribute('aria-checked', String(shown));
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('column-picker')).toHaveCount(0);
}

/** Date cells read "Wed Nov 25" (CELL_DATE_FORMAT); their editor takes "Nov 25, 2026" (EDIT_DATE_FORMAT). */
const formatCellDate = (date: Date) => `${date.toLocaleDateString('en-US', { month: 'short' })} ${date.getDate()}`;
const formatEditDate = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** The cells carry no year; the seed runs from November 2026 into 2027. */
function parseCellDate(text: string): Date {
  // `Dec 11` (Schedule cell) or `Fri Dec 11`: drop a leading weekday only when three parts are given.
  const parts = text.trim().split(/\s+/);
  const monthDay = (parts.length > 2 ? parts.slice(1) : parts).join(' ');
  let date = new Date(`${monthDay}, 2026`);
  if (!Number.isNaN(date.getTime()) && date.getMonth() < 6) {
    date = new Date(`${monthDay}, 2027`);
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error(`cannot parse the rendered date "${text}"`);
  }
  return date;
}

const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

async function signIn(page: Page, who: Credentials): Promise<void> {
  await page.goto('/');
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForWorkspace(page);
}

async function waitForWorkspace(page: Page): Promise<void> {
  await expect(badge(page)).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  await expect(page.locator('.b-gantt .b-gantt-task-wrap').first()).toBeVisible({ timeout: BOOT_MS });
  await expect(nameCell(page, 100)).toHaveText('Site setup & demolition');
}

/** `id -> "name|start|finish"` for every task row currently rendered by the Gantt grid. */
async function renderedRows(page: Page): Promise<Record<string, string>> {
  return page.locator('.b-gantt .b-grid-row[data-id]').evaluateAll((rows) => {
    const out: Record<string, string> = {};
    for (const row of rows) {
      const name = row.querySelector('[data-column="name"]')?.textContent?.trim();
      if (!name) continue; // timeline rows carry no grid cells
      const start = row.querySelector('.look-when-start')?.textContent?.trim() ?? '';
      const end = row.querySelector('.look-when-end')?.textContent?.trim() ?? '';
      out[row.getAttribute('data-id') ?? ''] = `${name}|${start}|${end}`;
    }
    return out;
  });
}

/** The two Gantts agree on every row both have rendered, and both render the rows that matter. */
async function expectSameRows(a: Page, b: Page, mustInclude: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const [rowsA, rowsB] = await Promise.all([renderedRows(a), renderedRows(b)]);
        const common = Object.keys(rowsA).filter((id) => id in rowsB);
        const mismatches = common.filter((id) => rowsA[id] !== rowsB[id]).map((id) => `${id}: ${rowsA[id]} vs ${rowsB[id]}`);
        const missing = mustInclude.filter((id) => !common.includes(id));
        return { common: common.length, mismatches, missing };
      },
      { timeout: PROPAGATION_MS * 2 },
    )
    .toEqual({ common: expect.any(Number), mismatches: [], missing: [] });
  const [rowsA, rowsB] = await Promise.all([renderedRows(a), renderedRows(b)]);
  expect(Object.keys(rowsA).filter((id) => id in rowsB).length).toBeGreaterThanOrEqual(15);
}

async function renameTask(page: Page, id: string | number, name: string): Promise<void> {
  await nameCell(page, id).dblclick();
  const input = page.locator('.b-cell-editor input:visible');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(nameCell(page, id)).toHaveText(name);
  // Enter must close the editor: an open editor pauses the project queue and holds back remote revisions.
  await expect(page.locator('.b-cell-editor input:visible')).toHaveCount(0);
}

/**
 * Moves a task through the Schedule cell's editor (double-click opens it; Save applies the change as
 * one transaction). With autoSetConstraints the engine turns the new start into a
 * start-no-earlier-than constraint and reschedules the successors, so the revision carries `$input`
 * plus engine consequences plus the project's own end date.
 */
async function setTaskStart(page: Page, id: string | number, date: Date): Promise<void> {
  await scheduleCell(page, id).dblclick();
  const editor = page.locator('.look-editor');
  const input = editor.locator('[data-ref="start"] input');
  await expect(input).toBeVisible();
  await input.fill(formatEditDate(date));
  await input.press('Tab');
  await editor.locator('[data-ref="save"]').click();
  await expect(editor).toHaveCount(0);
  await expect(startCell(page, id)).toHaveText(formatCellDate(date));
}

/** Adds a task through the Gantt's own context menu and returns its server-assigned id. */
async function addTaskBelow(page: Page, anchorId: number): Promise<string> {
  const rowIds = async () => Object.keys(await renderedRows(page));
  const before = new Set(await rowIds());
  await nameCell(page, anchorId).click();
  await nameCell(page, anchorId).click({ button: 'right' });
  const items = page.locator('.b-float-root .b-menu-item');
  await items.filter({ hasText: /^Add$/ }).first().hover();
  await items.filter({ hasText: /^Task below$/ }).first().click();
  const added = async () => (await rowIds()).filter((id) => !before.has(id));
  await expect.poll(added).toHaveLength(1);
  // The new record first carries a phantom id; the server echo replaces it with the real id.
  await expect.poll(async () => (await added())[0] ?? '', { timeout: PROPAGATION_MS * 3 }).toMatch(/^\d+$/);
  const [id] = await added();
  return id!;
}

function collectPageErrors(page: Page, into: string[]): void {
  page.on('pageerror', (error) => into.push(`pageerror: ${error.message}`));
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe('two browsers on the seeded Riverside Clinic project', () => {
  // The steps build on each other (sign-in, then edits, reload, offline); a failure skips the rest
  // instead of restarting the worker with blank pages.
  test.describe.configure({ mode: 'serial' });

  let pmContext: BrowserContext;
  let cmContext: BrowserContext;
  let pm: Page;
  let cm: Page;
  const pageErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    mkdirSync(SHOTS, { recursive: true });
    [pmContext, cmContext] = await Promise.all([browser.newContext(), browser.newContext()]);
    [pm, cm] = await Promise.all([pmContext.newPage(), cmContext.newPage()]);
    collectPageErrors(pm, pageErrors);
    collectPageErrors(cm, pageErrors);
  });

  test.afterAll(async () => {
    await Promise.all([pmContext?.close(), cmContext?.close()]);
  });

  test('both members load the seed; both are offered the money columns and the Costs tab', async () => {
    await Promise.all([signIn(pm, PM), signIn(cm, CM)]);

    // One role: both are full members of the project, and the app calls everyone a member.
    for (const page of [pm, cm]) {
      await expect(page.getByTestId('viewer-role')).toHaveAttribute('data-role', 'cm');
      await expect(page.getByTestId('viewer-role')).toHaveText('Member');
      await expect(page.getByText('SANDBOX')).toHaveCount(0);
    }
    await expect(pm.getByTestId('viewer')).toContainText('Chris Hale');
    await expect(cm.getByTestId('viewer')).toContainText('Deepak Jayaram');

    // Everyone starts on Task, Crew and Schedule, with no money on screen; both are offered the money columns.
    const costPlan = (page: Page) => page.locator('.b-gantt .b-grid-cell[data-column-id="cost-plan"]');
    const craneCost = (page: Page) => page.locator('.b-gantt .b-grid-row[data-id="15"] .b-grid-cell[data-column-id="cost-plan"]');
    for (const page of [pm, cm]) {
      const headers = await ganttHeaders(page).allTextContents();
      for (const column of COST_COLUMNS) expect(headers, `${column} must not show on load`).not.toContain(column);
      await expect(costPlan(page)).toHaveCount(0);
      await page.getByTestId('column-picker-button').click();
      await expect(page.getByTestId('column-option-schedule-when')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('column-option-cost-plan')).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByTestId('column-option-cost-actual')).toHaveAttribute('aria-checked', 'false');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('column-picker')).toHaveCount(0);
      await setColumns(page, ['cost-plan', 'cost-actual'], true);
      const shown = await ganttHeaders(page).allTextContents();
      for (const column of COST_COLUMNS) expect(shown, `${column} must show once picked`).toContain(column);
      await expect(craneCost(page)).toContainText('$98,400');
      await expect(craneCost(page)).toContainText('of $96,000 budget');
    }
    await Promise.all([shot(pm, '01a-pm-costs'), shot(cm, '02a-cm-costs')]);
    for (const page of [pm, cm]) {
      await setColumns(page, ['cost-plan', 'cost-actual'], false);
      await expect(costPlan(page)).toHaveCount(0);
    }

    // Both get the crane task's Costs tab in the side panel: budget, forecast and the idle rental on top.
    for (const page of [pm, cm]) {
      await nameCell(page, 15).click();
      await expect(page.getByTestId('task-inspector')).toHaveAttribute('data-task-id', '15');
      await page.getByTestId('task-tab-money').click();
      await expect(page.getByTestId('cost-statement')).toContainText('$96,000.00');
      await expect(page.getByTestId('cost-statement')).toContainText('$98,400.00');
      await expect(page.getByTestId('cost-variance')).toContainText('$2,400.00 over');
    }

    // Both see the seed: phases, the crane task, the crane's time on site beside its work and the crew
    // workload. Nothing on load says the plan is wrong: no rule is watching yet.
    for (const page of [pm, cm]) {
      await expect(nameCell(page, 200)).toHaveText('Foundations & steel frame');
      await expect(nameCell(page, 15)).toHaveText('Erect structural steel frame');
      expect(await page.locator('.b-gantt .b-gantt-task-wrap').count()).toBeGreaterThan(10);
      await expect(page.getByTestId('attention-count')).toHaveCount(0);
      // Bars render only inside the visible time span; fitting the project brings the crane's into view.
      await page.getByTestId('zoom-fit').click();
      await expect(page.locator('.b-gantt .b-indicator.look-rental-band[data-task-record-id="15"]')).toHaveCount(1);
      await page.getByTestId('gantt-view').click();
      await page.getByTestId('toggle-crew-workload').click();
      await expect(page.locator('.b-resource-histogram')).toBeVisible();
    }
    // Deepak adds the idle-rental recipe: now both have one thing to look at, and both see what the idle
    // days cost.
    await cm.getByTestId('inspector-tab-alerts').click();
    await cm.getByTestId('watch-part-rules').click();
    await cm.getByTestId('watch-recipe-add-idle-rental').click();
    for (const page of [pm, cm]) await expect(page.getByTestId('attention-count')).toContainText('1 thing to look at');
    await pm.getByTestId('inspector-tab-alerts').click();
    for (const page of [pm, cm]) {
      await page.getByTestId('watch-part-now').click();
      await expect(page.getByTestId('alert-item')).toContainText('Crane booked 4 days');
      await expect(page.getByTestId('alert-item')).toContainText('$');
    }
    await expectSameRows(pm, cm, ['100', '200', '211', '15']);
    await Promise.all([shot(pm, '01-pm-gantt'), shot(cm, '02-cm-gantt')]);
  });

  test('a concurrent add-task and move-task converge in both browsers within about two seconds', async () => {
    const stamp = Date.now().toString(36);
    const pmTaskName = `PM task ${stamp}`;
    const cmRename = `Break out yard slab (CM ${stamp})`;
    // Steel fabrication (232) heads the chain 232 → 233 → 234 → 15 (crane erection); moving it makes the
    // engine reschedule every successor, and those consequences must arrive in the other browser.
    const moved = '232';
    const chain = ['232', '233', '234', '15'];
    const before = await renderedRows(cm);
    const originalStart = parseCellDate(before[moved]!.split('|')[1]!);
    const movedStart = addDays(originalStart, 2); // Monday to Wednesday: working days in both calendars

    const started = Date.now();
    const [newId] = await Promise.all([addTaskBelow(pm, 213), setTaskStart(cm, moved, movedStart)]);
    await Promise.all([renameTask(pm, newId, pmTaskName), renameTask(cm, 211, cmRename)]);

    await Promise.all([
      expect(nameCell(cm, newId)).toHaveText(pmTaskName, { timeout: PROPAGATION_MS }),
      expect(nameCell(pm, 211)).toHaveText(cmRename, { timeout: PROPAGATION_MS }),
      expect(startCell(pm, moved)).toHaveText(formatCellDate(movedStart), { timeout: PROPAGATION_MS }),
    ]);
    console.log(`both browsers show all changes after ${Date.now() - started} ms (new task id ${newId})`);

    await expect(badge(pm)).toHaveAttribute('data-sync-status', 'synced');
    await expect(badge(cm)).toHaveAttribute('data-sync-status', 'synced');
    await expectSameRows(pm, cm, ['211', '213', newId, ...chain]);
    const after = await renderedRows(pm);
    for (const id of chain) {
      expect(after[id], `task ${id} must have been rescheduled by the move of task ${moved}`).not.toBe(before[id]);
    }
    await Promise.all([shot(pm, '03-pm-after-concurrent-edits'), shot(cm, '04-cm-after-concurrent-edits')]);

    // Move task 232 back so the seed schedule (and the crane booking narrative) survives repeated runs.
    await setTaskStart(cm, moved, originalStart);
    await expect(startCell(pm, moved)).toHaveText(formatCellDate(originalStart), { timeout: PROPAGATION_MS });
    await expectSameRows(pm, cm, chain);
    const restored = await renderedRows(pm);
    for (const id of chain) {
      expect(restored[id], `task ${id} must be back on its seed dates`).toBe(before[id]);
    }
  });

  test('a reloaded browser rebuilds from snapshot + catch-up and matches the other', async () => {
    // The column layout is the viewer's own and survives the reload.
    await setColumns(cm, ['cost-plan', 'cost-actual'], true);
    const started = Date.now();
    await cm.reload();
    await waitForWorkspace(cm);
    console.log(`cm reloaded into a synced workspace in ${Date.now() - started} ms`);
    await expect(cm.getByTestId('viewer-role')).toHaveAttribute('data-role', 'cm');
    expect(await ganttHeaders(cm).allTextContents()).toEqual(expect.arrayContaining(COST_COLUMNS));
    await setColumns(cm, ['cost-plan', 'cost-actual'], false);
    await expectSameRows(pm, cm, ['211', '212', '214']);
    await shot(cm, '05-cm-after-reload');
  });

  test('an offline edit is queued (pending) and converges after reconnect (synced)', async () => {
    const stamp = Date.now().toString(36);
    const offlineName = `Rebar & bolts (offline ${stamp})`;

    await pmContext.setOffline(true);
    await renameTask(pm, 214, offlineName);
    await expect(badge(pm)).toHaveAttribute('data-sync-status', 'pending', { timeout: 10_000 });
    await expect(badge(pm)).toContainText('pending');
    await shot(pm, '06-pm-offline-pending');
    await expect(nameCell(cm, 214)).not.toHaveText(offlineName);

    const reconnected = Date.now();
    await pmContext.setOffline(false);
    await expect(badge(pm)).toHaveAttribute('data-sync-status', 'synced', { timeout: RECOVERY_MS });
    await expect(nameCell(cm, 214)).toHaveText(offlineName, { timeout: RECOVERY_MS });
    console.log(`offline edit delivered ${Date.now() - reconnected} ms after reconnect`);
    await expectSameRows(pm, cm, ['211', '212', '214']);
    await Promise.all([shot(pm, '07-pm-after-reconnect'), shot(cm, '08-cm-after-reconnect')]);

    expect(pageErrors).toEqual([]);
  });
});

const RIVERSIDE = { id: SEED_IDS.project, name: 'Riverside Clinic' };
const CEDAR = { id: CEDAR_IDS.project, name: 'Cedar Park Clinic' };
/** The build-out of three office floors: three floor phases and Completion, 30 tasks in all, nothing rented. */
const HARBOR = { id: HARBOR_IDS.project, name: 'Harbor Street Offices', tasks: 30 };

/** Every task of the open plan, phases included, read from the project's own task store. */
async function taskCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const gantt = (globalThis as { bryntum?: { fromElement(element: Element | null): any } }).bryntum!.fromElement(document.querySelector('.b-gantt'));
    let count = 0;
    gantt.project.taskStore.traverse((record: { isRoot?: boolean }) => {
      if (!record.isRoot) count++;
    });
    return count;
  });
}

/** A project has opened in this page: its name in the header and the tab title, its plan synced and drawn. */
async function waitForProject(page: Page, name: string): Promise<void> {
  await expect(page).toHaveTitle(`${name} · Gantry`, { timeout: BOOT_MS });
  await expect(page.getByTestId('project-overview-button').locator('h1')).toHaveText(name);
  await expect(badge(page)).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  await expect(page.locator('.b-gantt .b-gantt-task-wrap').first()).toBeVisible({ timeout: BOOT_MS });
}

test.describe('one browser: the crew panes under the plan and the project switcher', () => {
  test.describe.configure({ mode: 'serial' });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // These checks' browsers start on the fixture (playwright.config.ts).
    context = await browser.newContext();
    page = await context.newPage();
    await signIn(page, PM);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('the View menu opens and closes the crew workload and the crew schedule under the plan', async () => {
    const view = page.getByTestId('gantt-view');
    const workload = page.getByTestId('toggle-crew-workload');
    const schedule = page.getByTestId('toggle-crew-schedule');
    const pane = page.locator('.collab-histogram-pane');
    // Nothing sits under the plan until someone asks for it.
    await expect(pane).toHaveCount(0);
    await view.click();
    await expect(page.getByRole('group', { name: 'Crew views' })).toContainText('Under the plan');
    await expect(workload).toHaveAttribute('aria-checked', 'false');
    await expect(schedule).toHaveAttribute('aria-checked', 'false');

    // Crew workload: how busy each crew is, under the plan's own time axis.
    await workload.click();
    await expect(workload).toHaveAttribute('aria-checked', 'true');
    await expect(pane.locator('.b-resource-histogram')).toBeVisible();
    await expect(page.getByTestId('crew-pane-workload')).toHaveAttribute('aria-selected', 'true');

    // Crew schedule takes its place: each crew's tasks on its own row.
    await schedule.click();
    await expect(schedule).toHaveAttribute('aria-checked', 'true');
    await expect(workload).toHaveAttribute('aria-checked', 'false');
    await expect(pane.locator('.crew-schedule')).toBeVisible();
    await expect(pane.locator('.b-resource-histogram')).toHaveCount(0);
    await expect(page.getByTestId('crew-pane-schedule')).toHaveAttribute('aria-selected', 'true');

    // Switched off in the menu: nothing under the plan again.
    await schedule.click();
    await expect(schedule).toHaveAttribute('aria-checked', 'false');
    await expect(pane).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(workload).toHaveCount(0);

    // The pane's own close button does the same, and the menu says so.
    await view.click();
    await workload.click();
    await page.keyboard.press('Escape');
    await expect(workload).toHaveCount(0);
    await expect(pane.locator('.b-resource-histogram')).toBeVisible();
    await page.getByTestId('close-crew-pane').click();
    await expect(pane).toHaveCount(0);
    await view.click();
    await expect(workload).toHaveAttribute('aria-checked', 'false');
    await expect(schedule).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(workload).toHaveCount(0);
  });

  test('the project menu offers Harbor alone, links open the others, and the browser remembers the last one', async () => {
    resetDemoProject(HARBOR.id);
    const rentalsTab = page.getByTestId('inspector-tab-rentals');
    // Harbor Street Offices is the one listed project: with nothing to switch to, the project card lists no projects.
    const noProjectList = async () => {
      await page.getByTestId('project-overview-button').click();
      await expect(page.getByTestId('project-overview')).toBeVisible();
      await expect(page.getByTestId('project-list')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('project-overview')).toHaveCount(0);
    };

    // The fixture is reached by link only, and so is Cedar Park Clinic.
    await waitForProject(page, RIVERSIDE.name);
    await expect(rentalsTab).toHaveAttribute('aria-label', 'Rentals');
    await noProjectList();

    await page.goto(`/?project=${HARBOR.id}`);
    await expect(page).toHaveURL(new RegExp(`[?&]project=${HARBOR.id}`), { timeout: BOOT_MS });
    // Harbor Street Offices: its own plan (30 tasks, nothing rented, so no Rentals) and tab title.
    await waitForProject(page, HARBOR.name);
    await expect.poll(() => taskCount(page)).toBe(HARBOR.tasks);
    await expect(nameCell(page, 100)).toHaveText('Level 1 build-out');
    await expect(page.getByTestId('inspector-tab-task')).toBeVisible();
    await expect(rentalsTab).toHaveCount(0);

    // Reloaded, and opened again without naming a project: the browser remembers Harbor.
    await page.reload();
    await waitForProject(page, HARBOR.name);
    await page.goto('/');
    await waitForProject(page, HARBOR.name);
    await expect.poll(() => taskCount(page)).toBe(HARBOR.tasks);
    await expect(rentalsTab).toHaveCount(0);

    // On to Cedar Park Clinic by its link, which the browser then remembers in turn; a link still opens the fixture.
    await noProjectList();
    await page.goto(`/?project=${CEDAR.id}`);
    await expect(page).toHaveURL(new RegExp(`[?&]project=${CEDAR.id}`), { timeout: BOOT_MS });
    await waitForProject(page, CEDAR.name);
    await expect(nameCell(page, 100)).toHaveText('Site & foundations');
    await page.goto('/');
    await waitForProject(page, CEDAR.name);
    await page.goto(`/?project=${RIVERSIDE.id}`);
    await waitForProject(page, RIVERSIDE.name);
    await expect(nameCell(page, 100)).toHaveText('Site setup & demolition');
  });
});

/**
 * The Equipment cell and its editor, through the real UI on the test project: a machine on a task always
 * shows its own dates and draws its outline, double-click edits them on that task for everyone, undo and
 * redo work, and the machine can be taken off the task. Also the date picker every date field uses.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { riversideClinic } from '../../packages/shared/src/seed/index.ts';
import { resetDemoProject } from './demo-reset';

const CM = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
const PM = { email: process.env.E2E_PM_EMAIL ?? 'pm@demo.local', password: process.env.E2E_PM_PASSWORD ?? 'demo-pm-2026' };
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? path.join('test-results', 'screenshots');
const BOOT_MS = 90_000;
const TASK = riversideClinic.booking.task_id;

const editor = (page: Page) => page.locator('.look-rental-editor');
const NEXT_TASK = 242;
/** Riverside's concrete pump is on this task with no rental booked. */
const PUMP_TASK = 215;
const cellOf = (page: Page, id: number) => page.locator(`.b-gantt .b-grid-row[data-id="${id}"] .b-grid-cell[data-column-id="equipment"]`);
const cell = (page: Page) => cellOf(page, TASK);
/** The outline Bryntum draws on a task's row, once the bar's dates are in view. */
const outline = (page: Page, id: number) => page.locator(`.b-gantt .b-indicator.look-rental-band[data-task-record-id="${id}"]`);
const dateField = (page: Page, label: string) => editor(page).getByLabel(label, { exact: true });

async function signIn(browser: Browser, who: typeof CM): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  await expect(cell(page)).toContainText('Crane', { timeout: BOOT_MS });
  return page;
}

async function typeDate(page: Page, label: string, text: string): Promise<void> {
  const field = dateField(page, label);
  await field.fill(text);
  await field.press('Tab');
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
test.beforeEach(() => resetDemoProject());
test.afterAll(() => resetDemoProject());

test('double-clicking the Equipment cell edits the rental for everyone', async ({ browser }) => {
  const page = await signIn(browser, CM);
  const other = await signIn(browser, PM);
  await expect(cell(page)).toContainText('Dec 7–17');

  await cell(page).dblclick();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toContainText('Crane');
  await expect(editor(page)).toContainText('Rental from Northgate Equipment Rental');
  await expect(dateField(page, 'Start date')).toHaveValue('Dec 7, 2026');
  await expect(dateField(page, 'End date')).toHaveValue('Dec 17, 2026');
  await page.screenshot({ path: path.join(SHOTS, 'rental-editor-open.png') });

  // The facts follow the dates before anything is saved.
  await typeDate(page, 'Start date', 'Dec 14, 2026');
  await typeDate(page, 'End date', 'Dec 16, 2026');
  await expect(editor(page)).toContainText('3 rental days');
  await expect(editor(page)).toContainText('$1,800');
  await expect(cell(page)).toContainText('Dec 7–17');
  await page.screenshot({ path: path.join(SHOTS, 'rental-editor-edited.png') });

  // A start after the end brings the end along.
  await typeDate(page, 'Start date', 'Dec 21, 2026');
  await expect(dateField(page, 'End date')).toHaveValue('Dec 21, 2026');
  await expect(editor(page)).toContainText('1 rental day');

  await typeDate(page, 'Start date', 'Dec 14, 2026');
  await typeDate(page, 'End date', 'Dec 16, 2026');
  await editor(page).getByRole('button', { name: 'Save' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(cell(page)).toContainText('Dec 14–16');
  await expect(cell(other)).toContainText('Dec 14–16');

  // It stays after a reload.
  await page.reload();
  await expect(cell(page)).toContainText('Dec 14–16', { timeout: BOOT_MS });

  // Cancel leaves it alone.
  await cell(page).dblclick();
  await typeDate(page, 'End date', 'Dec 18, 2026');
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(cell(page)).toContainText('Dec 14–16');

  // The history says who changed it.
  await page.getByTestId('inspector-tab-history').click();
  await expect(page.getByTestId('changelog-panel')).toContainText('changed the dates of Crane on Erect structural steel frame');
  await page.screenshot({ path: path.join(SHOTS, 'rental-editor-history.png') });

  await page.context().close();
  await other.context().close();
});

test('the keyboard opens and saves it, dates that make no sense cannot be saved, and an empty cell stays shut', async ({ browser }) => {
  const page = await signIn(browser, CM);
  await cell(page).click();
  await page.keyboard.press('F2');
  await expect(editor(page)).toBeVisible();

  await typeDate(page, 'End date', 'Dec 1, 2026');
  await expect(editor(page).getByRole('alert')).toContainText('The end date cannot be before the start date.');
  await expect(editor(page).getByRole('button', { name: 'Save' })).toBeDisabled();

  await dateField(page, 'End date').fill('Dec 16, 2026');
  await dateField(page, 'End date').press('Enter');
  await expect(editor(page)).toBeHidden();
  await expect(cell(page)).toContainText('Dec 7–16');

  // A task with no equipment has nothing to edit.
  await page.locator('.b-gantt .b-grid-row', { hasText: 'Cure spread' }).first().locator('[data-column-id="equipment"]').dblclick();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
  await page.context().close();
});

test('a machine on another task has its own dates and outline, and can come off the task', async ({ browser }) => {
  const page = await signIn(browser, CM);
  await page.getByTestId('zoom-fit').click();
  await expect(cellOf(page, NEXT_TASK)).not.toContainText('Crane');
  await expect(outline(page, TASK)).toHaveCount(1);
  await expect(outline(page, NEXT_TASK)).toHaveCount(0);

  // The crane goes on a second task: it shows there too, going by that task's days.
  await page.evaluate(
    ([event, resource]) => {
      const gantt = (globalThis as unknown as { bryntum: { fromElement(element: Element): { project: { assignmentStore: { add(data: object): void } } } } }).bryntum.fromElement(document.querySelector('.b-gantt')!);
      gantt.project.assignmentStore.add({ event, resource, units: 100 });
    },
    [NEXT_TASK, riversideClinic.booking.resource_id],
  );
  await expect(cellOf(page, NEXT_TASK)).toContainText('Dec 18–21');
  await expect(cell(page)).toContainText('Dec 7–17');
  await expect(outline(page, NEXT_TASK)).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, 'rental-outline-both.png') });

  // Saved from here, only this task changes, and the rental on the other task is untouched.
  await cellOf(page, NEXT_TASK).dblclick();
  await expect(editor(page)).toContainText('No rental booked for this task');
  await typeDate(page, 'End date', 'Dec 22, 2026');
  await editor(page).getByRole('button', { name: 'Save' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(cellOf(page, NEXT_TASK)).toContainText('Dec 18–22');
  await expect(cell(page)).toContainText('Dec 7–17');

  // Remove from task: gone from this one, and still on the other.
  await cellOf(page, NEXT_TASK).dblclick();
  await editor(page).getByRole('button', { name: 'Remove from task' }).click();
  await expect(cellOf(page, NEXT_TASK)).not.toContainText('Crane');
  await expect(outline(page, NEXT_TASK)).toHaveCount(0);
  await expect(cell(page)).toContainText('Dec 7–17');
  await expect(outline(page, TASK)).toHaveCount(1);

  // Delete on the cell does the same.
  await cell(page).click();
  await page.keyboard.press('Delete');
  await expect(cell(page)).not.toContainText('Crane');
  await expect(outline(page, TASK)).toHaveCount(0);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
  await page.context().close();
});

test('a machine with no rental has dates of its own too, and undo puts it back on the task’s days', async ({ browser }) => {
  const page = await signIn(browser, CM);
  await page.getByTestId('zoom-fit').click();
  const pump = cellOf(page, PUMP_TASK);
  await expect(pump).toContainText('Nov 19');
  await expect(outline(page, PUMP_TASK)).toHaveCount(1);

  await pump.dblclick();
  await expect(editor(page)).toContainText('No rental booked for this task');
  await expect(dateField(page, 'End date')).toBeEnabled();
  await expect(editor(page).getByRole('button', { name: 'Remove from task' })).toBeEnabled();
  await page.screenshot({ path: path.join(SHOTS, 'rental-editor-no-rental.png') });
  await typeDate(page, 'End date', 'Nov 20, 2026');
  await editor(page).getByRole('button', { name: 'Save' }).click();
  await expect(pump).toContainText('Nov 19–20');

  await page.getByTestId('gantt-undo').click();
  await expect(pump).toContainText('Nov 19');
  await expect(pump).not.toContainText('Nov 19–20');
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
  await page.context().close();
});

test('the date picker is an even grid, and every date stays readable under the pointer', async ({ browser }) => {
  const page = await signIn(browser, CM);
  await cell(page).dblclick();
  await expect(editor(page)).toBeVisible();
  const field = editor(page).locator('.b-field', { hasText: 'Start date' }).first();
  await dateField(page, 'Start date').focus();
  // The field's own border is the focus ring: nothing extra around the input beside the calendar icon.
  await expect(dateField(page, 'Start date')).toHaveCSS('box-shadow', 'none');
  await field.locator('.b-field-trigger:visible').first().click();
  const picker = page.locator('.b-date-picker:visible').last();
  await expect(picker).toBeVisible();

  // No gaps: a date fills its cell, and the cells touch across and down.
  const layout = await picker.evaluate((element) => {
    const cells = [...element.querySelectorAll('.b-calendar-panel-cell')];
    const box = (cell: Element) => cell.getBoundingClientRect();
    return { insets: cells.map((cell) => box(cell).width - box(cell.querySelector('.b-date-picker-cell-inner')!).width), across: box(cells[1]!).left - box(cells[0]!).right, down: box(cells[7]!).top - box(cells[0]!).bottom };
  });
  expect(Math.max(...layout.insets)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(layout.across)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(layout.down)).toBeLessThanOrEqual(0.5);

  // The chosen day's number used to take its background's color under the pointer.
  for (const target of ['.b-selected-date', '.b-calendar-panel-cell:not(.b-selected-date):not(.b-non-working-day):not(.b-other-month)']) {
    const date = picker.locator(target).first();
    await date.hover();
    const colors = await date.evaluate((element) => {
      const inner = getComputedStyle(element.querySelector('.b-date-picker-cell-inner')!);
      return { text: inner.color, background: inner.backgroundColor };
    });
    expect(colors.text).not.toBe(colors.background);
  }
  await picker.screenshot({ path: path.join(SHOTS, 'rental-picker.png') });

  // Picking a date leaves no stray line either.
  await picker.locator('.b-calendar-panel-cell:not(.b-selected-date):not(.b-non-working-day):not(.b-other-month)').nth(3).click();
  await expect(dateField(page, 'Start date')).toHaveCSS('box-shadow', 'none');
  await field.screenshot({ path: path.join(SHOTS, 'rental-field-after-pick.png') });
  await page.context().close();
});

test('rental dates are plan changes: numbered in the history, undone and redone for everyone', async ({ browser }) => {
  const page = await signIn(browser, CM);
  const other = await signIn(browser, PM);
  const undoButton = page.getByTestId('gantt-undo');
  const redoButton = page.getByTestId('gantt-redo');
  await expect(cell(page)).toContainText('Dec 7–17');
  await expect(undoButton).toBeDisabled();

  await cell(page).dblclick();
  await typeDate(page, 'End date', 'Dec 16, 2026');
  await editor(page).getByRole('button', { name: 'Save' }).click();
  await expect(cell(page)).toContainText('Dec 7–16');
  await expect(cell(other)).toContainText('Dec 7–16');
  await expect(undoButton).toBeEnabled();
  await expect(undoButton).toHaveAttribute('title', /Change Crane dates/);

  await undoButton.click();
  await expect(cell(page)).toContainText('Dec 7–17');
  await expect(cell(other)).toContainText('Dec 7–17');
  await expect(redoButton).toBeEnabled();

  await redoButton.click();
  await expect(cell(page)).toContainText('Dec 7–16');
  await expect(cell(other)).toContainText('Dec 7–16');

  // A task's edit and a rental's edit come back in the order they were made.
  await page.locator(`.b-gantt .b-grid-row[data-id="${NEXT_TASK}"] .b-grid-cell[data-column-id="schedule-when"]`).dblclick();
  await page.locator('.look-schedule-editor').getByLabel('Working days', { exact: true }).fill('3');
  await page.locator('.look-schedule-editor').getByRole('button', { name: 'Save' }).click();
  await expect(undoButton).toHaveAttribute('title', /Edit schedule/);
  await undoButton.click();
  await expect(undoButton).toHaveAttribute('title', /Change Crane dates/);
  await expect(cell(page)).toContainText('Dec 7–16');
  await undoButton.click();
  await expect(cell(page)).toContainText('Dec 7–17');
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');

  // Each step is its own numbered change, and it stays after a reload.
  await redoButton.click();
  await expect(cell(page)).toContainText('Dec 7–16');
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
  await page.reload();
  await expect(cell(page)).toContainText('Dec 7–16', { timeout: BOOT_MS });
  await page.getByTestId('inspector-tab-history').click();
  await expect(page.getByTestId('changelog-panel')).toContainText('changed the dates of Crane on Erect structural steel frame');
  await expect(page.getByTestId('changelog-panel')).toContainText(/change #\d+/);
  await page.screenshot({ path: path.join(SHOTS, 'rental-history-revisions.png') });
  await page.context().close();
  await other.context().close();
});

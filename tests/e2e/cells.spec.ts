/**
 * The fill handle and Delete on collapsed cells, in the browser: dragging a Schedule cell's fill
 * handle down gives the cells below its length and progress (their starts stay where their links put
 * them, and the plan says so), Delete over Schedule cells takes the progress back, and the money cell
 * (Budget · Forecast) fills and clears both amounts. Starts from, and restores, the seed (the demo reset).
 * Runs against the local Supabase stack with the seeded demo accounts (docs/SETUP.md).
 */
import { expect, test, type Page } from '@playwright/test';
import { resetDemoProject } from './demo-reset';

const CM = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
const BOOT_MS = 90_000;
/** Break out yard slab (2 days, 50% done), then Excavate and Inspect, each waiting for the one above. */
const [SOURCE, NEXT, AFTER] = [211, 212, 213];

const cell = (page: Page, id: number, column: string) => page.locator(`.b-gantt .b-grid-row[data-id="${id}"] .b-grid-cell[data-column-id="${column}"]`);
const days = (page: Page, id: number) => cell(page, id, 'schedule-when').locator('.look-when-days');
const progress = (page: Page, id: number) => cell(page, id, 'schedule-when').locator('.look-progress-value');

/** Drags the fill handle of the selected cells down to the row of `toId`. */
async function dragFillHandle(page: Page, toId: number, column: string): Promise<void> {
  const handle = await page.locator('.b-fill-handle-handle').first().boundingBox();
  const target = await cell(page, toId, column).boundingBox();
  if (!handle || !target) throw new Error('fill handle or target cell not on screen');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.describe.serial('fill handle and Delete on collapsed cells', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    resetDemoProject();
    // Wide enough for the money column to sit fully inside the grid, fill handle included.
    page = await (await browser.newContext({ viewport: { width: 1920, height: 1000 } })).newPage();
    await page.goto('/');
    await page.locator('input[name="email"]').fill(CM.email);
    await page.locator('input[name="password"]').fill(CM.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await expect(cell(page, SOURCE, 'schedule-when')).toBeVisible({ timeout: BOOT_MS });
  });

  test.afterAll(async () => {
    await page?.context().close();
    resetDemoProject();
  });

  test('filling Schedule cells down copies length and progress; links keep the starts', async () => {
    await expect(days(page, SOURCE)).toHaveText('2d');
    await expect(progress(page, SOURCE)).toHaveText('50%');
    await expect(days(page, NEXT)).not.toHaveText('2d');
    await cell(page, SOURCE, 'schedule-when').click();
    await dragFillHandle(page, AFTER, 'schedule-when');
    for (const id of [NEXT, AFTER]) {
      await expect(days(page, id)).toHaveText('2d');
      await expect(progress(page, id)).toHaveText('50%');
    }
    await expect(page.getByTestId('gantt-cell-notice')).toHaveText('Filled 2 cells · 2 tasks stay later: they wait for earlier work');
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
  });

  test('Delete over Schedule cells takes the progress back, as one change', async () => {
    await cell(page, NEXT, 'schedule-when').click();
    await cell(page, AFTER, 'schedule-when').click({ modifiers: ['Shift'] });
    await page.keyboard.press('Delete');
    for (const id of [NEXT, AFTER]) await expect(progress(page, id)).toHaveText('0%');
    // The lengths are the task's, not something to clear.
    await expect(days(page, NEXT)).toHaveText('2d');
    await expect(page.getByTestId('gantt-cell-notice')).toHaveText('Cleared 2 cells');
  });

  test('the money cell fills and clears both amounts', async () => {
    await page.getByTestId('column-picker-button').click();
    await page.getByTestId('column-option-cost-plan').click();
    await page.keyboard.press('Escape');
    const money = (id: number) => cell(page, id, 'cost-plan');
    await expect(money(SOURCE)).toBeVisible();
    const sourceText = (await money(SOURCE).locator('.look-cost-value').textContent()) ?? '';
    const budgetText = (await money(SOURCE).locator('.look-cost-sub').textContent()) ?? '';
    await money(SOURCE).click();
    await dragFillHandle(page, NEXT, 'cost-plan');
    await expect(money(NEXT).locator('.look-cost-value')).toHaveText(sourceText);
    await expect(money(NEXT).locator('.look-cost-sub')).toHaveText(budgetText);

    await money(NEXT).click();
    await page.keyboard.press('Delete');
    await expect(money(NEXT).locator('.look-cost-value')).toHaveText('$0');
    await expect(page.getByTestId('gantt-cell-notice')).toHaveText('Cleared 1 cell');
  });
});

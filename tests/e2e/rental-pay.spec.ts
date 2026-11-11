/**
 * A rental in two browsers, from the demo reset to the payout. Its dates are the deal: Deepak changes them by hand on the
 * task, with nothing to approve; Chris sees them and what they come to at once; Undo takes them back and Redo puts them on
 * again; a working day of cover either side is called cover, not idle; and Pay pays what the dates say: Review payment,
 * then Send payout.
 *
 * The payout's outcome depends on the Edge Functions (`pnpm functions:serve`) and the sandbox's balance: E2E_PAYOUT=succeeded
 * requires PayPal to report it paid; the default accepts any genuine outcome and checks the receipt when it is paid.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { resetDemoProject } from './demo-reset';

const PM = { email: process.env.E2E_PM_EMAIL ?? 'pm@demo.local', password: process.env.E2E_PM_PASSWORD ?? 'demo-pm-2026' };
const CM = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? path.join('test-results', 'screenshots');
const PAYOUT = process.env.E2E_PAYOUT ?? 'any';
const BOOT_MS = 90_000;
const STEP_MS = 30_000;
const CRANE_TASK = 15;

async function openWorkspace(browser: Browser, who: typeof CM): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  return page;
}

const nameCell = (page: Page, id: number) => page.locator(`.b-gantt .b-grid-row[data-id="${id}"] .b-grid-cell[data-column="name"]`).first();
const equipmentCell = (page: Page) => page.locator(`.b-gantt .b-grid-row[data-id="${CRANE_TASK}"] .b-grid-cell[data-column-id="equipment"]`).first();
const craneRow = (page: Page) => page.locator('[data-testid="rentals-row"][data-equipment="Crane"]');

async function openEquipment(page: Page): Promise<void> {
  await page.getByTestId('gantt-search').fill('Erect structural');
  await nameCell(page, CRANE_TASK).click();
  await expect(page.getByTestId('task-inspector')).toHaveAttribute('data-task-id', String(CRANE_TASK));
  await page.getByTestId('task-tab-equipment').click();
  await expect(page.getByTestId('task-equipment-facts')).toBeVisible();
}

async function typeDate(page: Page, testId: string, text: string): Promise<void> {
  const input = page.locator(`[data-testid="${testId}"] input`);
  await input.click();
  await input.fill(text);
  await input.press('Tab');
}

test.beforeAll(() => {
  resetDemoProject();
  mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(() => resetDemoProject());

test('new dates by hand are the fix, Undo takes them back, and Pay pays what they say', async ({ browser }) => {
  test.setTimeout(240_000);
  const cm = await openWorkspace(browser, CM);
  const pm = await openWorkspace(browser, PM);
  await openEquipment(cm);
  await pm.getByTestId('inspector-tab-rentals').click();
  await expect(craneRow(pm)).toContainText('Mon, Dec 7 to Thu, Dec 17');

  await test.step('as booked: every day on rent is paid, and the days before the work are idle', async () => {
    await expect(cm.getByTestId('task-equipment-facts')).toContainText('11 days');
    await expect(cm.getByTestId('task-equipment-facts')).toContainText('$6,600');
    await expect(cm.getByTestId('task-equipment-idle')).toHaveText('4 days: 4 before, 0 after ($2,400)');
    // The Sunday inside the work is paid, and nobody can date it away.
    await expect(cm.getByTestId('task-equipment-off')).toContainText('1 day, still on rent ($600)');
  });

  await test.step('a working day either side, by hand: nothing to approve, and everyone sees what it comes to', async () => {
    await typeDate(cm, 'task-equipment-start', 'Dec 10, 2026');
    await typeDate(cm, 'task-equipment-end', 'Dec 18, 2026');
    await expect(cm.getByTestId('task-equipment-facts')).toContainText('9 days', { timeout: STEP_MS });
    await expect(cm.getByTestId('task-equipment-facts')).toContainText('$5,400');
    await expect(cm.getByTestId('task-equipment-facts')).toContainText('Cover around the work');
    await expect(cm.getByTestId('task-equipment-idle')).toContainText('2 days: 1 before, 1 after');
    await expect(cm.getByTestId('task-equipment-pay')).toBeVisible();
    await expect(equipmentCell(cm)).toContainText('Dec 10–18');
    await expect(craneRow(pm)).toContainText('Thu, Dec 10 to Fri, Dec 18', { timeout: STEP_MS });
    await expect(craneRow(pm).getByTestId('rentals-row-saved')).toHaveText('$1,200.00 less than quoted');
    await cm.screenshot({ path: path.join(SHOTS, 'rental-pay-1-by-hand.png') });
  });

  await test.step('Undo takes them back and Redo puts them on again, for everyone', async () => {
    await cm.getByTestId('gantt-undo').click();
    await expect(equipmentCell(cm)).toContainText('Dec 10–17', { timeout: STEP_MS });
    await cm.getByTestId('gantt-undo').click();
    await expect(equipmentCell(cm)).toContainText('Dec 7–17', { timeout: STEP_MS });
    await expect(craneRow(pm)).toContainText('Mon, Dec 7 to Thu, Dec 17', { timeout: STEP_MS });
    await cm.getByTestId('gantt-redo').click();
    await cm.getByTestId('gantt-redo').click();
    await expect(equipmentCell(cm)).toContainText('Dec 10–18', { timeout: STEP_MS });
    await expect(craneRow(pm)).toContainText('Thu, Dec 10 to Fri, Dec 18', { timeout: STEP_MS });
    await expect(cm.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: STEP_MS });
  });

  await test.step('Pay pays those dates, reviewed in PayPal Payouts’ words first', async () => {
    await cm.getByTestId('task-equipment-pay').click();
    const sheet = cm.getByTestId('task-equipment-pay-confirm');
    await expect(sheet).toHaveAttribute('data-phase', 'review');
    await expect(sheet).toContainText('Review your payment details');
    await expect(cm.getByTestId('task-equipment-pay-line')).toContainText('Northgate Equipment Rental$5,400.00to their PayPal account');
    await expect(cm.getByTestId('task-equipment-pay-fee')).toContainText('$0.25 per payment');
    await expect(cm.getByTestId('task-equipment-pay-total')).toHaveText('$5,400.25');
    await cm.screenshot({ path: path.join(SHOTS, 'rental-pay-2-confirm.png') });
    await cm.getByTestId('task-equipment-pay-confirmed').click();
    // PayPal took the payout (the sheet follows it), or the app said why it couldn't send it.
    const outcome = cm.locator('[data-testid="task-equipment-pay-confirm"][data-phase="sent"], [data-testid="task-equipment-pay-error"]');
    await expect(outcome.first()).toBeVisible({ timeout: 90_000 });
    // PayPal may say no (an empty sandbox, say). This app may not.
    await expect(cm.getByTestId('task-equipment-pay-error')).toHaveCount(0);
    await cm.screenshot({ path: path.join(SHOTS, 'rental-pay-3-outcome.png') });
    if (PAYOUT === 'succeeded') await expect(cm.getByTestId('task-equipment-pay-paid')).toBeVisible({ timeout: 120_000 });
    if (await cm.getByTestId('task-equipment-pay-paid').isVisible()) {
      await expect(cm.getByTestId('task-equipment-pay-paid')).toContainText('$5,400.00');
      await expect(cm.getByTestId('task-equipment-pay-line')).toContainText('PayPal: Paid');
      await expect(cm.getByTestId('task-equipment-pay-receipt')).toBeVisible({ timeout: STEP_MS });
      await expect(craneRow(pm).getByTestId('rental-pay-paid')).toContainText('PayPal Payouts · Batch ID', { timeout: STEP_MS });
      await cm.getByTestId('task-equipment-pay-close').click();
      await expect(cm.getByTestId('task-equipment-pay-paid')).toContainText('PayPal Payouts · Batch ID');
    }
  });
});

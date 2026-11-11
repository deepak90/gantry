/**
 * The two stories the app is shown with, from a reset project, through the real UI.
 *
 * Cedar Park Clinic: a rule written in plain English finds a rented machine booked twice and two idle;
 * accepting the double booking's fix moves the work, and the idle days with it, but not what they cost; the crane's
 * fix is accepted, the lift's declined, and PayPal pays the two rentals.
 *
 * Harbor Street Offices: a piece of work drafted by the assistant goes to the library, a drag puts it
 * where it belongs between two tasks with no group row over it, the other floors fill by themselves, and a rule prepares the invoices when those floors are finished.
 *
 * The steps in the header follow along, from the project's own data, and "Show me" points at the next thing.
 *
 * Needs the agent service (`pnpm agent:dev`, or AGENT_MODE=mock) and the functions (`pnpm functions:serve`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CEDAR_IDS, HARBOR_IDS } from '../../packages/shared/src/seed/index.ts';

const CM = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? path.join('test-results', 'screenshots');
const BOOT_MS = 90_000;
const TURN_MS = 90_000;
const PAYPAL_MS = 120_000;

function reset(project: string): void {
  execFileSync(process.execPath, ['--env-file-if-exists=.env.local', 'scripts/demo-reset.ts', '--force', '--project', project], { stdio: 'pipe' });
}

async function open(page: Page, project: string): Promise<void> {
  // The other checks hide the steps; these walk them.
  await page.addInitScript(() => window.localStorage.removeItem('collab.first-run.skip'));
  await page.goto(`/?project=${project}`);
  await page.locator('input[name="email"]').fill(CM.email);
  await page.locator('input[name="password"]').fill(CM.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  // The plan opens alone: the rail of tabs is there, and no panel covers a third of the screen.
  await expect(page.getByTestId('inspector-tab-assistant')).toBeVisible({ timeout: BOOT_MS });
  await expect(page.locator('.inspector-panel')).toHaveCount(0);
}

const shot = async (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const chip = (page: Page) => page.getByTestId('assistant-next-chip');
const rail = (page: Page) => page.getByTestId('story-rail-button');
const row = (page: Page, equipment: string): Locator => page.locator(`[data-testid="review-row"][data-equipment="${equipment}"]`);

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test('a rule finds the rentals, one fix changes the next, PayPal pays', async ({ page }) => {
  reset(CEDAR_IDS.project);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, CEDAR_IDS.project);

  // Nothing is flagged until someone asks: no alerts, no overlays, no demo words.
  await expect(page.locator('.app-header')).not.toContainText(/sandbox|demo/i);
  await expect(rail(page)).toContainText('Set a rule on the rentals');
  await shot(page, 'demo1-1-calm');

  // "Show me" points at the next thing right away; a click anywhere puts it away.
  await page.getByTestId('story-rail-button').click();
  await expect(page.getByTestId('story-steps')).toBeVisible();
  await shot(page, 'demo1-1-steps');
  await page.getByTestId('story-steps').getByRole('button', { name: 'Show me' }).click();
  await expect(page.getByTestId('story-coach')).toBeVisible();
  await expect(page.getByTestId('story-coach')).toContainText('Set a rule on the rentals');
  await shot(page, 'demo1-1-coach');
  await page.locator('.app-header').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('story-coach')).toBeHidden();

  // The rule, from plain English, in blocks, with what it would find now.
  await expect(chip(page)).toContainText('rented equipment');
  await chip(page).click();
  const draft = page.getByTestId('assistant-rule-draft');
  await expect(draft).toBeVisible({ timeout: TURN_MS });
  await expect(draft.getByTestId('rule-condition')).toHaveCount(2);
  await expect(page.getByTestId('rule-now')).toContainText('3 things', { timeout: TURN_MS });
  await shot(page, 'demo1-2-rule');
  await page.getByTestId('rule-start').click();

  // One card, three rentals; the excavator is fine and stays out.
  const review = page.getByTestId('assistant-review');
  await expect(review).toBeVisible({ timeout: TURN_MS });
  await expect(review.getByTestId('review-row')).toHaveCount(3, { timeout: TURN_MS });
  await expect(row(page, 'Excavator')).toHaveCount(0);
  await expect(row(page, 'Crane').getByTestId('review-idle-cost')).toHaveText('$4,200');
  await expect(row(page, 'Scissor lift').getByTestId('review-idle-cost')).toHaveText('$1,080');
  await expect(rail(page)).toContainText('Accept a fix');
  await shot(page, 'demo1-3-review');

  // Accepting the double booking moves the work: idle days move from after it to before it, and the total stays.
  await row(page, 'Concrete pump').getByTestId('review-accept').click();
  await expect(row(page, 'Concrete pump')).toHaveAttribute('data-state', 'accepted', { timeout: TURN_MS });
  await expect(row(page, 'Crane').getByTestId('review-idle-cost')).toHaveText('$4,200', { timeout: TURN_MS });
  await expect(row(page, 'Scissor lift').getByTestId('review-idle-cost')).toHaveText('$1,080', { timeout: TURN_MS });
  await expect(page.getByTestId('review-summary')).toContainText('Handover 2 days later');
  await expect(rail(page)).toContainText('Decide the rest');
  await shot(page, 'demo1-4-ripple');

  // After the move the work starts on a Monday, so a day of cover before it would pay for a weekend too: the suggestion leaves it out.
  await expect(row(page, 'Crane').getByTestId('review-suggestion')).toContainText('A working day after');
  await expect(row(page, 'Crane').getByTestId('review-suggestion')).toContainText('9 days, $5,400, saves $3,600');
  await row(page, 'Crane').getByTestId('review-accept').click();
  await expect(row(page, 'Crane')).toHaveAttribute('data-state', 'accepted', { timeout: TURN_MS });
  await expect(page.getByTestId('review-summary')).toContainText('Saved $4,500');
  // It can always be taken back until the money moves, and accepted again.
  await row(page, 'Crane').getByTestId('review-undo').click();
  await expect(row(page, 'Crane')).toHaveAttribute('data-state', 'open', { timeout: TURN_MS });
  await expect(row(page, 'Crane').getByTestId('review-idle-cost')).toHaveText('$4,200', { timeout: TURN_MS });
  await row(page, 'Crane').getByTestId('review-accept').click();
  await expect(row(page, 'Crane')).toHaveAttribute('data-state', 'accepted', { timeout: TURN_MS });
  await row(page, 'Scissor lift').getByTestId('review-decline').click();
  await expect(row(page, 'Scissor lift')).toHaveAttribute('data-state', 'declined', { timeout: TURN_MS });
  await expect(rail(page)).toContainText('Pay with PayPal');
  await shot(page, 'demo1-5-decided');

  // Two firms, reviewed in PayPal Payouts' words, then one press.
  await page.getByTestId('review-pay').click();
  await expect(page.getByTestId('review-pay-confirm')).toContainText('Northgate Equipment Rental');
  await expect(page.getByTestId('review-pay-confirm')).toContainText('Ridgeway Concrete Pumping');
  await expect(page.getByTestId('review-pay-from')).toHaveText("Ashford Builders' PayPal balance");
  await expect(page.getByTestId('review-pay-total')).toHaveText('$6,750.50');
  await shot(page, 'demo1-6-pay');
  await page.getByTestId('review-pay-confirmed').click();
  await expect(row(page, 'Crane')).toHaveAttribute('data-state', 'paid', { timeout: PAYPAL_MS });
  await expect(row(page, 'Concrete pump')).toHaveAttribute('data-state', 'paid', { timeout: PAYPAL_MS });
  await expect(page.getByTestId('review-paid')).toContainText('$6,750');
  await expect(rail(page)).toContainText('Every rental is settled', { timeout: PAYPAL_MS });
  await shot(page, 'demo1-7-paid');
  expect(errors).toEqual([]);
});

test('a piece of work goes across the floors, then the finished floors are billed', async ({ page }) => {
  reset(HARBOR_IDS.project);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, HARBOR_IDS.project);
  await expect(rail(page)).toContainText('Draft a package of work');
  await shot(page, 'demo2-1-waterfall');
  await page.getByTestId('inspector-tab-assistant').click();

  // Drafted by the assistant, saved to the library.
  await expect(chip(page)).toContainText('light fixtures');
  await chip(page).click();
  const draft = page.getByTestId('assistant-card-snippets');
  await expect(draft).toBeVisible({ timeout: TURN_MS });
  await shot(page, 'demo2-2-draft');
  await draft.getByRole('button', { name: 'Save to library' }).click();
  await expect(chip(page)).toContainText('library', { timeout: TURN_MS });
  await expect(rail(page)).toContainText('Drag it onto Level 1');
  await chip(page).click();
  await expect(page.getByTestId('library-panel')).toBeVisible();

  // A drag anywhere on Level 1: the assistant says where it fits, and it goes in when that is pressed.
  const card = page.getByTestId('library-card').first();
  await card.hover();
  const grab = card.locator('.library-grab').first();
  const from = (await grab.boundingBox())!;
  const target = (await page.locator('.b-grid-row', { hasText: 'Paint, level 1' }).first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 200, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  const suggested = page.getByTestId('library-choose-suggested');
  await expect(suggested).toContainText(/ceiling grid/i, { timeout: TURN_MS });
  await expect(page.getByTestId('library-note')).toHaveCount(0);
  await shot(page, 'demo2-3-where-it-fits');
  await suggested.click();
  await expect(page.getByTestId('library-note')).toBeVisible({ timeout: TURN_MS });
  await expect(page.getByTestId('library-note-placed')).toContainText(/ceiling/i);
  // Its links place it: no date is pinned on the new rows, which are on screen as they go in.
  await expect(page.locator('.b-indicator.b-constraint-date')).toHaveCount(0);
  await expect(rail(page)).toContainText('Add it to the other floors', { timeout: TURN_MS });
  await shot(page, 'demo2-3-spliced');

  await expect(page.locator('.b-gantt .b-grid-row [data-column="name"]', { hasText: /^Light fixtures$/ })).toHaveCount(0); // No group row over the new tasks.

  // The assistant finds the other floors and asks to add it there too; one Apply adds them as one change.
  await page.getByTestId('inspector-tab-assistant').click();
  const edit = page.getByTestId('assistant-card-edit');
  await expect(edit).toBeVisible({ timeout: TURN_MS });
  await shot(page, 'demo2-4-asking');
  await edit.getByTestId('assistant-edit-apply').click();
  await expect(chip(page)).toContainText('Bill the tenant', { timeout: TURN_MS });
  await expect(rail(page)).toContainText('Set a billing rule');
  await shot(page, 'demo2-5-all-floors');

  // Every floor reads the same: the new tasks spliced between the grid and the tiles, with no group row.
  for (const level of [1, 2, 3]) {
    await page.locator('.b-gantt .b-grid-body-container').first().evaluate((element, at) => element.scrollTo(0, at), (level - 1) * 13 * 46);
    await page.waitForTimeout(300);
    const rendered = await page.locator('.b-gantt .b-grid-row[data-id]').evaluateAll((elements) =>
      elements
        .map((element) => ({ top: element.getBoundingClientRect().top, name: element.querySelector('[data-column="name"]')?.textContent?.trim() ?? '' }))
        .filter((entry) => entry.name)
        .sort((a, b) => a.top - b.top)
        .map((entry) => entry.name),
    );
    const grid = rendered.indexOf(`Ceiling grid, level ${level}`);
    expect(grid, rendered.join(' | ')).toBeGreaterThan(-1);
    // The package's tasks sit right after the grid, and the tiles follow them. The names are the assistant's own.
    const tiles = rendered.indexOf(`Ceiling tiles, level ${level}`);
    expect(tiles - grid, rendered.join(' | ')).toBeGreaterThanOrEqual(4);
    expect(tiles - grid, rendered.join(' | ')).toBeLessThanOrEqual(7);
    expect(rendered.slice(grid + 1, tiles).every((name) => !/level \d/i.test(name)), rendered.join(' | ')).toBe(true);
  }

  // The rule that ties it to billing.
  await chip(page).click();
  const rule = page.getByTestId('assistant-rule-draft').last();
  await expect(rule).toBeVisible({ timeout: TURN_MS });
  await expect(page.getByTestId('rule-now').last()).toContainText('Nothing to report', { timeout: TURN_MS });
  await shot(page, 'demo2-6-rule');
  await page.getByTestId('rule-start').last().click();
  await expect(page.getByTestId('rule-watching').last()).toBeVisible({ timeout: TURN_MS });

  // Level 2 is finished: its invoice is prepared; a person sends it through PayPal.
  await expect(chip(page)).toContainText('Level 2', { timeout: TURN_MS });
  await expect(rail(page)).toContainText('Finish a floor');
  await chip(page).click();
  await expect(rail(page)).toContainText('Send its invoice', { timeout: TURN_MS });
  const invoices = page.getByTestId('assistant-invoices').last();
  await expect(invoices).toBeVisible({ timeout: TURN_MS });
  const level2 = invoices.locator('[data-testid="invoice-row"][data-floor="Level 2 build-out"]');
  await expect(level2).toBeVisible({ timeout: TURN_MS });
  await shot(page, 'demo2-7-invoice');
  await level2.getByTestId('invoice-send').click();
  await expect(level2).toHaveAttribute('data-status', 'sent', { timeout: PAYPAL_MS });
  await expect(level2.getByTestId('invoice-sent')).toContainText('Sent');
  await shot(page, 'demo2-8-sent');

  // Level 3 follows the same way.
  await expect(chip(page)).toContainText('Level 3', { timeout: TURN_MS });
  await expect(rail(page)).toContainText('Bill the other floors');
  await chip(page).click();
  const level3 = page.locator('[data-testid="invoice-row"][data-floor="Level 3 build-out"]').last();
  await expect(level3).toBeVisible({ timeout: TURN_MS });
  await level3.getByTestId('invoice-send').click();
  await expect(level3).toHaveAttribute('data-status', 'sent', { timeout: PAYPAL_MS });
  await expect(rail(page)).toContainText('Every floor is billed', { timeout: TURN_MS });
  await shot(page, 'demo2-9-both-sent');
  expect(errors).toEqual([]);
});

test('opening a project stays at one zoom, and fitting it is one smooth press', async ({ page }) => {
  await open(page, CEDAR_IDS.project);
  const header = page.locator('.b-sch-header-row').first();
  await expect(header).toContainText('Week of');
  const opened = await header.innerText();
  await page.waitForTimeout(1500);
  expect(await header.innerText()).toBe(opened);

  // The bars scale through frames in between, rather than jumping to their new size.
  const widths = await page.evaluate(async () => {
    const seen: number[] = [];
    const widest = () => Math.max(0, ...[...document.querySelectorAll('.b-gantt .b-gantt-task-wrap[data-task-id] .b-gantt-task')].map((bar) => Math.round(bar.getBoundingClientRect().width)));
    (document.querySelector('[data-testid="zoom-fit"]') as HTMLElement).click();
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise(requestAnimationFrame);
      const width = widest();
      if (seen.at(-1) !== width) seen.push(width);
    }
    return seen;
  });
  expect(widths.length, widths.join(' ')).toBeGreaterThan(4);
  await expect(header).toContainText('January 2027');
});

test('the steps can be hidden and come back from the account menu', async ({ page }) => {
  reset(CEDAR_IDS.project);
  await open(page, CEDAR_IDS.project);
  await page.getByTestId('story-rail-button').click();
  await page.getByRole('button', { name: 'Hide the steps' }).click();
  await expect(page.getByTestId('story-rail')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  await expect(page.getByTestId('inspector-tab-assistant')).toBeVisible({ timeout: BOOT_MS });
  await expect(page.getByTestId('story-rail')).toHaveCount(0);

  await page.getByTestId('viewer').click();
  await page.getByTestId('show-steps').click();
  await expect(rail(page)).toContainText('Set a rule on the rentals');
});

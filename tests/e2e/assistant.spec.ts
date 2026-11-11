/**
 * The assistant in two browsers, from the demo reset: with both members in the plan it waits to be
 * asked (AGENT_PROACTIVE=off); Chris selects the crane erection task and asks what is wrong with it,
 * and the assistant answers about that task with the idle-crane issue card (amounts shown: everyone
 * sees costs), in a new conversation private to Chris until he invites Deepak, who then opens it and
 * sees the same card; Chris answers with the card's button; the assistant drafts new rental dates as
 * a change to the plan, with a working day of cover either side; Chris applies it and both see the dates
 * and what they come to. Asked in plain words for more cover, it works out the dates on the machine's own
 * calendar and drafts them too; Undo takes them back. The assistant never changes or pays anything itself.
 *
 * Needs the agent service. The spec starts one in mock mode (no API key, scripted model) unless one
 * is already running (`pnpm agent:dev`), in which case that one answers (only one instance leads).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { resetDemoProject } from './demo-reset';

const PM = { email: process.env.E2E_PM_EMAIL ?? 'pm@demo.local', password: process.env.E2E_PM_PASSWORD ?? 'demo-pm-2026' };
const CM = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? path.join('test-results', 'screenshots');
const BOOT_MS = 90_000;
/** A turn of the mock model takes well under a second; a live one a few seconds. */
const TURN_MS = 45_000;

let agent: ChildProcess | null = null;

async function startAgent(): Promise<void> {
  // Node itself (not through pnpm), so stopping it stops the service and no stray instance keeps leading.
  agent = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: path.join('apps', 'agent'),
    env: { ...process.env, AGENT_MODE: process.env.AGENT_MODE ?? 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the agent service did not start within 60 s')), 60_000);
    const onData = (chunk: Buffer) => {
      // Either it leads, or another instance already does (it then stands by and that one answers).
      if (/ready: listening|standing by/.test(chunk.toString())) {
        clearTimeout(timer);
        resolve();
      }
    };
    agent!.stdout?.on('data', onData);
    agent!.stderr?.on('data', onData);
    agent!.on('exit', (code) => reject(new Error(`the agent service exited (${code})`)));
  });
}

async function openWorkspace(browser: Browser, who: { email: string; password: string }): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  return page;
}

const panel = (page: Page) => page.getByTestId('assistant-panel');

async function openAssistant(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) await page.getByTestId('inspector-tab-assistant').click();
  await expect(panel(page)).toBeVisible();
}

test.beforeAll(async () => {
  resetDemoProject();
  mkdirSync(SHOTS, { recursive: true });
  await startAgent();
});

test.afterAll(async () => {
  const running = agent;
  if (!running || running.exitCode !== null) {
    resetDemoProject();
    return;
  }
  // A graceful stop leaves the channels; a service that hangs is stopped hard, so none keeps leading.
  const exited = new Promise<void>((resolve) => running.once('exit', () => resolve()));
  running.kill('SIGTERM');
  const timer = setTimeout(() => running.kill('SIGKILL'), 8_000);
  await exited;
  clearTimeout(timer);
  // What the assistant's changes left on the plan isn't for the next spec.
  resetDemoProject();
});

test('asked about the selected task, the assistant finds the idle crane and drafts new dates; asked in plain words, it pads them', async ({ browser }) => {
  test.setTimeout(240_000);
  const pm = await openWorkspace(browser, PM);
  const cm = await openWorkspace(browser, CM);

  await test.step('with both members in the plan, it waits to be asked', async () => {
    for (const page of [pm, cm]) await openAssistant(page);
    await pm.waitForTimeout(4_000);
    for (const page of [pm, cm]) await expect(panel(page).getByTestId('assistant-issue-card')).toHaveCount(0);
    await expect(panel(pm).getByTestId('assistant-mode-ask')).toHaveAttribute('aria-checked', 'true');
  });

  await test.step('Chris selects the crane erection and asks what is wrong with it', async () => {
    await pm.getByTestId('gantt-search').fill('Erect structural');
    await pm.locator('.b-grid-cell', { hasText: 'Erect structural steel frame' }).first().click();
    await expect(panel(pm).getByTestId('assistant-context-chip')).toContainText('Erect structural steel frame');
    await panel(pm).getByTestId('assistant-input').fill('What is wrong with this task?');
    await panel(pm).getByTestId('assistant-send').click();
    await expect(panel(pm).getByTestId('assistant-person-message').last()).toContainText(/about\s+Erect structural steel frame/);
    const issue = panel(pm).getByTestId('assistant-issue-card');
    await expect(issue).toBeVisible({ timeout: TURN_MS });
    await expect(issue).toContainText(/crane/i);
    // Everyone sees costs: the card names the money, nothing is masked.
    await expect(issue).toContainText('$');
    await expect(issue).not.toContainText('•••');
    // A new conversation is private to the person who started it.
    await expect(panel(pm).getByTestId('thread-audience')).toContainText('Private: you and Remy');
    await expect(panel(cm).getByTestId('assistant-issue-card')).toHaveCount(0);
  });

  await test.step('Chris invites Deepak, who opens the conversation and sees the issue', async () => {
    await panel(pm).getByTestId('thread-invite').click();
    await panel(pm).getByTestId('thread-invite-member').filter({ hasText: 'Deepak Jayaram' }).click();
    // Deepak sees costs, so there is nothing to caution about.
    await expect(panel(pm).getByTestId('thread-caution')).toHaveCount(0);
    await expect(panel(pm).getByTestId('thread-audience')).toContainText('Private: you and Deepak');
    await panel(cm).getByTestId('thread-switcher').click();
    await panel(cm).getByTestId('thread-option').filter({ hasText: 'Chris' }).click();
    await expect(panel(cm).getByTestId('thread-audience')).toContainText('Private: Chris and you');
    const issue = panel(cm).getByTestId('assistant-issue-card');
    await expect(issue).toBeVisible({ timeout: TURN_MS });
    await expect(issue).toContainText(/crane/i);
    await expect(issue).toContainText('$');
    await expect(issue).not.toContainText('•••');
    await cm.screenshot({ path: path.join(SHOTS, 'assistant-01-cm-issue.png') });
  });

  const craneCell = (page: Page) => page.locator('.b-gantt .b-grid-row[data-id="15"] .b-grid-cell[data-column-id="equipment"]').first();

  await test.step('Chris asks for the fix: new dates, as a change he applies', async () => {
    await panel(pm).getByTestId('assistant-action-prepare_fix').click();
    await expect(panel(pm).getByTestId('assistant-person-message').last()).toContainText(/prepare the fix/i);
    const edit = panel(pm).getByTestId('assistant-card-edit').last();
    await expect(edit).toBeVisible({ timeout: TURN_MS });
    await expect(panel(cm).getByTestId('assistant-card-edit').last()).toBeVisible({ timeout: TURN_MS });
    await expect(edit).toContainText(/Crane on rent/);
    await expect(edit.getByTestId('assistant-edit-rental')).toHaveText(/9 days on rent, \$5,400: saves \$1,200/);
    // Once a change is shown, the issue card no longer offers to prepare it.
    await expect(panel(pm).getByTestId('assistant-action-prepare_fix')).toBeDisabled();
    await pm.screenshot({ path: path.join(SHOTS, 'assistant-02-pm-fix.png') });
    await edit.getByTestId('assistant-edit-apply').click();
    for (const page of [pm, cm]) await expect(craneCell(page)).toContainText('Dec 10–18', { timeout: TURN_MS });
    await cm.screenshot({ path: path.join(SHOTS, 'assistant-03-cm-applied.png') });
  });

  await test.step('in plain words, more cover: the assistant works out the dates, and Undo takes them back', async () => {
    await panel(pm).getByTestId('assistant-input').fill('Two days before and one day after.');
    await panel(pm).getByTestId('assistant-send').click();
    const edit = panel(pm).getByTestId('assistant-card-edit').last();
    await expect(edit).toContainText(/Wed, Dec 9/, { timeout: TURN_MS });
    await edit.getByTestId('assistant-edit-apply').click();
    for (const page of [pm, cm]) await expect(craneCell(page)).toContainText('Dec 9–18', { timeout: TURN_MS });
    await pm.getByTestId('gantt-undo').click();
    for (const page of [pm, cm]) await expect(craneCell(page)).toContainText('Dec 10–18', { timeout: TURN_MS });
  });
});

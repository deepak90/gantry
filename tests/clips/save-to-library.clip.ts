/**
 * Clip: save work from the plan to the task library. Gesture: click "Pour spread footings", Shift-click
 * "Cure spread footings", right-click, "Save to library…"; the Library tab opens on a short form (name,
 * what it holds, where it is filed); type a name and Save. The camera follows from the plan to the
 * panel. The new library row is answered in the browser (write-free sandbox).
 */
import { expect, test } from '@playwright/test';
import { Recorder, boxOf, clickOn, clipOverlay, glide, inserted, openTab, saveClip, signIn, writeFreeSandbox, type ClipMeta, type Crop } from './clip';

const META: ClipMeta = {
  id: 'save-to-library',
  title: 'Save work to the library',
  summary: 'Select tasks in the plan, right-click, Save to library, name it, and Save.',
  steps: [
    'Click a task, then Shift-click another to select both.',
    'Right-click them and choose “Save to library…”.',
    'Name it in the short form and pick the folder it goes in.',
    'Save: it is in the Library tab, ready to drag into any plan.',
  ],
  topics: ['save to library', 'library', 'snippet', 'template', 'reuse', 'keep', 'copy work', 'save tasks'],
};

const FIRST = 215; // Pour spread footings
const SECOND = 216; // Cure spread footings
const NAME = 'Pour & cure spread footings';

test(META.title, async ({ page, context }) => {
  const sandbox = await writeFreeSandbox(context, { tables: { library_snippets: (body) => inserted(body, { created_by: null, updated_by: null }) } });
  await clipOverlay(context);
  await signIn(page);
  await openTab(page, null);
  await page.evaluate(async (id) => {
    const gantt = (globalThis as any).bryntum.query('gantt');
    const task = gantt.taskStore.getById(id);
    await gantt.expandTo(task);
    await gantt.scrollRowIntoView(task.parent, { block: 'start' });
  }, FIRST);
  await page.mouse.move(800, 900);
  await page.waitForTimeout(800);

  const nameCell = (id: number) => page.locator(`.b-gantt .b-grid-sub-grid-locked .b-grid-row[data-id="${id}"] .b-grid-cell`).first();
  const first = await boxOf(nameCell(FIRST));
  const second = await boxOf(nameCell(SECOND));
  const width = 832;
  const height = (width * 9) / 16;
  // First the plan's rows (where the menu opens), then the side panel once the form is there.
  const onRows: Crop = { x: 0, y: Math.max(48, Math.round(first.y - 110)), width, height };

  const recorder = new Recorder(page, onRows).start();
  await page.waitForTimeout(600);
  const at = (box: { x: number; y: number; height: number }) => ({ x: box.x + 70, y: box.y + box.height / 2 });
  await glide(page, at(first), 30);
  await page.waitForTimeout(300);
  await page.mouse.click(at(first).x, at(first).y);
  await page.waitForTimeout(500);
  await glide(page, at(second), 20);
  await page.waitForTimeout(300);
  await nameCell(SECOND).click({ position: { x: 70, y: second.height / 2 }, modifiers: ['Shift'] });
  await page.waitForTimeout(600);
  await page.mouse.click(at(second).x, at(second).y, { button: 'right' });
  const item = page.getByRole('menuitem', { name: /Save to library/ });
  await expect(item).toBeVisible();
  await page.waitForTimeout(700);
  await clickOn(page, item, { steps: 18, pause: 450 });

  const form = page.getByTestId('library-save-form');
  await expect(form).toBeVisible();
  await expect(form).toContainText('2 tasks');
  const before = await page.getByTestId('library-card').count();
  const panel = await boxOf(page.getByTestId('library-panel'));
  const onPanel: Crop = { x: Math.round(panel.x + panel.width - width), y: Math.round(panel.y), width, height };
  await page.waitForTimeout(300);
  await recorder.panTo(onPanel, 900);
  await page.waitForTimeout(500);
  await clickOn(page, form.getByTestId('library-save-name'), { steps: 25, pause: 200 });
  await page.getByTestId('library-save-name').selectText();
  await page.keyboard.type(NAME, { delay: 55 });
  await page.waitForTimeout(400);
  // Filed with the other structure pieces (a native list does not draw in a recording: pick it outright).
  const folder = form.locator('select');
  await clickOn(page, folder, { steps: 20, pause: 300 });
  await folder.selectOption({ label: 'Structure' });
  await page.waitForTimeout(600);
  await clickOn(page, form.getByTestId('library-save-submit'), { steps: 20, pause: 400 });
  await expect(form).toBeHidden();
  const saved = page.getByTestId('library-card').filter({ hasText: NAME });
  await expect(saved).toBeVisible();
  await page.waitForTimeout(700);
  // Follow the new card down the panel.
  const card = await boxOf(saved);
  const y = Math.round(Math.min(Math.max(panel.y, card.y + card.height / 2 - height / 2), panel.y + panel.height - height));
  if (Math.abs(y - onPanel.y) > 8) await recorder.panTo({ ...onPanel, y }, 800);
  await glide(page, { x: card.x + card.width * 0.55, y: card.y + card.height + 18 }, 20);
  await page.waitForTimeout(1_800);
  const recording = await recorder.stop();

  // The outcome: one new snippet of the two tasks, answered in the browser; nothing else written.
  expect(await page.getByTestId('library-card').count()).toBe(before + 1);
  const rows = sandbox.rows.get('library_snippets') ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: NAME, origin: 'plan', folder_id: expect.any(String) });
  expect(sandbox.blocked).toEqual([]);

  await saveClip(page, META, recording, { crf: 42 });
});

/**
 * Every way a library piece reaches the plan, through the real UI on a real Gantt and the local
 * backend. Titles carry the ids docs/library-scenarios.md lists them under.
 *
 * The assistant's answer on where a piece fits is the spec's own (place-snippet is answered in the
 * browser) and a drop is not told to the agent service, so a run is repeatable and costs nothing. The
 * `@live` checks are the exception: they need `pnpm agent:dev` and `pnpm functions:serve`.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { rowFieldsOf, type SnippetDraft } from '../../packages/shared/src/library.ts';
import { HARBOR_IDS, SEED_IDS } from '../../packages/shared/src/seed/index.ts';
import { resetDemoProject } from './demo-reset';
import {
  BOOT_MS,
  PM,
  answerPlacement,
  choice,
  collectProblems,
  dropNote,
  fingerprint,
  into,
  libraryCard,
  named,
  numbersReady,
  openLibrary,
  outOf,
  planOf,
  quietAgent,
  saved,
  signIn,
  suggested,
  way,
  type PlacementAnswer,
  type PlacementBody,
  type Plan,
} from './plan';

const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? path.join('test-results', 'screenshots', 'library');
const TURN_MS = 90_000;
const env = { ...parseEnv(readFileSync('.env.local', 'utf8')), ...process.env } as Record<string, string | undefined>;

const RIVERSIDE = SEED_IDS.project;
const HARBOR = HARBOR_IDS.project;

/** Link types as Bryntum numbers them. */
const SS = 0;
const FS = 2;

const REASON = 'The fixtures hang from the grid, so they go in before the tiles close the ceiling.';

/** A plain run of tasks: it goes in as rows of their own, with no group row over them. */
const FIXTURES: SnippetDraft = {
  name: 'Light fixtures',
  summary: 'Order, deliver, install and test',
  icon: 'lightbulb',
  unit: { one: 'floor', many: 'floors' },
  children: [
    { key: 'order', name: 'Order light fixtures', duration: 1 },
    { key: 'deliver', name: 'Deliver light fixtures', duration: 2 },
    { key: 'install', name: 'Install light fixtures', duration: 4 },
    { key: 'test', name: 'Test light fixtures', duration: 1 },
  ],
  links: [
    { from: 'order', to: 'deliver' },
    { from: 'deliver', to: 'install' },
    { from: 'install', to: 'test' },
  ],
};
const NEW_TASKS = FIXTURES.children.map((task) => task.name);

const task = (plan: Plan, name: string) => {
  const found = plan.tasks.find((row) => row.name === name);
  if (!found) throw new Error(`no task named ${name}`);
  return found;
};
const pinned = (plan: Plan, names: readonly string[] = NEW_TASKS) => plan.tasks.filter((row) => names.includes(row.name) && row.constraint).map((row) => row.name);

async function addSnippet(project: string, draft: SnippetDraft): Promise<void> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/library_snippets`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: project, folder_id: null, position: 1000, origin: 'person', ...rowFieldsOf(draft) }),
  });
  if (!response.ok) throw new Error(`could not add the snippet: ${response.status} ${await response.text()}`);
}

/** On a Harbor floor: after its ceiling grid, before its tiles (tasks are numbered by floor). */
const harborAnswer = (body: PlacementBody): PlacementAnswer => {
  const floor = Number(body.group.id);
  return { after_id: String(floor + 14), before_id: String(floor + 16), reason: REASON };
};

/** Signs in on a project reset to its seed, with the library open and the agent quiet. */
async function start(page: Page, project: string, ...snippets: SnippetDraft[]): Promise<void> {
  resetDemoProject(project);
  for (const snippet of snippets) await addSnippet(project, snippet);
  await quietAgent(page.context());
  await signIn(page, project);
  await openLibrary(page);
}

type Zone = 'top' | 'middle' | 'bottom';
const FRACTION: Record<Zone, number> = { top: 0.15, middle: 0.5, bottom: 0.85 };

/** Where a task's row is, scrolled into view. */
const rowBox = (page: Page, name: string) =>
  page.evaluate(async (wanted) => {
    const gantt = (globalThis as any).__gantt();
    const record = gantt.taskStore.query((candidate: any) => candidate.name === wanted)[0];
    if (!record) throw new Error(`no row for ${wanted}`);
    await gantt.scrollRowIntoView(record, { block: 'center' });
    const row = gantt.getRowFor(record);
    const box = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return { grid: box(row.getElement('locked')), chart: box(row.getElement('normal')) };
  }, name);

const card = libraryCard;
/** A starter card by its key: it can be found again after a tweak renames it. */
const starterCard = (page: Page, key: string) => page.locator(`[data-snippet-id="${key}"]`);

/** Picks a card up and carries it over a row; the mouse button stays down. */
async function carry(page: Page, snippet: string, target: string, { zone = 'bottom' as Zone, side = 'grid' as 'grid' | 'chart' } = {}): Promise<void> {
  const box = await rowBox(page, target);
  const from = card(page, snippet);
  await from.locator('.library-grip').scrollIntoViewIfNeeded();
  const grip = (await from.locator('.library-grip').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await moveOver(page, box, zone, side);
}

async function moveOver(page: Page, box: Awaited<ReturnType<typeof rowBox>>, zone: Zone, side: 'grid' | 'chart' = 'grid'): Promise<void> {
  const area = side === 'grid' ? box.grid : box.chart;
  await page.mouse.move(area.x + Math.min(area.width / 2, 160), area.y + area.height * FRACTION[zone], { steps: 15 });
  await page.waitForTimeout(60);
}

/** Drags a card onto a row and lets go. */
async function drop(page: Page, snippet: string, target: string, options: { zone?: Zone; side?: 'grid' | 'chart' } = {}): Promise<void> {
  await carry(page, snippet, target, options);
  await page.mouse.up();
}

const keyOf = async (page: Page, name: string) => (await card(page, name).getAttribute('data-snippet-id'))!;
const hint = (page: Page) => page.locator('.library-drag-hint');
const note = dropNote;

/** The rows wearing a mark right now, by the task's name. */
const marked = (page: Page, cls: string) =>
  page.evaluate((wanted) => {
    const gantt = (globalThis as any).__gantt();
    return [...new Set([...document.querySelectorAll(`.collab-gantt-workspace .b-grid-subgrid-locked .b-grid-row.${wanted}, .collab-gantt-workspace .b-grid-sub-grid-locked .b-grid-row.${wanted}`)].map((row) => gantt.resolveTaskRecord(row)?.name))];
  }, cls);
/** What draws a line on the plan: the rows whose mark is showing (the assistant's place hides the let-go mark). */
const linesShowing = (page: Page) =>
  page.evaluate(() => {
    const gantt = (globalThis as any).__gantt();
    return [...document.querySelectorAll('.b-grid-row.library-drop-before, .b-grid-row.library-drop-after, .b-grid-row.library-drop-inside, .b-grid-row.library-suggested')]
      .filter((row) => getComputedStyle(row, '::before').content !== 'none')
      .map((row) => gantt.resolveTaskRecord(row)?.name)
      .filter((name, index, all) => all.indexOf(name) === index);
  });

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

let problems: string[] = [];

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
test.beforeEach(({ page }) => {
  problems = [];
  collectProblems(page, problems);
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await shot(page, `failed-${info.title.split(' ')[0]}`).catch(() => undefined);
  expect.soft(problems, 'errors in the page').toEqual([]);
});

test.describe('dragging', () => {
  test('A1 the hint and the line say where it lands, row by row', async ({ page }) => {
    await start(page, RIVERSIDE);
    await carry(page, 'Exam room build-out', 'X-ray room lead lining & shielded door', { zone: 'top' });
    await expect(hint(page)).toHaveText('After “Hang, tape & finish drywall partitions”');
    expect.soft(await marked(page, 'library-drop-before')).toEqual(['X-ray room lead lining & shielded door']);
    await moveOver(page, await rowBox(page, 'X-ray room lead lining & shielded door'), 'bottom');
    await expect(hint(page)).toHaveText('After “X-ray room lead lining & shielded door”');
    expect.soft(await marked(page, 'library-drop-after')).toEqual(['X-ray room lead lining & shielded door']);
    await moveOver(page, await rowBox(page, 'Partitions & ceilings'), 'middle');
    await expect(hint(page)).toHaveText('At the end of “Partitions & ceilings”');
    expect.soft(await marked(page, 'library-drop-inside')).toEqual(['Partitions & ceilings']);
    await moveOver(page, await rowBox(page, 'Painting & wall tile'), 'top');
    await expect(hint(page)).toHaveText('After all of “Partitions & ceilings”');
    await moveOver(page, await rowBox(page, 'Painting & wall tile'), 'bottom');
    await expect(hint(page)).toHaveText('At the start of “Painting & wall tile”, before “Painting”');
    await shot(page, 'A1-hint');
    // Off the rows: the toolbar.
    const bar = (await page.getByTestId('gantt-toolbar').boundingBox())!;
    await page.mouse.move(bar.x + 300, bar.y + bar.height / 2, { steps: 5 });
    await expect(hint(page)).toHaveText('Drop it on a row of the plan');
    expect.soft(await marked(page, 'library-drop-after')).toEqual([]);
    await page.mouse.up();
    await expect(choice(page)).toHaveCount(0);
  });

  test('A2 letting go off the plan does nothing and leaves nothing behind', async ({ page }) => {
    await start(page, RIVERSIDE);
    const before = fingerprint(await planOf(page));
    await carry(page, 'Exam room build-out', 'Suspended ceilings');
    const panel = (await page.getByTestId('library-panel').boundingBox())!;
    await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height - 8, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(choice(page)).toHaveCount(0);
    expect.soft(await page.evaluate(() => document.body.classList.contains('library-dragging'))).toBe(false);
    expect.soft(await marked(page, 'library-drop-after')).toEqual([]);
    await expect(page.locator('.library-drag-proxy')).toHaveCount(0);
    expect.soft(fingerprint(await planOf(page))).toEqual(before);
  });

  test('A3 Esc during a drag calls it off', async ({ page }) => {
    await start(page, RIVERSIDE);
    await carry(page, 'Exam room build-out', 'Suspended ceilings');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(choice(page)).toHaveCount(0);
    await expect(page.locator('.library-drag-proxy')).toHaveCount(0);
    expect.soft(await marked(page, 'library-drop-after')).toEqual([]);
  });

  test('A4 the chart side takes a drop like the grid side', async ({ page }) => {
    await start(page, RIVERSIDE);
    await drop(page, 'Exam room build-out', 'Suspended ceilings', { side: 'chart' });
    await expect(choice(page)).toBeVisible();
    await expect(choice(page)).toContainText('After “Suspended ceilings”');
    expect.soft(await marked(page, 'library-drop-after')).toEqual(['Suspended ceilings']);
  });

  test('A5 a card let go on a folder is filed there, and the plan is left alone', async ({ page }) => {
    await start(page, RIVERSIDE);
    const before = fingerprint(await planOf(page));
    const from = card(page, 'Exam room build-out');
    await from.hover();
    const grip = (await from.locator('.library-grip').boundingBox())!;
    const folder = page.locator('.library-folder-row', { hasText: 'Restrooms' });
    await folder.scrollIntoViewIfNeeded();
    const grip2 = (await from.locator('.library-grip').boundingBox()) ?? grip;
    const over = (await folder.boundingBox())!;
    await page.mouse.move(grip2.x + grip2.width / 2, grip2.y + grip2.height / 2);
    await page.mouse.down();
    await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 12 });
    await expect(hint(page)).toHaveText('File it in “Restrooms”');
    await page.mouse.up();
    await expect(page.getByTestId('library-folder').filter({ has: page.locator('.library-folder-row', { hasText: 'Restrooms' }) }).getByTestId('library-card').filter({ hasText: 'Exam room build-out' })).toBeVisible();
    await expect(choice(page)).toHaveCount(0);
    expect.soft(fingerprint(await planOf(page))).toEqual(before);
    await page.reload();
    await openLibrary(page);
    await expect(page.getByTestId('library-folder').filter({ has: page.locator('.library-folder-row', { hasText: 'Restrooms' }) }).getByTestId('library-card').filter({ hasText: 'Exam room build-out' })).toBeVisible();
  });

  test('A6 the plan scrolls when a card is held near its edge', async ({ page }) => {
    await start(page, RIVERSIDE);
    const before = await page.evaluate(() => (globalThis as any).__gantt().scrollable.y);
    await carry(page, 'Exam room build-out', 'Hang, tape & finish drywall partitions');
    const scrolledTo = await page.evaluate(() => (globalThis as any).__gantt().scrollable.y);
    const body = await page.evaluate(() => {
      const box = (globalThis as any).__gantt().bodyContainer.getBoundingClientRect();
      return { x: box.x, bottom: box.bottom };
    });
    await page.mouse.move(body.x + 150, body.bottom - 12, { steps: 6 });
    await page.waitForTimeout(1_500);
    const after = await page.evaluate(() => (globalThis as any).__gantt().scrollable.y);
    expect.soft(after, `scrollTop ${before} → ${scrolledTo} → ${after}`).toBeGreaterThan(scrolledTo);
    await page.mouse.up();
    await page.waitForTimeout(200);
    if (await choice(page).isVisible()) await page.keyboard.press('Escape');
  });

  test('A7 a plan that cannot be changed says so and takes no drop', async ({ page }) => {
    await start(page, RIVERSIDE);
    await page.evaluate(() => {
      (globalThis as any).__gantt().readOnly = true;
    });
    await carry(page, 'Exam room build-out', 'Suspended ceilings');
    await expect(hint(page)).toHaveText('You can look at this plan but not change it');
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(choice(page)).toHaveCount(0);
  });

  test('A8 a drop on a closed group goes at its end, and the group opens to show it', async ({ page }) => {
    await start(page, RIVERSIDE);
    await drop(page, 'Exam room build-out', 'Site setup & demolition', { zone: 'middle' });
    await expect(choice(page)).toContainText('At the end of “Site setup & demolition”');
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Exam room build-out');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(task(plan, 'Exam room build-out').parent).toBe(100);
    await expect(page.locator('.b-grid-subgrid-locked .b-grid-row, .b-grid-sub-grid-locked .b-grid-row').filter({ hasText: 'Exam room build-out' }).first()).toBeVisible();
    await shot(page, 'A8-closed-group');
  });

  test('A9 grouped by crew: a generated row takes no drop, a real one does', async ({ page }) => {
    await start(page, RIVERSIDE);
    await page.getByTestId('gantt-view').click();
    await page.getByRole('menu', { name: 'View' }).getByRole('group', { name: 'Group by' }).getByText('Crew').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('gantt-toolbar').click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(800);
    const generated = await page.evaluate(() => {
      const gantt = (globalThis as any).__gantt();
      const row = [...document.querySelectorAll('.b-grid-row')].find((element) => gantt.resolveTaskRecord(element)?.generatedTreeParent || gantt.resolveTaskRecord(element)?.meta?.generatedParent || gantt.resolveTaskRecord(element)?.isGeneratedParent);
      const box = row?.getBoundingClientRect();
      return box ? { x: box.x + 150, y: box.y + box.height / 2 } : null;
    });
    const from = card(page, 'Exam room build-out');
    await from.hover();
    const grip = (await from.locator('.library-grip').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    if (generated) {
      await page.mouse.move(generated.x, generated.y, { steps: 10 });
      await expect.soft(hint(page)).toHaveText('Drop it on a row of the plan');
    }
    const box = await page.evaluate(async () => {
      const gantt = (globalThis as any).__gantt();
      const shown = gantt.store.allRecords.find((row: any) => row.name === 'Suspended ceilings') ?? gantt.store.query((row: any) => row.name === 'Suspended ceilings')[0];
      await gantt.expandTo?.(shown, false).catch(() => undefined);
      await gantt.scrollRowIntoView(shown, { block: 'center' });
      const rect = gantt.getRowFor(shown).getElement('locked').getBoundingClientRect();
      return { x: rect.x, y: rect.y, height: rect.height };
    });
    await page.mouse.move(box.x + 150, box.y + box.height * 0.85, { steps: 10 });
    await expect(hint(page)).toHaveText('After “Suspended ceilings”');
    await shot(page, 'A9-grouped');
    await page.mouse.up();
    await expect(choice(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Exam room build-out');
    await saved(page);
    const plan = await page.evaluate(() => {
      const gantt = (globalThis as any).__gantt();
      const top = gantt.project.taskStore.allRecords.find((row: any) => row.name === 'Exam room build-out' && row.libraryRef);
      return { parent: top?.parent?.id ?? null, parentName: top?.parent?.name ?? null };
    });
    expect.soft(plan.parentName, 'in the plan’s own tree').toBe('Partitions & ceilings');
    await shot(page, 'A9-grouped-after');
  });

  test('A10 with a search on: a piece with groups lands whole, for everyone, and Undo takes it all out', async ({ page }) => {
    await start(page, RIVERSIDE);
    const before = await planOf(page);
    await page.getByTestId('gantt-search').fill('ceilings');
    await page.waitForTimeout(600);
    await drop(page, 'Exam room build-out', 'Suspended ceilings');
    await expect(choice(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Exam room build-out');
    await saved(page);
    await shot(page, 'A10-search');
    const added = (await planOf(page)).tasks.length - before.tasks.length;
    expect.soft(added, 'its heading, groups and tasks').toBeGreaterThan(10);
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await page.waitForTimeout(800);
    expect.soft((await planOf(page)).tasks.length - before.tasks.length, 'the server has all of it').toBe(added);
  });

  test('A11 with a search on: the search comes back after the drop, Undo works, and the assistant is told about the whole group', async ({ page }) => {
    const asked: { group: { tasks: unknown[] } }[] = [];
    await answerPlacement(page.context(), (body) => {
      asked.push(body as never);
      return { after_id: '411', before_id: null, reason: REASON };
    });
    await start(page, RIVERSIDE);
    const before = fingerprint(await planOf(page));
    await page.getByTestId('gantt-search').fill('ceilings');
    await page.waitForTimeout(600);
    const shownBefore = await page.evaluate(() => (globalThis as any).__gantt().store.count);
    await drop(page, 'Exam room build-out', 'Suspended ceilings');
    await expect(suggested(page)).toBeVisible();
    expect.soft(asked[0]?.group.tasks.length, 'all three tasks of the group, not just the one showing').toBe(3);
    await numbersReady(page);
    await way(page, 'push').click();
    await expect(note(page)).toContainText('Added Exam room build-out');
    await saved(page);
    expect.soft(await page.getByTestId('gantt-search').inputValue()).toBe('ceilings');
    await expect.poll(() => page.evaluate(() => (globalThis as any).__gantt().store.filters?.count ?? 0), { message: 'the search is still applied' }).toBeGreaterThan(0);
    await shot(page, 'A11-search-after');
    await page.getByTestId('library-undo').click();
    await expect(note(page)).toContainText('Took out');
    await saved(page);
    expect.soft(fingerprint(await planOf(page)), 'all of it taken out, links back').toEqual(before);
    expect.soft(await page.evaluate(() => (globalThis as any).__gantt().store.count)).toBe(shownBefore);
  });

  test('A13 with a search on: toolbar undo and redo keep the plan whole, for the server too', async ({ page }) => {
    await start(page, RIVERSIDE);
    const before = fingerprint(await planOf(page));
    await page.getByTestId('gantt-search').fill('ceilings');
    await page.waitForTimeout(600);
    await drop(page, 'Exam room build-out', 'Suspended ceilings');
    await expect(choice(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'push').click();
    await expect(note(page)).toContainText('Added Exam room build-out');
    await saved(page);
    const after = await planOf(page);
    await page.getByTestId('gantt-undo').click();
    await saved(page);
    expect.soft(fingerprint(await planOf(page)), 'undo takes all of it out').toEqual(before);
    await page.getByTestId('gantt-redo').click();
    await saved(page);
    const redone = await planOf(page);
    expect.soft(redone.tasks.length, 'redo puts all of it back').toBe(after.tasks.length);
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await page.waitForTimeout(800);
    expect.soft((await planOf(page)).tasks.length, 'and the server has it').toBe(after.tasks.length);
  });

  test('A12 with a Show filter on: a drop lands whole too', async ({ page }) => {
    await start(page, RIVERSIDE);
    const before = await planOf(page);
    await page.getByRole('radiogroup', { name: 'Show' }).getByText('In progress').click();
    await page.waitForTimeout(600);
    const row = await page.evaluate(() => {
      const gantt = (globalThis as any).__gantt();
      const group = gantt.store.allRecords.find((candidate: any) => candidate.name === 'Partitions & ceilings');
      return gantt.scrollRowIntoView(group, { block: 'center' }).then(() => {
        const box = gantt.getRowFor(group).getElement('locked').getBoundingClientRect();
        return { x: box.x, y: box.y, height: box.height };
      });
    });
    const from = card(page, 'Exam room build-out');
    await from.hover();
    const grip = (await from.locator('.library-grip').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + 150, row.y + row.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(choice(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Exam room build-out');
    await saved(page);
    const added = (await planOf(page)).tasks.length - before.tasks.length;
    expect.soft(added).toBeGreaterThan(10);
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await page.waitForTimeout(800);
    expect.soft((await planOf(page)).tasks.length - before.tasks.length).toBe(added);
  });
});

test.describe('the drop card', () => {
  test('B1 it says where the assistant would put it, and nothing lands until that is pressed', async ({ page }) => {
    let answer: (value: PlacementAnswer) => void = () => undefined;
    await answerPlacement(page.context(), () => new Promise((resolve) => (answer = resolve)));
    await start(page, HARBOR, FIXTURES);
    const before = fingerprint(await planOf(page));
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(page.getByTestId('library-suggest-asking')).toContainText('Finding where it fits');
    await expect.soft(way(page, 'push')).toBeVisible();
    await shot(page, 'B1-asking');
    answer({ after_id: '114', before_id: '116', reason: REASON });
    await expect(suggested(page)).toContainText('After Ceiling grid, level 1');
    await expect(suggested(page)).toContainText('before Ceiling tiles, level 1');
    await expect(suggested(page)).toContainText(REASON);
    await expect(suggested(page)).toContainText('Suggested by Remy');
    await numbersReady(page);
    await expect(suggested(page), 'the same numbers as the other ways').toContainText(/tasks? moves? later/);
    await expect(suggested(page)).not.toContainText('Handover');
    await shot(page, 'B1-ready');
    await expect(suggested(page)).toBeFocused();
    expect.soft(await linesShowing(page), 'one line, at the assistant’s place').toEqual(['Ceiling grid, level 1']);
    expect.soft(fingerprint(await planOf(page))).toEqual(before);
    await expect(note(page)).toHaveCount(0);
  });

  test('B2 Enter takes the assistant’s place: spliced between the two tasks, placed by links, and it says why', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(note(page)).toContainText('Added Light fixtures');
    await expect(page.getByTestId('library-note-placed')).toContainText(REASON);
    await expect(page.getByTestId('library-note-placed')).not.toContainText('Placed for you');
    await saved(page);
    await shot(page, 'B2-placed');
    const plan = await planOf(page);
    const [order, deliver, install, test_] = NEW_TASKS.map((name) => task(plan, name));
    expect.soft(into(plan, order!.id)).toEqual([expect.objectContaining({ from: 114, type: FS })]);
    expect.soft(into(plan, deliver!.id)).toEqual([expect.objectContaining({ from: order!.id, type: FS })]);
    expect.soft(into(plan, install!.id)).toEqual([expect.objectContaining({ from: deliver!.id, type: FS })]);
    expect.soft(outOf(plan, test_!.id)).toEqual([expect.objectContaining({ to: 116, type: FS })]);
    expect.soft(outOf(plan, 114).map((link) => link.to)).toEqual([order!.id]);
    expect.soft(pinned(plan)).toEqual([]);
    await expect(page.locator('.b-indicator.b-constraint-date')).toHaveCount(0);
  });

  test('B3 push where it was let go: what waited for that task waits for the piece', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    const before = await planOf(page);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await numbersReady(page);
    await expect(way(page, 'push')).toContainText(/tasks? moves? later/);
    await way(page, 'push').click();
    await expect(note(page)).toContainText('moved later');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(into(plan, task(plan, 'Order light fixtures').id)).toEqual([expect.objectContaining({ from: 117, type: FS })]);
    expect.soft(into(plan, 118)).toEqual([expect.objectContaining({ from: task(plan, 'Test light fixtures').id, type: FS })]);
    expect.soft(task(plan, 'Floor finishes, level 1').start! > task(before, 'Floor finishes, level 1').start!).toBe(true);
    expect.soft(pinned(plan)).toEqual([]);
  });

  test('B4 fit in: it follows the task, and nothing already in the plan moves', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    const before = await planOf(page);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await numbersReady(page);
    await expect(way(page, 'fit')).toContainText('Nothing already in the plan moves');
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Nothing already in the plan moved');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(into(plan, task(plan, 'Order light fixtures').id)).toEqual([expect.objectContaining({ from: 117, type: FS })]);
    expect.soft(outOf(plan, task(plan, 'Test light fixtures').id)).toEqual([]);
    expect.soft(into(plan, 118)).toEqual([expect.objectContaining({ from: 117 })]);
    for (const row of before.tasks.filter((candidate) => typeof candidate.id === 'number' && !plan.tasks.find((after) => after.parent === candidate.id))) {
      expect.soft(task(plan, row.name).start, row.name).toBe(row.start);
    }
    expect.soft(pinned(plan)).toEqual([]);
  });

  test('B5 run alongside: it starts when the task starts', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await numbersReady(page);
    await page.getByRole('button', { name: 'More ways to tie it in' }).click();
    await way(page, 'alongside').click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(into(plan, task(plan, 'Order light fixtures').id)).toEqual([expect.objectContaining({ from: 117, type: SS })]);
    expect.soft(task(plan, 'Order light fixtures').start).toBe(task(plan, 'Paint, level 1').start);
    expect.soft(pinned(plan)).toEqual([]);
  });

  test('B6 place it with no links: only its first task is pinned, and the note says so', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await numbersReady(page);
    await page.getByRole('button', { name: 'More ways to tie it in' }).click();
    await way(page, 'unlinked').click();
    await expect(note(page)).toContainText('pinned there with no links');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(into(plan, task(plan, 'Order light fixtures').id)).toEqual([]);
    expect.soft(pinned(plan)).toEqual(['Order light fixtures']);
    await expect(page.locator('.b-indicator.b-constraint-date')).toHaveCount(1);
  });

  for (const mode of ['push', 'fit', 'alongside', 'unlinked'] as const) {
    test(`B7 a piece with groups, ${mode}: one heading over its tasks, tied in, and only what nothing leads to is pinned`, async ({ page }) => {
      await start(page, RIVERSIDE);
      await drop(page, 'Exam room build-out', 'Hang, tape & finish drywall partitions');
      await numbersReady(page);
      if (mode === 'alongside' || mode === 'unlinked') await page.getByRole('button', { name: 'More ways to tie it in' }).click();
      await way(page, mode).click();
      await expect(note(page)).toContainText('Added Exam room build-out');
      await saved(page);
      await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
      const plan = await planOf(page);
      const top = task(plan, 'Exam room build-out');
      expect.soft(top.parent).toBe(410);
      const led = new Set(plan.links.map((link) => link.to));
      const parents = new Set(plan.tasks.map((row) => row.parent));
      const inPiece = (id: number | string): boolean => {
        const row = plan.tasks.find((candidate) => candidate.id === id);
        return Boolean(row && (row.id === top.id || (row.parent !== null && inPiece(row.parent))));
      };
      const leaves = plan.tasks.filter((row) => inPiece(row.id) && !parents.has(row.id));
      expect.soft(leaves.length).toBeGreaterThan(5);
      for (const leaf of leaves) expect.soft([leaf.name, leaf.constraint]).toEqual([leaf.name, led.has(leaf.id) ? null : 'startnoearlierthan']);
      if (mode === 'push') expect.soft(outOf(plan, 411).map((link) => link.to).filter((to) => [413, 421, 422].includes(to as number))).toEqual([]);
      else expect.soft(outOf(plan, 411).map((link) => link.to).filter((to) => [413, 421, 422].includes(to as number)).sort()).toEqual([413, 421, 422]);
      await shot(page, `B7-${mode}`);
    });
  }

  test('B8 its tweaks reach the plan: name, how many, how long', async ({ page }) => {
    await start(page, RIVERSIDE);
    const from = starterCard(page, await keyOf(page, 'Exam room build-out'));
    await from.locator('.library-toggle').click();
    await from.getByLabel('Name of the new work').fill('Consult room');
    await from.getByRole('button', { name: 'One more' }).click();
    await from.locator('select').selectOption({ index: 0 });
    const scale = await from.locator('select').inputValue();
    await expect(from).toContainText('Consult room × 2');
    await from.locator('.library-grip').scrollIntoViewIfNeeded();
    await drop(page, 'Consult room', 'Suspended ceilings');
    await numbersReady(page);
    await expect(choice(page)).toContainText('Consult room × 2');
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Consult room × 2');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(plan.tasks.filter((row) => row.name.startsWith('Consult room')).map((row) => row.name).sort()).toEqual(['Consult room – room 1', 'Consult room – room 2']);
    expect.soft(Number(scale)).toBeLessThan(1);
  });

  test('B9 Esc, the close button and a click elsewhere all cancel, cleanly', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    const before = fingerprint(await planOf(page));
    const cancels: [string, () => Promise<void>][] = [
      ['esc', () => page.keyboard.press('Escape')],
      ['close', () => choice(page).getByRole('button', { name: 'Cancel' }).click()],
      ['outside', () => page.getByTestId('gantt-toolbar').click({ position: { x: 4, y: 4 } })],
    ];
    for (const [label, cancel] of cancels) {
      await drop(page, 'Light fixtures', 'Paint, level 1');
      await expect(suggested(page)).toBeVisible();
      await cancel();
      await expect(choice(page), label).toHaveCount(0);
      expect.soft(await marked(page, 'library-drop-after'), label).toEqual([]);
      expect.soft(await marked(page, 'library-suggested'), label).toEqual([]);
    }
    expect.soft(fingerprint(await planOf(page))).toEqual(before);
  });

  test('B10 the assistant is down, or names a task elsewhere: the rules answer, and say it is them', async ({ page }) => {
    let mode: 'down' | 'wrong' = 'down';
    await answerPlacement(page.context(), () => {
      if (mode === 'down') throw new Error('down');
      return { after_id: '214', before_id: '216', reason: 'Level 2?' };
    });
    await start(page, HARBOR, FIXTURES);
    for (const next of ['down', 'wrong'] as const) {
      mode = next;
      await drop(page, 'Light fixtures', 'Paint, level 1');
      await expect(suggested(page), next).toContainText('By the usual trade order');
      await expect.soft(suggested(page), next).toContainText('After');
      await shot(page, `B10-${next}`);
      await page.keyboard.press('Escape');
      await expect(choice(page)).toHaveCount(0);
    }
  });

  test('B11 the assistant is slow: the rules answer after 15 s, and an answer after a choice changes nothing', async ({ page }) => {
    test.setTimeout(120_000);
    let late: (value: PlacementAnswer) => void = () => undefined;
    await answerPlacement(page.context(), () => new Promise((resolve) => (late = resolve)));
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(page.getByTestId('library-suggest-asking')).toBeVisible();
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const plan = await planOf(page);
    late({ after_id: '114', before_id: '116', reason: REASON });
    await page.waitForTimeout(800);
    await expect(choice(page)).toHaveCount(0);
    expect.soft(fingerprint(await planOf(page))).toEqual(fingerprint(plan));
    await note(page).getByRole('button', { name: 'Dismiss' }).click();

    await drop(page, 'Light fixtures', 'Floor finishes, level 2');
    await expect(page.getByTestId('library-suggest-asking')).toBeVisible();
    await expect(suggested(page)).toContainText('By the usual trade order', { timeout: 20_000 });
  });

  test('B12 at the very top of the plan there is no group to ask about: just the ways, with numbers', async ({ page }) => {
    const asked = await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Level 1 build-out', { zone: 'top' });
    await expect(choice(page)).toContainText('At the very start of the plan');
    await numbersReady(page);
    await expect(suggested(page)).toHaveCount(0);
    await expect(page.getByTestId('library-suggest-asking')).toHaveCount(0);
    expect.soft(asked).toEqual([]);
    await shot(page, 'B12-top');
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(task(plan, 'Order light fixtures').parent).toBeNull();
    expect.soft(task(plan, 'Order light fixtures').constraint).toBe('startnoearlierthan');
    expect.soft(pinned(plan, NEW_TASKS.slice(1))).toEqual([]);
  });

  test('B13 who does the work: an unknown crew is asked about, and the answer holds for the assistant’s place too', async ({ page }) => {
    await answerPlacement(page.context(), () => ({ after_id: '412', before_id: '413', reason: REASON }));
    await start(page, RIVERSIDE);
    const person = await page.evaluate(() => (globalThis as any).__gantt().project.resourceStore.allRecords.find((crew: any) => !crew.isMaterial)?.name as string);
    await drop(page, 'Firestopping & inspection package', 'Hang, tape & finish drywall partitions');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    const crews = choice(page).locator('.library-choice-crews');
    await expect(crews).toContainText('Who does it');
    await crews.locator('select').first().selectOption({ label: await crews.locator('select').first().locator('option', { hasText: person }).first().innerText() });
    await shot(page, 'B13-crews');
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Firestopping');
    await saved(page);
    const plan = await planOf(page);
    const assigned = plan.tasks.filter((row) => row.crews.includes(person) && row.ref === null && plan.tasks.find((top) => top.name.startsWith('Firestopping & inspection package'))).length;
    expect.soft(assigned).toBeGreaterThan(0);
  });

  test('B14 a second drag while the card is up replaces it, with no marks left behind', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await drop(page, 'Light fixtures', 'Floor finishes, level 1');
    await expect(choice(page)).toContainText('After “Floor finishes, level 1”');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    expect.soft(await marked(page, 'library-drop-after')).toEqual(['Floor finishes, level 1']);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect.soft(await marked(page, 'library-drop-after')).toEqual([]);
  });

  test('B15 on a small window the card stays on screen and every way can be reached', async ({ page }) => {
    await answerPlacement(page.context(), () => ({ after_id: '412', before_id: '413', reason: REASON }));
    await page.setViewportSize({ width: 1280, height: 640 });
    await start(page, RIVERSIDE);
    await drop(page, 'Firestopping & inspection package', 'Hang, tape & finish drywall partitions', { side: 'chart' });
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    await page.getByRole('button', { name: 'More ways to tie it in' }).click();
    await page.waitForTimeout(200);
    await shot(page, 'B15-small');
    const box = (await choice(page).boundingBox())!;
    expect.soft(box.y, 'top').toBeGreaterThanOrEqual(0);
    expect.soft(box.x + box.width, 'right').toBeLessThanOrEqual(1280);
    expect.soft(box.y + box.height, 'bottom').toBeLessThanOrEqual(640);
    await way(page, 'unlinked').scrollIntoViewIfNeeded();
    const last = (await way(page, 'unlinked').boundingBox())!;
    expect.soft(last.y + last.height, 'the last way').toBeLessThanOrEqual(640);
  });

  test('B16 the keyboard way: Add after the selected task opens the same card', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    const from = card(page, 'Light fixtures');
    await from.locator('.library-toggle').click();
    await expect(from.getByTestId('library-add-after')).toBeDisabled();
    await rowBox(page, 'Paint, level 1');
    await page.locator('.b-grid-row', { hasText: 'Paint, level 1' }).first().locator('[data-column="name"]').click();
    await page.getByTestId('inspector-tab-library').waitFor();
    if (!(await page.getByTestId('library-panel').isVisible())) await openLibrary(page);
    await expect(from.getByTestId('library-add-after')).toContainText('Add after “Paint, level 1”');
    await from.getByTestId('library-add-after').click();
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    await page.keyboard.press('Enter');
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(into(plan, task(plan, 'Order light fixtures').id)).toEqual([expect.objectContaining({ from: 114 })]);
  });

  test('B17 scrolling the plan under the card keeps the mark on the right task', async ({ page }) => {
    await start(page, RIVERSIDE);
    await drop(page, 'Exam room build-out', 'Suspended ceilings');
    await numbersReady(page);
    const box = await rowBox(page, 'Suspended ceilings');
    await page.mouse.move(box.grid.x + 80, 300);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(500);
    const wearing = await marked(page, 'library-drop-after');
    await shot(page, 'B17-scrolled');
    expect.soft(wearing.filter((name) => name !== 'Suspended ceilings'), 'rows wearing the mark of another').toEqual([]);
  });

  test('B18 the assistant’s place is brought into view when it is off screen', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 520 });
    await answerPlacement(page.context(), () => ({ after_id: '111', before_id: '112', reason: REASON }));
    await start(page, HARBOR, FIXTURES);
    await page.evaluate(() => void (globalThis as any).__gantt().scrollable.scrollTo(null, 330));
    await page.waitForTimeout(300);
    const row = page.locator('.b-grid-row', { hasText: 'Floor finishes, level 1' }).first();
    const box = (await row.boundingBox())!;
    const from = card(page, 'Light fixtures');
    await from.hover();
    const grip = (await from.locator('.library-grip').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + box.height * 0.85, { steps: 12 });
    await page.mouse.up();
    await expect(suggested(page)).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, 'B18-off-screen');
    expect.soft(await marked(page, 'library-suggested')).toEqual(['Lay out partitions, level 1']);
    const visible = await page.evaluate(() => {
      const gantt = (globalThis as any).__gantt();
      const rowOf = gantt.getRowFor(gantt.taskStore.getById(111));
      if (!rowOf) return false;
      const box = rowOf.getElement('locked').getBoundingClientRect();
      const body = gantt.bodyContainer.getBoundingClientRect();
      return box.top >= body.top - 1 && box.bottom <= body.bottom + 1;
    });
    expect.soft(visible, 'the row the assistant named is in view').toBe(true);
  });

  test('B19 a drop while the last one is still saving is not swallowed', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await page.context().route('**/rest/v1/rpc/submit_revision', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    // The first drop scrolls the plan to the new rows: that has to settle under the pointer.
    await page.waitForTimeout(700);
    // The same floor, so it asks rather than following the first drop.
    await drop(page, 'Light fixtures', 'Floor finishes, level 1');
    // The row keeps its mark, and the card opens as soon as the first drop is saved.
    expect.soft(await marked(page, 'library-drop-after')).toEqual(['Floor finishes, level 1']);
    await shot(page, 'B19-second-drop');
    await expect(choice(page)).toContainText('After “Floor finishes, level 1”', { timeout: 15_000 });
  });
});

/** Locks a task as a payment on its way does, and returns its name. */
const lockTask = (page: Page, id: number): Promise<string> =>
  page.evaluate(async (task) => {
    const { setPaymentLocks } = await import('/src/gantt/payment-lock.ts' as string);
    const gantt = (globalThis as any).__gantt();
    // The workspace reads the locks from the workflow on every redraw: this stands in for a payment on its way.
    setInterval(() => setPaymentLocks(gantt.project, [task]), 20);
    setPaymentLocks(gantt.project, [task]);
    return gantt.taskStore.getById(task).name as string;
  }, id);
const taskOf = (plan: Plan, id: number) => plan.tasks.find((row) => row.id === id)!;

test.describe('what the piece lands next to', () => {
  const setOn = (page: Page, name: string, values: Record<string, unknown>) =>
    page.evaluate(
      async ({ wanted, change }) => {
        const gantt = (globalThis as any).__gantt();
        const row = gantt.taskStore.query((candidate: any) => candidate.name === wanted)[0];
        const dated = { ...change } as Record<string, unknown>;
        if (dated.constraintDate === 'start') dated.constraintDate = row.startDate;
        row.set(dated);
        await gantt.project.commitAsync();
      },
      { wanted: name, change: values },
    );

  test('C1 a task below with Start no earlier than still moves, and keeps its constraint', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await setOn(page, 'Paint, level 1', { constraintDate: 'start', constraintType: 'startnoearlierthan' });
    await saved(page);
    const before = await planOf(page);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(task(plan, 'Paint, level 1').start! > task(before, 'Paint, level 1').start!).toBe(true);
    expect.soft(task(plan, 'Paint, level 1').constraint).toBe('startnoearlierthan');
    expect.soft(task(plan, 'Paint, level 1').constraintDate).toBe(task(before, 'Paint, level 1').constraintDate);
  });

  /** A piece with Paint fixed on its date, dropped on the task the fixed task waits for. */
  async function facingFixedDate(page: Page): Promise<Plan> {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await setOn(page, 'Paint, level 1', { constraintDate: 'start', constraintType: 'muststarton' });
    await saved(page);
    const before = await planOf(page);
    await drop(page, 'Light fixtures', 'Ceiling grid, level 1');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    return before;
  }

  test('C2 a task below with Must start on: the card says the push cannot work, before anyone presses it', async ({ page }) => {
    const before = await facingFixedDate(page);
    await shot(page, 'C2-card');
    await expect(way(page, 'push')).toContainText('Paint, level 1');
    await expect(way(page, 'push')).not.toContainText('Nothing already in the plan moves');
    await expect(way(page, 'push')).toBeDisabled();
    await expect(suggested(page)).toContainText('Paint, level 1');
    await expect(suggested(page)).toBeDisabled();
    // Fitting it in moves nothing, so it is still open.
    await expect(way(page, 'fit')).toBeEnabled();
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Nothing already in the plan moved');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(task(plan, 'Paint, level 1').start).toBe(task(before, 'Paint, level 1').start);
  });

  test('C6 a blind drop into a fixed date: cancelling the conflict leaves nothing behind', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    await setOn(page, 'Paint, level 2', { constraintDate: 'start', constraintType: 'muststarton' });
    await saved(page);
    const before = fingerprint(await planOf(page));
    await drop(page, 'Light fixtures', 'Paint, level 2');
    const popup = page.locator('.b-popup').filter({ hasText: 'Scheduling conflict' });
    await expect(popup).toBeVisible({ timeout: 20_000 });
    await shot(page, 'C6-conflict');
    await popup.getByText('Cancel the change and do nothing').click();
    await popup.getByRole('button', { name: 'Apply' }).click();
    await expect(popup).toHaveCount(0);
    await expect(page.locator('.library-error')).toContainText(/not added|fixed date|clash/i);
    await page.waitForTimeout(1_200);
    await shot(page, 'C6-cancelled');
    await saved(page);
    expect.soft(fingerprint(await planOf(page)), 'all of it gone, not half of it').toEqual(before);
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await page.waitForTimeout(800);
    expect.soft(fingerprint(await planOf(page)), 'and the server agrees').toEqual(before);
  });

  test('C7 a blind drop into a fixed date: taking the constraint off lets the drop finish', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    await setOn(page, 'Paint, level 2', { constraintDate: 'start', constraintType: 'muststarton' });
    await saved(page);
    await drop(page, 'Light fixtures', 'Paint, level 2');
    const popup = page.locator('.b-popup').filter({ hasText: 'Scheduling conflict' });
    await expect(popup).toBeVisible({ timeout: 20_000 });
    await popup.getByText(/Remove "Must-Start-On" constraint/).click();
    await popup.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('library-note-placed')).toContainText('Placed for you', { timeout: 20_000 });
    await saved(page);
    const plan = await planOf(page);
    expect.soft(named(plan, 'Order light fixtures').length).toBe(2);
    expect.soft(task(plan, 'Paint, level 2').constraint).toBeNull();
    expect.soft(pinned(plan)).toEqual([]);
  });

  test('C3 a manually scheduled task below stays put, and the card and the note say what moved', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await setOn(page, 'Ceiling tiles, level 1', { manuallyScheduled: true });
    await saved(page);
    const before = await planOf(page);
    await drop(page, 'Light fixtures', 'Ceiling grid, level 1');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'push').click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(task(plan, 'Ceiling tiles, level 1').start).toBe(task(before, 'Ceiling tiles, level 1').start);
    await shot(page, 'C3-manual');
  });

  test('C4 next to a split task, a milestone, a finished task', async ({ page }) => {
    await start(page, RIVERSIDE);
    for (const target of ['Painting', 'Building dried in', 'Suspended ceilings']) {
      if (target === 'Suspended ceilings') await setOn(page, target, { percentDone: 100 });
      await saved(page);
      await drop(page, 'Firestopping & inspection package', target);
      await expect(choice(page), target).toBeVisible();
      await numbersReady(page);
      await expect.soft(way(page, 'push'), target).not.toContainText('could not');
      await way(page, 'push').click();
      await expect(note(page), target).toContainText('Added Firestopping');
      await saved(page);
      await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
      await note(page).getByRole('button', { name: 'Dismiss' }).click();
    }
    await shot(page, 'C4-three');
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  });

  test('C5 a push that would move a task PayPal is paying for is refused, plainly, and fitting in still works', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    const before = fingerprint(await planOf(page));
    const name = await lockTask(page, 117);
    await drop(page, 'Light fixtures', 'Ceiling grid, level 1');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    await shot(page, 'C5-locked-card');
    await expect(way(page, 'push')).toBeDisabled();
    await expect(way(page, 'push')).toContainText(name);
    await expect(way(page, 'push')).toContainText('PayPal');
    await expect(suggested(page)).toBeDisabled();
    await expect(way(page, 'fit')).toBeEnabled();
    expect(fingerprint(await planOf(page))).toEqual(before);
    const paid = taskOf(await planOf(page), 117);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const after = taskOf(await planOf(page), 117);
    expect.soft([after.start, after.end]).toEqual([paid.start, paid.end]);
  });

  test('C8 the next floor would move a task PayPal is paying for: nothing lands, and it says why', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const name = await lockTask(page, task(await planOf(page), 'Paint, level 2').id as number);
    const before = fingerprint(await planOf(page));
    await drop(page, 'Light fixtures', 'Paint, level 2');
    await expect(page.locator('.library-error')).toContainText(name, { timeout: 20_000 });
    await expect(page.locator('.library-error')).toContainText('PayPal');
    await saved(page);
    expect(fingerprint(await planOf(page))).toEqual(before);
  });
});

test.describe('after the drop', () => {
  /** A piece on Level 1 at the assistant's place, saved. */
  async function placed(page: Page): Promise<Plan> {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    const before = await planOf(page);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    return before;
  }

  test('D1 the note’s Undo brings the plan back exactly, for everyone and after a reload', async ({ page }) => {
    const before = await placed(page);
    await page.getByTestId('library-undo').click();
    await expect(note(page)).toContainText('Took out Light fixtures');
    await expect(note(page)).toContainText('went back');
    await expect(page.getByTestId('library-undo')).toHaveCount(0);
    await saved(page);
    expect.soft(fingerprint(await planOf(page))).toEqual(fingerprint(before));
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await page.waitForTimeout(800);
    expect.soft(fingerprint(await planOf(page))).toEqual(fingerprint(before));
  });

  test('D2 toolbar undo takes the whole drop out in one step, and redo puts it back the same', async ({ page }) => {
    const before = await placed(page);
    const after = await planOf(page);
    await expect(page.getByTestId('gantt-undo')).toBeEnabled();
    await page.getByTestId('gantt-undo').click();
    await saved(page);
    expect.soft(fingerprint(await planOf(page))).toEqual(fingerprint(before));
    await page.getByTestId('gantt-redo').click();
    await saved(page);
    const redone = await planOf(page);
    expect.soft(redone.tasks.map((row) => [row.name, row.start, row.end, row.constraint]).sort()).toEqual(after.tasks.map((row) => [row.name, row.start, row.end, row.constraint]).sort());
    expect.soft(pinned(redone)).toEqual([]);
    await shot(page, 'D2-redo');
  });

  test('D3 the note does not offer to take out a piece the toolbar already took out', async ({ page }) => {
    const before = await placed(page);
    await page.getByTestId('gantt-undo').click();
    await saved(page);
    await expect(page.getByTestId('library-undo')).toHaveCount(0);
    await expect(note(page)).toHaveCount(0);
    expect.soft(fingerprint(await planOf(page)), 'no links doubled, nothing lost').toEqual(fingerprint(before));
    await shot(page, 'D3-stale-note');
  });

  test('D4 the toolbar can undo the note’s Undo, and nothing doubles', async ({ page }) => {
    await placed(page);
    const after = await planOf(page);
    await page.getByTestId('library-undo').click();
    await expect(note(page)).toContainText('Took out');
    await saved(page);
    await page.getByTestId('gantt-undo').click();
    await saved(page);
    const again = await planOf(page);
    expect.soft(again.tasks.map((row) => [row.name, row.start, row.end]).sort()).toEqual(after.tasks.map((row) => [row.name, row.start, row.end]).sort());
    expect.soft(again.links.length).toBe(after.links.length);
    expect.soft(pinned(again)).toEqual([]);
  });

  test('D5 Undo after more work: a task of the piece deleted, a later task edited', async ({ page }) => {
    await placed(page);
    await page.evaluate(async () => {
      const gantt = (globalThis as any).__gantt();
      gantt.taskStore.query((row: any) => row.name === 'Deliver light fixtures')[0].remove();
      gantt.taskStore.getById(117).duration = 5;
      await gantt.project.commitAsync();
    });
    await saved(page);
    await page.getByTestId('library-undo').click();
    await expect(note(page)).toContainText('Took out');
    await saved(page);
    const plan = await planOf(page);
    for (const name of NEW_TASKS) expect.soft(named(plan, name), name).toEqual([]);
    expect.soft(into(plan, 116), 'the tiles wait for the grid again').toEqual([expect.objectContaining({ from: 114 })]);
    expect.soft(task(plan, 'Paint, level 1').id).toBe(117);
    const paint = await page.evaluate(() => (globalThis as any).__gantt().taskStore.getById(117).duration);
    expect.soft(paint, 'the later edit stays').toBe(5);
  });

  test('D6 it survives a reload: same rows, same links, no pins', async ({ page }) => {
    await placed(page);
    const after = await planOf(page);
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await page.waitForTimeout(800);
    expect.soft(fingerprint(await planOf(page))).toEqual(fingerprint(after));
    await expect(page.locator('.b-indicator.b-constraint-date')).toHaveCount(0);
  });

  test('D7 a second person sees the drop and the undo live, and both plans agree', async ({ page, browser, baseURL }) => {
    await answerPlacement(page.context(), harborAnswer);
    resetDemoProject(HARBOR);
    await addSnippet(HARBOR, FIXTURES);
    await quietAgent(page.context());
    const other = await browser.newContext({ baseURL: baseURL!, viewport: { width: 1600, height: 1000 }, storageState: { cookies: [], origins: [{ origin: baseURL!, localStorage: [{ name: 'collab.first-run.skip', value: '1' }] }] } });
    const second = await other.newPage();
    try {
      await signIn(second, HARBOR, PM);
      await signIn(page, HARBOR);
      await openLibrary(page);
      await drop(page, 'Light fixtures', 'Paint, level 1');
      await expect(suggested(page)).toBeVisible();
      await suggested(page).click();
      await expect(note(page)).toContainText('Added Light fixtures');
      await saved(page);
      await expect.poll(async () => named(await planOf(second), 'Order light fixtures').length, { timeout: 15_000 }).toBe(1);
      await saved(second);
      expect.soft(fingerprint(await planOf(second))).toEqual(fingerprint(await planOf(page)));
      await second.screenshot({ path: path.join(SHOTS, 'D7-second-person.png') });
      await expect(second.locator('.b-indicator.b-constraint-date')).toHaveCount(0);
      await page.getByTestId('library-undo').click();
      await expect(note(page)).toContainText('Took out');
      await saved(page);
      await expect.poll(async () => named(await planOf(second), 'Order light fixtures').length, { timeout: 15_000 }).toBe(0);
      await saved(second);
      expect.soft(fingerprint(await planOf(second))).toEqual(fingerprint(await planOf(page)));
    } finally {
      await other.close();
    }
  });

  test('D12 the second person has a search on: the drop reaches them whole, with no corrections', async ({ page, browser, baseURL }) => {
    await answerPlacement(page.context(), harborAnswer);
    resetDemoProject(RIVERSIDE);
    await quietAgent(page.context());
    const other = await browser.newContext({ baseURL: baseURL!, viewport: { width: 1600, height: 1000 }, storageState: { cookies: [], origins: [{ origin: baseURL!, localStorage: [{ name: 'collab.first-run.skip', value: '1' }] }] } });
    const second = await other.newPage();
    const sent: string[] = [];
    second.on('request', (request) => {
      if (/submit_revision/.test(request.url())) sent.push(request.url());
    });
    try {
      await signIn(second, RIVERSIDE, PM);
      await second.getByTestId('gantt-search').fill('ceilings');
      await second.waitForTimeout(600);
      await signIn(page, RIVERSIDE);
      await openLibrary(page);
      const count = (await planOf(page)).tasks.length;
      await drop(page, 'Exam room build-out', 'Suspended ceilings');
      await expect(choice(page)).toBeVisible();
      await numbersReady(page);
      await way(page, 'push').click();
      await expect(note(page)).toContainText('Added');
      await saved(page);
      await expect.poll(async () => (await planOf(second)).tasks.length, { timeout: 15_000 }).toBeGreaterThan(count + 10);
      await page.waitForTimeout(1_500);
      await expect(second.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
      expect.soft(sent, 'the second person sends nothing').toEqual([]);
      expect.soft(fingerprint(await planOf(second))).toEqual(fingerprint(await planOf(page)));
    } finally {
      await other.close();
    }
  });

  test('D8 the same piece twice in one place: two runs, in order, each with its own Undo', async ({ page }) => {
    const before = await placed(page);
    await note(page).getByRole('button', { name: 'Dismiss' }).click();
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'push').click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(named(plan, 'Order light fixtures').length).toBe(2);
    await page.getByTestId('library-undo').click();
    await expect(note(page)).toContainText('Took out');
    await saved(page);
    const undone = await planOf(page);
    expect.soft(named(undone, 'Order light fixtures').length).toBe(1);
    expect.soft(named(undone, 'Order light fixtures')[0]!.start).toBe(named(plan, 'Order light fixtures').map((row) => row.start).sort()[0]);
    expect.soft(before.tasks.length + 4).toBe(undone.tasks.length);
  });

  test('D9 the next floor follows the first without asking; once the first is undone it asks again', async ({ page }) => {
    const asked = await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    await expect(page.getByTestId('library-undo')).toBeEnabled();

    await drop(page, 'Light fixtures', 'Paint, level 2');
    await expect(page.getByTestId('library-note-placed')).toContainText('Placed for you', { timeout: 20_000 });
    await expect(choice(page)).toHaveCount(0);
    await saved(page);
    let plan = await planOf(page);
    const onLevel2 = named(plan, 'Order light fixtures').find((row) => row.parent === 200)!;
    expect.soft(into(plan, onLevel2.id)).toEqual([expect.objectContaining({ from: 214 })]);
    expect.soft(asked.at(-1)?.precedent).toMatchObject({ group: 'Level 1 build-out', after: 'Ceiling grid, level 1' });

    await page.getByTestId('library-undo').click();
    await expect(note(page)).toContainText('Took out');
    await saved(page);
    await page.getByTestId('gantt-undo').waitFor();
    plan = await planOf(page);
    expect.soft(named(plan, 'Order light fixtures').length).toBe(1);
    // Level 1 still has it: Level 3 still follows. Taken off Level 1 too, the next drop asks.
    await page.evaluate(async () => {
      const gantt = (globalThis as any).__gantt();
      for (const row of gantt.taskStore.query((candidate: any) => candidate.libraryRef)) row.remove();
      await gantt.project.commitAsync();
    });
    await saved(page);
    await drop(page, 'Light fixtures', 'Paint, level 3');
    await expect(suggested(page)).toBeVisible();
    await expect(choice(page)).toBeVisible();
  });

  test('D10 Show in the plan finds the piece from anywhere', async ({ page }) => {
    await placed(page);
    await page.evaluate(() => void (globalThis as any).__gantt().scrollable.scrollTo(null, 1600));
    await page.waitForTimeout(400);
    await note(page).getByRole('button', { name: 'Show in the plan' }).click();
    await page.waitForTimeout(900);
    await expect(page.locator('.b-grid-row', { hasText: 'Order light fixtures' }).first()).toBeInViewport();
  });

  test('D11 the piece behaves as part of the plan: the work before it shrinks and it all comes back', async ({ page }) => {
    await placed(page);
    const after = await planOf(page);
    await page.evaluate(async () => {
      const gantt = (globalThis as any).__gantt();
      gantt.taskStore.getById(113).duration = 1;
      await gantt.project.commitAsync();
    });
    await saved(page);
    const plan = await planOf(page);
    expect.soft(task(plan, 'Order light fixtures').start! < task(after, 'Order light fixtures').start!, 'the piece comes back').toBe(true);
    expect.soft(task(plan, 'Ceiling tiles, level 1').start! < task(after, 'Ceiling tiles, level 1').start!, 'and what follows it').toBe(true);
  });
});

test.describe('the library itself', () => {
  test('E1 search by name, task and crew; nothing found says so', async ({ page }) => {
    await start(page, RIVERSIDE);
    const search = page.getByLabel('Search the library');
    await search.fill('lead lined');
    await expect(page.getByTestId('library-card')).toHaveCount(1);
    await expect(page.locator('.library-status')).toHaveText('1 snippet match.');
    await search.fill('zzz nothing');
    await expect(page.getByTestId('library-card')).toHaveCount(0);
    await expect(page.locator('.library-status')).toHaveText('Nothing matches.');
    await search.fill('Exam room');
    // A card found by search can be dragged like any other.
    await drop(page, 'Exam room build-out', 'Suspended ceilings');
    await expect(choice(page)).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('E2 folders: new, rename, nest, close (remembered), delete moves its cards up', async ({ page }) => {
    await start(page, RIVERSIDE);
    await page.getByTestId('library-new').click();
    await page.getByRole('menuitem', { name: 'New folder' }).click();
    await page.getByLabel('New name').fill('Fit-out kit');
    await page.keyboard.press('Enter');
    const folder = page.locator('.library-folder-row', { hasText: 'Fit-out kit' });
    await expect(folder).toBeVisible();
    await page.getByRole('button', { name: 'More for Exam room build-out' }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    await page.locator('.library-menu').getByRole('menuitem', { name: 'Fit-out kit' }).click();
    const inFolder = page.getByTestId('library-folder').filter({ has: folder }).getByTestId('library-card').filter({ hasText: 'Exam room build-out' });
    await expect(inFolder).toBeVisible();
    await folder.getByRole('button', { name: 'Close Fit-out kit' }).click();
    await expect(inFolder).toHaveCount(0);
    await page.reload();
    await openLibrary(page);
    await expect(page.locator('.library-folder-row', { hasText: 'Fit-out kit' }).getByRole('button', { name: 'Open Fit-out kit' })).toBeVisible();
    await page.getByRole('button', { name: 'More for Fit-out kit' }).click();
    await page.getByRole('menuitem', { name: 'Delete folder…' }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.locator('.library-folder-row', { hasText: 'Fit-out kit' })).toBeVisible();
    await page.getByRole('button', { name: 'More for Fit-out kit' }).click();
    await page.getByRole('menuitem', { name: 'Delete folder…' }).click();
    await expect(page.locator('.library-confirm')).toContainText('1 snippet move up');
    await page.locator('.library-confirm').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.library-folder-row', { hasText: 'Fit-out kit' })).toHaveCount(0);
    await expect(card(page, 'Exam room build-out')).toBeVisible();
  });

  test('E3 a card’s menu: duplicate, rename, Esc keeps the name, delete asks and leaves the plan alone', async ({ page }) => {
    await start(page, RIVERSIDE);
    await drop(page, 'Exam room build-out', 'Suspended ceilings');
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added');
    await saved(page);
    const inPlan = fingerprint(await planOf(page));
    await page.getByRole('button', { name: 'More for Exam room build-out' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(card(page, 'Exam room build-out (copy)')).toBeVisible();
    await page.getByRole('button', { name: 'More for Exam room build-out (copy)' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('New name').fill('Second exam room');
    await page.keyboard.press('Escape');
    await expect(card(page, 'Exam room build-out (copy)')).toBeVisible();
    await page.getByRole('button', { name: 'More for Exam room build-out (copy)' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('New name').fill('Second exam room');
    await page.keyboard.press('Enter');
    await expect(card(page, 'Second exam room')).toBeVisible();
    await page.getByRole('button', { name: 'More for Second exam room' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await expect(page.locator('.library-confirm')).toContainText('Work already in the plan stays');
    await page.locator('.library-confirm').getByRole('button', { name: 'Delete' }).click();
    await expect(card(page, 'Second exam room')).toHaveCount(0);
    // The piece's source goes too: what was dropped from it stays.
    await page.getByRole('button', { name: 'More for Exam room build-out' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await page.locator('.library-confirm').getByRole('button', { name: 'Delete' }).click();
    await expect(card(page, 'Exam room build-out')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect.soft(fingerprint(await planOf(page))).toEqual(inPlan);
    await page.reload();
    await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
    await page.waitForTimeout(800);
    expect.soft(fingerprint(await planOf(page))).toEqual(inPlan);
  });

  test('E4 Undo my changes puts a card’s tweaks back', async ({ page }) => {
    await start(page, RIVERSIDE);
    const from = starterCard(page, await keyOf(page, 'Exam room build-out'));
    await from.locator('.library-toggle').click();
    await from.getByLabel('Name of the new work').fill('Other');
    await from.getByRole('button', { name: 'One more' }).click();
    await expect(from).toContainText('Other × 2');
    await from.getByRole('button', { name: 'Undo my changes' }).click();
    await expect(card(page, 'Exam room build-out')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo my changes' })).toHaveCount(0);
  });

  test('E5 save from the plan: tasks picked in the plan become a card that drops back in', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await rowBox(page, 'Ceiling grid, level 1');
    await page.locator('.b-grid-row', { hasText: 'Ceiling grid, level 1' }).first().locator('[data-column="name"]').click();
    await page.locator('.b-grid-row', { hasText: 'Ceiling tiles, level 1' }).first().locator('[data-column="name"]').click({ modifiers: ['Control'] });
    await page.waitForTimeout(300);
    await openLibrary(page);
    await expect(page.getByTestId('library-save-picked')).toContainText('the 2 selected tasks');
    await page.getByTestId('library-save-picked').click();
    await expect(page.getByTestId('library-save-name')).toHaveValue(/Ceiling grid.*Ceiling tiles/);
    await shot(page, 'E5-save-form');
    await page.getByTestId('library-save-name').fill('Ceilings');
    await page.getByTestId('library-save-submit').click();
    await expect(card(page, 'Ceilings')).toBeVisible();
    await expect(card(page, 'Ceilings')).toContainText('2 tasks');
    await drop(page, 'Ceilings', 'Paint, level 2');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'push').click();
    await expect(note(page)).toContainText('Added Ceilings');
    await saved(page);
    const plan = await planOf(page);
    expect.soft(named(plan, 'Ceiling grid, level 1').length, 'a copy, under the same name').toBe(2);
    expect.soft(pinned(plan, ['Ceiling grid, level 1', 'Ceiling tiles, level 1'])).toEqual([]);
  });

  test('E6 save from the plan: the task menu, a whole group, a blank name, Esc', async ({ page }) => {
    await start(page, RIVERSIDE);
    await rowBox(page, 'Partitions & ceilings');
    await page.locator('.b-grid-row', { hasText: 'Partitions & ceilings' }).first().locator('[data-column="name"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Save to library/ }).click();
    await expect(page.getByTestId('library-save-name')).toHaveValue('Partitions & ceilings');
    await page.getByTestId('library-save-name').fill('   ');
    await expect(page.getByTestId('library-save-submit')).toBeDisabled();
    await page.getByTestId('library-save-name').press('Escape');
    await expect(page.getByTestId('library-save-form')).toHaveCount(0);
    await shot(page, 'E6-after-esc');
  });

  test('E11 with a search on: saving a whole group keeps the tasks the search is hiding', async ({ page }) => {
    await start(page, RIVERSIDE);
    await page.getByTestId('gantt-search').fill('ceilings');
    await page.waitForTimeout(600);
    await page.locator('.b-grid-row', { hasText: 'Partitions & ceilings' }).first().locator('[data-column="name"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Save to library/ }).click();
    await expect(page.getByTestId('library-save-form')).toContainText('3 tasks');
    await shot(page, 'E11-save-form');
    await page.getByTestId('library-save-name').press('Escape');
  });

  test('E7 the builder: a new piece from nothing, saved and dropped', async ({ page }) => {
    await answerPlacement(page.context(), harborAnswer);
    await start(page, HARBOR, FIXTURES);
    await page.getByTestId('library-new').click();
    await page.getByTestId('library-new-snippet').click();
    const builder = page.getByTestId('snippet-builder');
    await expect(builder).toBeVisible();
    await shot(page, 'E7-empty-builder');
    await builder.locator('.builder-name, [data-testid=builder-name]').first().fill('Sprinkler heads');
    await page.getByTestId('builder-add-task').click();
    await page.getByTestId('builder-add-task').click();
    await page.waitForTimeout(500);
    await shot(page, 'E7-two-rows');
    await expect(page.getByTestId('builder-save')).toBeEnabled();
    await page.getByTestId('builder-save').click();
    await expect(builder).toHaveCount(0);
    await expect(card(page, 'Sprinkler heads')).toBeVisible();
    await expect(card(page, 'Sprinkler heads')).toContainText('3 tasks');
    await drop(page, 'Sprinkler heads', 'Paint, level 1');
    await expect(suggested(page)).toBeVisible();
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added Sprinkler heads');
    await saved(page);
  });

  test('E8 the builder: edit an existing piece, unsaved changes ask, save as a copy; the plan is untouched', async ({ page }) => {
    await start(page, RIVERSIDE);
    await drop(page, 'Exam room build-out', 'Suspended ceilings');
    await numbersReady(page);
    await way(page, 'fit').click();
    await expect(note(page)).toContainText('Added');
    await saved(page);
    const inPlan = fingerprint(await planOf(page));
    await page.getByRole('button', { name: 'More for Exam room build-out' }).click();
    await page.getByTestId('library-edit').click();
    const builder = page.getByTestId('snippet-builder');
    await expect(builder).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, 'E8-builder');
    await page.keyboard.press('Escape');
    await expect(builder, 'nothing changed: Esc closes').toHaveCount(0);
    await page.getByRole('button', { name: 'More for Exam room build-out' }).click();
    await page.getByTestId('library-edit').click();
    await builder.locator('.builder-name, [data-testid=builder-name]').first().fill('Exam room, large');
    await builder.getByRole('button', { name: 'Cancel' }).click();
    await expect(builder).toContainText('Close without saving your changes?');
    await builder.getByRole('button', { name: 'Keep editing' }).click();
    await builder.getByRole('button', { name: 'Save as a copy' }).click();
    await expect(builder).toHaveCount(0);
    await expect(card(page, 'Exam room, large')).toBeVisible();
    await expect(card(page, 'Exam room build-out')).toBeVisible();
    expect.soft(fingerprint(await planOf(page))).toEqual(inPlan);
  });

  test('E9 two people: a saved card shows up for the other, a deleted one goes, even with it open', async ({ page, browser, baseURL }) => {
    resetDemoProject(RIVERSIDE);
    await quietAgent(page.context());
    const other = await browser.newContext({ baseURL: baseURL!, viewport: { width: 1600, height: 1000 }, storageState: { cookies: [], origins: [{ origin: baseURL!, localStorage: [{ name: 'collab.first-run.skip', value: '1' }] }] } });
    const second = await other.newPage();
    try {
      await signIn(second, RIVERSIDE, PM);
      await openLibrary(second);
      await signIn(page, RIVERSIDE);
      await openLibrary(page);
      await page.getByRole('button', { name: 'More for Exam room build-out' }).click();
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      await expect(card(second, 'Exam room build-out (copy)')).toBeVisible({ timeout: 15_000 });
      await card(second, 'Exam room build-out (copy)').locator('.library-toggle').click();
      await page.getByRole('button', { name: 'More for Exam room build-out (copy)' }).click();
      await page.getByRole('menuitem', { name: 'Delete…' }).click();
      await page.locator('.library-confirm').getByRole('button', { name: 'Delete' }).click();
      await expect(card(second, 'Exam room build-out (copy)')).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await other.close();
    }
  });

  test('E10 a piece with time ranges: its bands land with it and follow it', async ({ page }) => {
    await start(page, RIVERSIDE);
    await drop(page, 'X-ray room', 'Suspended ceilings');
    await numbersReady(page);
    await way(page, 'push').click();
    await expect(note(page)).toContainText('Added X-ray');
    await saved(page);
    await page.waitForTimeout(600);
    await shot(page, 'E10-bands');
    const bands = () => page.evaluate(() => (globalThis as any).__gantt().project.timeRangeStore.allRecords.map((range: any) => ({ name: range.name, start: range.startDate?.toISOString?.() })));
    const before = await bands();
    expect.soft(before.length).toBeGreaterThan(0);
    await page.evaluate(async () => {
      const gantt = (globalThis as any).__gantt();
      gantt.taskStore.getById(411).duration += 5;
      await gantt.project.commitAsync();
    });
    await saved(page);
    await page.waitForTimeout(600);
    expect.soft(await bands(), 'the bands moved with the work').not.toEqual(before);
    await page.getByTestId('library-undo').click();
    await expect(note(page)).toContainText('Took out');
    await saved(page);
    await page.waitForTimeout(600);
    expect.soft((await bands()).length, 'taken out with it').toBe(0);
  });
});

test.describe('with the assistant @live', () => {
  test.setTimeout(240_000);

  async function liveFixtures(page: Page): Promise<void> {
    resetDemoProject(HARBOR);
    await addSnippet(HARBOR, FIXTURES);
    await signIn(page, HARBOR);
    await openLibrary(page);
    await drop(page, 'Light fixtures', 'Paint, level 1');
    await expect(suggested(page)).toContainText('Suggested by Remy', { timeout: TURN_MS });
    await shot(page, 'F-live-card');
    await expect.soft(suggested(page)).toContainText(/ceiling grid/i);
    await suggested(page).click();
    await expect(note(page)).toContainText('Added Light fixtures');
    await saved(page);
    await page.getByTestId('inspector-tab-assistant').click();
  }

  test('F1 after a drop it asks to add it to the other floors, and one Apply does: one change, no pins, one undo, and the history says so', async ({ page }) => {
    await liveFixtures(page);
    const adding: unknown[] = [];
    page.on('request', (request) => {
      if (!/rpc\/submit_revision/.test(request.url()) || request.method() !== 'POST') return;
      if (request.postDataJSON()?.p_changes?.tasks?.$input?.added?.length) adding.push(request.postDataJSON());
    });
    // It asks first: nothing goes in until someone presses Apply.
    const edit = page.getByTestId('assistant-card-edit').last();
    await expect(edit.getByTestId('assistant-edit-apply')).toBeEnabled({ timeout: TURN_MS });
    await page.waitForTimeout(1000);
    expect.soft(named(await planOf(page), 'Order light fixtures').length).toBe(1);
    expect.soft(adding, 'nothing added before Apply').toHaveLength(0);
    await shot(page, 'F1-asking');
    await edit.getByTestId('assistant-edit-apply').click();
    await expect.poll(async () => named(await planOf(page), 'Order light fixtures').length, { timeout: TURN_MS }).toBeGreaterThan(1);
    await saved(page);
    const plan = await planOf(page);
    expect.soft(pinned(plan)).toEqual([]);
    expect.soft(adding, 'one change, whatever the floors').toHaveLength(1);
    await page.waitForTimeout(500);
    await expect(page.locator('.b-indicator.b-constraint-date')).toHaveCount(0);
    await shot(page, 'F1-filled');
    await expect(page.getByTestId('assistant-card-edit')).not.toContainText('Handover');
    // History is under More here.
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByTestId('inspector-tab-history').click();
    await expect(page.getByTestId('changelog-panel')).toContainText(/light fixtures/i, { timeout: TURN_MS });
    // One undo takes all of it out.
    await page.getByTestId('gantt-undo').click();
    await saved(page);
    expect.soft(named(await planOf(page), 'Order light fixtures').length).toBe(1);
  });

  test('F3 Find reusable work comes back with something that can be saved', async ({ page }) => {
    resetDemoProject(RIVERSIDE);
    await signIn(page, RIVERSIDE);
    await openLibrary(page);
    await page.getByTestId('library-find-repeats').click();
    await expect(page.getByTestId('assistant-panel')).toBeVisible();
    await expect(page.getByTestId('assistant-card-snippets')).toBeVisible({ timeout: TURN_MS * 2 });
    await shot(page, 'F3-reusable');
    const save = page.getByTestId('assistant-save-snippet').first();
    await save.click();
    await expect(save, 'not saved twice').toBeHidden({ timeout: 15_000 }).catch(() => expect.soft(save).toBeDisabled());
  });
});

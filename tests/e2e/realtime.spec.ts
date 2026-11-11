/**
 * Two real browsers on one plan: a real Gantt on each side, the real submit_revision and Realtime
 * between them. Every change goes through the UI, and every check ends the same way: both browsers
 * hold the same plan (row order, links and crews included), nothing was reported as out of sync, and
 * a reload rebuilt from the server matches. Titles carry the ids docs/library-scenarios.md lists them
 * under.
 *
 * The second browser is never a spectator for long: `contention` has both writing at the same moment
 * (the same cell, the same row, links that close a loop between them, overlapping deletes, a snippet
 * against a move), and `a long session` lets both loose at random, from a seed, so a failure replays.
 *
 * Runs on the Riverside Clinic fixture, reset before each check. No model runs (see `quietAgent`).
 */
import { expect, test as base, type Page } from '@playwright/test';
import { SEED_IDS } from '../../packages/shared/src/seed/index.ts';
import { resetDemoProject } from './demo-reset';
import {
  CM,
  PM,
  addBelow,
  agree,
  answerPlacement,
  badge,
  cell,
  choice,
  collectProblems,
  dragRow,
  dropCard,
  dropNote,
  groupBy,
  idOf,
  into,
  libraryCard,
  menu,
  nameCell,
  named,
  numbersReady,
  openLibrary,
  outOf,
  planDiff,
  planOf,
  rebuildsTo,
  rename,
  revisionsSentBy,
  row,
  saved,
  search,
  selectRows,
  showRow,
  signIn,
  suggested,
  taskIn,
  quietAgent,
  way,
  type Plan,
} from './plan';

const RIVERSIDE = SEED_IDS.project;
/** A change must show in the other browser within about two seconds. */
const LIVE_MS = 5_000;

// Riverside Clinic: 211 → 212 → 213 → 214, a chain in Spread footings (210, six tasks).
const SAW = 211;
const DIG = 212;
const INSPECT = 213;
const REBAR = 214;
const FOOTINGS = 210;
// Partitions & ceilings (410) holds 411, 412, 413; 411 leads to 413, 421 and 422.
const PARTITIONS = 410;
const DRYWALL = 411;
const XRAY = 412;
const CEILINGS = 413;
const PAINTING = 420;
const SEARCH = 'ceilings';
const CREW = 'Calloway Construction';

interface Pair {
  a: Page;
  b: Page;
  /** Revisions each has sent since the last `clearSent`. */
  sentA: string[];
  sentB: string[];
  problems: string[];
}

const test = base.extend<Pair>({
  problems: async ({}, use) => use([]),
  sentA: async ({ page }, use) => use(revisionsSentBy(page)),
  sentB: async ({ b }, use) => use(revisionsSentBy(b)),
  // After `b`, whose fixture resets the project.
  a: async ({ page, problems, b }, use) => {
    void b;
    collectProblems(page, problems, 'A ');
    await quietAgent(page.context());
    await signIn(page, RIVERSIDE, CM);
    await use(page);
  },
  b: async ({ browser, baseURL, problems }, use) => {
    resetDemoProject(RIVERSIDE);
    const context = await browser.newContext({
      baseURL: baseURL!,
      viewport: { width: 1600, height: 1000 },
      storageState: { cookies: [], origins: [{ origin: baseURL!, localStorage: [{ name: 'collab.first-run.skip', value: '1' }] }] },
    });
    const page = await context.newPage();
    collectProblems(page, problems, 'B ');
    await quietAgent(context);
    await signIn(page, RIVERSIDE, PM);
    await use(page);
    await context.close();
  },
});

test.use({ actionTimeout: 10_000 });

test.beforeEach(async ({ a }) => {
  void a;
});

test.afterEach(async ({ a, b, problems }, info) => {
  if (info.status !== info.expectedStatus) {
    await a.screenshot({ path: info.outputPath('a.png') }).catch(() => undefined);
    await b.screenshot({ path: info.outputPath('b.png') }).catch(() => undefined);
    await info.attach('A', { path: info.outputPath('a.png'), contentType: 'image/png' }).catch(() => undefined);
    await info.attach('B', { path: info.outputPath('b.png'), contentType: 'image/png' }).catch(() => undefined);
    expect.soft(problems, 'errors in the pages').toEqual([]);
    return;
  }
  expect(problems, 'errors in the pages').toEqual([]);
  if (info.title.startsWith('L')) return; // They compare what they can themselves (`agreeExceptEmptied`).
  await agree(a, b);
  await rebuildsTo(b, await planOf(a), 'the second browser, rebuilt from the server,');
});

/** Waits for a state of the plan in the other browser, however the change arrived. */
const liveIn = (page: Page, check: (plan: Plan) => boolean, message: string) => expect.poll(async () => check(await planOf(page)), { timeout: LIVE_MS, message }).toBe(true);

test.describe('add, change, delete', () => {
  test('R1 a new task shows live, gets its name, and is one revision each', async ({ a, b, sentA, sentB }) => {
    const created = await addBelow(a, INSPECT, 'Dewater footing trench');
    await liveIn(b, (plan) => taskIn(plan, created)?.name === 'Dewater footing trench', 'the other browser has the task, named');
    await agree(a, b);
    expect.soft(sentB, 'the person watching sends nothing').toEqual([]);
    expect.soft(sentA.length, 'add, then rename').toBeLessThanOrEqual(2);
  });

  test('R2 a subtask turns a task into a group on both sides', async ({ a, b }) => {
    await menu(a, DIG, 'Add', 'Subtask');
    await liveIn(b, (plan) => plan.tasks.some((task) => task.parent === DIG), 'the other browser has the subtask');
    await saved(a);
  });

  test('R3 deleting a task takes its links and crew with it; undo brings all of it back', async ({ a, b, sentB }) => {
    const before = await planOf(a);
    await menu(a, DIG, 'Delete');
    await liveIn(b, (plan) => !taskIn(plan, DIG), 'gone in the other browser');
    await agree(a, b);
    expect.soft(into(await planOf(b), DIG)).toEqual([]);
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => Boolean(taskIn(plan, DIG)), 'back in the other browser');
    await agree(a, b);
    const after = await planOf(b);
    expect.soft(taskIn(after, DIG)?.crews).toEqual(taskIn(before, DIG)?.crews);
    expect.soft(into(after, DIG).map((link) => link.from)).toEqual([SAW]);
    expect.soft(outOf(after, DIG).map((link) => link.to)).toEqual([INSPECT]);
    expect.soft(sentB).toEqual([]);
  });

  test('R4 deleting a group takes its tasks; undo brings the whole group back', async ({ a, b }) => {
    const before = await planOf(a);
    await menu(a, FOOTINGS, 'Delete');
    await liveIn(b, (plan) => !taskIn(plan, FOOTINGS) && !taskIn(plan, DIG), 'the group and its tasks are gone');
    await agree(a, b);
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => Boolean(taskIn(plan, DIG)), 'all back');
    await agree(a, b);
    expect.soft((await planOf(b)).tasks.length).toBe(before.tasks.length);
    expect.soft((await planOf(b)).links.length).toBe(before.links.length);
  });
});

test.describe('bulk actions', () => {
  test('R5 deleting several tasks at once is one change for the other browser', async ({ a, b, sentA }) => {
    await selectRows(a, DIG, INSPECT, REBAR);
    await menu(a, REBAR, 'Delete');
    await liveIn(b, (plan) => !taskIn(plan, DIG) && !taskIn(plan, INSPECT) && !taskIn(plan, REBAR), 'all three gone');
    await agree(a, b);
    expect.soft(sentA.length, 'one revision').toBe(1);
  });

  test('R6 Link in order and Remove links, several tasks at once', async ({ a, b }) => {
    await selectRows(a, XRAY, CEILINGS);
    await menu(a, CEILINGS, 'Link in order');
    await liveIn(b, (plan) => into(plan, CEILINGS).some((link) => link.from === XRAY), 'linked in the other browser');
    await agree(a, b);
    await selectRows(a, XRAY, CEILINGS);
    await menu(a, CEILINGS, 'Remove links');
    await liveIn(b, (plan) => !into(plan, CEILINGS).some((link) => link.from === XRAY), 'unlinked in the other browser');
  });

  test('R7 clearing a block of Schedule cells is one change', async ({ a, b, sentA }) => {
    await showRow(a, DIG);
    await cell(a, DIG, 'schedule-when').click();
    await cell(a, INSPECT, 'schedule-when').click({ modifiers: ['Shift'] });
    await a.keyboard.press('Delete');
    await saved(a);
    await agree(a, b);
    expect.soft(sentA.length).toBeLessThanOrEqual(1);
  });

  test('R8 indenting several tasks at once', async ({ a, b }) => {
    await selectRows(a, CEILINGS);
    await menu(a, CEILINGS, 'Move into the task above');
    await liveIn(b, (plan) => taskIn(plan, CEILINGS)?.parent === XRAY, 'moved in the other browser');
    await agree(a, b);
    await selectRows(a, 422);
    await menu(a, 422, 'Move into the task above');
    await liveIn(b, (plan) => taskIn(plan, 422)?.parent === 421, 'the next one too');
  });
});

test.describe('indent, outdent, reorder', () => {
  test('R9 indent, then outdent, then undo twice: row order the same on both sides each time', async ({ a, b }) => {
    const before = await planOf(a);
    await menu(a, CEILINGS, 'Move into the task above');
    await liveIn(b, (plan) => taskIn(plan, CEILINGS)?.parent === XRAY, 'indented');
    await agree(a, b);
    await menu(a, CEILINGS, 'Move out one level');
    await liveIn(b, (plan) => taskIn(plan, CEILINGS)?.parent === PARTITIONS, 'outdented');
    await agree(a, b);
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => taskIn(plan, CEILINGS)?.parent === XRAY, 'undo: indented again');
    await agree(a, b);
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => taskIn(plan, CEILINGS)?.parent === PARTITIONS, 'undo: back');
    await agree(a, b);
    expect.soft(taskIn(await planOf(b), CEILINGS)?.wbs).toBe(taskIn(before, CEILINGS)?.wbs);
  });

  test('R21 moving a task inside the task it waits for asks first; meanwhile the other person’s work is safe', async ({ a, b }) => {
    const popup = a.locator('.b-popup').filter({ hasText: 'Scheduling cycle' });
    await menu(a, INSPECT, 'Move into the task above');
    await expect(popup, 'it says what would loop').toBeVisible();
    // The other person carries on while the question is open.
    await rename(b, CEILINGS, 'Renamed during the question');
    await saved(b);
    await popup.getByText(/Cancel/).first().click();
    await popup.getByRole('button', { name: 'Apply' }).click();
    await expect(popup).toHaveCount(0);
    await agree(a, b);
    const plan = await planOf(a);
    expect.soft(taskIn(plan, INSPECT)?.parent, 'cancelled: nothing moved').toBe(FOOTINGS);
    expect.soft(taskIn(plan, CEILINGS)?.name, 'and the other person’s change arrived').toBe('Renamed during the question');
  });

  test('R22 the same question, answered by taking the link off: the move and the link reach the other browser', async ({ a, b }) => {
    const popup = a.locator('.b-popup').filter({ hasText: 'Scheduling cycle' });
    await menu(a, INSPECT, 'Move into the task above');
    await expect(popup).toBeVisible();
    await popup.getByText(/Remove dependency/).first().click();
    await popup.getByRole('button', { name: 'Apply' }).click();
    await expect(popup).toHaveCount(0);
    await liveIn(b, (plan) => taskIn(plan, INSPECT)?.parent === DIG, 'moved in the other browser');
    await agree(a, b);
    expect.soft(into(await planOf(b), INSPECT).filter((link) => link.from === DIG)).toEqual([]);
  });

  test('R10 a row dragged within its group: same order on both sides', async ({ a, b }) => {
    await dragRow(a, REBAR, SAW, 'below');
    await liveIn(b, (plan) => (taskIn(plan, REBAR)?.index ?? 99) < (taskIn(plan, DIG)?.index ?? 0), 'moved up in the other browser');
    await agree(a, b);
  });

  test('R11 a row dragged into another group', async ({ a, b }) => {
    await dragRow(a, XRAY, 421, 'below');
    await liveIn(b, (plan) => taskIn(plan, XRAY)?.parent === PAINTING, 'in the other group in the other browser');
    await agree(a, b);
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => taskIn(plan, XRAY)?.parent === PARTITIONS, 'undone');
  });

  test('R12 both reorder the same group at the same moment: one order, everywhere', async ({ a, b }) => {
    await Promise.all([showRow(a, SAW), showRow(b, SAW)]);
    await Promise.all([dragRow(a, REBAR, SAW, 'below'), dragRow(b, 216, SAW, 'above')]);
    await agree(a, b);
  });
});

test.describe('copy, cut, paste', () => {
  test('R13 a copied group pastes with its tasks, links and crews on both sides', async ({ a, b, sentB }) => {
    const before = await planOf(a);
    await menu(a, FOOTINGS, 'Copy task');
    await menu(a, PAINTING, 'Paste task');
    await expect.poll(async () => (await planOf(a)).tasks.length, { message: 'pasted' }).toBeGreaterThan(before.tasks.length + 5);
    await saved(a);
    await liveIn(b, (plan) => plan.tasks.length > before.tasks.length + 5, 'pasted in the other browser');
    await agree(a, b);
    expect.soft(sentB).toEqual([]);
  });

  test('R14 cut and paste moves a task, keeping its id, links and crew', async ({ a, b }) => {
    const before = await planOf(a);
    await menu(a, CEILINGS, 'Cut task');
    await menu(a, 422, 'Paste task');
    await expect.poll(async () => taskIn(await planOf(a), CEILINGS)?.parent ?? (await planOf(a)).tasks.find((task) => task.name === 'Suspended ceilings')?.parent, { message: 'moved' }).toBe(PAINTING);
    await saved(a);
    await agree(a, b);
    const after = await planOf(b);
    const moved = named(after, 'Suspended ceilings');
    expect.soft(moved.length, 'one copy, not two').toBe(1);
    expect.soft(after.tasks.length).toBe(before.tasks.length);
  });

  test('R15 cut in one browser while the other edits that task', async ({ a, b }) => {
    await showRow(b, CEILINGS);
    await Promise.all([rename(b, CEILINGS, 'Suspended ceilings, revised'), menu(a, CEILINGS, 'Cut task').then(() => menu(a, 422, 'Paste task'))]);
    await agree(a, b);
    expect.soft(named(await planOf(b), 'Suspended ceilings, revised').length + named(await planOf(b), 'Suspended ceilings').length, 'one task, whichever name won').toBe(1);
  });

  test('R16 paste of several selected tasks', async ({ a, b }) => {
    const before = await planOf(a);
    await selectRows(a, DIG, INSPECT);
    await menu(a, INSPECT, 'Copy task');
    await menu(a, 216, 'Paste task');
    await expect.poll(async () => (await planOf(a)).tasks.length, { message: 'pasted' }).toBe(before.tasks.length + 2);
    await saved(a);
    await liveIn(b, (plan) => plan.tasks.length === before.tasks.length + 2, 'pasted in the other browser');
  });
});

test.describe('at the same moment', () => {
  test('R17 one deletes a group while the other adds a task under it', async ({ a, b }) => {
    await showRow(b, DIG);
    await Promise.all([menu(a, FOOTINGS, 'Delete'), menu(b, DIG, 'Add', 'Task below')]);
    await agree(a, b);
    expect.soft(taskIn(await planOf(b), FOOTINGS)).toBeUndefined();
  });

  test('R18 both rename one task', async ({ a, b }) => {
    await Promise.all([rename(a, DIG, 'From A'), rename(b, DIG, 'From B')]);
    await agree(a, b);
    expect.soft(['From A', 'From B']).toContain(taskIn(await planOf(a), DIG)?.name);
  });

  test('R19 one indents a task while the other deletes the task above it', async ({ a, b }) => {
    await Promise.allSettled([menu(a, CEILINGS, 'Move into the task above'), menu(b, XRAY, 'Delete')]);
    await agree(a, b);
  });

  test('R20 both undo their own change, with the other’s still there', async ({ a, b }) => {
    await rename(a, SAW, 'A renamed');
    await rename(b, INSPECT, 'B renamed');
    await agree(a, b);
    await Promise.all([a.getByTestId('gantt-undo').click(), b.getByTestId('gantt-undo').click()]);
    await agree(a, b);
    const plan = await planOf(a);
    expect.soft(taskIn(plan, SAW)?.name).not.toBe('A renamed');
    expect.soft(taskIn(plan, INSPECT)?.name).not.toBe('B renamed');
  });
});

test.describe('with a filter on', () => {
  test('F1 searching browser adds and renames: the other gets it, and the search stays', async ({ a, b }) => {
    await search(a, SEARCH);
    const before = await planOf(a);
    await menu(a, CEILINGS, 'Add', 'Task below');
    await liveIn(b, (plan) => plan.tasks.length === before.tasks.length + 1, 'in the other browser');
    await agree(a, b);
    await expect(a.getByTestId('gantt-search')).toHaveValue(SEARCH);
  });

  test('F2 deleting a group with hidden tasks removes them everywhere', async ({ a, b }) => {
    await search(a, SEARCH);
    await menu(a, PARTITIONS, 'Delete');
    await liveIn(b, (plan) => !taskIn(plan, PARTITIONS) && !taskIn(plan, DRYWALL) && !taskIn(plan, XRAY), 'the group and all its tasks are gone');
    await agree(a, b);
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => Boolean(taskIn(plan, DRYWALL)) && Boolean(taskIn(plan, CEILINGS)), 'all back, the hidden tasks too');
    await agree(a, b);
  });

  test('F3 copying a group with hidden tasks pastes all of it', async ({ a, b }) => {
    const before = await planOf(a);
    await search(a, SEARCH);
    await menu(a, PARTITIONS, 'Copy task');
    await menu(a, PAINTING, 'Paste task');
    await expect.poll(async () => (await planOf(a)).tasks.length, { message: 'pasted', timeout: 10_000 }).toBeGreaterThan(before.tasks.length);
    await saved(a);
    await agree(a, b);
    expect.soft((await planOf(b)).tasks.length - before.tasks.length, 'the group and its three tasks').toBe(4);
  });

  test('F4 cutting a group with hidden tasks moves all of it', async ({ a, b }) => {
    const before = await planOf(a);
    await search(a, SEARCH);
    await menu(a, PARTITIONS, 'Cut task');
    await menu(a, PAINTING, 'Paste task');
    await a.waitForTimeout(1_500);
    await saved(a);
    await agree(a, b);
    expect.soft((await planOf(b)).tasks.length, 'nothing lost, nothing doubled').toBe(before.tasks.length);
  });

  test('F5 indenting and outdenting next to hidden tasks', async ({ a, b }) => {
    // Suspended ceilings is the only row showing in its group, so there is no task above it to go into;
    // the search that shows two of them leaves the X-ray room between the others out of sight.
    await search(a, 'o');
    const shown: number[] = await a.evaluate((group) => (globalThis as any).__gantt().store.getById(group).children.map((task: any) => task.id), PARTITIONS);
    expect(shown.length).toBeGreaterThanOrEqual(2);
    await menu(a, shown.at(-1)!, 'Move into the task above');
    await a.waitForTimeout(800);
    await agree(a, b);
    await menu(a, shown.at(-1)!, 'Move out one level');
    await a.waitForTimeout(800);
    await agree(a, b);
  });

  test('F6 reordering while hidden tasks sit between the rows', async ({ a, b }) => {
    await search(a, 'footing');
    await a.waitForTimeout(300);
    const shown = await a.evaluate((group) => (globalThis as any).__gantt().store.getById(group).children.map((task: any) => task.id), FOOTINGS);
    expect(shown.length, 'at least two rows showing in the group').toBeGreaterThanOrEqual(2);
    await dragRow(a, shown.at(-1), shown[0], 'above');
    await a.waitForTimeout(800);
    await agree(a, b);
  });

  test('F7 bulk delete with some of the group hidden', async ({ a, b }) => {
    await search(a, 'footing');
    const shown: number[] = await a.evaluate((group) => (globalThis as any).__gantt().store.getById(group).children.map((task: any) => task.id), FOOTINGS);
    await selectRows(a, shown[0]!, shown[1]!);
    await menu(a, shown[1]!, 'Delete');
    await liveIn(b, (plan) => !taskIn(plan, shown[0]!) && !taskIn(plan, shown[1]!), 'both gone in the other browser');
    await agree(a, b);
  });

  // Bryntum #13813: undone once the filter is off, the row came back at its place among the rows the filter showed.
  test('F12 a task deleted under a search and undone after it: back in its own row, on both sides', async ({ a, b }) => {
    await search(a, 'footing');
    const rows = async (page: Page) => page.evaluate((group) => (globalThis as any).__gantt().project.taskStore.getById(group).orderedChildren.map((task: any) => task.id), FOOTINGS);
    const before = await rows(a);
    const shown: number[] = await a.evaluate((group) => (globalThis as any).__gantt().store.getById(group).children.map((task: any) => task.id), FOOTINGS);
    const victim = shown[shown.length - 1]!;
    await menu(a, victim, 'Delete');
    await liveIn(b, (plan) => !taskIn(plan, victim), 'gone in the other browser');
    await search(a, '');
    await a.getByRole('button', { name: /^Undo/ }).first().click();
    await liveIn(b, (plan) => Boolean(taskIn(plan, victim)), 'back in the other browser');
    await agree(a, b);
    expect.soft(await rows(a)).toEqual(before);
    expect.soft(await rows(b)).toEqual(before);
  });

  test('F8 the other browser is searching: every kind of change reaches it whole and it sends nothing', async ({ a, b, sentB }) => {
    await search(b, SEARCH);
    await menu(a, DIG, 'Delete');
    await a.waitForTimeout(500);
    await menu(a, INSPECT, 'Move into the task above');
    await a.waitForTimeout(500);
    await menu(a, FOOTINGS, 'Copy task');
    await menu(a, PAINTING, 'Paste task');
    await saved(a);
    await menu(a, PARTITIONS, 'Delete');
    await agree(a, b);
    expect.soft(sentB).toEqual([]);
    await expect(b.getByTestId('gantt-search')).toHaveValue(SEARCH);
    await search(b, '');
    await agree(a, b);
  });

  test('F9 both are searching for different things, and both edit', async ({ a, b }) => {
    await search(a, 'ceilings');
    await search(b, 'footing');
    await Promise.all([rename(a, CEILINGS, 'Ceilings, level one'), menu(b, FOOTINGS, 'Delete')]);
    await agree(a, b);
  });

  test('F10 the other browser is grouped by crew: changes arrive, and the view stays', async ({ a, b, sentB }) => {
    await groupBy(b, 'Crew');
    await menu(a, DIG, 'Delete');
    await a.waitForTimeout(500);
    await addBelow(a, INSPECT, 'New after inspect');
    await agree(a, b);
    expect.soft(sentB).toEqual([]);
  });

  test('F11 editing from a grouped view: rename and delete reach the other browser', async ({ a, b }) => {
    await groupBy(a, 'Crew');
    const shown = await a.evaluate(() => {
      const gantt = (globalThis as any).__gantt();
      const leaf = gantt.store.allRecords.find((record: any) => record.isLeaf && record.name === 'Excavate spread footings');
      return leaf ? gantt.store.getById(leaf.id) && leaf.id : null;
    });
    expect(shown, 'the task is in the grouped view').not.toBeNull();
    await a.evaluate(async (id) => {
      const gantt = (globalThis as any).__gantt();
      const record = gantt.store.getById(id);
      await gantt.expandTo(record, false).catch(() => undefined);
      await gantt.scrollRowIntoView(record, { block: 'center' });
    }, shown);
    await nameCell(a, shown).click({ button: 'right' });
    await a.locator('.b-float-root .b-menu-item').filter({ hasText: /^Delete$/ }).first().click();
    await liveIn(b, (plan) => !plan.tasks.some((task) => task.name === 'Excavate spread footings'), 'gone in the other browser');
    await agree(a, b);
  });
});

test.describe('with an editor open', () => {
  const editor = (page: Page) => page.locator('.b-cell-editor input:visible');
  const openName = async (page: Page, id: number, text: string) => {
    await showRow(page, id);
    await nameCell(page, id).dblclick();
    await expect(editor(page)).toBeVisible();
    await editor(page).fill(text);
  };

  /** The first Esc takes the typing back, as in any of Bryntum's fields; the second closes the editor. */
  const closeWithEsc = async (page: Page) => {
    await editor(page).press('Escape');
    await expect(editor(page)).toHaveValue(/.*/);
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
  };

  test('E1 the other person renames the task you are typing in: your Enter still lands, once', async ({ a, b }) => {
    await openName(b, DIG, 'From B, typed slowly');
    await rename(a, DIG, 'From A, already saved');
    await saved(a);
    await b.waitForTimeout(800);
    await expect(editor(b), 'still typing').toHaveValue('From B, typed slowly');
    await editor(b).press('Enter');
    await expect(editor(b)).toHaveCount(0);
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), DIG)?.name).toBe('From B, typed slowly');
  });

  test('E2 the other person deletes the task you are typing in: nothing breaks, and you can carry on', async ({ a, b }) => {
    await openName(b, DIG, 'Lost words');
    await menu(a, DIG, 'Delete');
    await saved(a);
    await b.waitForTimeout(1_000);
    await b.screenshot({ path: test.info().outputPath('E2-b.png') });
    if (await editor(b).isVisible()) await editor(b).press('Enter');
    await expect(editor(b)).toHaveCount(0);
    await agree(a, b);
    await rename(b, INSPECT, 'Carrying on');
    await agree(a, b);
  });

  test('E3 the other person moves the row you are typing in', async ({ a, b }) => {
    await openName(b, CEILINGS, 'Typed during a move');
    await menu(a, CEILINGS, 'Move into the task above');
    await saved(a);
    await b.waitForTimeout(600);
    if (await editor(b).isVisible()) await editor(b).press('Enter');
    await expect(editor(b)).toHaveCount(0);
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), CEILINGS)?.parent).toBe(XRAY);
  });

  test('E4 the other person works on while your editor is open, then Esc: all their changes arrive', async ({ a, b }) => {
    await openName(b, DIG, 'Never saved');
    await rename(a, SAW, 'Change one');
    await addBelow(a, INSPECT, 'Change two');
    await menu(a, REBAR, 'Delete');
    await saved(a);
    await closeWithEsc(b);
    await agree(a, b);
    const plan = await planOf(b);
    expect.soft(taskIn(plan, SAW)?.name).toBe('Change one');
    expect.soft(named(plan, 'Change two').length).toBe(1);
    expect.soft(taskIn(plan, REBAR)).toBeUndefined();
    expect.soft(named(plan, 'Never saved')).toEqual([]);
  });

  test('E5 an open editor on the far side does not hold up your own saves', async ({ a, b }) => {
    await openName(b, DIG, 'Still here');
    const started = Date.now();
    await rename(a, SAW, 'Saved while B types');
    await saved(a);
    expect.soft(Date.now() - started, 'saved without waiting for the other browser').toBeLessThan(5_000);
    await closeWithEsc(b);
    await agree(a, b);
  });

  test('E6 the dates editor is open when the other person deletes the task', async ({ a, b }) => {
    await showRow(b, DIG);
    await cell(b, DIG, 'schedule-when').dblclick();
    const dates = b.locator('.look-editor');
    await expect(dates).toBeVisible();
    await menu(a, DIG, 'Delete');
    await saved(a);
    await b.waitForTimeout(800);
    await b.screenshot({ path: test.info().outputPath('E6-b.png') });
    if (await dates.isVisible()) await dates.locator('[data-ref="save"]').click();
    await b.waitForTimeout(600);
    if (await dates.isVisible()) await b.keyboard.press('Escape');
    await agree(a, b);
    expect.soft(taskIn(await planOf(b), DIG)).toBeUndefined();
  });

  test('E7 the task panel is open when the other person deletes the task: it says so, and the panel recovers', async ({ a, b }) => {
    await menu(b, DIG, 'Edit task…');
    await expect(b.getByTestId('task-inspector')).toHaveAttribute('data-task-id', String(DIG));
    await menu(a, DIG, 'Delete');
    await expect(b.getByText('This task is no longer in the plan.')).toBeVisible({ timeout: LIVE_MS });
    await agree(a, b);
    await menu(b, INSPECT, 'Edit task…');
    await expect(b.getByTestId('task-inspector')).toHaveAttribute('data-task-id', String(INSPECT));
  });

  test('E8 typing in the task panel while the other person changes the same task', async ({ a, b }) => {
    await menu(b, DIG, 'Edit task…');
    const name = b.getByTestId('task-name');
    await name.fill('Typed in the panel');
    await rename(a, DIG, 'Saved by A');
    await saved(a);
    await b.waitForTimeout(800);
    await expect(name, 'what you are typing is not overwritten').toHaveValue('Typed in the panel');
    await name.press('Enter');
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), DIG)?.name).toBe('Typed in the panel');
  });

  test('E9 the notes are open while the other person edits them: nobody’s words corrupt the task', async ({ a, b }) => {
    await menu(b, DIG, 'Edit task…');
    await b.getByRole('tab', { name: /Notes/ }).click();
    const note = b.getByTestId('task-note');
    await note.fill('B writes first');
    await menu(a, DIG, 'Edit task…');
    await a.getByRole('tab', { name: /Notes/ }).click();
    await a.getByTestId('task-note').fill('A writes too');
    await a.getByTestId('task-note').blur();
    await saved(a);
    await note.blur();
    await agree(a, b);
    expect.soft(['A writes too', 'B writes first']).toContain(taskIn(await planOf(a), DIG)?.note);
  });

  test('E10 changes under an open crew tab show live', async ({ a, b }) => {
    await menu(b, DIG, 'Edit task…');
    await b.getByRole('tab', { name: /Crew/ }).click();
    await expect(b.getByTestId('task-crew-row')).toContainText(CREW);
    await a.evaluate(async (id) => {
      const gantt = (globalThis as any).__gantt();
      const task = gantt.taskStore.getById(id);
      gantt.project.assignmentStore.remove(task.assignments[0]);
      await gantt.project.commitAsync();
    }, DIG);
    await expect(b.getByTestId('task-crew-row')).toHaveCount(0, { timeout: LIVE_MS });
  });
});

test.describe('snippets', () => {
  const PIECE = 'Exam room build-out';
  const placeBelow = async (page: Page, target: number) => {
    await openLibrary(page);
    await dropCard(page, PIECE, target);
    await expect(choice(page)).toBeVisible();
    await numbersReady(page);
  };

  test('S1 a drop reaches the other browser whole, in one revision', async ({ a, b, sentA, sentB }) => {
    const before = await planOf(a);
    await placeBelow(a, DRYWALL);
    await way(a, 'push').click();
    await expect(dropNote(a)).toContainText('Added');
    await liveIn(b, (plan) => plan.tasks.length > before.tasks.length + 10, 'all of it in the other browser');
    await agree(a, b);
    expect.soft(sentA.length, 'one revision').toBe(1);
    expect.soft(sentB).toEqual([]);
    await expect(b.locator('.b-indicator.b-constraint-date')).toHaveCount(0);
  });

  test('S2 both drop into the same group at the same moment: both land, in one order everywhere', async ({ a, b }) => {
    const before = await planOf(a);
    await Promise.all([placeBelow(a, DRYWALL), placeBelow(b, DRYWALL)]);
    await Promise.all([way(a, 'push').click(), way(b, 'fit').click()]);
    await Promise.all([expect(dropNote(a)).toContainText('Added'), expect(dropNote(b)).toContainText('Added')]);
    await agree(a, b);
    expect.soft((await planOf(a)).tasks.length).toBeGreaterThan(before.tasks.length + 20);
    expect.soft(named(await planOf(a), PIECE).length, 'two copies').toBe(2);
  });

  test('S3 the other person deletes the task the card is about: it says so, and nothing half lands', async ({ a, b }) => {
    const before = await planOf(a);
    await placeBelow(a, XRAY);
    await menu(b, XRAY, 'Delete');
    await saved(b);
    await a.waitForTimeout(800);
    await way(a, 'fit').click();
    await a.waitForTimeout(1_200);
    await a.screenshot({ path: test.info().outputPath('S3-a.png') });
    await expect(a.locator('.library-error')).toContainText(/no longer|removed/i);
    await agree(a, b);
    expect.soft((await planOf(a)).tasks.length).toBe(before.tasks.length - 1);
  });

  test('S4 the other person deletes the task the assistant named: the card does not get stuck', async ({ a, b }) => {
    await answerPlacement(a.context(), () => ({ after_id: String(XRAY), before_id: String(CEILINGS), reason: 'After the lead lining.' }));
    await placeBelow(a, DRYWALL);
    await expect(suggested(a)).toBeVisible();
    await menu(b, XRAY, 'Delete');
    await saved(b);
    await a.waitForTimeout(800);
    await suggested(a).click({ timeout: 3_000 }).catch(() => undefined);
    await a.waitForTimeout(800);
    await a.screenshot({ path: test.info().outputPath('S4-a.png') });
    if (await choice(a).isVisible()) await expect(choice(a)).toContainText(/no longer|removed/i);
    else await expect(a.locator('.library-error')).toContainText(/no longer|removed/i);
    await a.keyboard.press('Escape');
    await agree(a, b);
  });

  test('S5 undo by the note, after the other person edited the piece and what follows it', async ({ a, b }) => {
    await placeBelow(a, DRYWALL);
    await way(a, 'push').click();
    await expect(dropNote(a)).toContainText('Added');
    await agree(a, b);
    const first = await idOf(b, 'Lay out walls & door locations');
    await rename(b, first, 'Edited by B');
    await rename(b, CEILINGS, 'Ceilings edited by B');
    await agree(a, b);
    await a.getByTestId('library-undo').click();
    await expect(dropNote(a)).toContainText('Took out');
    await agree(a, b);
    const plan = await planOf(b);
    expect.soft(named(plan, PIECE)).toEqual([]);
    expect.soft(taskIn(plan, CEILINGS)?.name, 'B’s edit outside the piece stays').toBe('Ceilings edited by B');
    expect.soft(into(plan, CEILINGS).some((link) => link.from === DRYWALL), 'the link is back').toBe(true);
  });

  test('S6 the other person is typing in a row below when the drop pushes it', async ({ a, b }) => {
    await showRow(b, CEILINGS);
    await nameCell(b, CEILINGS).dblclick();
    await b.locator('.b-cell-editor input:visible').fill('Typed while pushed');
    await placeBelow(a, DRYWALL);
    await way(a, 'push').click();
    await expect(dropNote(a)).toContainText('Added');
    await saved(a);
    await b.waitForTimeout(800);
    await b.locator('.b-cell-editor input:visible').press('Enter');
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), CEILINGS)?.name).toBe('Typed while pushed');
  });

  test('S7 the other person deletes the card you are holding, or have just let go', async ({ a, b }) => {
    await placeBelow(a, DRYWALL);
    await openLibrary(b);
    await b.getByRole('button', { name: `More for ${PIECE}` }).click();
    await b.getByRole('menuitem', { name: 'Delete…' }).click();
    await b.locator('.library-confirm').getByRole('button', { name: 'Delete' }).click();
    await expect(libraryCard(a, PIECE)).toHaveCount(0, { timeout: LIVE_MS });
    await way(a, 'fit').click();
    await expect(dropNote(a), 'the card held a copy: the drop still lands').toContainText('Added');
    await agree(a, b);
  });

  test('S8 the builder is open on a piece the other person deletes: Save does not lose the work silently', async ({ a, b }) => {
    await openLibrary(a);
    await openLibrary(b);
    await a.getByRole('button', { name: `More for ${PIECE}` }).click();
    await a.getByTestId('library-edit').click();
    const builder = a.getByTestId('snippet-builder');
    await expect(builder).toBeVisible();
    await builder.locator('.builder-name, [data-testid=builder-name]').first().fill('Exam room, reworked');
    await b.getByRole('button', { name: `More for ${PIECE}` }).click();
    await b.getByRole('menuitem', { name: 'Delete…' }).click();
    await b.locator('.library-confirm').getByRole('button', { name: 'Delete' }).click();
    await expect(libraryCard(b, PIECE)).toHaveCount(0);
    await a.waitForTimeout(600);
    await a.getByTestId('builder-save').click();
    await a.waitForTimeout(1_000);
    await a.screenshot({ path: test.info().outputPath('S8-a.png') });
    const saved_ = await libraryCard(a, 'Exam room, reworked').count();
    const told = await builder.locator('.builder-notice').innerText().catch(() => '');
    expect.soft(saved_ > 0 || /no longer|deleted|removed/i.test(told), `saved as new, or says it was deleted; said “${told}”`).toBe(true);
  });

  test('S9 a drop with a search on in one browser and a group-by in the other', async ({ a, b, sentB }) => {
    await search(a, SEARCH);
    await groupBy(b, 'Crew');
    const before = await planOf(a);
    await placeBelow(a, CEILINGS);
    await way(a, 'push').click();
    await expect(dropNote(a)).toContainText('Added');
    await saved(a);
    await liveIn(b, (plan) => plan.tasks.length > before.tasks.length + 10, 'whole in the other browser');
    await agree(a, b);
    expect.soft(sentB).toEqual([]);
  });
});

test.describe('crews', () => {
  const crewRow = (page: Page, name: string) => page.locator('[data-testid=crew-row]', { hasText: name }).first();
  const openCrews = async (page: Page) => {
    await page.getByTestId('inspector-tab-crews').click();
    await expect(page.getByTestId('crew-manager')).toBeVisible();
  };
  /** Drags a crew from the panel onto a task's row. */
  const dragCrew = async (page: Page, name: string, id: number) => {
    await showRow(page, id);
    const from = (await crewRow(page, name).locator('.crew-row-text').boundingBox())!;
    const to = (await row(page, id).first().boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(to.x + 150, to.y + to.height / 2, { steps: 14 });
    await page.waitForTimeout(80);
    await page.mouse.up();
  };

  test('C1 a new crew shows in the other browser’s panel, and its name follows as it is typed in', async ({ a, b }) => {
    await openCrews(a);
    await openCrews(b);
    await a.getByTestId('add-crew').click();
    await expect(crewRow(b, 'New crew')).toBeVisible({ timeout: LIVE_MS });
    const name = a.locator('.crew-row.is-editing input').first();
    await name.fill('Summit Fire Protection');
    await name.blur();
    await expect(crewRow(b, 'Summit Fire Protection')).toBeVisible({ timeout: LIVE_MS });
    await agree(a, b);
  });

  test('C2 a crew dragged onto a task shows live; undo takes it back', async ({ a, b }) => {
    await openCrews(a);
    await dragCrew(a, 'Halden Electrical', XRAY);
    await liveIn(b, (plan) => Boolean(taskIn(plan, XRAY)?.crews.includes('Halden Electrical')), 'on the task in the other browser');
    await agree(a, b);
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => !taskIn(plan, XRAY)?.crews.includes('Halden Electrical'), 'off again in the other browser');
  });

  test('C3 a crew dragged onto a task with a search on', async ({ a, b }) => {
    await search(a, SEARCH);
    await openCrews(a);
    await dragCrew(a, 'Halden Electrical', CEILINGS);
    await liveIn(b, (plan) => Boolean(taskIn(plan, CEILINGS)?.crews.includes('Halden Electrical')), 'on the task in the other browser');
  });

  test('C4 one deletes a task while the other puts a crew on it', async ({ a, b }) => {
    await openCrews(a);
    await Promise.all([dragCrew(a, 'Halden Electrical', XRAY), menu(b, XRAY, 'Delete')]);
    await a.waitForTimeout(1_000);
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), XRAY)).toBeUndefined();
  });

  test('C5 one removes a crew while the other puts it on a task', async ({ a, b }) => {
    await openCrews(a);
    await openCrews(b);
    await crewRow(b, 'Halden Electrical').getByRole('button', { name: 'Edit Halden Electrical' }).click();
    await b.locator('.crew-row.is-editing').getByRole('button', { name: /Remove/ }).first().click();
    const confirm = b.locator('.crew-row.is-editing').getByRole('button', { name: /Remove/ }).last();
    await Promise.all([dragCrew(a, 'Halden Electrical', XRAY), confirm.click()]);
    await a.waitForTimeout(1_000);
    await agree(a, b);
    const plan = await planOf(a);
    expect.soft(plan.crews.some((crew) => crew.includes('Halden Electrical'))).toBe(false);
    expect.soft(taskIn(plan, XRAY)?.crews).not.toContain('Halden Electrical');
  });

  test('C6 removing a crew under an open crew tab and its bars', async ({ a, b }) => {
    await menu(b, DIG, 'Edit task…');
    await b.getByRole('tab', { name: /Crew/ }).click();
    await expect(b.getByTestId('task-crew-row')).toContainText(CREW);
    await openCrews(a);
    await crewRow(a, CREW).getByRole('button', { name: `Edit ${CREW}` }).click();
    await a.locator('.crew-row.is-editing').getByRole('button', { name: /Remove/ }).first().click();
    await a.locator('.crew-row.is-editing').getByRole('button', { name: /Remove/ }).last().click();
    await expect(b.getByTestId('task-crew-row')).toHaveCount(0, { timeout: LIVE_MS });
    await agree(a, b);
  });

  test('C7 renaming a crew reaches the bars and the panel of the other browser', async ({ a, b }) => {
    await openCrews(a);
    await crewRow(a, 'Halden Electrical').getByRole('button', { name: 'Edit Halden Electrical' }).click();
    const name = a.locator('.crew-row.is-editing input').first();
    await name.fill('Halden & Sons Electrical');
    await name.blur();
    await liveIn(b, (plan) => plan.crews.some((crew) => crew.includes('Halden & Sons Electrical')), 'renamed in the other browser');
    await agree(a, b);
  });

  test('C8 a snippet asks who does the work; the firm picked is removed before pressing', async ({ a, b }) => {
    await openLibrary(a);
    await dropCard(a, 'Firestopping & inspection package', DRYWALL);
    await expect(choice(a)).toBeVisible();
    await numbersReady(a);
    const crews = choice(a).locator('.library-choice-crews select').first();
    await crews.selectOption({ label: await crews.locator('option', { hasText: 'Halden Electrical' }).first().innerText() });
    await openCrews(b);
    await crewRow(b, 'Halden Electrical').getByRole('button', { name: 'Edit Halden Electrical' }).click();
    await b.locator('.crew-row.is-editing').getByRole('button', { name: /Remove/ }).first().click();
    await b.locator('.crew-row.is-editing').getByRole('button', { name: /Remove/ }).last().click();
    await saved(b);
    await a.waitForTimeout(800);
    await way(a, 'fit').click();
    await a.waitForTimeout(1_500);
    await a.screenshot({ path: test.info().outputPath('C8-a.png') });
    await agree(a, b);
    const plan = await planOf(a);
    expect.soft(plan.assignments.some((assignment) => assignment.includes(':undefined:')), 'no assignment to a crew that is gone').toBe(false);
  });
});

/** A task's start moved by a number of days, through its Schedule cell's editor. */
async function moveStart(page: Page, id: number, days: number): Promise<void> {
  await showRow(page, id);
  const start = taskIn(await planOf(page), id)!.start!;
  const date = new Date(`${start}:00`);
  date.setDate(date.getDate() + days);
  const text = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  await cell(page, id, 'schedule-when').dblclick();
  const editor = page.locator('.look-editor');
  const input = editor.locator('[data-ref="start"] input');
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Tab');
  await editor.locator('[data-ref="save"]').click();
  await expect(editor).toHaveCount(0);
}

/** Drags a task's bar along the timeline. */
async function dragBar(page: Page, id: number, pixels: number): Promise<void> {
  await page.evaluate(async (wanted) => {
    const gantt = (globalThis as any).__gantt();
    await gantt.scrollTaskIntoView(gantt.store.getById(wanted), { block: 'center' });
  }, id);
  const bar = page.locator(`.b-gantt-task-wrap[data-task-id="${id}"]`).first();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + pixels, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

/** A link added the way the task panel's Links tab adds it; says what the app said if it refused. */
const addLink = (page: Page, from: number, to: number): Promise<string | null> =>
  page.evaluate(
    async ({ from: fromId, to: toId }) => {
      const { addLink: add } = await import('/src/inspector/task/apply.ts' as string);
      return add((globalThis as any).__gantt().project, { fromId, toId, type: 2 }).then(
        () => null,
        (error: Error) => error.message,
      );
    },
    { from, to },
  );

/** A crew put on a task the way the crew panel does it. */
const putCrew = (page: Page, task: number, crew: number): Promise<string | null> =>
  page.evaluate(
    async ({ task: taskId, crew: crewId }) => {
      const { assignCrew } = await import('/src/gantt/crew-drop.ts' as string);
      const { project } = (globalThis as any).__gantt();
      return assignCrew(project, project.taskStore.getById(taskId), project.resourceStore.getById(crewId)).then(
        () => null,
        (error: Error) => error.message,
      );
    },
    { task, crew },
  );

/** Is there a loop in the links? Every client must end without one. */
const hasLoop = (plan: Plan): boolean => {
  const next = new Map<unknown, unknown[]>();
  for (const link of plan.links) if (link.active) next.set(link.from, [...(next.get(link.from) ?? []), link.to]);
  const state = new Map<unknown, 1 | 2>();
  const walk = (node: unknown): boolean => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    const found = (next.get(node) ?? []).some(walk);
    state.set(node, 2);
    return found;
  };
  return [...next.keys()].some(walk);
};

test.describe('contention', () => {
  test('K1 both drag the same bar at the same moment', async ({ a, b }) => {
    await Promise.all([dragBar(a, INSPECT, 70), dragBar(b, INSPECT, 140)]);
    await agree(a, b);
  });

  test('K2 one drags a bar while the other deletes the task', async ({ a, b }) => {
    await Promise.allSettled([dragBar(a, INSPECT, 70), menu(b, INSPECT, 'Delete')]);
    await a.keyboard.press('Escape');
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), INSPECT)).toBeUndefined();
  });

  test('K3 one drags a bar while the other moves the row into the task above', async ({ a, b }) => {
    await Promise.all([dragBar(a, CEILINGS, 70), menu(b, CEILINGS, 'Move into the task above')]);
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), CEILINGS)?.parent).toBe(XRAY);
  });

  test('K4 both set the same task’s start in the same cell', async ({ a, b }) => {
    await Promise.all([moveStart(a, INSPECT, 3), moveStart(b, INSPECT, 7)]);
    await agree(a, b);
  });

  test('K5 two links that close a loop only together: no client is left with a loop or out of sync', async ({ a, b }) => {
    const said = await Promise.all([addLink(a, XRAY, 422), addLink(b, 422, XRAY)]);
    await test.info().attach('said', { body: JSON.stringify(said), contentType: 'application/json' });
    await a.waitForTimeout(1_500);
    await agree(a, b);
    const plan = await planOf(a);
    expect(hasLoop(plan), 'no loop in the plan').toBe(false);
  });

  test('K6 a long loop through the existing chain, closed from both ends', async ({ a, b }) => {
    await Promise.all([addLink(a, REBAR, XRAY), addLink(b, XRAY, SAW)]);
    await a.waitForTimeout(1_500);
    await agree(a, b);
    expect(hasLoop(await planOf(a)), 'no loop in the plan').toBe(false);
  });

  test('K7 a loop one person could make alone is refused, in plain words, and nothing is sent', async ({ a, b, sentA }) => {
    const said = await addLink(a, REBAR, SAW);
    expect(said).toMatch(/loop/i);
    expect.soft(sentA).toEqual([]);
    await agree(a, b);
  });

  test('K23 one links two tasks while the other moves one inside the other', async ({ a, b }) => {
    await Promise.allSettled([addLink(a, XRAY, CEILINGS), menu(b, CEILINGS, 'Move into the task above')]);
    await a.waitForTimeout(1_200);
    for (const page of [a, b]) {
      const popup = page.locator('.b-popup').filter({ hasText: 'Scheduling cycle' });
      if (await popup.count()) {
        await page.screenshot({ path: test.info().outputPath('K23-popup.png') });
        await popup.getByText(/Cancel/).first().click();
        await popup.getByRole('button', { name: 'Apply' }).click();
      }
    }
    await agree(a, b);
    expect(hasLoop(await planOf(a))).toBe(false);
  });

  test('K24 moving a split task keeps its gap, on both sides', async ({ a, b }) => {
    const segments = (page: Page) => page.evaluate(() => ((globalThis as any).__gantt().project.taskStore.getById(421).segments ?? []).map((segment: any) => segment.duration));
    const before = await segments(a);
    expect(before.length).toBeGreaterThan(1);
    await moveStart(a, 421, 2);
    await agree(a, b);
    expect.soft(await segments(a)).toEqual(before);
    expect.soft(await segments(b)).toEqual(before);
  });

  // Replaying the pending delete and link proposes the end of the split tasks they move: a cycle no link can
  // break, which took the second browser out of sync for good. Holding the revision back makes it happen every time.
  test('K26 pending changes that move split tasks are replayed under someone else\'s', async ({ a, b }) => {
    const pieces = (page: Page) =>
      page.evaluate(() => [421, 341].map((id) => ((globalThis as any).__gantt().project.taskStore.getById(id).segments ?? []).map((segment: any) => segment.duration)));
    const before = await pieces(a);
    await b.route('**/rpc/submit_revision', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue().catch(() => undefined);
    });
    await selectRows(b, 242, 464);
    await menu(b, 464, 'Delete');
    expect(await addLink(b, 462, 111)).toBeNull();
    await menu(a, 614, 'Add', 'Task below');
    await b.waitForTimeout(2_500);
    await expect(badge(b)).not.toHaveAttribute('data-sync-status', 'error');
    await b.unroute('**/rpc/submit_revision');
    await agree(a, b);
    expect.soft(await pieces(a)).toEqual(before);
    expect.soft(await pieces(b)).toEqual(before);
  });

  // Bryntum #13859: undo and redo crossing their own revisions on the way back left a task with no dates.
  test('K27 delete, undo, redo, undo while the server is slow: the task comes back whole, everywhere', async ({ a, b }) => {
    const before = taskIn(await planOf(a), INSPECT)!;
    await a.route('**/rpc/submit_revision', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue().catch(() => undefined);
    });
    await menu(a, INSPECT, 'Delete');
    await liveIn(a, (plan) => !taskIn(plan, INSPECT), 'gone');
    for (const button of ['Undo', 'Redo', 'Undo']) {
      await a.getByRole('button', { name: new RegExp(`^${button}`) }).first().click();
      await a.waitForTimeout(250);
    }
    await a.unroute('**/rpc/submit_revision');
    await liveIn(b, (plan) => Boolean(taskIn(plan, INSPECT)), 'back in the other browser');
    await agree(a, b);
    const after = taskIn(await planOf(a), INSPECT)!;
    expect.soft([after.start, after.parent, after.name]).toEqual([before.start, before.parent, before.name]);
  });

  // Bryntum #13068: the same pair of tasks, linked differently by two people at once.
  test('K28 both link the same two tasks, one finish-to-start and one start-to-start: one link, everywhere', async ({ a, b }) => {
    const same = (page: Page, type: number) =>
      page.evaluate(
        async ({ from, to, kind }) => {
          const { addLink: add } = await import('/src/inspector/task/apply.ts' as string);
          return add((globalThis as any).__gantt().project, { fromId: from, toId: to, type: kind }).then(
            () => null,
            (error: Error) => error.message,
          );
        },
        { from: XRAY, to: 422, kind: type },
      );
    await Promise.all([same(a, 2), same(b, 0)]);
    await a.waitForTimeout(1_200);
    await agree(a, b);
    expect(into(await planOf(a), 422).filter((link) => link.from === XRAY)).toHaveLength(1);
  });

  // Bryntum #11451: redoing a removal lost track of what was assigned.
  test('K29 a task with a crew deleted, undone, redone and undone again: the crew comes back, everywhere', async ({ a, b }) => {
    const crewsBefore = taskIn(await planOf(a), DIG)!.crews;
    expect(crewsBefore.length).toBeGreaterThan(0);
    await menu(a, DIG, 'Delete');
    await liveIn(b, (plan) => !taskIn(plan, DIG), 'gone');
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => Boolean(taskIn(plan, DIG)), 'back');
    await a.getByTestId('gantt-redo').click();
    await liveIn(b, (plan) => !taskIn(plan, DIG), 'gone again');
    await a.getByTestId('gantt-undo').click();
    await liveIn(b, (plan) => Boolean(taskIn(plan, DIG)), 'back again');
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), DIG)?.crews).toEqual(crewsBefore);
    expect.soft(taskIn(await planOf(b), DIG)?.crews).toEqual(crewsBefore);
  });

  for (const held of ['the mover', 'the adder'] as const) {
    test(`K30 one moves a task out a level while the other adds a subtask under it, ${held} reaching the server last`, async ({ a, b }) => {
      const page = held === 'the mover' ? b : a;
      await page.route('**/rpc/submit_revision', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        await route.continue().catch(() => undefined);
      });
      await Promise.all([menu(a, 121, 'Add', 'Subtask'), menu(b, 121, 'Move out one level')]);
      await a.waitForTimeout(2_000);
      await page.unroute('**/rpc/submit_revision');
      await agree(a, b);
      const plan = await planOf(a);
      expect.soft(taskIn(plan, 121)?.parent).toBe(100);
    });
  }

  for (const held of ['first', 'second'] as const) {
    test(`K31 both undo at the same moment, one undoing a delete, the ${held} person's reaching the server last`, async ({ a, b }) => {
      await menu(a, CEILINGS, 'Add', 'Task below');
      await menu(b, DIG, 'Delete');
      await liveIn(a, (plan) => !taskIn(plan, DIG), 'gone in the first browser');
      await Promise.all([saved(a), saved(b)]);
      const slow = held === 'first' ? a : b;
      await slow.route('**/rpc/submit_revision', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        await route.continue().catch(() => undefined);
      });
      await Promise.all([a.getByTestId('gantt-undo').click(), b.getByTestId('gantt-undo').click()]);
      await a.waitForTimeout(1_800);
      await slow.unroute('**/rpc/submit_revision');
      await agree(a, b);
      expect.soft(taskIn(await planOf(a), DIG), 'the delete is undone').toBeDefined();
    });

    test(`K32 one undoes a delete while the other pastes a copy of that group, the ${held} person's reaching the server last`, async ({ a, b }) => {
      await menu(b, DIG, 'Delete');
      await liveIn(a, (plan) => !taskIn(plan, DIG), 'gone in the first browser');
      await Promise.all([saved(a), saved(b)]);
      const slow = held === 'first' ? a : b;
      await slow.route('**/rpc/submit_revision', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        await route.continue().catch(() => undefined);
      });
      await menu(a, FOOTINGS, 'Copy task');
      await Promise.all([menu(a, PAINTING, 'Paste task'), b.getByTestId('gantt-undo').click()]);
      await a.waitForTimeout(1_800);
      await a.getByTestId('gantt-undo').click();
      await a.waitForTimeout(1_200);
      await slow.unroute('**/rpc/submit_revision');
      await agree(a, b);
      expect.soft(taskIn(await planOf(a), DIG), 'the delete is undone').toBeDefined();
    });
  }

  // Found in Z: the delete went out marked as calculated, so the other browser never applied it.
  for (const kind of ['while someone else\'s change lands', 'during its own recalculation'] as const) {
    test(`K33 a menu action clicked in the turn the engine leaves for the screen, ${kind}, reaches everyone`, async ({ a, b }) => {
      await nameCell(b, DIG).click({ button: 'right' });
      await expect(b.locator('.b-float-root .b-menu-item').filter({ hasText: /^Delete$/ }).first()).toBeVisible();
      // A real click, queued in that turn, the way the browser queues a person's.
      await b.evaluate(() => {
        const project = (globalThis as any).__gantt().project;
        const detach = project.on({
          refresh: ({ isCalculated }: { isCalculated?: boolean }) => {
            if (!isCalculated) return;
            detach();
            setTimeout(() => [...document.querySelectorAll<HTMLElement>('.b-float-root .b-menu-item')].find((element) => element.textContent?.trim() === 'Delete')?.click());
          },
        });
      });
      if (kind === 'during its own recalculation') await b.evaluate((id) => ((globalThis as any).__gantt().project.taskStore.getById(id).duration = 9), SAW);
      else await moveStart(a, SAW, 1);
      await liveIn(a, (plan) => !taskIn(plan, DIG), 'gone in the other browser');
      await agree(a, b);
    });
  }

  test('K25 two people move two groups into each other: one move stands, nobody is out of sync', async ({ a, b }) => {
    await Promise.allSettled([dragRow(a, PARTITIONS, 421, 'below'), dragRow(b, PAINTING, DRYWALL, 'below')]);
    await a.waitForTimeout(1_200);
    await agree(a, b);
    const plan = await planOf(a);
    expect.soft(taskIn(plan, PARTITIONS)?.parent === PAINTING && taskIn(plan, PAINTING)?.parent === PARTITIONS, 'not each inside the other').toBe(false);
  });

  test('K8 both make the same link at once: one link, everywhere', async ({ a, b }) => {
    await Promise.all([addLink(a, XRAY, 422), addLink(b, XRAY, 422)]);
    await a.waitForTimeout(800);
    await agree(a, b);
    expect.soft(into(await planOf(a), 422).filter((link) => link.from === XRAY).length).toBe(1);
  });

  test('K9 both put the same crew on one task: on it once, everywhere', async ({ a, b }) => {
    await Promise.all([putCrew(a, XRAY, 2), putCrew(b, XRAY, 2)]);
    await a.waitForTimeout(800);
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), XRAY)?.crews.filter((crew) => crew === 'Halden Electrical').length).toBe(1);
  });

  test('K10 one indents the task the other outdents', async ({ a, b }) => {
    await menu(a, CEILINGS, 'Move into the task above');
    await agree(a, b);
    await Promise.allSettled([menu(a, CEILINGS, 'Move out one level'), menu(b, CEILINGS, 'Move out one level')]);
    await a.waitForTimeout(600);
    await agree(a, b);
  });

  // Known: a group that loses its last task keeps dates that can differ until a reload (docs/library-scenarios.md).
  test.fixme('K11 both delete the same task, and overlapping selections', async ({ a, b }) => {
    await Promise.all([menu(a, INSPECT, 'Delete'), menu(b, INSPECT, 'Delete')]);
    await agree(a, b);
    await selectRows(a, 421, 422);
    await selectRows(b, 422);
    await Promise.all([menu(a, 422, 'Delete'), menu(b, 422, 'Delete')]);
    await agree(a, b);
    const plan = await planOf(a);
    expect.soft(taskIn(plan, 421)).toBeUndefined();
    expect.soft(taskIn(plan, 422)).toBeUndefined();
  });

  test('K12 one cuts a task the other deletes, then pastes', async ({ a, b }) => {
    await menu(a, CEILINGS, 'Cut task');
    await menu(b, CEILINGS, 'Delete');
    await saved(b);
    await a.waitForTimeout(800);
    await menu(a, 422, 'Paste task').catch(() => undefined);
    await a.keyboard.press('Escape');
    await a.waitForTimeout(800);
    await agree(a, b);
    expect.soft(named(await planOf(a), 'Suspended ceilings').length).toBeLessThanOrEqual(1);
  });

  test('K13 one pastes into a group the other has just deleted', async ({ a, b }) => {
    await menu(a, DIG, 'Copy task');
    await Promise.allSettled([menu(a, 422, 'Paste task'), menu(b, PAINTING, 'Delete')]);
    await a.keyboard.press('Escape');
    await a.waitForTimeout(1_000);
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), PAINTING)).toBeUndefined();
  });

  test('K14 one drags a row into a group the other is deleting', async ({ a, b }) => {
    await showRow(a, XRAY);
    await Promise.allSettled([dragRow(a, XRAY, 421, 'below'), menu(b, PAINTING, 'Delete')]);
    await a.waitForTimeout(800);
    await agree(a, b);
  });

  test('K15 a snippet lands next to a row the other is moving', async ({ a, b }) => {
    await openLibrary(a);
    await dropCard(a, 'Exam room build-out', DRYWALL);
    await expect(choice(a)).toBeVisible();
    await numbersReady(a);
    await Promise.all([way(a, 'push').click(), dragRow(b, CEILINGS, 421, 'below')]);
    await expect(dropNote(a)).toContainText(/Added/);
    await agree(a, b);
  });

  test('K16 a snippet pushes a task the other is deleting', async ({ a, b }) => {
    await openLibrary(a);
    await dropCard(a, 'Exam room build-out', DRYWALL);
    await expect(choice(a)).toBeVisible();
    await numbersReady(a);
    await Promise.all([way(a, 'push').click(), menu(b, CEILINGS, 'Delete')]);
    await expect(dropNote(a)).toContainText(/Added/);
    await agree(a, b);
    expect.soft(taskIn(await planOf(a), CEILINGS)).toBeUndefined();
  });

  test('K17 a snippet lands while the other renames, reschedules and links around it', async ({ a, b }) => {
    await openLibrary(a);
    await dropCard(a, 'Exam room build-out', DRYWALL);
    await expect(choice(a)).toBeVisible();
    await numbersReady(a);
    // Rows redrawing under the pointer can make a person miss their double-click: they would try again.
    await Promise.allSettled([way(a, 'push').click(), rename(b, CEILINGS, 'Ceilings, moved'), moveStart(b, 421, 2)]);
    await expect(dropNote(a)).toContainText(/Added/);
    await agree(a, b);
  });

  test('K18 both drop onto each other’s freshly dropped work', async ({ a, b }) => {
    await openLibrary(a);
    await openLibrary(b);
    await dropCard(a, 'Exam room build-out', DRYWALL);
    await numbersReady(a);
    await way(a, 'fit').click();
    await expect(dropNote(a)).toContainText('Added');
    await agree(a, b);
    const first = (await planOf(b)).tasks.find((task) => task.name === 'Exam room build-out')!.id as number;
    await Promise.all([
      (async () => {
        await dropCard(b, 'Firestopping & inspection package', first);
        await numbersReady(b);
        await way(b, 'fit').click();
      })(),
      (async () => {
        await dropCard(a, 'Firestopping & inspection package', CEILINGS);
        await numbersReady(a);
        await way(a, 'push').click();
      })(),
    ]);
    await agree(a, b);
  });

  test('K19 undo in one browser after the other has built on the change', async ({ a, b }) => {
    const created = await addBelow(a, INSPECT, 'Built on by B');
    await agree(a, b);
    expect.soft(await addLink(b, created, REBAR)).toBeNull();
    await rename(b, created, 'Renamed by B');
    await agree(a, b);
    await a.getByTestId('gantt-undo').click();
    await a.waitForTimeout(800);
    await a.getByTestId('gantt-undo').click();
    await a.waitForTimeout(800);
    await agree(a, b);
  });

  test('K20 rapid fire on the same rows from both sides', async ({ a, b }) => {
    const type = async (page: Page, id: number, text: string) => {
      await showRow(page, id);
      await nameCell(page, id).dblclick();
      const input = page.locator('.b-cell-editor input:visible');
      await input.fill(text);
      await input.press('Enter');
    };
    const burst = async (page: Page, tag: string) => {
      for (let round = 0; round < 4; round++) {
        await type(page, DIG, `${tag} ${round}`);
        await type(page, INSPECT, `${tag} ${round}`);
      }
    };
    await Promise.all([burst(a, 'A'), burst(b, 'B')]);
    await agree(a, b);
  });

  test('K21 one edits a cell while the other deletes the group holding it, and keeps typing elsewhere', async ({ a, b }) => {
    await showRow(a, DIG);
    await nameCell(a, DIG).dblclick();
    const input = a.locator('.b-cell-editor input:visible');
    await input.fill('In a group that goes away');
    await menu(b, FOOTINGS, 'Delete');
    await saved(b);
    await a.waitForTimeout(1_000);
    if (await input.isVisible()) await input.press('Enter');
    await expect(input).toHaveCount(0);
    await agree(a, b);
    await rename(a, CEILINGS, 'Still working');
    await agree(a, b);
  });

  test('K22 a filtered browser and an unfiltered one fight over the same group', async ({ a, b }) => {
    await search(a, SEARCH);
    // One pointer each: the second person deletes, then drags, while the first copies and pastes.
    await Promise.allSettled([menu(a, PARTITIONS, 'Copy task').then(() => menu(a, PAINTING, 'Paste task')), menu(b, XRAY, 'Delete').then(() => dragRow(b, DRYWALL, CEILINGS, 'below'))]);
    await a.keyboard.press('Escape');
    await a.waitForTimeout(1_000);
    await agree(a, b);
  });
});

/** As `agree`, leaving out the known difference in a group that lost its last task. */
async function agreeExceptEmptied(a: Page, b: Page, groups: ReadonlySet<number>, label: string): Promise<void> {
  await Promise.all([saved(a), saved(b)]);
  await expect
    .poll(
      async () => {
        const [left, right] = [await planOf(a), await planOf(b)];
        const parents = new Set(left.tasks.map((task) => task.parent));
        const emptied = new Set(left.tasks.filter((task) => groups.has(task.id as number) && !parents.has(task.id)).map((task) => task.id));
        return planDiff(left, right).filter((line) => !emptied.has(Number(/^task (\d+)/.exec(line)?.[1])));
      },
      { timeout: 12_000, message: `${label} hold the same plan` },
    )
    .toEqual([]);
}

test.describe('a long session', () => {
  test.setTimeout(420_000);

  /** Small and repeatable: the same seed takes the same turns. */
  const randomFrom = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mix = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mix = (mix + Math.imul(mix ^ (mix >>> 7), 61 | mix)) ^ mix;
    return ((mix ^ (mix >>> 14)) >>> 0) / 4_294_967_296;
  };

  type Turn = (page: Page, pick: <T>(list: readonly T[]) => T) => Promise<string>;

  const leafIds = async (page: Page) => {
    const plan = await planOf(page);
    const parents = new Set(plan.tasks.map((task) => task.parent));
    return plan.tasks.filter((task) => typeof task.id === 'number' && !parents.has(task.id) && task.parent !== null).map((task) => task.id as number);
  };
  const groupIds = async (page: Page) => {
    const plan = await planOf(page);
    const parents = new Set(plan.tasks.map((task) => task.parent));
    return plan.tasks.filter((task) => typeof task.id === 'number' && parents.has(task.id)).map((task) => task.id as number);
  };

  const TURNS: Record<string, Turn> = {
    rename: async (page, pick) => {
      const id = pick(await leafIds(page));
      await rename(page, id, `R${Date.now() % 100000}`);
      return `rename ${id}`;
    },
    reschedule: async (page, pick) => {
      const id = pick(await leafIds(page));
      await moveStart(page, id, pick([1, 2, 3, 5]));
      return `reschedule ${id}`;
    },
    dragBar: async (page, pick) => {
      const id = pick(await leafIds(page));
      await dragBar(page, id, pick([40, 70, 110, -40]));
      return `dragBar ${id}`;
    },
    add: async (page, pick) => {
      const id = pick(await leafIds(page));
      await menu(page, id, 'Add', 'Task below');
      return `add below ${id}`;
    },
    subtask: async (page, pick) => {
      const id = pick(await leafIds(page));
      await menu(page, id, 'Add', 'Subtask');
      return `subtask of ${id}`;
    },
    remove: async (page, pick) => {
      const id = pick(await leafIds(page));
      await menu(page, id, 'Delete');
      return `delete ${id}`;
    },
    removeGroup: async (page, pick) => {
      const id = pick(await groupIds(page));
      await menu(page, id, 'Delete');
      return `delete group ${id}`;
    },
    bulkRemove: async (page, pick) => {
      const ids = await leafIds(page);
      const [first, second] = [pick(ids), pick(ids)];
      await selectRows(page, ...new Set([first, second]));
      await menu(page, second, 'Delete');
      return `bulk delete ${first} ${second}`;
    },
    indent: async (page, pick) => {
      const id = pick(await leafIds(page));
      await menu(page, id, 'Move into the task above');
      return `indent ${id}`;
    },
    outdent: async (page, pick) => {
      const id = pick(await leafIds(page));
      await menu(page, id, 'Move out one level');
      return `outdent ${id}`;
    },
    reorder: async (page, pick) => {
      const ids = await leafIds(page);
      const [id, target] = [pick(ids), pick(ids)];
      if (id !== target) {
        await showRow(page, id);
        if (await nameCell(page, target).isVisible()) await dragRow(page, id, target, pick(['above', 'below']));
      }
      return `reorder ${id} by ${target}`;
    },
    copyPaste: async (page, pick) => {
      const ids = await leafIds(page);
      const [id, target] = [pick(ids), pick(ids)];
      await menu(page, id, 'Copy task');
      await menu(page, target, 'Paste task');
      return `copy ${id} to ${target}`;
    },
    copyGroup: async (page, pick) => {
      const id = pick(await groupIds(page));
      const target = pick(await groupIds(page));
      await menu(page, id, 'Copy task');
      await menu(page, target, 'Paste task');
      return `copy group ${id} to ${target}`;
    },
    cutPaste: async (page, pick) => {
      const ids = await leafIds(page);
      const [id, target] = [pick(ids), pick(ids)];
      await menu(page, id, 'Cut task');
      await menu(page, target, 'Paste task');
      return `cut ${id} to ${target}`;
    },
    link: async (page, pick) => {
      const ids = await leafIds(page);
      const [from, to] = [pick(ids), pick(ids)];
      const said = from === to ? 'same' : await addLink(page, from, to);
      return `link ${from}>${to} ${said ?? 'ok'}`;
    },
    crew: async (page, pick) => {
      const id = pick(await leafIds(page));
      const crew = pick([1, 2, 3, 5, 6, 9]);
      const said = await putCrew(page, id, crew);
      return `crew ${crew} on ${id} ${said ?? 'ok'}`;
    },
    undo: async (page) => {
      const button = page.getByTestId('gantt-undo');
      if (await button.isEnabled()) await button.click();
      return 'undo';
    },
    redo: async (page) => {
      const button = page.getByTestId('gantt-redo');
      if (await button.isEnabled()) await button.click();
      return 'redo';
    },
    holdEditor: async (page, pick) => {
      const id = pick(await leafIds(page));
      await showRow(page, id);
      await nameCell(page, id).dblclick();
      const input = page.locator('.b-cell-editor input:visible');
      await input.fill(`H${Date.now() % 100000}`);
      await page.waitForTimeout(pick([300, 900, 1_600]));
      if (await input.isVisible()) await input.press('Enter');
      return `editor held on ${id}`;
    },
    search: async (page, pick) => {
      await search(page, pick(['ceilings', 'footing', 'level', 'paint', '']));
      return 'search';
    },
    clearSearch: async (page) => {
      await search(page, '');
      return 'clear search';
    },
    snippet: async (page, pick) => {
      const id = pick(await leafIds(page));
      await openLibrary(page);
      await dropCard(page, pick(['Exam room build-out', 'Firestopping & inspection package', 'X-ray room lead lining']), id);
      await expect(choice(page)).toBeVisible({ timeout: 5_000 });
      await numbersReady(page);
      await way(page, pick(['fit', 'push'])).click({ timeout: 2_000 });
      return `snippet by ${id}`;
    },
  };
  const NAMES = Object.keys(TURNS);

  for (const seed of [11, 23, 37]) {
    test(`L${seed} both people work at random for 30 rounds, and the plan holds`, async ({ a, b }, info) => {
      const random = randomFrom(seed);
      const pick = <T,>(list: readonly T[]): T => {
        if (list.length === 0) throw new Error('nothing to pick from');
        return list[Math.floor(random() * list.length)]!;
      };
      const log: string[] = [];
      const seedGroups = new Set(await groupIds(a));
      const take = async (page: Page, who: string, round: number) => {
        const name = pick(NAMES);
        try {
          log.push(`${round} ${who} ${await TURNS[name]!(page, pick)}`);
        } catch (error) {
          // A row the other person just removed, say: the person would simply try something else.
          log.push(`${round} ${who} ${name} did not happen: ${String(error).split('\n')[0]!.slice(0, 80)}`);
        }
        await page.keyboard.press('Escape').catch(() => undefined);
      };
      try {
        for (let round = 1; round <= 30; round++) {
          await Promise.all([take(a, 'A', round), take(b, 'B', round)]);
          for (const page of [a, b]) expect(await badge(page).getAttribute('data-sync-status'), `round ${round}: nobody is out of sync`).not.toBe('error');
          if (round % 6 === 0) {
            await agreeExceptEmptied(a, b, seedGroups, `after round ${round}, both browsers`);
            expect(hasLoop(await planOf(a)), `round ${round}: no loop`).toBe(false);
          }
        }
        await Promise.all([search(a, ''), search(b, '')]);
        await agreeExceptEmptied(a, b, seedGroups, 'at the end, both browsers');
      } finally {
        await info.attach('turns', { body: log.join('\n'), contentType: 'text/plain' });
      }
    });
  }
});

test('Z the sync badge never reported an error across a busy session of mixed edits', async ({ a, b }) => {
  const statuses: string[] = [];
  const watch = async (page: Page) => {
    const value = await badge(page).getAttribute('data-sync-status');
    if (value) statuses.push(value);
  };
  await search(a, SEARCH);
  await menu(a, CEILINGS, 'Add', 'Task below');
  await watch(a);
  await menu(b, DIG, 'Delete');
  await watch(b);
  await search(a, '');
  await menu(a, FOOTINGS, 'Copy task');
  await menu(a, PAINTING, 'Paste task');
  await watch(a);
  await menu(b, 422, 'Move into the task above').catch(() => undefined);
  await watch(b);
  await a.getByTestId('gantt-undo').click();
  await b.getByTestId('gantt-undo').click();
  await agree(a, b);
  expect(statuses).not.toContain('error');
});

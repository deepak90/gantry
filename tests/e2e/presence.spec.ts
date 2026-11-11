/**
 * Presence between two browsers of different sizes: each sees the other in the header, a pointer
 * over the plan lands on the same task (and date) on the other screen, a selected row is
 * highlighted for the other person, and follow mode mirrors the leader's zoom, date and task
 * without the follower ever sending a view back, until Escape, scrolling or the leader leaving.
 * Runs against the local Supabase stack with the seeded demo accounts (docs/SETUP.md).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface Credentials {
  email: string;
  password: string;
}

const PM: Credentials = { email: process.env.E2E_PM_EMAIL ?? 'pm@demo.local', password: process.env.E2E_PM_PASSWORD ?? 'demo-pm-2026' };
const CM: Credentials = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
const BOOT_MS = 90_000;
/** Presence and broadcasts travel through local Realtime: well under a second, with room to spare. */
const LIVE_MS = 5_000;
const CRANE_TASK = 15;

async function open(browser: Browser, who: Credentials, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  await expect(page.locator('.b-gantt .b-gantt-task-wrap').first()).toBeVisible({ timeout: BOOT_MS });
  await expect(page.getByTestId('presence-layer')).toHaveCount(1, { timeout: BOOT_MS });
  return { context, page };
}

/** Follows (or stops following) someone: their avatar opens a card about them; following is a button in it. */
async function toggleFollow(page: Page, session: string): Promise<void> {
  await page.getByTestId(`presence-avatar-${session}`).click();
  await expect(page.getByTestId(`presence-card-${session}`)).toBeVisible();
  await page.getByTestId(`presence-follow-${session}`).click();
}

/** The other person's avatar in this page's header, and their session id. */
async function otherPerson(page: Page, name: string): Promise<{ avatar: ReturnType<Page['locator']>; session: string }> {
  const avatar = page.locator(`[data-testid^="presence-avatar-"][data-name="${name}"]`);
  await expect(avatar).toHaveCount(1, { timeout: LIVE_MS * 2 });
  const testId = (await avatar.getAttribute('data-testid')) ?? '';
  return { avatar, session: testId.replace('presence-avatar-', '') };
}

const row = (page: Page, id: number) => page.locator(`.b-gantt .b-grid-sub-grid-locked .b-grid-row[data-id="${id}"]`);
const bar = (page: Page, id: number) => page.locator(`.b-gantt .b-gantt-task-wrap[data-task-id="${id}"] .b-gantt-task`);

/** Fits the project and scrolls the crane task's row into the middle. */
async function showCraneTask(page: Page): Promise<void> {
  await page.getByTestId('zoom-fit').click();
  await page.getByTestId('gantt-search').fill('Erect structural steel frame');
  await expect(row(page, CRANE_TASK)).toBeVisible();
  await expect(bar(page, CRANE_TASK)).toBeVisible();
}

const layerView = async (page: Page) => {
  const layer = page.getByTestId('presence-layer');
  return {
    preset: (await layer.getAttribute('data-view-preset')) ?? '',
    center: (await layer.getAttribute('data-view-center')) ?? '',
    anchor: (await layer.getAttribute('data-view-anchor')) ?? '',
  };
};

/** Scrolls with the mouse wheel over the visible middle of the plan's rows. */
async function wheelOver(page: Page, dx: number, dy: number): Promise<void> {
  const body = await page.locator('.b-gantt .b-grid-body-container').first().boundingBox();
  const timeline = await page.locator('.b-gantt .b-grid-sub-grid-normal').first().boundingBox();
  if (!body || !timeline) throw new Error('the plan is not on screen');
  const x = dx !== 0 ? timeline.x + Math.min(timeline.width, body.x + body.width - timeline.x) / 2 : body.x + body.width / 4;
  await page.mouse.move(x, body.y + body.height / 2);
  await page.mouse.wheel(dx, dy);
}

/**
 * Whether the follower shows what the leader shows: the same zoom level, the leader's middle date
 * within a few pixels of the middle of the follower's timeline, and the leader's middle task on screen
 * (in the middle, unless the follower's taller window is pinned at the top or bottom of the plan).
 */
async function describeFollow(follower: Page, lead: { preset: string; center: string; anchor: string }): Promise<string> {
  const seen = await follower.evaluate(({ center, anchor }) => {
    const gantt = (globalThis as { bryntum?: { fromElement(element: Element | null): any } }).bryntum?.fromElement(document.querySelector('.b-gantt'));
    if (!gantt) return null;
    const timeline = gantt.timeAxisSubGrid.scrollable;
    const offset = Math.abs(gantt.getCoordinateFromDate(new Date(center), true) - timeline.x - timeline.clientWidth / 2);
    const body = gantt.bodyContainer.getBoundingClientRect();
    const row = document.querySelector(`.b-gantt .b-grid-sub-grid-locked .b-grid-row[data-id="${anchor}"]`)?.getBoundingClientRect();
    return { preset: String(gantt.viewPreset.id), offset: Math.round(offset), onScreen: Boolean(row && row.top >= body.top - 1 && row.bottom <= body.bottom + 1) };
  }, lead);
  if (!seen) return 'no plan';
  return seen.preset === lead.preset && seen.offset <= 8 && seen.onScreen ? 'same view' : JSON.stringify({ lead, seen });
}

/** How a plan is drawn: folded rows, sort order, group rows, rows shown, zoom and the span of time on screen. */
async function planState(page: Page) {
  return page.evaluate(() => {
    const gantt = (globalThis as { bryntum?: { fromElement(element: Element | null): any } }).bryntum!.fromElement(document.querySelector('.b-gantt'));
    const collapsed: string[] = [];
    const rows: string[] = [];
    let groups = 0;
    gantt.store.traverse((record: any) => {
      const key = record.generatedParent ? `g:${record.key ?? record.name}` : `t:${(record.$original ?? record).id}`;
      if (record.generatedParent) groups++;
      if (!record.isLeaf && !record.isExpanded(gantt.store)) collapsed.push(key);
    });
    for (let index = 0; index < gantt.store.count; index++) {
      const record = gantt.store.getAt(index);
      rows.push(record.generatedParent ? `g:${record.key ?? record.name}` : `t:${(record.$original ?? record).id}`);
    }
    const span = gantt.visibleDateRange;
    return {
      collapsed: collapsed.sort(),
      sort: gantt.store.sorters.map((sorter: any) => `${sorter.field}:${sorter.ascending}`),
      groups,
      rows,
      preset: String(gantt.viewPreset.id),
      span: [span.startDate.getTime(), span.endDate.getTime()] as [number, number],
    };
  });
}

/** Whether two plans show the same rows in the same order. */
async function sameRows(a: Page, b: Page): Promise<string> {
  const [left, right] = await Promise.all([planState(a), planState(b)]);
  return left.rows.join(',') === right.rows.join(',') ? 'same rows' : `${left.rows.length} rows vs ${right.rows.length}: ${left.rows.slice(0, 6).join(',')} | ${right.rows.slice(0, 6).join(',')}`;
}

/** Whether two plans show the same span of time (within 2% of it), at the same zoom level. */
async function sameSpan(a: Page, b: Page): Promise<string> {
  const [left, right] = await Promise.all([planState(a), planState(b)]);
  const length = right.span[1] - right.span[0];
  const off = Math.max(Math.abs(left.span[0] - right.span[0]), Math.abs(left.span[1] - right.span[1]));
  return left.preset === right.preset && off <= length * 0.02 ? 'same span' : JSON.stringify({ follower: left.span.map((t) => new Date(t).toISOString()), leader: right.span.map((t) => new Date(t).toISOString()), presets: [left.preset, right.preset] });
}

/** Records the timeline and body scroll positions on every screen frame. */
async function recordScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as any;
    const gantt = w.bryntum.fromElement(document.querySelector('.b-gantt'));
    w.__scrollLog = [] as [number, number][];
    w.__recording = true;
    const tick = () => {
      if (!w.__recording) return;
      w.__scrollLog.push([gantt.timeAxisSubGrid.scrollable.x, gantt.scrollable.y]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Of the frames between the first and the last movement: the share that moved, and the biggest step. */
async function stopRecording(page: Page): Promise<{ movedShare: number; maxJump: number; frames: number }> {
  const log = await page.evaluate(() => {
    const w = globalThis as any;
    w.__recording = false;
    return w.__scrollLog as [number, number][];
  });
  const steps = log.slice(1).map((position, index) => Math.hypot(position[0] - log[index]![0], position[1] - log[index]![1]));
  const first = steps.findIndex((step) => step > 0);
  const last = steps.length - 1 - [...steps].reverse().findIndex((step) => step > 0);
  const window = first === -1 ? [] : steps.slice(first, last + 1);
  return { movedShare: window.length ? window.filter((step) => step > 0).length / window.length : 0, maxJump: Math.max(0, ...window), frames: window.length };
}

test.describe.serial('presence: live cursors and follow mode', () => {
  let pmContext: BrowserContext | undefined;
  let cmContext: BrowserContext | undefined;
  let pm: Page;
  let cm: Page;
  let cmSession = '';
  let pmSession = '';

  test.beforeAll(async ({ browser }) => {
    // Two different window sizes: positions travel as tasks and dates, never pixels.
    [{ context: pmContext, page: pm }, { context: cmContext, page: cm }] = await Promise.all([
      open(browser, PM, { width: 1600, height: 1000 }),
      open(browser, CM, { width: 1280, height: 820 }),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([pmContext?.close(), cmContext?.close()]);
  });

  test('each sees the other in the header, as a member', async () => {
    const cmSeenByPm = await otherPerson(pm, 'Deepak Jayaram');
    const pmSeenByCm = await otherPerson(cm, 'Chris Hale');
    cmSession = cmSeenByPm.session;
    pmSession = pmSeenByCm.session;
    // One role: everyone on the project reads as a member (and neither is a simulated person).
    await expect(cmSeenByPm.avatar).toHaveAttribute('aria-label', 'Deepak Jayaram, Member');
    await expect(pmSeenByCm.avatar).toHaveAttribute('aria-label', 'Chris Hale, Member');
    // Nobody else is in this plan: the simulated crowd works in another project.
    await expect(pm.getByTestId('presence-bar')).toHaveAttribute('data-count', '1');
    await expect(cm.getByTestId('presence-bar')).toHaveAttribute('data-count', '1');
  });

  test('a pointer over the plan lands on the same task and date on the other screen', async () => {
    await Promise.all([showCraneTask(pm), showCraneTask(cm)]);
    const cursor = pm.getByTestId(`presence-cursor-${cmSession}`);

    // Over the grid: the same row and column.
    await cm.locator(`.b-gantt .b-grid-row[data-id="${CRANE_TASK}"] .b-grid-cell[data-column-id="schedule-when"]`).hover();
    await expect(cursor).toBeVisible({ timeout: LIVE_MS });
    await expect(cursor).toHaveAttribute('data-task-id', String(CRANE_TASK));
    await expect(cursor).toHaveAttribute('data-kind', 'grid');

    // Over the timeline: the middle of the crane bar is a date inside the same bar on the other screen.
    const cmBar = await bar(cm, CRANE_TASK).boundingBox();
    expect(cmBar).not.toBeNull();
    await cm.mouse.move(cmBar!.x + cmBar!.width / 2, cmBar!.y + cmBar!.height / 2, { steps: 4 });
    await expect(cursor).toHaveAttribute('data-kind', 'timeline', { timeout: LIVE_MS });
    await expect
      .poll(
        async () => {
          const [arrow, pmBar, pmRow] = await Promise.all([cursor.boundingBox(), bar(pm, CRANE_TASK).boundingBox(), pm.locator(`.b-gantt .b-grid-sub-grid-normal .b-grid-row[data-id="${CRANE_TASK}"]`).boundingBox()]);
          if (!arrow || !pmBar || !pmRow) return 'not placed';
          const insideBar = arrow.x >= pmBar.x - 2 && arrow.x <= pmBar.x + pmBar.width + 2;
          const insideRow = arrow.y >= pmRow.y - 2 && arrow.y <= pmRow.y + pmRow.height + 2;
          return insideBar && insideRow ? 'on the crane bar' : `at ${Math.round(arrow.x)},${Math.round(arrow.y)}`;
        },
        { timeout: LIVE_MS },
      )
      .toBe('on the crane bar');

    // Leaving the plan takes the pointer away.
    await cm.getByTestId('gantt-toolbar').hover();
    await expect(cursor).toHaveCount(0, { timeout: LIVE_MS });
    // Nobody sees their own pointer.
    await expect(cm.locator('[data-testid^="presence-cursor-"]')).toHaveCount(0);
  });

  test('the cell the other person is on is framed in their color, with their name', async () => {
    await cm.locator(`.b-gantt .b-grid-row[data-id="${CRANE_TASK}"] .b-grid-cell[data-column="name"]`).click();
    const active = pm.getByTestId(`presence-active-${cmSession}`);
    await expect(active).toHaveAttribute('data-task-id', String(CRANE_TASK), { timeout: LIVE_MS });
    await expect(active).toHaveAttribute('data-column', 'task');
    await expect(active).toBeVisible();
    await expect(pm.getByTestId(`presence-flag-${cmSession}`)).toHaveText('Deepak');
    // The frame sits exactly on the same cell of the other screen.
    const [frame, own] = await Promise.all([active.boundingBox(), pm.locator(`.b-gantt .b-grid-row[data-id="${CRANE_TASK}"] .b-grid-cell[data-column="name"]`).boundingBox()]);
    expect(Math.abs(frame!.y - own!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(frame!.height - own!.height)).toBeLessThanOrEqual(1);
  });

  test('a block of selected cells shows as one tinted, outlined block', async () => {
    await cm.getByTestId('gantt-search').fill('');
    await pm.getByTestId('gantt-search').fill('');
    const cmCell = (id: number, column: string) => cm.locator(`.b-gantt .b-grid-row[data-id="${id}"] .b-grid-cell[data-column-id="${column}"]`);
    const from = await cmCell(211, 'schedule-crew').boundingBox();
    const to = await cmCell(213, 'schedule-when').boundingBox();
    await cm.mouse.move(from!.x + 10, from!.y + 10);
    await cm.mouse.down();
    await cm.mouse.move(to!.x + 20, to!.y + 10, { steps: 8 });
    await cm.mouse.up();
    // Three rows by three columns: Crew, Equipment (between them in the default layout) and Schedule.
    const cells = pm.getByTestId(`presence-cell-${cmSession}`);
    await expect(cells).toHaveCount(9, { timeout: LIVE_MS });
    const edges = await cells.evaluateAll((elements) =>
      elements.map((element) => ({ row: element.getAttribute('data-task-id'), column: element.getAttribute('data-column'), top: element.classList.contains('edge-t'), bottom: element.classList.contains('edge-b'), left: element.classList.contains('edge-l'), right: element.classList.contains('edge-r') })),
    );
    expect(edges.map((edge) => `${edge.row}/${edge.column}`).sort()).toEqual(
      ['211', '212', '213'].flatMap((row) => ['equipment', 'schedule-crew', 'schedule-when'].map((column) => `${row}/${column}`)).sort(),
    );
    // One outline around the block: top edges on the first row, bottom edges on the last, left edges on the first column, right edges on the last.
    for (const edge of edges) {
      expect(edge.top, `top edge of ${edge.row}/${edge.column}`).toBe(edge.row === '211');
      expect(edge.bottom, `bottom edge of ${edge.row}/${edge.column}`).toBe(edge.row === '213');
      expect(edge.left, `left edge of ${edge.row}/${edge.column}`).toBe(edge.column === 'schedule-crew');
      expect(edge.right, `right edge of ${edge.row}/${edge.column}`).toBe(edge.column === 'schedule-when');
    }
  });

  test('editing a cell shows on the other screen while it lasts', async () => {
    await cm.locator('.b-gantt .b-grid-row[data-id="213"] .b-grid-cell[data-column="name"]').dblclick();
    const active = pm.getByTestId(`presence-active-${cmSession}`);
    await expect(active).toHaveClass(/is-editing/, { timeout: LIVE_MS });
    await expect(active).toHaveAttribute('data-task-id', '213');
    await expect(pm.getByTestId(`presence-flag-${cmSession}`)).toHaveClass(/is-open/);
    await cm.keyboard.press('Escape');
    await expect(active).not.toHaveClass(/is-editing/, { timeout: LIVE_MS });
  });

  test('a fill shows the cells it is about to write, and nothing once it is called off', async () => {
    // The leader's narrower window: fold the side panel so the Schedule column (and its fill handle) fits.
    await cm.getByTestId('inspector-tab-task').click();
    await expect(cm.getByTestId('task-inspector')).toHaveCount(0);
    await cm.locator('.b-gantt .b-grid-row[data-id="211"] .b-grid-cell[data-column-id="schedule-when"]').click();
    const handle = await cm.locator('.b-fill-handle-handle').first().boundingBox();
    const target = await cm.locator('.b-gantt .b-grid-row[data-id="214"] .b-grid-cell[data-column-id="schedule-when"]').boundingBox();
    await cm.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await cm.mouse.down();
    await cm.mouse.move(handle!.x + handle!.width / 2, target!.y + target!.height / 2, { steps: 10 });
    await expect(pm.getByTestId(`presence-fill-${cmSession}`).first()).toBeVisible({ timeout: LIVE_MS });
    expect(await pm.getByTestId(`presence-fill-${cmSession}`).count()).toBeGreaterThanOrEqual(3);
    // Escape calls the fill off: nothing is written, and the preview goes.
    await cm.keyboard.press('Escape');
    await cm.mouse.up();
    await expect(pm.getByTestId(`presence-fill-${cmSession}`)).toHaveCount(0, { timeout: LIVE_MS });
    await cm.getByTestId('inspector-tab-task').click();
  });

  test('follow mode mirrors zoom, date and task across window sizes, and never sends a view back', async () => {
    await Promise.all([pm.getByTestId('gantt-search').fill(''), cm.getByTestId('gantt-search').fill('')]);
    await toggleFollow(pm, cmSession);
    await expect(pm.getByTestId('follow-banner')).toHaveAttribute('data-following', cmSession, { timeout: LIVE_MS });
    await expect(pm.getByTestId('follow-banner')).toContainText('Following Deepak Jayaram');
    await expect(cm.getByTestId('presence-followers')).toContainText('Chris is following you', { timeout: LIVE_MS });

    // The leader zooms and scrolls; the follower shows the same zoom, the same date and task in the middle.
    await cm.getByRole('button', { name: 'Zoom in' }).click();
    await wheelOver(cm, 0, 900);
    await wheelOver(cm, 600, 0);
    await expect
      .poll(async () => describeFollow(pm, await layerView(cm)), { timeout: LIVE_MS * 2 })
      .toBe('same view');

    // The leader selects a task: the follower's plan selects it too.
    const lead = await layerView(cm);
    if (lead.anchor) {
      await cm.locator(`.b-gantt .b-grid-row[data-id="${lead.anchor}"] .b-grid-cell[data-column="name"]`).click();
      await expect(pm.locator(`.b-gantt .b-grid-sub-grid-locked .b-grid-row[data-id="${lead.anchor}"]`)).toHaveClass(/b-selected/, { timeout: LIVE_MS });
    }

    // No feedback loop: the follower applied frames but sent none.
    expect(Number(await pm.getByTestId('presence-bar').getAttribute('data-frames-applied'))).toBeGreaterThan(0);
    await expect(pm.getByTestId('presence-bar')).toHaveAttribute('data-frames-sent', '0');
    // Clicking a task whose bar is off screen scrolls the leader's plan to it, over 300 ms: the leader is still after that.
    await cm.waitForTimeout(800);
    const appliedBefore = Number(await pm.getByTestId('presence-bar').getAttribute('data-frames-applied'));
    await pm.waitForTimeout(2_500);
    // A still leader sends only heartbeats (every 2 s).
    expect(Number(await pm.getByTestId('presence-bar').getAttribute('data-frames-applied')) - appliedBefore).toBeLessThanOrEqual(2);
    await expect(pm.getByTestId('presence-bar')).toHaveAttribute('data-frames-sent', '0');
  });

  test('Escape stops following; the leader’s moves no longer move the follower', async () => {
    await pm.keyboard.press('Escape');
    await expect(pm.getByTestId('follow-banner')).toHaveCount(0);
    await expect(cm.getByTestId('presence-followers')).toHaveCount(0, { timeout: LIVE_MS });
    const before = await layerView(pm);
    await cm.getByRole('button', { name: 'Zoom out' }).click();
    await wheelOver(cm, 0, -600);
    await cm.waitForTimeout(1_000);
    expect(await layerView(pm)).toEqual(before);
  });

  test('scrolling the plan yourself also stops following', async () => {
    await toggleFollow(pm, cmSession);
    await expect(pm.getByTestId('follow-banner')).toBeVisible({ timeout: LIVE_MS });
    await wheelOver(pm, 0, 400);
    await expect(pm.getByTestId('follow-banner')).toHaveCount(0);
  });

  test('a follower moves on every screen frame while the leader pans, not in jumps', async () => {
    await toggleFollow(pm, cmSession);
    await expect(pm.getByTestId('follow-banner')).not.toContainText('waiting', { timeout: LIVE_MS });
    await pm.waitForTimeout(500);
    await recordScroll(pm);
    // 3 s of a steady pan on the leader, driven frame by frame.
    await cm.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const gantt = (globalThis as { bryntum?: { fromElement(element: Element | null): any } }).bryntum!.fromElement(document.querySelector('.b-gantt'));
          const start = performance.now();
          const step = (time: number) => {
            gantt.timeAxisSubGrid.scrollable.x += 6;
            gantt.scrollable.y += 3;
            if (time - start < 3_000) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        }),
    );
    await pm.waitForTimeout(500);
    const motion = await stopRecording(pm);
    // Before the fix the follower moved on ~18% of frames (10 jumps a second, up to 47 px each).
    expect(motion.movedShare, JSON.stringify(motion)).toBeGreaterThan(0.85);
    expect(motion.maxJump, JSON.stringify(motion)).toBeLessThan(25);
    await pm.keyboard.press('Escape');
    await expect(pm.getByTestId('follow-banner')).toHaveCount(0);
  });

  test('a follower sees the plan folded, filtered, sorted, grouped and zoomed like the leader, then gets their own back', async () => {
    // The follower's own way of looking at the plan: only work in progress.
    await pm.getByTestId('gantt-filter').getByRole('radio', { name: /In progress/ }).click();
    const own = await planState(pm);

    await toggleFollow(pm, cmSession);
    await expect(pm.getByTestId('follow-banner')).not.toContainText('waiting', { timeout: LIVE_MS });
    // The leader's filter (everything) replaces the follower's at once.
    await expect(pm.getByTestId('gantt-filter').getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true', { timeout: LIVE_MS });

    // The leader folds an open phase that is on their screen.
    const phase = await cm.evaluate(() => {
      const gantt = (globalThis as { bryntum?: { fromElement(element: Element | null): any } }).bryntum!.fromElement(document.querySelector('.b-gantt'));
      const shown = gantt.rowManager.rows.map((row: any) => gantt.store.getById(row.id)).filter(Boolean);
      return shown.find((record: any) => !record.isLeaf && record.isExpanded(gantt.store) && record.children.length > 1)?.id as number;
    });
    expect(phase).toBeTruthy();
    await cm.locator(`.b-gantt .b-grid-sub-grid-locked .b-grid-row[data-id="${phase}"] .b-tree-expander`).click();
    await expect.poll(async () => (await planState(pm)).collapsed, { timeout: LIVE_MS }).toContain(`t:${phase}`);
    await expect.poll(async () => sameRows(pm, cm), { timeout: LIVE_MS }).toBe('same rows');

    // Sorted by name from the column header.
    await cm.evaluate(() => {
      const gantt = (globalThis as { bryntum?: { fromElement(element: Element | null): any } }).bryntum!.fromElement(document.querySelector('.b-gantt'));
      gantt.store.sort({ field: 'name', columnOwned: true }, false);
    });
    await expect.poll(async () => (await planState(pm)).sort, { timeout: LIVE_MS }).toEqual(['name:false']);
    await expect.poll(async () => sameRows(pm, cm), { timeout: LIVE_MS }).toBe('same rows');

    // Filtered to what needs attention, and searched.
    await cm.getByTestId('gantt-filter').getByRole('radio', { name: /Attention/ }).click();
    await expect(pm.getByTestId('gantt-filter').getByRole('radio', { name: /Attention/ })).toHaveAttribute('aria-checked', 'true', { timeout: LIVE_MS });
    // The follower takes the leader's rule for what needs attention, so the same rows show.
    await expect.poll(async () => sameRows(pm, cm), { timeout: LIVE_MS }).toBe('same rows');
    await cm.getByTestId('gantt-filter').getByRole('radio', { name: /^All/ }).click();
    await cm.getByTestId('gantt-search').fill('steel');
    await expect(pm.getByTestId('gantt-search')).toHaveValue('steel', { timeout: LIVE_MS });
    await expect.poll(async () => sameRows(pm, cm), { timeout: LIVE_MS }).toBe('same rows');
    await cm.getByTestId('gantt-search').fill('');

    // Grouped by crew.
    await cm.getByTestId('gantt-view').click();
    await cm.getByTestId('gantt-group').getByRole('menuitemradio', { name: 'Crew' }).click();
    await cm.keyboard.press('Escape');
    await expect.poll(async () => (await planState(pm)).groups, { timeout: LIVE_MS * 2 }).toBeGreaterThan(0);
    await expect.poll(async () => sameRows(pm, cm), { timeout: LIVE_MS }).toBe('same rows');

    // Zoomed to fit the whole project: the same span of time on a window of another size.
    await cm.getByTestId('zoom-fit').click();
    await expect.poll(async () => sameSpan(pm, cm), { timeout: LIVE_MS }).toBe('same span');

    // Back on the follower: stop, and take their own view back.
    await pm.keyboard.press('Escape');
    await expect(pm.getByTestId('presence-restore')).toBeVisible();
    await pm.getByTestId('presence-restore').getByRole('button', { name: 'Back to my view' }).click();
    await expect(pm.getByTestId('gantt-filter').getByRole('radio', { name: /In progress/ })).toHaveAttribute('aria-checked', 'true', { timeout: LIVE_MS });
    await expect.poll(async () => planState(pm), { timeout: LIVE_MS }).toMatchObject({ collapsed: own.collapsed, sort: own.sort, groups: 0, preset: own.preset });

    // Leave both plans as they were for the next tests.
    await pm.getByTestId('gantt-filter').getByRole('radio', { name: /^All/ }).click();
    await cm.getByTestId('gantt-view').click();
    await cm.getByTestId('gantt-group').getByRole('menuitemradio', { name: 'Phase' }).click();
    await cm.keyboard.press('Escape');
    await cm.evaluate((id) => {
      const gantt = (globalThis as { bryntum?: { fromElement(element: Element | null): any } }).bryntum!.fromElement(document.querySelector('.b-gantt'));
      gantt.store.clearSorters();
      void gantt.expand(id);
    }, phase);
  });

  test('a person cannot follow someone who follows them', async () => {
    await toggleFollow(pm, cmSession);
    await expect(cm.getByTestId('presence-followers')).toBeVisible({ timeout: LIVE_MS });
    await toggleFollow(cm, pmSession);
    await expect(cm.getByTestId('presence-note')).toContainText('Chris is following you');
    await expect(cm.getByTestId('follow-banner')).toHaveCount(0);
  });

  test('following ends with a note when the leader leaves', async () => {
    await expect(pm.getByTestId('follow-banner')).toBeVisible();
    await cm.close();
    await expect(pm.getByTestId('follow-banner')).toHaveCount(0, { timeout: LIVE_MS * 3 });
    await expect(pm.getByTestId('presence-note')).toContainText('Deepak Jayaram left, so you stopped following.');
    await expect(pm.locator(`[data-testid="presence-avatar-${cmSession}"]`)).toHaveCount(0);
  });
});

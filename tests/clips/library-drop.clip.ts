/**
 * Clip: add a piece of work from the task library. Gesture: drag the "Accessible restroom build-out" card
 * from the Library tab onto the plan, just below "Safety vinyl flooring & cove base"; the card that
 * appears has the assistant's say on where it fits (after the flooring, before the doors) above the
 * ways to tie it in where it was let go; take the assistant's place. Then the result: the note in the
 * panel on what moved and why; with the panel closed, the piece's tasks in the grid under one heading,
 * with their outline numbers; and the links that tie it in, read from their hover cards: it waits for
 * the flooring, and the doors wait for it. The assistant's answer (place-snippet) is the clip's own,
 * given in the browser (write-free sandbox). Recorded as a tape (apps/clip-studio renders it): the
 * camera starts on the whole window, follows the card, reads the rows up close and ends on the plan.
 */
import { expect, test, type Page } from '@playwright/test';
import type { ClipRect } from '../../packages/shared/src/clips';
import { Tape, boxOf, center, clickOn, clipColumns, clipOverlay, glide, openTab, signIn, writeFreeSandbox, type ClipMeta, type Point } from './clip';

const META: ClipMeta = {
  id: 'library-drop',
  title: 'Add work from the library',
  summary: 'Drag a library card onto the plan; Remy says where it fits, and its tasks and links go in with it.',
  steps: [
    'Open the Library tab and grab a card.',
    'Drag it onto the plan: the line shows where it lands.',
    'Let go: take Remy’s place, or tie it in where you let go.',
    'The note says what moved and why; Undo takes it out again.',
    'Close the panel: its tasks sit under one heading, with outline numbers.',
    'Links tie it in: it waits for the flooring, and the doors wait for it.',
  ],
  topics: ['library', 'snippet', 'template', 'add work', 'drag', 'drop', 'reuse', 'where', 'fits', 'outline', 'links', 'undo'],
};

const SNIPPET = 'Accessible restroom build-out';
const AFTER = 461; // Safety vinyl flooring & cove base: the doors, millwork and handover work wait for it
const BEFORE = 462; // Doors, frames & hardware
const REASON = 'The build-out needs the vinyl floor and cove base down, and its door is hung with the others next.';
/** The piece: its heading, three groups and ten tasks. */
const ROWS = 14;

// The whole window in the clip's own shape, so the widest shot is all of it; wide enough for the grid
// and the piece's run of links side by side, with room for a link's card beside the last of them.
test.use({ viewport: { width: 1920, height: 1080 } });

/**
 * No link hover cards while the pointer crosses the plan, until the clip reads them (switched off in
 * Bryntum: a card hidden by a style never finishes its fade, and then sticks).
 */
const quietLinks = (page: Page, quiet: boolean) =>
  page.evaluate((on) => {
    (globalThis as any).bryntum.query('gantt').features.dependencies.showTooltip = !on;
  }, quiet);

interface Placed {
  /** Grid rows (the column side) of the anchor, the piece's rows in order, and the task after it. */
  anchor: ClipRect;
  rows: ClipRect[];
  next: ClipRect;
  /** Bars, as far as the timeline shows them: the anchor's, the piece's heading's, its first task's and the next task's. */
  bars: { anchor: ClipRect; top: ClipRect; first: ClipRect; next: ClipRect };
  /** Points on the links that tie the piece in, where the pointer finds the line itself (not a bar over it): from the anchor, and on to the next task. */
  into: Point | null;
  onward: Point | null;
}

/** Where the dropped piece is on screen, read from the plan (its tasks are those under its heading). */
function placed(page: Page): Promise<Placed | null> {
  return page.evaluate(
    ({ snippet, after, before }) => {
      const gantt = (globalThis as any).bryntum.query('gantt');
      const store = gantt.taskStore;
      const top = store.query((task: any) => task.name === snippet && task.libraryRef)[0];
      const anchor = store.getById(after);
      const next = store.getById(before);
      if (!top || !anchor || !next) return null;
      const piece: any[] = [];
      top.traverse((task: any) => piece.push(task));
      const box = (element: Element | null | undefined) => {
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const row = (task: any) => box(gantt.getRowFor(task)?.elements?.locked);
      const timeline = gantt.subGrids.normal.element.getBoundingClientRect();
      const bar = (task: any) => {
        const whole = box(gantt.getElementFromTaskRecord(task));
        if (!whole) return null;
        const left = Math.max(whole.x, timeline.left);
        return { ...whole, x: left, width: Math.max(1, Math.min(whole.x + whole.width, timeline.right) - left) };
      };
      // The point on a link's line nearest its middle where the pointer finds that line (bars and other lines cross it), in window pixels.
      const along = (link: any) => {
        const line = link && (gantt.getElementForDependency(link) as SVGGeometryElement | undefined);
        const matrix = line?.getScreenCTM?.();
        if (!line?.getTotalLength || !matrix) return null;
        const length = line.getTotalLength();
        let best: { x: number; y: number; off: number } | null = null;
        for (let at = 0; at <= length; at += 2) {
          const point = line.getPointAtLength(at);
          const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
          const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
          const hit = document.elementFromPoint(x, y) as HTMLElement | SVGElement | null;
          const off = Math.abs(at - length / 2);
          if (hit?.dataset?.depId === String(link.id) && (!best || off < best.off)) best = { x, y, off };
        }
        return best && { x: best.x, y: best.y };
      };
      const links = gantt.dependencyStore.records as any[];
      const into = links.find((link) => link.fromEvent === anchor && piece.includes(link.toEvent));
      const onward = links.find((link) => link.fromEvent === top && link.toEvent === next);
      const first = piece.find((task) => task.isLeaf);
      const rows = piece.map(row);
      const bars = { anchor: bar(anchor), top: bar(top), first: bar(first), next: bar(next) };
      if (rows.some((rect) => !rect) || !row(anchor) || !row(next) || Object.values(bars).some((rect) => !rect)) return null;
      return { anchor: row(anchor), rows, next: row(next), bars, into: along(into), onward: along(onward) };
    },
    { snippet: SNIPPET, after: AFTER, before: BEFORE },
  ) as Promise<Placed | null>;
}

/** Scrolls the plan to a row at the top, then a date at the left, eased (Bryntum's own scroll animation, on the tape's clock). */
function scrollPlan(page: Page, to: { row: number; date: number }, ms: number): Promise<void> {
  return page.evaluate(
    async ({ row, date, ms: duration }) => {
      const gantt = (globalThis as any).bryntum.query('gantt');
      const animate = { duration, easing: 'easeInOutCubic' };
      // One after the other: two scroll animations at once leave the timeline at the wrong date.
      await gantt.scrollRowIntoView(gantt.taskStore.getById(row), { block: 'start', animate });
      await gantt.scrollToDate(new Date(date), { block: 'start', animate });
    },
    { ...to, ms },
  );
}

const union = (boxes: readonly ClipRect[]): ClipRect => {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  return { x: left, y: top, width: Math.max(...boxes.map((box) => box.x + box.width)) - left, height: Math.max(...boxes.map((box) => box.y + box.height)) - top };
};

test(META.title, async ({ page, context }) => {
  // A tape records at a fraction of real time.
  test.setTimeout(420_000);
  const sandbox = await writeFreeSandbox(context, {
    functions: { 'place-snippet': () => ({ after_id: String(AFTER), before_id: String(BEFORE), reason: REASON }) },
  });
  await clipOverlay(context, { cursor: false });
  // The grid as a planner reading a piece would set it: whole names, the outline number, crews and dates.
  await clipColumns(context, { visible: ['task', 'wbs', 'schedule-crew', 'schedule-when'], widths: { task: 450, wbs: 84 } });
  await Tape.prepare(context);
  await signIn(page);
  await openTab(page, 'library');
  await quietLinks(page, true);
  // The card near the top of the panel: the folder above it closed.
  await page.getByRole('button', { name: 'Close Clinical rooms' }).click();
  const anchorEnd = await page.evaluate(async (id) => {
    const gantt = (globalThis as any).bryntum.query('gantt');
    const task = gantt.taskStore.getById(id);
    await gantt.expandTo(task);
    await gantt.scrollRowIntoView(task.parent, { block: 'start' });
    await gantt.scrollToDate(new Date(task.endDate.getTime() - 4 * 86_400_000), { block: 'start' });
    return task.endDate.getTime() as number;
  }, AFTER);
  const card = page.getByTestId('library-card').filter({ hasText: SNIPPET }).first();
  const row = page.locator(`.b-gantt .b-grid-sub-grid-normal .b-grid-row[data-id="${AFTER}"]`);
  const timeline = await boxOf(page.locator('.b-gantt .b-grid-sub-grid-normal').first());
  const rowBox = await boxOf(row);
  const grab = await boxOf(card.locator('.library-grab'));
  // Over the row's lower edge: the snippet lands just below it.
  const drop = { x: timeline.x + Math.min(200, timeline.width * 0.45), y: rowBox.y + rowBox.height * 0.86 };
  const before = await page.evaluate(() => {
    const gantt = (globalThis as any).bryntum.query('gantt');
    return { tasks: gantt.taskStore.count as number, handover: (gantt.taskStore.getById(620)?.endDate?.getTime() ?? null) as number | null };
  });

  // The page's clock runs slow while the tape records: its realtime socket has to stay open throughout.
  const closed: string[] = [];
  page.on('websocket', (socket) => socket.on('close', () => closed.push(new URL(socket.url()).pathname)));
  const tape = await new Tape(page, META).start({ x: 1380, y: 760 });
  // The whole window first, so it is clear where this happens; then in to the card.
  await page.waitForTimeout(1_000);
  tape.step(0);
  await tape.look(card, { pad: 64, ms: 1_000, ring: true });
  await glide(page, center(grab));
  await page.waitForTimeout(300);
  await page.mouse.down();
  tape.step(1);
  // The camera widens to the card and the row it goes to while the hand travels.
  await tape.look([grab, { x: drop.x - 180, y: rowBox.y - 40, width: 360, height: rowBox.height + 80 }], { pad: 40, ms: 1_000, wait: false });
  await glide(page, { x: (grab.x + drop.x) / 2, y: (grab.y + drop.y) / 2 - 30 });
  await glide(page, drop);
  await page.waitForTimeout(700);
  await page.mouse.up();
  tape.step(2);

  const choice = page.getByTestId('library-choice');
  await expect(choice).toBeVisible();
  const suggested = choice.getByTestId('library-choose-suggested');
  await expect(suggested).toContainText('before Doors, frames & hardware');
  await expect(choice.getByTestId('library-choose-push')).not.toContainText('Working out');
  await tape.look(choice, { pad: 36, ms: 800 });
  // Close in on the assistant's place: where, and why. Pointing at it marks the task it follows.
  const option = await boxOf(suggested);
  await glide(page, { x: option.x + option.width * 0.6, y: option.y + option.height * 0.5 });
  await tape.look(suggested, { pad: 30, ms: 700, ring: true });
  await page.waitForTimeout(1_500);
  await clickOn(page, suggested, { pause: 250 });
  tape.step(3);

  const note = page.getByTestId('library-note');
  await expect(note).toContainText('Added');
  await expect(note.getByTestId('library-note-placed')).toContainText(REASON);
  // The note: what moved, and why it went there.
  await tape.look(note, { pad: 36, ms: 1_000, ring: true });
  await page.waitForTimeout(1_800);
  tape.step(4);

  // The panel closes and the plan takes the room; it scrolls to the work the piece follows, so the
  // whole piece shows.
  const tab = page.getByTestId('inspector-tab-library');
  await tape.look([note, tab], { pad: 40, ms: 700, wait: false });
  await clickOn(page, tab, { pause: 200 });
  await expect(page.locator('.inspector-tab.is-active')).toHaveCount(0);
  await tape.look([], { ms: 1_000, wait: false });
  await page.waitForTimeout(300);
  // The pointer rests on the grid (over the chart it would wake the link cards).
  await glide(page, { x: 700, y: 640 });
  await scrollPlan(page, { row: AFTER, date: anchorEnd - 4 * 86_400_000 }, 700);
  let at = (await placed(page))!;
  expect(at.rows).toHaveLength(ROWS);
  // Up close on the column side: the heading, its first group and tasks, under the work it follows.
  await tape.look([at.anchor, ...at.rows.slice(0, 7)], { pad: 8, ms: 1_100, ring: at.rows[0]! });
  await page.waitForTimeout(1_800);
  // Wider, with the dates, down the rest of it to the work that now waits for it.
  await tape.look([...at.rows.slice(6), at.next], { pad: 12, ms: 1_100 });
  await page.waitForTimeout(1_400);
  tape.step(5);

  await quietLinks(page, false);
  expect(at.into, 'the link from the flooring').not.toBeNull();
  expect(at.onward, 'the link on to the doors').not.toBeNull();
  const tip = page.locator('.look-dep-tooltip').first();
  // The link from the work it follows: its card says it waits for the flooring.
  await tape.look([at.bars.anchor, at.bars.first], { pad: 70, ms: 1_000, wait: false });
  await glide(page, at.into!);
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Safety vinyl flooring');
  await tape.look([at.bars.anchor, at.bars.first, await boxOf(tip)], { pad: 36, ms: 700, ring: tip });
  await page.waitForTimeout(1_700);
  // And the link on: the doors wait for the piece.
  await glide(page, at.onward!);
  await expect(tip).toContainText('Doors, frames');
  await tape.look([at.bars.top, at.bars.next, await boxOf(tip)], { pad: 36, ms: 900, ring: tip });
  await page.waitForTimeout(1_600);
  // The plan with the piece in it: rows and bars, linked in. The pointer moves off to the right, clear of the links.
  await glide(page, { x: Math.min(page.viewportSize()!.width - 140, at.bars.next.x + at.bars.next.width + 60), y: at.onward!.y });
  at = (await placed(page))!;
  await tape.look(union([at.anchor, at.next, at.bars.anchor, at.bars.next]), { pad: 16, ms: 1_100 });
  await page.waitForTimeout(600);
  await tape.stop();
  expect(closed, 'realtime sockets closed while recording').toEqual([]);

  // The outcome: the piece is in the plan after the flooring and before the doors, the later work
  // moved back, and nothing reached the database.
  const after = await page.evaluate(
    ({ snippet, anchor, next }) => {
      const gantt = (globalThis as any).bryntum.query('gantt');
      const store = gantt.taskStore;
      const top = store.query((task: any) => task.name === snippet && task.libraryRef)[0];
      return {
        tasks: store.count as number,
        handover: (store.getById(620)?.endDate?.getTime() ?? null) as number | null,
        follows: top?.previousSibling?.id === anchor,
        leadsTo: (top?.successors ?? []).some((link: any) => link.toEvent?.id === next),
      };
    },
    { snippet: SNIPPET, anchor: AFTER, next: BEFORE },
  );
  expect(after.tasks).toBe(before.tasks + ROWS);
  expect(after.follows).toBe(true);
  expect(after.leadsTo).toBe(true);
  expect(after.handover).toBeGreaterThan(before.handover!);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
  expect(sandbox.revisions.length).toBeGreaterThanOrEqual(1);
  expect(sandbox.calls.map((call) => call.fn)).toEqual(['place-snippet']);
  expect(sandbox.calls[0]!.args).toMatchObject({ dropped_after: String(AFTER), snippet: { name: SNIPPET } });
  // The drop is also told to the assistant (a new conversation): blocked in the sandbox, nothing else is.
  expect(sandbox.blocked.filter((write) => !/\/rpc\/(create_agent_thread|post_agent_message)$/.test(write))).toEqual([]);
});

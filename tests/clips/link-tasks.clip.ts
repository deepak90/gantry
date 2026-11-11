/**
 * Clip: link two tasks. Scene: in this tab only, the dig and the inspection of the spread footings are
 * unlinked and the inspection is pinned to Thu, Nov 12, so it overlaps the dig. Gesture: drag from the
 * end terminal of "Excavate spread footings" to the start terminal of "Inspect footing excavations"; the
 * scheduling engine moves the inspection (and the work after it) to after the dig.
 */
import { expect, test, type Page } from '@playwright/test';
import { Recorder, boxOf, clipOverlay, cropAround, glide, openTab, saveClip, signIn, writeFreeSandbox, type ClipMeta, type Point } from './clip';

const META: ClipMeta = {
  id: 'link-tasks',
  title: 'Link two tasks',
  summary: 'Drag from the end of one bar to the start of another, so the second task waits for the first.',
  steps: [
    'Point at the first task’s bar: a small dot appears at each end.',
    'Drag from the dot at its end to the start of the task that has to wait.',
    'Let go: the arrow is drawn and the later work moves to make room.',
  ],
  topics: ['link', 'dependency', 'connect tasks', 'arrow', 'predecessor', 'successor', 'waits for', 'finish to start', 'join'],
};

const FROM = 212; // Excavate spread footings
const TO = 213; // Inspect footing excavations (hold point)

/** The centers of a bar's link terminals (shown while the bar is hovered). */
function terminalsOf(page: Page, id: number): Promise<Point[]> {
  return page.evaluate(
    (taskId) =>
      [...document.querySelectorAll(`.b-gantt .b-gantt-task-wrap[data-task-id="${taskId}"] .b-sch-terminal`)].map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }),
    id,
  );
}

test(META.title, async ({ page, context }) => {
  const sandbox = await writeFreeSandbox(context);
  await clipOverlay(context);
  await signIn(page);
  await openTab(page, null);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(600);

  // The scene: the two tasks unlinked, the inspection pinned so it overlaps the dig.
  await page.evaluate(
    async ({ from, to }) => {
      const gantt = (globalThis as any).bryntum.query('gantt');
      const link = gantt.dependencyStore.records.find((dep: any) => String(dep.fromEvent?.id) === String(from) && String(dep.toEvent?.id) === String(to));
      if (link) gantt.dependencyStore.remove(link);
      await gantt.taskStore.getById(to).setConstraint('startnoearlierthan', new Date(2026, 10, 12, 8));
      await gantt.project.commitAsync();
    },
    { from: FROM, to: TO },
  );
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const gantt = (globalThis as any).bryntum.query('gantt');
    await gantt.scrollRowIntoView(gantt.taskStore.getById(210), { block: 'start' });
    await gantt.scrollToDate(new Date(2026, 10, 9), { block: 'start' });
  });
  await page.mouse.move(1000, 760);
  await page.waitForTimeout(1_200);

  const bar = (id: number) => page.locator(`.b-gantt .b-gantt-task-wrap[data-task-id="${id}"]`);
  const boxes = await Promise.all([211, 212, 213, 214, 215].map((id) => bar(id).boundingBox()));
  const from = (await bar(FROM).boundingBox())!;
  const to = (await bar(TO).boundingBox())!;
  // The timeline only: from the splitter to the right edge of the plan, header included.
  const timeline = await boxOf(page.locator('.b-gantt .b-grid-sub-grid-normal').first());
  const crop = cropAround(page, boxes.filter((box) => box !== null), { pad: 56, minWidth: 640, within: { x: timeline.x, y: 0, width: timeline.width, height: 1000 } });
  const startBefore = await page.evaluate((id) => (globalThis as any).bryntum.query('gantt').taskStore.getById(id).startDate.getTime(), TO);

  const recorder = new Recorder(page, crop).start();
  await page.waitForTimeout(700);
  // Hover the first bar so its terminals show, then take the one at its end.
  await glide(page, { x: from.x + from.width * 0.6, y: from.y + from.height / 2 }, 30);
  await page.waitForTimeout(450);
  const ends = await terminalsOf(page, FROM);
  const end = ends.sort((a, b) => b.x - a.x)[0] ?? { x: from.x + from.width + 4, y: from.y + from.height / 2 };
  await glide(page, end, 12);
  await page.waitForTimeout(250);
  await page.mouse.down();
  await glide(page, { x: to.x + to.width * 0.5, y: to.y + to.height / 2 }, 35);
  await page.waitForTimeout(200);
  const starts = await terminalsOf(page, TO);
  const start = starts.sort((a, b) => a.x - b.x)[0] ?? { x: to.x + 2, y: to.y + to.height / 2 };
  await glide(page, start, 10);
  await page.waitForTimeout(450);
  await page.mouse.up();
  await page.waitForTimeout(300);
  await glide(page, { x: start.x + 120, y: start.y + 130 }, 30);
  await page.waitForTimeout(1_600);
  const recording = await recorder.stop();

  // The outcome: linked, the inspection moved after the dig, saved (in the sandbox), nothing else written.
  const after = await page.evaluate(
    ({ from: fromId, to: toId }) => {
      const gantt = (globalThis as any).bryntum.query('gantt');
      return {
        linked: gantt.dependencyStore.records.some((dep: any) => String(dep.fromEvent?.id) === String(fromId) && String(dep.toEvent?.id) === String(toId)),
        start: gantt.taskStore.getById(toId).startDate.getTime(),
        digEnds: gantt.taskStore.getById(fromId).endDate.getTime(),
      };
    },
    { from: FROM, to: TO },
  );
  expect(after.linked).toBe(true);
  expect(after.start).toBeGreaterThan(startBefore);
  expect(after.start).toBeGreaterThanOrEqual(after.digEnds);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-sync-status', 'synced');
  expect(sandbox.revisions.length).toBeGreaterThanOrEqual(2);
  expect(sandbox.blocked).toEqual([]);

  await saveClip(page, META, recording);
});

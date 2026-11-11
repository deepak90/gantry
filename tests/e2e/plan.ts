/**
 * What the library and realtime checks share: signing in, reading the live plan out of the page as
 * plain data, comparing two browsers task by task, and driving rows through the real UI.
 */
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';

export const CM = { email: process.env.E2E_CM_EMAIL ?? 'cm@demo.local', password: process.env.E2E_CM_PASSWORD ?? 'demo-cm-2026' };
export const PM = { email: process.env.E2E_PM_EMAIL ?? 'pm@demo.local', password: process.env.E2E_PM_PASSWORD ?? 'demo-pm-2026' };
export const BOOT_MS = 90_000;

export interface TaskRow {
  id: number | string;
  name: string;
  parent: number | string | null;
  /** The row's place among its siblings (the order every client must share). */
  index: number | null;
  wbs: string;
  start: string | null;
  end: string | null;
  duration: number | null;
  percent: number | null;
  constraint: string | null;
  constraintDate: string | null;
  manual: boolean;
  note: string | null;
  ref: string | null;
  crews: string[];
}
export interface LinkRow {
  from: number | string;
  to: number | string;
  active: boolean;
  type: number;
  lag: number;
}
export interface Plan {
  tasks: TaskRow[];
  links: LinkRow[];
  assignments: string[];
  crews: string[];
}

/** Helpers the page runs itself: the main Gantt (the builder has one too), and the plan as plain data. */
export function installPageHelpers(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const gantt = () => (globalThis as any).bryntum.queryAll('gantt').find((widget: any) => widget.element?.closest('.collab-gantt-workspace'));
  const day = (date: unknown) => (date instanceof Date ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : null);
  scope.__gantt = gantt;
  scope.__plan = () => {
    const { project } = gantt();
    return {
      tasks: project.taskStore.allRecords.map((task: any) => ({
        id: task.id,
        name: task.name,
        parent: task.parent?.isRoot ? null : (task.parent?.id ?? null),
        index: task.orderedParentIndex ?? null,
        wbs: String(task.wbsValue),
        start: day(task.startDate),
        end: day(task.endDate),
        duration: task.duration ?? null,
        percent: task.percentDone ?? null,
        constraint: task.constraintType ?? null,
        constraintDate: day(task.constraintDate),
        manual: Boolean(task.manuallyScheduled),
        note: task.note ?? null,
        ref: task.libraryRef ?? null,
        crews: (task.assignments ?? []).map((assignment: any) => assignment.resource?.name).filter(Boolean).sort(),
      })),
      links: project.dependencyStore.allRecords.map((link: any) => ({ from: link.fromEvent?.id, to: link.toEvent?.id, active: link.active !== false, type: link.type, lag: link.lag })),
      assignments: project.assignmentStore.allRecords.map((assignment: any) => `${assignment.event?.id}:${assignment.resource?.id}:${assignment.units}`),
      crews: project.resourceStore.allRecords.map((crew: any) => `${crew.id}:${crew.name}:${crew.trade ?? ''}`),
    };
  };
}

export const planOf = (page: Page): Promise<Plan> => page.evaluate(() => (globalThis as any).__plan());
export const taskIn = (plan: Plan, id: number | string) => plan.tasks.find((row) => row.id === id);
export const named = (plan: Plan, name: string) => plan.tasks.filter((row) => row.name === name);
export const into = (plan: Plan, id: number | string) => plan.links.filter((link) => link.to === id);
export const outOf = (plan: Plan, id: number | string) => plan.links.filter((link) => link.from === id);

/** The plan as far as an undo must bring it back: every task's place and dates, every link. */
export const fingerprint = (plan: Plan) => ({
  tasks: plan.tasks.map(({ id, name, parent, start, end, constraint }) => ({ id, name, parent, start, end, constraint })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  links: plan.links.map((link) => `${link.from}>${link.to}:${link.type}:${link.lag}:${link.active ? 'on' : 'off'}`).sort(),
});

/** What differs between two plans, one line per difference: empty when every client agrees. */
export function planDiff(a: Plan, b: Plan): string[] {
  const out: string[] = [];
  const ids = new Set([...a.tasks, ...b.tasks].map((row) => row.id));
  for (const id of ids) {
    const left = taskIn(a, id);
    const right = taskIn(b, id);
    if (!left || !right) {
      out.push(`task ${String(id)} “${(left ?? right)!.name}” only in ${left ? 'the first' : 'the second'}`);
      continue;
    }
    for (const key of Object.keys(left) as (keyof TaskRow)[]) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) out.push(`task ${String(id)} “${left.name}” ${key}: ${JSON.stringify(left[key])} vs ${JSON.stringify(right[key])}`);
    }
  }
  const links = (plan: Plan) => plan.links.map((link) => `${link.from}>${link.to}:${link.type}:${link.lag}`).sort();
  for (const [label, left, right] of [
    ['link', links(a), links(b)],
    ['assignment', [...a.assignments].sort(), [...b.assignments].sort()],
    ['crew', [...a.crews].sort(), [...b.crews].sort()],
  ] as const) {
    for (const entry of left) if (!right.includes(entry)) out.push(`${label} ${entry} only in the first`);
    for (const entry of right) if (!left.includes(entry)) out.push(`${label} ${entry} only in the second`);
  }
  return out.slice(0, 40);
}

export const badge = (page: Page) => page.getByTestId('sync-badge');

export async function signIn(page: Page, project: string, person = CM): Promise<void> {
  await page.addInitScript(installPageHelpers);
  await page.goto(`/?project=${project}`);
  await page.locator('input[name="email"]').fill(person.email);
  await page.locator('input[name="password"]').fill(person.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await booted(page);
}

/** The plan is on screen and caught up. */
export async function booted(page: Page): Promise<void> {
  await expect(badge(page)).toHaveAttribute('data-sync-status', 'synced', { timeout: BOOT_MS });
  await page.waitForFunction(() => Boolean((globalThis as any).__gantt?.()?.project?.taskStore?.count), undefined, { timeout: BOOT_MS });
  // The 3D view comes up once the chart has settled: what follows isn't to race with it.
  await page.waitForSelector('.fx3d-dock', { state: 'attached', timeout: 30_000 });
}

/** The server has taken the change: every task numbered, nothing left to send. */
export async function saved(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gantt().project.taskStore.allRecords.every((row: any) => typeof row.id === 'number')), { timeout: 30_000, message: 'every task has its real id' }).toBe(true);
  await expect(badge(page)).toHaveAttribute('data-sync-status', 'synced', { timeout: 30_000 });
  await page.waitForTimeout(400);
  await expect(badge(page)).toHaveAttribute('data-sync-status', 'synced', { timeout: 30_000 });
}

/** Both browsers have settled on the same plan, down to row order, links and crews. */
export async function agree(a: Page, b: Page, label = 'both browsers'): Promise<void> {
  await Promise.all([saved(a), saved(b)]);
  await expect.poll(async () => planDiff(await planOf(a), await planOf(b)), { timeout: 12_000, message: `${label} hold the same plan` }).toEqual([]);
}

/** A reload rebuilds the plan from the server alone: it must match what the browsers show. */
export async function rebuildsTo(page: Page, plan: Plan, label = 'a reload'): Promise<void> {
  await page.reload();
  await booted(page);
  await page.waitForTimeout(600);
  expect(planDiff(await planOf(page), plan), `${label} matches`).toEqual([]);
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

export interface PlacementBody {
  group: { id: string; name: string; tasks: unknown[] };
  precedent: unknown;
}
export type PlacementAnswer = { after_id: string; before_id: string | null; reason: string };

const answered = new WeakSet<BrowserContext>();

/** Answers place-snippet in the browser; `answer` may wait, throw (the function is down) or give a task of another floor. */
export async function answerPlacement(context: BrowserContext, answer: (body: PlacementBody) => PlacementAnswer | Promise<PlacementAnswer>): Promise<PlacementBody[]> {
  const asked: PlacementBody[] = [];
  answered.add(context);
  await context.route('**/functions/v1/place-snippet', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
    const body = JSON.parse(route.request().postData() ?? '{}') as PlacementBody;
    asked.push(body);
    try {
      return await route.fulfill({ status: 200, headers: CORS, json: await answer(body) });
    } catch {
      return route.fulfill({ status: 500, headers: CORS, json: { error: 'down' } }).catch(() => undefined);
    }
  });
  return asked;
}

/** No model runs: the agent service is not told about drops, and place-snippet is down unless answered here. */
export async function quietAgent(context: BrowserContext): Promise<void> {
  if (!answered.has(context)) {
    await context.route('**/functions/v1/place-snippet', (route) => route.fulfill({ status: route.request().method() === 'OPTIONS' ? 200 : 500, headers: CORS, json: { error: 'down' } }));
  }
  for (const fn of ['post_agent_message', 'create_agent_thread']) await context.route(`**/rest/v1/rpc/${fn}`, (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 200, headers: CORS }) : route.abort('blockedbyclient')));
}

const QUIET_ERRORS = /Failed to load resource|net::ERR|blockedbyclient|WebSocket|Failed to fetch|Download the React DevTools|realtime/i;

/** Bryntum #13956, open, and seen on its own realtime demo: a hover over the timeline as it redraws. Nothing comes of it. */
const KNOWN_BRYNTUM_ERROR = /new TimelineContext/;

/** Errors in the page, and anything RevisionSync warned about. */
export function collectProblems(page: Page, into: string[], who = ''): void {
  page.on('pageerror', (error) => KNOWN_BRYNTUM_ERROR.test(error.stack ?? '') || into.push(`${who}pageerror: ${error.message} ${(error.stack ?? '').split('\n').slice(1, 7).map((line) => line.trim().replace(/https?:\/\/[^/]+\//, '').replace(/\?[vt]=\w+/g, '')).join(' < ')}`.slice(0, 700)));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !QUIET_ERRORS.test(text)) into.push(`${who}console: ${text.slice(0, 300)}`);
    if (message.type() === 'warning' && /RevisionSync|Failed to apply|out of sync/i.test(text)) into.push(`${who}sync: ${text.slice(0, 1200)}`);
  });
}

/** Every revision this page sends: one action should be one revision, and a person only watching sends none. */
export function revisionsSentBy(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (/rpc\/submit_revision/.test(request.url()) && request.method() === 'POST') sent.push(request.url());
  });
  return sent;
}

// Rows ------------------------------------------------------------------------------------------

export const row = (page: Page, id: number | string) => page.locator(`.b-gantt .b-grid-row[data-id="${id}"]`);
export const nameCell = (page: Page, id: number | string) => row(page, id).locator('.b-grid-cell[data-column="name"]');
export const cell = (page: Page, id: number | string, column: string) => row(page, id).locator(`.b-grid-cell[data-column-id="${column}"]`);

/** Brings a task's row on screen. */
export const showRow = (page: Page, id: number | string) =>
  page.evaluate(async (wanted) => {
    const gantt = (globalThis as any).__gantt();
    const record = gantt.store.getById(wanted);
    if (!record) throw new Error(`no row for task ${wanted}`);
    await gantt.expandTo(record, false).catch(() => undefined);
    await gantt.scrollRowIntoView(record, { block: 'center' });
  }, id);

/** Clicks through the task's menu: `menu(page, 213, 'Add', 'Task below')`. Keeps a selection the task is part of. */
export async function menu(page: Page, id: number | string, ...path: string[]): Promise<void> {
  await showRow(page, id);
  await nameCell(page, id).click({ button: 'right' });
  const items = page.locator('.b-float-root .b-menu-item');
  for (const [index, label] of path.entries()) {
    const item = items.filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();
    if (index < path.length - 1) await item.hover();
    else await item.click();
  }
}

/** Selects whole tasks in the plan (a click, then Ctrl or Cmd plus a click on each of the others). */
export async function selectRows(page: Page, ...ids: (number | string)[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await showRow(page, id);
    await nameCell(page, id).click(index === 0 ? {} : { modifiers: ['ControlOrMeta'] });
  }
  await expect
    .poll(() => page.evaluate(() => ((globalThis as any).__gantt().selectedRecords ?? []).map((record: any) => record.id)), { message: 'the rows are selected' })
    .toEqual(expect.arrayContaining(ids));
}

/** The id of the task with this name, once the server has numbered it. */
export async function idOf(page: Page, name: string): Promise<number> {
  await expect.poll(async () => typeof named(await planOf(page), name)[0]?.id, { timeout: 15_000, message: `“${name}” has its real id` }).toBe('number');
  return named(await planOf(page), name)[0]!.id as number;
}

export async function rename(page: Page, id: number | string, name: string): Promise<void> {
  await showRow(page, id);
  await nameCell(page, id).dblclick();
  const input = page.locator('.b-cell-editor input:visible');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(nameCell(page, id)).toHaveText(name);
  await expect(page.locator('.b-cell-editor input:visible')).toHaveCount(0);
}

/** Adds a task below another through the task menu; returns its id once it has one. */
export async function addBelow(page: Page, id: number, name: string): Promise<number> {
  const before = new Set((await planOf(page)).tasks.map((task) => task.id));
  await menu(page, id, 'Add', 'Task below');
  const added = async () => (await planOf(page)).tasks.filter((task) => !before.has(task.id));
  await expect.poll(async () => (await added()).length, { message: 'a task was added' }).toBe(1);
  await expect.poll(async () => typeof (await added())[0]?.id, { timeout: 15_000 }).toBe('number');
  const created = (await added())[0]!.id as number;
  // A new task's name opens for typing in some flows: close that first.
  await page.keyboard.press('Escape');
  await rename(page, created, name);
  return created;
}

/** Drags a row by its grip onto another, above or below it. */
export async function dragRow(page: Page, id: number | string, target: number | string, where: 'above' | 'below' = 'below'): Promise<void> {
  await showRow(page, id);
  const from = (await nameCell(page, id).boundingBox())!;
  await page.mouse.move(from.x + 7, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 7, from.y + from.height / 2 + 6, { steps: 3 });
  const to = (await nameCell(page, target).boundingBox())!;
  await page.mouse.move(to.x + 60, to.y + to.height * (where === 'above' ? 0.12 : 0.88), { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

export async function search(page: Page, text: string): Promise<void> {
  await page.getByTestId('gantt-search').fill(text);
  await page.waitForTimeout(500);
}

export async function groupBy(page: Page, label: string): Promise<void> {
  await page.getByTestId('gantt-view').click();
  await page.getByRole('menu', { name: 'View' }).getByRole('group', { name: 'Group by' }).getByText(label).click();
  await page.getByTestId('gantt-toolbar').click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(500);
}

// The library -----------------------------------------------------------------------------------

export async function openLibrary(page: Page): Promise<void> {
  // The tab closes the panel when it is already open.
  if (!(await page.getByTestId('library-panel').isVisible())) await page.getByTestId('inspector-tab-library').click();
  await expect(page.getByTestId('library-panel')).toBeVisible();
  await expect(page.getByTestId('library-card').first()).toBeVisible();
}

export const libraryCard = (page: Page, name: string) => page.getByTestId('library-card').filter({ hasText: name }).first();
export const choice = (page: Page) => page.getByTestId('library-choice');
export const suggested = (page: Page) => page.getByTestId('library-choose-suggested');
export const dropNote = (page: Page) => page.getByTestId('library-note');
export const way = (page: Page, mode: string) => page.getByTestId(`library-choose-${mode}`);
export const numbersReady = (page: Page) => expect(choice(page).locator('.library-choice-wait')).toHaveCount(0, { timeout: 30_000 });

/** Drags a library card onto the lower half of a task's row and lets go. */
export async function dropCard(page: Page, snippet: string, target: number | string): Promise<void> {
  await showRow(page, target);
  const from = libraryCard(page, snippet);
  await from.scrollIntoViewIfNeeded();
  await from.hover();
  const grip = (await from.locator('.library-grip').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  const box = (await nameCell(page, target).boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + box.height * 0.85, { steps: 15 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

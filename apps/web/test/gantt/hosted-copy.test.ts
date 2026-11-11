/**
 * The film's two pieces in each visitor's copy of Harbor on the hosted site. A copy's plan is Harbor's seed: in
 * supabase/seed_snapshot.sql every copy's row (and its demo_seeds row, which free_copy puts back) takes Harbor's. Loaded
 * the way the app loads it, the copy draws the week the city inspector is away as a band; the hold after the footings
 * draws the slab's work held (hatched, tagged) until Granite Ridge and Pinecrest are paid; and the chart opens on both
 * (gantt/opening-view.ts): the hold, the slab it holds, Tue, Nov 10, and the away week.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DateHelper, type ProjectModel, type TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { HARBOR_COPY_COUNT, HARBOR_FOOTINGS_PAID, HARBOR_IDS, HARBOR_STEEL_TASK, harborCopyIds } from '@collab/shared/seed';
import { renderAfterLabel, renderTaskBar, type LookState } from '../../src/gantt/look';
import { LEAD_DAYS, openingView, showOpeningView, TAG_ROOM_PX } from '../../src/gantt/opening-view';
import { gateFor, paymentOf, recordPaid } from '../../src/gantt/pay-gates';
import { createProjectModel, toInlineDataPackage } from '../../src/gantt/project';
import { attachBands } from '../../src/library/bands';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync } from '../../src/sync/revision-sync';
import { PROJECT_ID, loadResult } from '../sync/helpers';

const FOOTINGS = 20;
const STRIP_AND_BACKFILL = 24;
const SLAB = 30;
/** The slab's work in plan order: gravel base, rebar, the city inspection, the pour, the cure. */
const SLAB_WORK = [31, 32, 35, 33, 34];
/** The film's day, the hosted site's plan date. */
const FILM_DAY = new Date(2026, 10, 10);

const here = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(here, '../../../../supabase/seed_snapshot.sql'), 'utf8');
const CSS = readFileSync(join(here, '../../src/styles/gantt.css'), 'utf8');

/** What copy `n` loads: Harbor's seed plan, which the copy's row takes from Harbor's row in demo_seeds. */
function copySnapshot(n: number): ProjectInlineData {
  expect(SQL).toContain(`values ('${harborCopyIds(n).project}', 'Harbor Street Offices', 'USD', 0, (select d.snapshot from public.demo_seeds d where d.project_id = '${HARBOR_IDS.project}')`);
  const harbor = new RegExp(`values \\('${HARBOR_IDS.project}', 'Harbor Street Offices', 'USD', 0, \\$snapshot\\$([\\s\\S]*?)\\$snapshot\\$::jsonb`).exec(SQL);
  expect(harbor).not.toBeNull();
  return JSON.parse(harbor![1]!) as ProjectInlineData;
}

const visits: { project: ProjectModel; sync: RevisionSync }[] = [];

afterEach(() => {
  for (const { project, sync } of visits.splice(0)) {
    sync.dispose();
    project.destroy();
  }
});

/** The copy as a visitor's page loads it (app/supabase-deps.ts): the stored snapshot through the revision sync. */
async function visit(snapshot: ProjectInlineData): Promise<ProjectModel> {
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot: structuredClone(snapshot) });
  const project = createProjectModel();
  const sync = new RevisionSync(project, relay.connect('visitor'), { sessionId: 'visitor', projectId: PROJECT_ID, prepareSnapshot: toInlineDataPackage });
  visits.push({ project, sync });
  await sync.init(loadResult(structuredClone(snapshot)));
  await project.commitAsync();
  return project;
}

const task = (project: ProjectModel, id: number) => project.taskStore.getById(id) as TaskModel;
const day = (value: unknown) => (value instanceof Date ? DateHelper.format(value, 'ddd YYYY-MM-DD') : String(value));

interface TimeRange {
  id: unknown;
  name?: string;
  startDate?: Date;
  endDate?: Date;
  cls?: unknown;
  getData(field: string): unknown;
}

const timeRanges = (project: ProjectModel) => (project as unknown as { timeRangeStore: { records: TimeRange[]; changes: unknown } }).timeRangeStore;

const LOOK: LookState = { decorations: new Map(), canViewCosts: true, moneyColumns: false, currency: 'USD', groupBy: 'phase', colorBy: 'phase' };

/** The classes the chart puts on a bar's wrapper, which the hold's styles key on. */
function barClasses(record: TaskModel): string[] {
  const wrapper = new Set<string>();
  const wrapperCls = { add: (name: string) => void wrapper.add(name) };
  renderTaskBar(LOOK, { taskRecord: record, renderData: { cls: { add: () => undefined }, wrapperCls, style: '', iconCls: '' } });
  return [...wrapper];
}

/** Every text in a DomConfig tree, in order. */
function texts(config: unknown): string[] {
  if (Array.isArray(config)) return config.flatMap(texts);
  if (!config || typeof config !== 'object') return [];
  const node = config as { text?: string; children?: unknown[] };
  return [...(node.text ? [node.text] : []), ...(node.children ?? []).flatMap(texts)];
}

const label = (project: ProjectModel, id: number) => texts(renderAfterLabel(LOOK, { taskRecord: task(project, id) })).join('');

async function payFootings(project: ProjectModel): Promise<void> {
  const gate = gateFor(project, task(project, HARBOR_FOOTINGS_PAID))!;
  await recordPaid(project, gate.id, paymentOf(gate), 'TEST-BATCH', new Date(2026, 10, 10, 9));
}

describe('a hosted copy of Harbor, as a visitor loads it', () => {
  it('starts every copy from Harbor’s seed plan', () => {
    for (let n = 1; n <= HARBOR_COPY_COUNT; n += 1) copySnapshot(n);
  });

  it('draws the week the city inspector is away as a band on the chart, kept out of the plan’s changes', async () => {
    const project = await visit(copySnapshot(1));
    const stop = attachBands(project);
    const store = timeRanges(project);
    const band = store.records.find((range) => range.name === 'City inspector away');
    expect(band).toBeDefined();
    expect([day(band!.startDate), day(band!.endDate)]).toEqual(['Mon 2026-11-23', 'Sat 2026-11-28']);
    expect(String(band!.cls)).toContain('library-band-amber');
    expect(band!.getData('taskName')).toBe('City inspection, slab');
    expect(store.changes).toBeNull();
    stop();
  });

  it('draws the slab’s work held while the footings are unpaid, and lets it go once they are paid', async () => {
    const project = await visit(copySnapshot(1));
    for (const id of [SLAB, ...SLAB_WORK]) expect(barClasses(task(project, id)), task(project, id).name ?? '').toContain('look-held');
    for (const id of [FOOTINGS, STRIP_AND_BACKFILL, HARBOR_STEEL_TASK]) expect(barClasses(task(project, id))).not.toContain('look-held');
    expect(label(project, SLAB)).toBe('Ground-floor slab held until paid');
    expect(label(project, HARBOR_FOOTINGS_PAID)).toContain('$37,800 due');

    await payFootings(project);
    for (const id of [SLAB, ...SLAB_WORK]) expect(barClasses(task(project, id))).not.toContain('look-held');
    expect(label(project, SLAB)).not.toContain('held until paid');
  });

  it('hatches a held task across its whole bar, under its late tail, not in the tail’s place', () => {
    const rule = (selector: string) => {
      const at = CSS.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return CSS.slice(at, CSS.indexOf('}', at));
    };
    // A task's bar has two layers: its late tail, as wide as the slip (nothing while on time), and its fill, all of it.
    const bar = rule('.collab-gantt-workspace .b-gantt-task-wrap:not(.b-gantt-task-parent, .b-milestone-wrap) .b-gantt-task');
    expect(bar).toContain('background-image: var(--look-tail), var(--look-fill');
    expect(bar).toContain('background-size: var(--look-slip, 0%) 100%, 100% 100%');
    // The hold's hatching is the fill, the tail kept over it.
    const held = rule('.collab-gantt-workspace .b-gantt-task-wrap.look-held:not(.b-milestone-wrap) .b-gantt-task');
    expect(held).toMatch(/--look-fill: repeating-linear-gradient\(/);
    expect(held).toContain('background-image: var(--look-tail, none), var(--look-fill);');
  });
});

describe('where the hosted chart opens', () => {
  it('on the hold: its groups opened, the footings at the top, from before them to past the slab, Nov 10 and the away week inside', async () => {
    const project = await visit(copySnapshot(1));
    const view = openingView(project, FILM_DAY)!;
    expect(view.gate.id).toBe(HARBOR_FOOTINGS_PAID);
    expect(view.reveal.map((row) => row.id)).toEqual([HARBOR_FOOTINGS_PAID, FOOTINGS, SLAB]);
    expect(view.open.map((row) => row.id)).toEqual([SLAB]);
    expect(view.top.id).toBe(FOOTINGS);
    // The footings start Wed, Oct 28; the slab is cured by the end of Tue, Dec 1.
    expect(day(view.from)).toBe(day(new Date(2026, 9, 28 - LEAD_DAYS)));
    expect(day(view.to)).toBe('Wed 2026-12-02');
    expect(view.from <= FILM_DAY && FILM_DAY < view.to).toBe(true);
    expect(view.from <= new Date(2026, 10, 23) && new Date(2026, 10, 28) <= view.to).toBe(true);
  });

  it('brings it on screen with the chart’s own moves, and does nothing once the hold is paid', async () => {
    const project = await visit(copySnapshot(1));
    const moves: string[] = [];
    const chart = {
      expandTo: async (rows: TaskModel[]) => void moves.push(`expandTo ${rows.map((row) => row.id).join(',')}`),
      expand: async (row: TaskModel) => void moves.push(`expand ${row.id}`),
      scrollRowIntoView: async (row: TaskModel, options: { block?: string }) => void moves.push(`row ${row.id} ${options.block}`),
      zoomToSpan: (span: { startDate: Date; endDate: Date; rightMargin?: number }) => void moves.push(`zoom ${day(span.startDate)} ${day(span.endDate)} +${span.rightMargin}px`),
      scrollToDate: async (date: Date, options: { block?: string }) => void moves.push(`date ${day(date)} ${options.block}`),
    };
    expect(await showOpeningView(chart as never, project, FILM_DAY)).toBe(true);
    expect(moves).toEqual([
      `expandTo ${HARBOR_FOOTINGS_PAID},${FOOTINGS},${SLAB}`,
      `expand ${SLAB}`,
      `row ${FOOTINGS} start`,
      `zoom Thu 2026-10-22 Wed 2026-12-02 +${TAG_ROOM_PX}px`,
      'date Thu 2026-10-22 start',
    ]);

    await payFootings(project);
    moves.length = 0;
    expect(openingView(project, FILM_DAY)).toBeNull();
    expect(await showOpeningView(chart as never, project, FILM_DAY)).toBe(false);
    expect(moves).toEqual([]);
  });
});

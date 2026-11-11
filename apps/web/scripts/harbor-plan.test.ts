/**
 * Harbor Street Offices as the landing page's 3D hero reads it (src/site/media/harbor-plan.json): every row of the
 * plan as a PlanTask (gantt/fx3d/building-plan.ts), from the seed the hosted copies start from (Harbor's snapshot in
 * supabase/seed_snapshot.sql), dated by the real scheduling engine and read the way the app's site view reads its rows
 * (readPlanTasks in gantt/fx3d/building-view.ts). Dates are calendar days ('YYYY-MM-DD'), so the hero reads the same
 * in every time zone; src/site/landing/harbor.ts turns them into the epoch milliseconds a PlanTask holds.
 *
 * Check: pnpm --filter @collab/web exec vitest run scripts/harbor-plan · rewrite: HARBOR_PLAN_WRITE=1 and the same.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DateHelper, type ProjectModel, type ResourceModel, type TaskModel } from '@bryntum/gantt';
import type { ProjectInlineData } from '@collab/shared';
import { HARBOR_IDS } from '@collab/shared/seed';
import { machineKind, workDaysOf } from '../src/gantt/fx3d/facts';
import { crewColor, crewSizeOn, equipmentOf, laborOf, phaseClass } from '../src/gantt/look';
import { createProjectModel, loadProjectInlineData } from '../src/gantt/project';
import type { HarborPlanRow } from '../src/site/landing/harbor';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(here, '../../../supabase/seed_snapshot.sql'), 'utf8');
const TOKENS = readFileSync(join(here, '../src/styles/tokens.css'), 'utf8');
const OUT = join(here, '../src/site/media/harbor-plan.json');

/** Harbor's plan as the hosted copies load it: every copy's row takes Harbor's snapshot (see test/gantt/hosted-copy.test.ts). */
function harborSnapshot(): ProjectInlineData {
  const found = new RegExp(`values \\('${HARBOR_IDS.project}', 'Harbor Street Offices', 'USD', 0, \\$snapshot\\$([\\s\\S]*?)\\$snapshot\\$::jsonb`).exec(SQL);
  if (!found) throw new Error('harbor-plan: Harbor’s snapshot is not in supabase/seed_snapshot.sql');
  return JSON.parse(found[1]!) as ProjectInlineData;
}

/** Harbor's rentals in the same file: what a day of each machine costs, by task and machine. */
function harborRates(): Map<string, number> {
  const rates = new Map<string, number>();
  const row = /insert into public\.equipment_bookings \([^)]*\) values \('[^']*', '([^']*)', (\d+), (\d+), '[^']*', '[^']*', (\d+),/g;
  for (const [, project, task, resource, rate] of SQL.matchAll(row)) if (project === HARBOR_IDS.project) rates.set(`${task}:${resource}`, Number(rate));
  return rates;
}

/** A design token as the chart's computed style has it: `var()` taken all the way down. */
function token(name: string): string {
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS)?.[1]?.trim();
  if (!value) throw new Error(`harbor-plan: no ${name} in tokens.css`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, inner: string) => token(inner));
}

/** The bar's color on the chart: its phase's (`--look-phase`, set by the phase's class). */
const barColor = (task: TaskModel) => {
  const phase = phaseClass(task).replace('look-phase-', '');
  return token(`--cat-${phase}`);
};

const day = (value: Date | number) => DateHelper.format(new Date(value), 'YYYY-MM-DD');

function rowOf(task: TaskModel, rates: Map<string, number>): HarborPlanRow {
  const start = task.startDate as Date;
  const end = task.endDate as Date;
  const path: string[] = [];
  const pathIds: number[] = [];
  for (let parent = task.parent as TaskModel | null; parent && !(parent as unknown as { isRoot?: boolean }).isRoot; parent = parent.parent as TaskModel | null) {
    path.unshift(parent.name ?? '');
    pathIds.unshift(parent.id as number);
  }
  const calendar = (task as TaskModel & { effectiveCalendar?: Parameters<typeof workDaysOf>[2] }).effectiveCalendar;
  const machine = equipmentOf(task)[0] as (ResourceModel & { id: number }) | undefined;
  const kind = machine ? machineKind(machine.name ?? '') : null;
  const rental = machine ? ((task.assignments ?? []) as { resource: ResourceModel | null; rentalStart?: string | null; rentalEnd?: string | null }[]).find((assignment) => assignment.resource === machine) : undefined;
  return {
    id: task.id as number,
    name: task.name ?? '',
    path,
    pathIds,
    wbs: String((task as TaskModel & { wbsCode?: unknown }).wbsCode ?? ''),
    start: day(start),
    end: day(end),
    workDays: workDaysOf(start, end, calendar).map(day),
    color: barColor(task),
    crews: laborOf(task).map((crew) => ({ name: crew.name ?? '', color: crewColor(crew), people: crewSizeOn(task, crew).people })),
    machine:
      machine && kind && rental?.rentalStart && rental.rentalEnd
        ? { kind, name: machine.name ?? 'Machine', booked: [rental.rentalStart, rental.rentalEnd], rateMinor: rates.get(`${task.id}:${machine.id}`) ?? 0 }
        : null,
    percent: task.percentDone ?? 0,
    milestone: Boolean(task.isMilestone),
  };
}

/** One row a line: small, and a change to the seed reads as a change to its rows. */
const serialize = (rows: readonly HarborPlanRow[]) => `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`;

let project: ProjectModel | undefined;
afterAll(() => project?.destroy());

describe('the landing page’s Harbor plan', () => {
  it('is Harbor’s seed plan as the engine schedules it', async () => {
    project = createProjectModel();
    await loadProjectInlineData(project, harborSnapshot());
    const rates = harborRates();
    const leaves = (project.taskStore as unknown as { allRecords: TaskModel[] }).allRecords.filter((record) => !(record as unknown as { isRoot?: boolean }).isRoot && record.isLeaf && record.startDate instanceof Date && record.endDate instanceof Date);
    const rows = leaves.map((task) => rowOf(task, rates));
    const text = serialize(rows);
    if (process.env.HARBOR_PLAN_WRITE === '1') {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, text);
    }
    expect(readFileSync(OUT, 'utf8'), 'src/site/media/harbor-plan.json is out of date: run this with HARBOR_PLAN_WRITE=1').toBe(text);
  });
});

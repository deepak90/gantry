// Run: pnpm --filter @collab/web exec vitest run -c scripts/odds-runs.config.ts
/**
 * Writes src/site/media/odds-runs.json, the runs the landing page's odds section replays (src/site/landing/odds.ts).
 *
 * Harbor Street Offices' seed plan on Bryntum's scheduling engine, asked the way the odds panel asks on the hosted
 * site (odds/odds-controller.ts): the plan's today pinned to Tue, Nov 10, 2026 (VITE_PLAN_DATE, set by
 * scripts/odds-runs.config.ts), the app's own assumptions (seed 7, 1,000 runs), the footings paid on Friday's pay run,
 * then its first way forward, the footings paid when they fall due, which is today. The pair is the one the board
 * stands side by side in the film (`comparison()`).
 *
 * Each run's handover day is kept in run order, in days from the contract date; with the contract date, the planned
 * handover (the plan as it stands, and each choice's own with every length as planned) and the weekdays off on the
 * board's dates (the plan's calendar). Nothing is made up: a run the engine could not schedule stops the script.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import type { ProjectModel } from '@bryntum/gantt';
import { HARBOR_FOOTINGS_PAID, harborOffices } from '@collab/shared/seed';
import { DEFAULT_ASSUMPTIONS, plannedRun, type Simulation } from '../src/gantt/monte-carlo';
import { createProjectModel, loadProjectInlineData } from '../src/gantt/project';
import { defaultRange, weekdayOf } from '../src/odds/galton/board';
import type { PlotPass } from '../src/odds/dot-plot';
import { OddsController, type OddsState } from '../src/odds/odds-controller';
import { planClock } from '../src/plan-clock';

// A path, not a URL: under jsdom, URL is the DOM's and Node won't take it.
const TARGET = join(dirname(fileURLToPath(import.meta.url)), '../src/site/media/odds-runs.json');
const iso = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
const quick = () => Promise.resolve();

let project: ProjectModel | null = null;
let controller: OddsController | null = null;
afterAll(() => {
  controller?.dispose();
  project?.destroy();
});

function finished(odds: OddsController): Promise<OddsState> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const state = odds.getState();
      if (state.phase === 'error') reject(new Error(state.error ?? 'The engine could not answer.'));
      else if (state.phase === 'done' && state.complete) resolve(state);
      else return;
      stop();
    };
    const stop = odds.subscribe(check);
    check();
  });
}

/** One choice's runs: the handover day of run 0, 1, 2 … in days from the contract date. */
function runsOf(simulation: Simulation, contractDay: number) {
  expect(simulation.failed).toBe(0);
  expect([...simulation.runs]).toEqual(Array.from({ length: DEFAULT_ASSUMPTIONS.runs }, (_, run) => run));
  return {
    onTime: simulation.onTime,
    p50: iso(simulation.p50),
    p80: iso(simulation.p80),
    days: Array.from(simulation.days, (day) => day - contractDay),
  };
}

it('runs Harbor 1,000 times each way on the scheduling engine and writes the runs', async () => {
  expect(planClock.pinned).toBe('2026-11-10');
  project = createProjectModel();
  await loadProjectInlineData(project, structuredClone(harborOffices.inlineData) as never);
  // The odds panel's controller with the app's own assumptions and its first way forward only (the payment).
  controller = new OddsController(project, { yieldNow: quick, assumptions: DEFAULT_ASSUMPTIONS, maxSteps: 1 });
  const told: PlotPass[] = [];
  controller.attachPlot({ begin: (pass) => void told.push(pass), land: () => {}, end: () => {}, show: () => {} });
  controller.show();
  const state = await finished(controller);

  const pay = state.ladder[1];
  expect(pay?.action).toMatchObject({ kind: 'pay', id: HARBOR_FOOTINGS_PAID });
  const pair = controller.comparison();
  expect(pair).toEqual({ wait: state.now, pay: pay!.simulation });
  const plan = state.plan!;
  const pass = told[0]!;
  expect(pass.contractDay).toBe(plan.contractDay);
  // The plan's today: the footings fall due today, so paying when due is paying today.
  expect(iso(plan.todayDay)).toBe('2026-11-10');
  expect(plan.holds.map((hold) => iso(hold.dueDay!))).toEqual(['2026-11-10']);

  const { from, to } = defaultRange(plan.contractDay);
  const holidays: string[] = [];
  for (let day = from; day <= to; day += 1) if (weekdayOf(day) % 6 !== 0 && pass.nonWorking(day)) holidays.push(iso(day));

  const data = {
    about:
      'Harbor Street Offices (seed plan) on Bryntum’s scheduling engine, asked on Tue, Nov 10, 2026 with seed 7: 1,000 runs with the footings paid on Friday’s pay run, and the same runs paid today. Each run’s handover day, in run order, in days from the contract date. Written by apps/web/scripts/odds-runs.ts.',
    asOf: iso(plan.todayDay),
    seed: DEFAULT_ASSUMPTIONS.seed,
    contract: iso(plan.contractDay),
    planned: iso(plan.plannedDay!),
    holidays,
    friday: { planned: iso(plannedRun(plan, DEFAULT_ASSUMPTIONS, {}).day), ...runsOf(pair!.wait, plan.contractDay) },
    today: { planned: iso(plannedRun(plan, DEFAULT_ASSUMPTIONS, pay!.scenario).day), ...runsOf(pair!.pay, plan.contractDay) },
  };
  // One line per list of numbers.
  const text = JSON.stringify(data, null, 2).replace(/\[\s+(-?\d+(?:,\s+-?\d+)*)\s+\]/g, (_, list: string) => `[${list.replace(/\s+/g, '')}]`);
  writeFileSync(TARGET, `${text}\n`);
  console.log(
    `Wrote ${TARGET}\n` +
      `  contract ${data.contract}, planned ${data.planned}, holidays ${holidays.join(', ') || 'none'}\n` +
      `  Friday's pay run: ${data.friday.onTime} of 1,000 on time, p50 ${data.friday.p50}, p80 ${data.friday.p80}, planned ${data.friday.planned}\n` +
      `  paid today:       ${data.today.onTime} of 1,000 on time, p50 ${data.today.p50}, p80 ${data.today.p80}, planned ${data.today.planned}`,
  );
}, 600_000);

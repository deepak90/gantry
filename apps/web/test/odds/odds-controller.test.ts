/**
 * The odds panel's controller on Harbor, two browsers on one relay: it answers when the panel opens, asks again on
 * its own when PayPal's answer marks the hold paid (in either browser), says when someone else's edit has made its
 * answer old without running again, and puts a Saturday step into the plan as one change before asking again. Its
 * plots (the dot plot and the board) are each told every run; the runs wait for the plots on screen to be ready,
 * never longer than the limit; a plot attached part way through is given the runs so far; and the board's side by
 * side gets the same runs paid two ways.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { HARBOR_FOOTINGS_PAID, harborOffices } from '@collab/shared/seed';
import { DEFAULT_ASSUMPTIONS } from '../../src/gantt/monte-carlo';
import { gateFor, paymentOf, recordPaid } from '../../src/gantt/pay-gates';
import type { LadderStep } from '../../src/gantt/monte-carlo-optimizer';
import type { PlotPass } from '../../src/odds/dot-plot';
import { OddsController, type OddsControllerOptions, type OddsState, type PlotSink } from '../../src/odds/odds-controller';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, sleep, type Client } from '../sync/helpers';

const TODAY = new Date(2026, 10, 7);
const quick = () => Promise.resolve();

let clients: Client[] = [];
const controllers: OddsController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  disposeAll(clients);
  clients = [];
});

async function twoBrowsers(): Promise<{ relay: InMemoryRelay; a: Client; b: Client }> {
  const snapshot = structuredClone(harborOffices.inlineData) as never;
  const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
  const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
  const b = await joinClient(relay, 'client-b', loadResult(structuredClone(snapshot)));
  clients = [a, b];
  await settle(clients, relay);
  return { relay, a, b };
}

function controllerFor(project: ProjectModel, options: OddsControllerOptions = {}): OddsController {
  const controller = new OddsController(project, { today: () => TODAY, yieldNow: quick, assumptions: { ...DEFAULT_ASSUMPTIONS, runs: 200 }, maxSteps: 2, ...options });
  controllers.push(controller);
  return controller;
}

/** A plot that writes down what it is told; `ready` as given. */
function fakePlot(ready?: () => Promise<void>) {
  const told = { begins: [] as PlotPass[], landed: [] as { run: number; day: number }[], ends: [] as number[][], shows: 0 };
  const sink: PlotSink = {
    begin: (pass) => void told.begins.push(pass),
    land: (landed) => void told.landed.push(...landed),
    end: (runs) => void told.ends.push([...runs]),
    show: () => void (told.shows += 1),
    ...(ready ? { ready } : {}),
  };
  return { sink, told };
}

const sorted = (runs: ArrayLike<number>) => [...Array.from(runs)].sort((x, y) => x - y);

/** Resolves with the state once it satisfies `done`. */
function until(controller: OddsController, done: (state: OddsState) => boolean, timeoutMs = 60_000): Promise<OddsState> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const state = controller.getState();
      if (!done(state)) return false;
      stop();
      clearTimeout(timer);
      resolve(state);
      return true;
    };
    const stop = controller.subscribe(() => void check());
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Timed out in phase ${controller.getState().phase}`));
    }, timeoutMs);
    check();
  });
}

describe('the odds controller', () => {
  it('answers when the panel opens: the runs, the threats, then the ways forward', async () => {
    const { a } = await twoBrowsers();
    const controller = controllerFor(a.project);
    controller.show();
    const state = await until(controller, (s) => s.phase === 'done');
    expect(state.now?.runs.length).toBe(200);
    expect(state.threats[0]?.name).toBe('Erect steel and metal deck');
    expect(state.ladder[0]?.action).toBeNull();
    expect(state.ladder[1]?.action).toMatchObject({ kind: 'pay', id: HARBOR_FOOTINGS_PAID });
    expect(state.holds).toHaveLength(1);
    expect(state.holds[0]!.days).toBeGreaterThan(0);
    expect(state.stale).toBe(false);
  }, 120_000);

  it('asks again on its own when PayPal’s answer marks the hold paid in another browser, and the dots move earlier', async () => {
    const { relay, a, b } = await twoBrowsers();
    const controller = controllerFor(a.project);
    const plot = fakePlot();
    controller.attachPlot(plot.sink);
    controller.show();
    const first = await until(controller, (s) => s.phase === 'done');
    // The board's side by side, before paying: the Friday pay run against paying when due, the same runs.
    const payStep = first.ladder.find((step) => step.action?.kind === 'pay')!;
    expect(controller.comparison()).toEqual({ wait: first.now, pay: payStep.simulation });
    expect(payStep.simulation.onTime).toBeGreaterThan(first.now!.onTime);
    const gate = gateFor(b.project, b.project.taskStore.getById(HARBOR_FOOTINGS_PAID) as TaskModel)!;
    await recordPaid(b.project, HARBOR_FOOTINGS_PAID, paymentOf(gate), 'BATCH-TEST', new Date(2026, 10, 7, 12));
    await settle(clients, relay);
    const paid = await until(controller, (s) => s.reason === 'paid' && s.phase === 'done');
    expect(paid.plan?.holds).toHaveLength(0);
    expect(paid.before?.p50).toBe(first.now!.p50);
    expect(paid.now!.p50).toBeLessThan(first.now!.p50);
    // The pay step is gone: the hold is paid.
    expect(paid.ladder.some((step) => step.action?.kind === 'pay')).toBe(false);
    // The plots keep what they show and move it (the board drains and refills); every run comes back.
    expect(plot.told.begins.map((pass) => pass.fresh)).toEqual([true, false]);
    expect(sorted(plot.told.ends.at(-1)!)).toEqual(sorted(paid.now!.runs));
    // After paying: the answer from before against this one.
    expect(controller.comparison()).toEqual({ wait: first.now, pay: paid.now });
  }, 120_000);

  it('tells every plot every run, and starts the runs only once the plots on screen are ready', async () => {
    const { a } = await twoBrowsers();
    const controller = controllerFor(a.project);
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dots = fakePlot();
    const board = fakePlot(() => loaded);
    controller.attachPlot(dots.sink);
    controller.attachPlot(board.sink);
    controller.show();
    await until(controller, (s) => s.phase === 'running' && s.plan !== null);
    await sleep(250);
    // Both were told the pass at once; no run has gone while the board's physics loads.
    expect([dots.told.begins.length, board.told.begins.length]).toEqual([1, 1]);
    expect(dots.told.begins[0]).toBe(board.told.begins[0]);
    expect(dots.told.landed).toHaveLength(0);
    expect(controller.getState().progress.done).toBe(0);
    release();
    const state = await until(controller, (s) => s.phase === 'done');
    expect(sorted(dots.told.landed.map((item) => item.run))).toEqual(sorted(state.now!.runs));
    expect(board.told.landed).toEqual(dots.told.landed);
    expect(board.told.ends).toEqual(dots.told.ends);
  }, 120_000);

  it('does not wait past the limit for a plot that never gets ready', async () => {
    const { a } = await twoBrowsers();
    const controller = controllerFor(a.project, { readyLimitMs: 60 });
    const stuck = fakePlot(() => new Promise<void>(() => undefined));
    controller.attachPlot(stuck.sink);
    controller.show();
    const state = await until(controller, (s) => s.phase === 'done');
    expect(stuck.told.landed).toHaveLength(state.now!.runs.length);
  }, 120_000);

  it('gives a plot attached part way through a pass the runs landed so far', async () => {
    const { a } = await twoBrowsers();
    const controller = controllerFor(a.project);
    const dots = fakePlot();
    let late: ReturnType<typeof fakePlot> | null = null;
    const land = dots.sink.land;
    dots.sink.land = (landed) => {
      land(landed);
      if (!late && dots.told.landed.length >= 20) {
        late = fakePlot();
        controller.attachPlot(late.sink);
      }
    };
    controller.attachPlot(dots.sink);
    controller.show();
    const state = await until(controller, (s) => s.phase === 'done');
    const joined = late as ReturnType<typeof fakePlot> | null;
    expect(joined).not.toBeNull();
    expect(joined!.told.begins).toHaveLength(1);
    expect(joined!.told.begins[0]!.fresh).toBe(true);
    // Every run, the ones before it joined included, each once.
    expect(sorted(joined!.told.landed.map((item) => item.run))).toEqual(sorted(state.now!.runs));
  }, 120_000);

  it('says the answer is from before someone else’s edit, and runs nothing until asked', async () => {
    const { relay, a, b } = await twoBrowsers();
    const controller = controllerFor(a.project);
    controller.show();
    const first = await until(controller, (s) => s.phase === 'done');
    (b.project.taskStore.getById(82) as TaskModel).set({ duration: 20 } as never);
    await settle(clients, relay);
    const stale = await until(controller, (s) => s.stale);
    expect(stale.phase).toBe('done');
    expect(stale.now).toBe(first.now);
    await sleep(200);
    expect(controller.getState().phase).toBe('done');
  }, 120_000);

  it('puts a Saturday step into the plan as one change, then asks again with it in', async () => {
    const { relay, a, b } = await twoBrowsers();
    const controller = controllerFor(a.project);
    controller.show();
    const first = await until(controller, (s) => s.phase === 'done');
    // A Saturday step as the ladder offers one: paying on time alone no longer reaches the target, so it does offer one.
    // Built here so that the test is about applying a step, not about the search.
    const step: LadderStep = { action: { kind: 'saturdays', id: 30, name: 'Slab on grade', tasks: 4 }, scenario: { saturdays: [30] }, simulation: first.now!, costMinor: 0, saturdays: 0 };
    const before = relay.revisionCount;
    await controller.apply(step);
    const applied = await until(controller, (s) => s.reason === 'applied' && s.phase === 'done');
    await settle(clients, relay);
    expect(relay.revisionCount - before).toBe(1);
    const rowId = step.action!.id;
    const row = b.project.taskStore.getById(rowId) as TaskModel;
    const calendarOf = (task: TaskModel) => (task as unknown as { calendar?: { id?: unknown } }).calendar?.id;
    const leaves = (row.isLeaf ? [row] : (row.children as TaskModel[])).filter((task) => !task.isMilestone);
    // The crews' tasks go on Saturdays; the city inspection keeps her calendar.
    for (const task of leaves) expect(calendarOf(task)).toBe(task.id === 35 ? 'inspector' : 'site');
    expect(applied.now!.p50).toBeLessThanOrEqual(first.now!.p50);
    expect(applied.now!.odds).toBeGreaterThanOrEqual(first.now!.odds);
  }, 120_000);
});

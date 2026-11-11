/**
 * The hosted site's plan date reaches everything that reads Harbor against today. With the real clock a month after
 * the film (Wed, Dec 9, 2026, mid-afternoon), the odds still ask about Tue, Nov 10 and give the film's numbers (109
 * and 754 runs of 1,000 on time: about 11% on the Friday pay run against 75% paid when due); the Friday pay run in the
 * late-payment forecast is still Fri, Nov 13, moving the handover from Thu, May 27 to Tue, Jun 8; the chart's today
 * line is drawn on Nov 10 by the app, not from the browser's clock; the 3D view counts reported work from Nov 10; and the
 * watch rules read Nov 10 as today. The same questions on the real clock land in December, which is why the site pins.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateHelper, type ProjectModel } from '@bryntum/gantt';
import { harborOffices } from '@collab/shared/seed';
import { watchPlan } from '../../src/alerts/live';
import { CURRENT_TIME_LINE, dayHeader, PLAN_TODAY_ID, showPlanToday } from '../../src/gantt/axis-marks';
import { progressAt } from '../../src/gantt/fx3d/facts';
import { latePaymentEffect } from '../../src/gantt/late-payment-effect';
import { DEFAULT_ASSUMPTIONS, OddsQuestion, dayNumber, readOddsPlan, simulate, type OddsAssumptions } from '../../src/gantt/monte-carlo';
import { createProjectModel, loadProjectInlineData } from '../../src/gantt/project';
import { OddsController, type OddsState } from '../../src/odds/odds-controller';
import { planClock } from '../../src/plan-clock';

vi.mock('../../src/hosted', async (original) => ({ ...(await original<typeof import('../../src/hosted')>()), HOSTED: true }));

/** A visit a month later: Wed, Dec 9, 2026, 3:42 PM where the test runs. */
const VISIT = new Date(2026, 11, 9, 15, 42);
const FILM_DAY = new Date(2026, 10, 10);
const quick = () => Promise.resolve();
const day = (value: Date) => DateHelper.format(value, 'YYYY-MM-DD');
const payRun: OddsAssumptions = { ...DEFAULT_ASSUMPTIONS, payPolicy: 'payRun' };
const whenDue: OddsAssumptions = { ...DEFAULT_ASSUMPTIONS, payPolicy: 'due' };

const projects: ProjectModel[] = [];
const closers: (() => void)[] = [];

beforeAll(() => {
  // Only Date: the engine's own timers run as usual, and the clock moves on from the visit as real time passes.
  vi.useFakeTimers({ toFake: ['Date'], now: VISIT, shouldAdvanceTime: true });
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  closers.splice(0).forEach((close) => close());
  projects.splice(0).forEach((project) => project.destroy());
});

async function harbor(): Promise<ProjectModel> {
  const project = createProjectModel();
  await loadProjectInlineData(project, structuredClone(harborOffices.inlineData) as never);
  projects.push(project);
  return project;
}

describe('the hosted site, a month after the film', () => {
  it('pins the plan to Tue, Nov 10, 2026, at the real time of day', () => {
    expect(day(new Date())).toBe('2026-12-09');
    expect(planClock.pinned).toBe('2026-11-10');
    expect(day(planClock.today())).toBe('2026-11-10');
    expect(planClock.now().getHours()).toBe(15);
    expect(day(planClock.now())).toBe('2026-11-10');
  });

  it('asks the odds about Nov 10 and gets the film’s numbers, which December’s clock would not', async () => {
    const project = await harbor();
    expect(readOddsPlan(project).todayDay).toBe(dayNumber(FILM_DAY));
    const question = await OddsQuestion.ask(project, { yieldNow: quick });
    closers.push(() => question.close());
    expect(day(question.today)).toBe('2026-11-10');
    const friday = await simulate(question, payRun, {}, { yieldNow: quick });
    const due = await simulate(question, whenDue, {}, { yieldNow: quick });
    expect([friday.onTime, due.onTime, friday.runs.length]).toEqual([109, 754, 1000]);

    // On the real clock the footings could be paid no sooner than Dec 9, either way: the deadline is all but lost.
    const late = await OddsQuestion.ask(project, { today: new Date(), yieldNow: quick });
    closers.push(() => late.close());
    const lateDue = await simulate(late, whenDue, {}, { yieldNow: quick });
    expect(lateDue.onTime).toBeLessThan(100);
  }, 90_000);

  it('runs the odds panel’s questions on Nov 10 when it is given no day', async () => {
    const project = await harbor();
    const controller = new OddsController(project, { yieldNow: quick, assumptions: { ...DEFAULT_ASSUMPTIONS, runs: 100 }, maxSteps: 1 });
    closers.push(() => controller.dispose());
    const asked = new Promise<OddsState>((resolve) => {
      const check = () => {
        const state = controller.getState();
        if (state.plan) resolve(state);
      };
      closers.push(controller.subscribe(check));
      check();
    });
    controller.show();
    expect((await asked).plan!.todayDay).toBe(dayNumber(FILM_DAY));
  }, 90_000);

  it('waits for the Friday pay run of Nov 13 in the forecast: the handover moves from May 27 to Jun 8', async () => {
    const project = await harbor();
    const effect = (await latePaymentEffect(project))!;
    expect(effect).toMatchObject({
      due: '2026-11-10',
      paid_on: '2026-11-13',
      handover_on_time: '2027-05-27',
      handover_if_late: '2027-06-08',
      slip_days: 12,
      waits_for: { task: 'City inspection, slab', why: 'City inspector away', now_on: '2026-11-30' },
    });
    // December's Friday, on the real clock.
    expect((await latePaymentEffect(project, { today: new Date() }))?.paid_on).toBe('2026-12-11');
  }, 60_000);

  it('draws the chart’s today line on Nov 10 itself, kept out of the plan’s changes, and fills in Nov 10 in the header', async () => {
    const project = await harbor();
    expect(CURRENT_TIME_LINE).toBe(false);
    const stop = showPlanToday(project);
    const store = (project as unknown as { timeRangeStore: { getById(id: string): { startDate: Date; endDate: Date; cls: unknown } | undefined; changes: unknown } }).timeRangeStore;
    const line = store.getById(PLAN_TODAY_ID)!;
    expect(day(line.startDate)).toBe('2026-11-10');
    expect(line.startDate.getHours()).toBe(15);
    expect(line.endDate.getTime()).toBe(line.startDate.getTime());
    expect(String(line.cls)).toContain('b-sch-current-time');
    expect(store.changes).toBeNull();
    stop();
    expect(store.getById(PLAN_TODAY_ID)).toBeUndefined();

    const cell: { headerCellCls?: string } = {};
    dayHeader('d1')(FILM_DAY, new Date(2026, 10, 11), cell);
    expect(cell.headerCellCls).toBe('look-today');
    dayHeader('d1')(new Date(2026, 11, 9), new Date(2026, 11, 10), cell);
    expect(cell.headerCellCls).toBe('');
  });

  it('counts reported work in the 3D view from Nov 10, and the watch rules read Nov 10 as today', async () => {
    const facts = { workDays: [new Date(2026, 10, 2).getTime(), new Date(2026, 11, 1).getTime()], percent: 60, start: new Date(2026, 10, 2), end: new Date(2026, 11, 2) };
    // Nov 20 is after the plan's today: the 60% reported counts. On the real clock it would be before today.
    expect(progressAt(facts, new Date(2026, 10, 20).getTime()).built).toBeCloseTo(0.6);
    expect(progressAt(facts, new Date(2026, 10, 20).getTime(), Date.now()).built).toBeLessThan(0.6);
    expect(watchPlan(await harbor(), new Map()).today).toBe('2026-11-10');
  });
});

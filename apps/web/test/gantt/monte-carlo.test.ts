/**
 * The odds on Harbor Street Offices, with the real scheduling engine and a fixed seed, against the lease's date
 * (Fri, Jun 11, the handover's deadline): the same seed gives the same numbers; paying the footings when they fall
 * due beats the Friday pay run by about sixty-five points, because the pay run misses the city inspector, who is
 * away Thanksgiving week; Saturdays on the slab cost a premium on the crews' hours; the ways forward start with the
 * payment and go on to Saturdays; and the plan, its undo history and the relay never hear of a run. The dice and the
 * statistics are checked on their own first.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DateHelper, type ProjectModel, type TaskModel } from '@bryntum/gantt';
import { HARBOR_FOOTINGS_PAID, harborOffices } from '@collab/shared/seed';
import {
  DEFAULT_ASSUMPTIONS,
  OddsQuestion,
  dateOfDay,
  dayNumber,
  peopleOn,
  planSignature,
  plannedRun,
  saturdayPremiumMinor,
  simulate,
  taskThreats,
  type OddsAssumptions,
} from '../../src/gantt/monte-carlo';
import { actionWords, applySaturdays, saturdayParts, waysForward } from '../../src/gantt/monte-carlo-optimizer';
import { dice, diceKey, drawnLength, percentile, rankCorrelation, ranks, triangular, wholeUnits, workKind } from '../../src/gantt/monte-carlo-sampling';
import { createProjectModel, loadProjectInlineData } from '../../src/gantt/project';
import { gateFor, recordPaid, paymentOf } from '../../src/gantt/pay-gates';
import { undo } from '../../src/gantt/undo';
import { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { PROJECT_ID, disposeAll, joinClient, loadResult, settle, type Client } from '../sync/helpers';

/** The day the questions are asked: Saturday, November 7, 2026, with the footings done and their payment not yet due. */
const TODAY = new Date(2026, 10, 7);
const SLAB = 30;
const quick = () => Promise.resolve();
const day = (value: number) => DateHelper.format(dateOfDay(value), 'ddd YYYY-MM-DD');
const payRun: OddsAssumptions = { ...DEFAULT_ASSUMPTIONS, payPolicy: 'payRun' };
const whenDue: OddsAssumptions = { ...DEFAULT_ASSUMPTIONS, payPolicy: 'due' };

let clients: Client[] = [];
const projects: ProjectModel[] = [];
const questions: OddsQuestion[] = [];
afterEach(() => {
  questions.splice(0).forEach((question) => question.close());
  disposeAll(clients);
  clients = [];
  projects.splice(0).forEach((project) => project.destroy());
});

async function harbor(): Promise<ProjectModel> {
  const project = createProjectModel();
  await loadProjectInlineData(project, structuredClone(harborOffices.inlineData) as never);
  projects.push(project);
  return project;
}

async function ask(project: ProjectModel): Promise<OddsQuestion> {
  const question = await OddsQuestion.ask(project, { today: TODAY, yieldNow: quick });
  questions.push(question);
  return question;
}

describe('the dice', () => {
  it('rolls the same numbers for the same seed, run and task, and different ones otherwise', () => {
    const key = diceKey(82);
    expect(dice(7, 412, key)).toEqual(dice(7, 412, key));
    expect(dice(7, 412, key)).not.toEqual(dice(8, 412, key));
    expect(dice(7, 412, key)).not.toEqual(dice(7, 413, key));
    expect(dice(7, 412, key)).not.toEqual(dice(7, 412, diceKey(41)));
    const [u, v] = dice(7, 0, key);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('draws three-point lengths inside their range, with their average', () => {
    const range = { low: 0.9, likely: 1, high: 1.35 };
    expect(triangular(range, 0)).toBeCloseTo(0.9);
    expect(triangular(range, 0.999_999)).toBeCloseTo(1.35, 2);
    let sum = 0;
    for (let i = 0; i < 20_000; i += 1) sum += triangular(range, (i + 0.5) / 20_000);
    expect(sum / 20_000).toBeCloseTo((0.9 + 1 + 1.35) / 3, 3);
  });

  it('keeps the average when it rounds to whole days, leaves done work alone and never shortens planned work to nothing', () => {
    let sum = 0;
    for (let i = 0; i < 10_000; i += 1) sum += wholeUnits(3.3, (i + 0.5) / 10_000);
    expect(sum / 10_000).toBeCloseTo(3.3, 2);
    // Half of a ten-day task is done: only the other half varies.
    expect(drawnLength({ planned: 10, done: 0.5 }, { low: 1.2, likely: 1.2, high: 1.2 }, 0.5, 0.99)).toBe(11);
    expect(drawnLength({ planned: 1, done: 0 }, { low: 0.5, likely: 0.5, high: 0.5 }, 0.5, 0.99)).toBe(1);
  });

  it('reads percentiles and rank correlation the usual way', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.8)).toBe(8);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect([...ranks([10, 20, 20, 30])]).toEqual([1, 2.5, 2.5, 4]);
    expect(rankCorrelation([1, 2, 3, 4], [10, 40, 90, 160])).toBeCloseTo(1);
    expect(rankCorrelation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
  });

  it('tells outdoor work in winter from indoor work and inspections', () => {
    const at = (month: number) => new Date(2027, month, 4);
    expect(workKind({ name: 'Curtain wall', groups: ['Envelope'], trades: ['Curtain wall'], start: at(0) })).toBe('winter');
    expect(workKind({ name: 'Pour slab on grade', groups: ['Slab on grade', 'Site and foundations'], trades: ['Concrete'], start: at(10) })).toBe('winter');
    expect(workKind({ name: 'Paint, level 1', groups: ['Level 1 build-out'], trades: ['Painting'], start: at(2) })).toBe('indoor');
    expect(workKind({ name: 'Landscaping', groups: [], trades: [], start: at(5) })).toBe('outdoor');
    expect(workKind({ name: 'Fire inspection', groups: ['Completion'], trades: [], start: at(4) })).toBe('inspection');
  });
});

describe('the odds on Harbor', () => {
  it('reads what varies: the work left, by kind, the footings hold and the contract date', async () => {
    const question = await ask(await harbor());
    const plan = question.live;
    expect(plan.varying).toHaveLength(47);
    expect(plan.kinds).toEqual(['winter', 'indoor', 'inspection']);
    const kindOf = (id: number) => plan.varying.find((task) => task.id === id)?.kind;
    expect(kindOf(82)).toBe('winter');
    expect(kindOf(34)).toBe('winter');
    expect(kindOf(117)).toBe('indoor');
    // The city's inspection of the slab: the one inspection in the plan.
    expect(kindOf(35)).toBe('inspection');
    // Done work doesn't vary.
    expect(plan.varying.some((task) => task.id === 23)).toBe(false);
    // The lease's date, the handover's deadline: ten working days after the plan's own May 27.
    expect(day(plan.contractDay)).toBe('Fri 2027-06-11');
    expect(plan.contractFrom).toBe('deadline');
    expect(day(plan.plannedDay!)).toBe('Thu 2027-05-27');
    expect(plan.holds.map((hold) => [hold.id, hold.pays, hold.holds, day(hold.dueDay!)])).toEqual([[HARBOR_FOOTINGS_PAID, 'Footings', 'Slab on grade', 'Tue 2026-11-10']]);
  });

  it('gives the plan its own answer with no dice: the pay run misses the city inspector, and Saturdays on the slab win back a day, not her week', async () => {
    const plan = (await ask(await harbor())).live;
    expect(day(plannedRun(plan, whenDue, {}).day)).toBe('Thu 2027-05-27');
    // Paid on Friday, Nov 13, the rebar is ready after she has left for Thanksgiving week: no inspection until Mon, Nov 30.
    expect(day(plannedRun(plan, payRun, {}).day)).toBe('Tue 2027-06-08');
    // The slab's crews on Saturdays win back one day (two Saturdays), not the week she is away: she keeps her calendar.
    const slab = plannedRun(plan, payRun, { saturdays: [SLAB] });
    expect(day(slab.day)).toBe('Mon 2027-06-07');
    expect(slab.saturdays.get(SLAB)?.days).toBe(2);
  });

  it('gives the same numbers for the same seed', async () => {
    const question = await ask(await harbor());
    const first = await simulate(question, payRun, {}, { yieldNow: quick, finishes: true, lengths: true });
    const again = await simulate(question, payRun, {}, { yieldNow: quick });
    expect([...again.days]).toEqual([...first.days]);
    expect(first.failed).toBe(0);
    expect(first.runs.length).toBe(1000);
    // Paid on the Friday pay run, with the default ranges: about one chance in nine of the lease's date, the slab
    // waiting out the inspector's week.
    expect({ onTime: first.onTime, p10: day(first.p10), p50: day(first.p50), p80: day(first.p80), p90: day(first.p90) }).toEqual({
      onTime: 109,
      p10: 'Fri 2027-06-11',
      p50: 'Thu 2027-06-17',
      p80: 'Mon 2027-06-21',
      p90: 'Wed 2027-06-23',
    });
    // The long winter work moves the handover most.
    expect(taskThreats(question.live, first, 3).map((threat) => [threat.name, Number(threat.correlation.toFixed(2))])).toEqual([
      ['Curtain wall', 0.43],
      ['Erect steel and metal deck', 0.39],
      ['Cure slab on grade', 0.27],
    ]);
    // Eight runs in ten finish the curtain wall by Wednesday, February 24; the plan has it done on Friday, February 5.
    expect(DateHelper.format(new Date(first.finishes!.get(82)! - 1), 'ddd YYYY-MM-DD')).toBe('Wed 2027-02-24');
    // Another seed rolls other dice.
    const other = await simulate(question, { ...payRun, seed: 8 }, {}, { yieldNow: quick, runIndices: Int32Array.from({ length: 100 }, (_, i) => i) });
    expect([...other.days]).not.toEqual([...first.days.slice(0, 100)]);
  }, 60_000);

  it('pays the footings when due rather than on the Friday pay run: earlier in every run, and better odds', async () => {
    const question = await ask(await harbor());
    const friday = await simulate(question, payRun, {}, { yieldNow: quick });
    const due = await simulate(question, whenDue, {}, { yieldNow: quick });
    // Each run is the same roll of the dice, paid two ways: never later when paid on time.
    for (let i = 0; i < due.days.length; i += 1) expect(due.days[i]!).toBeLessThanOrEqual(friday.days[i]!);
    expect({ onTime: due.onTime, p10: day(due.p10), p50: day(due.p50), p80: day(due.p80), p90: day(due.p90) }).toEqual({
      onTime: 754,
      p10: 'Thu 2027-06-03',
      p50: 'Wed 2027-06-09',
      p80: 'Mon 2027-06-14',
      p90: 'Wed 2027-06-16',
    });
    // About three in four paid on time, against about one in nine on the pay run.
    expect(due.odds - friday.odds).toBeGreaterThan(0.6);
  }, 60_000);

  it('puts Saturdays on the slab on top of the pay run, at a premium on the Saturdays actually worked', async () => {
    const question = await ask(await harbor());
    const friday = await simulate(question, payRun, {}, { yieldNow: quick });
    const due = await simulate(question, whenDue, {}, { yieldNow: quick });
    const slab = await simulate(question, payRun, { saturdays: [SLAB] }, { yieldNow: quick });
    // A little better than the pay run alone, nowhere near paying on time: her week away doesn't move for our Saturdays.
    expect(slab.p50).toBeLessThan(friday.p50);
    expect(slab.p50).toBeGreaterThan(due.p50);
    expect(slab.onTime).toBeGreaterThan(friday.onTime);
    expect(slab.onTime).toBeLessThan(due.onTime);
    const worked = slab.saturdays.get(SLAB)!;
    expect(worked.days).toBeCloseTo(2.505, 2);
    expect(Math.round(worked.premiumMinor / 100)).toBe(1550);
  }, 60_000);

  it('costs a Saturday from the crews on the task: the plan’s headcount, or the usual crew of the trade', async () => {
    const project = await harbor();
    const of = (id: number) => peopleOn(project.taskStore.getById(id) as TaskModel);
    // The plan says: seven on the slab pour, five on the curtain wall; the crane is a machine, not people.
    expect([of(33), of(82), of(41)]).toEqual([7, 5, 5]);
    // The plan doesn't say for the painters: a painting crew is usually five.
    expect(of(117)).toBe(5);
    // Five people: half of eight hours each at $65 an hour.
    expect(saturdayPremiumMinor(5, DEFAULT_ASSUMPTIONS)).toBe(130_000);
    expect(saturdayPremiumMinor(5, { ...DEFAULT_ASSUMPTIONS, saturdayPremium: 2, hourlyRate: 80 })).toBe(320_000);
  });

  it('finds the ways forward: the payment first, then Saturdays, each step raising the odds', async () => {
    const question = await ask(await harbor());
    const now = await simulate(question, payRun, {}, { yieldNow: quick });
    const ladder = await waysForward(question, payRun, now, { yieldNow: quick });
    // Paying on time alone reaches 754 of 1,000, short of eight in ten, so the search goes on to Saturdays on the slab.
    const words = (steps: readonly { action: Parameters<typeof actionWords>[0] | null; simulation: { onTime: number; p50: number }; costMinor: number }[]) =>
      steps.map((step) => [step.action ? actionWords(step.action) : 'Now', step.simulation.onTime, day(step.simulation.p50), Math.round(step.costMinor / 100)]);
    expect(words(ladder)).toEqual([
      ['Now', 109, 'Thu 2027-06-17', 0],
      ['Pay for Footings when it falls due', 754, 'Wed 2027-06-09', 0],
      ['Saturdays on Slab on grade', 966, 'Fri 2027-06-04', 1669],
    ]);
    expect(ladder[1]!.action).toMatchObject({ kind: 'pay', id: HARBOR_FOOTINGS_PAID });
    // Asked for more, it goes on with Saturdays, the best gain in odds per dollar first, each at a premium on the crews' hours.
    const further = await waysForward(question, payRun, now, { yieldNow: quick, target: 0.97 });
    expect(words(further)).toEqual([
      ['Now', 109, 'Thu 2027-06-17', 0],
      ['Pay for Footings when it falls due', 754, 'Wed 2027-06-09', 0],
      ['Saturdays on Slab on grade', 966, 'Fri 2027-06-04', 1669],
      ['Saturdays on Concrete deck, level 2', 983, 'Thu 2027-06-03', 285],
    ]);
    for (let i = 1; i < further.length; i += 1) {
      expect(further[i]!.simulation.p50).toBeLessThanOrEqual(further[i - 1]!.simulation.p50);
      expect(further[i]!.simulation.odds).toBeGreaterThanOrEqual(further[i - 1]!.simulation.odds);
    }
  }, 180_000);

  it('offers Saturdays on each part of the plan with work left, never on finished work', async () => {
    const plan = (await ask(await harbor())).live;
    expect(saturdayParts(plan).map((part) => part.row.id)).toEqual([30, 41, 50, 60, 70, 80, 90, 100, 200, 300, 400]);
  });
});

describe('a run leaves the plan alone', () => {
  async function twoBrowsers(): Promise<{ relay: InMemoryRelay; a: Client; b: Client }> {
    const snapshot = structuredClone(harborOffices.inlineData) as never;
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
    const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
    const b = await joinClient(relay, 'client-b', loadResult(structuredClone(snapshot)));
    clients = [a, b];
    await settle(clients, relay);
    return { relay, a, b };
  }

  const time = (value: unknown) => (value instanceof Date ? value.getTime() : null);
  const datesOf = (project: ProjectModel) => (project.taskStore.allRecords as TaskModel[]).map((task) => `${task.id}:${time(task.startDate)}:${time(task.endDate)}:${String(task.duration)}`);

  it('changes nothing, records nothing to undo and sends nothing', async () => {
    const { relay, a } = await twoBrowsers();
    const revisions = relay.revisionCount;
    const before = datesOf(a.project);
    const stm = a.project.stm as unknown as { position: number; queue: unknown[]; canUndo: boolean };
    const history = { position: stm.position, length: stm.queue.length, canUndo: stm.canUndo };
    const signature = planSignature(a.project);
    let dataReady = 0;
    const detach = a.project.on('dataReady', () => (dataReady += 1)) as unknown as () => void;

    const question = await ask(a.project);
    const now = await simulate(question, { ...payRun, runs: 200 }, {}, { yieldNow: quick, finishes: true, lengths: true });
    await waysForward(question, { ...payRun, runs: 200 }, now, { yieldNow: quick, maxSteps: 2 });
    detach();

    await settle(clients, relay);
    expect(dataReady).toBe(0);
    expect(relay.revisionCount).toBe(revisions);
    expect(datesOf(a.project)).toEqual(before);
    expect(a.project.taskStore.changes).toBeNull();
    expect({ position: stm.position, length: stm.queue.length, canUndo: stm.canUndo }).toEqual(history);
    expect(planSignature(a.project)).toBe(signature);
  }, 120_000);

  it('answers for the plan as it was asked when someone else changes it during the runs', async () => {
    const { relay, a, b } = await twoBrowsers();
    const question = await ask(a.project);
    const runs = { ...payRun, runs: 120 };
    const undisturbed = await simulate(question, runs, {}, { yieldNow: quick });
    let edited = false;
    // Halfway through, the other browser makes the curtain wall twice as long.
    const disturbed = await simulate(question, runs, {}, {
      yieldNow: async () => {
        if (!edited) {
          edited = true;
          (b.project.taskStore.getById(82) as TaskModel).set({ duration: 30 } as never);
          await settle(clients, relay);
        }
      },
      sliceMs: 5,
    });
    expect(edited).toBe(true);
    expect(question.changedSince()).toBe(true);
    expect(disturbed.onCopy).toBe(true);
    expect([...disturbed.days]).toEqual([...undisturbed.days]);
  }, 120_000);
});

describe('applying a step', () => {
  it('puts Saturdays on the slab as one change that one undo takes back', async () => {
    const snapshot = structuredClone(harborOffices.inlineData) as never;
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
    const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
    const b = await joinClient(relay, 'client-b', loadResult(structuredClone(snapshot)));
    clients = [a, b];
    await settle(clients, relay);
    const before = relay.revisionCount;
    const calendarOf = (project: ProjectModel, id: number) => (project.taskStore.getById(id) as unknown as { calendar?: { id?: unknown } | null }).calendar?.id ?? null;
    // The crews' four tasks.
    expect(await applySaturdays(a.project, SLAB)).toBe(4);
    await settle(clients, relay);
    expect(relay.revisionCount - before).toBe(1);
    for (const { project } of [a, b]) {
      for (const id of [31, 32, 33, 34]) expect(calendarOf(project, id)).toBe('site');
      // The inspection is the city's, and keeps her calendar.
      expect(calendarOf(project, 35)).toBe('inspector');
      expect((project.taskStore.getById(31) as unknown as { ignoreResourceCalendar: boolean }).ignoreResourceCalendar).toBe(true);
    }
    await undo(a.project);
    await settle(clients, relay);
    for (const { project } of [a, b]) for (const id of [31, 32, 33, 34]) expect(calendarOf(project, id)).not.toBe('site');
  }, 60_000);
});

describe('PayPal pays the hold', () => {
  it('moves the forecast: once paid, the hold is gone from the runs and every run is as early as paying on time', async () => {
    const snapshot = structuredClone(harborOffices.inlineData) as never;
    const relay = new InMemoryRelay({ projectId: PROJECT_ID, snapshot });
    const a = await joinClient(relay, 'client-a', loadResult(structuredClone(snapshot)));
    clients = [a];
    await settle(clients, relay);
    const runs = { ...payRun, runs: 200 };
    const before = await simulate(await ask(a.project), runs, {}, { yieldNow: quick });
    const due = await simulate(await ask(a.project), { ...runs, payPolicy: 'due' }, {}, { yieldNow: quick });
    const gate = gateFor(a.project, a.project.taskStore.getById(HARBOR_FOOTINGS_PAID) as TaskModel)!;
    await recordPaid(a.project, HARBOR_FOOTINGS_PAID, paymentOf(gate), 'BATCH-TEST', new Date(2026, 10, 7, 12));
    await settle(clients, relay);
    const question = await ask(a.project);
    expect(question.live.holds).toHaveLength(0);
    expect(question.live.todayDay).toBe(dayNumber(TODAY));
    const after = await simulate(question, runs, {}, { yieldNow: quick });
    expect(after.p50).toBeLessThan(before.p50);
    expect([...after.days]).toEqual([...due.days]);
  }, 60_000);
});

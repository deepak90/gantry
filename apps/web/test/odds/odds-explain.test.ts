/**
 * The odds board explains itself in two plain lines: what was run (the plan a thousand times, every task's time
 * varying as its kind of work does) and what a marble is; then what the percent and the date mean, how this board
 * pays the payments that hold work, and the step to take with its own odds, which can be shown on the board. Every
 * number is the runs' own: on the Harbor plan, the words carry the panel's figures.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { harborOffices } from '@collab/shared/seed';
import { dayNumber, DEFAULT_ASSUMPTIONS, type OddsPlan } from '../../src/gantt/monte-carlo';
import type { LadderStep } from '../../src/gantt/monte-carlo-optimizer';
import { createProjectModel, loadProjectInlineData } from '../../src/gantt/project';
import { OddsController, type OddsState } from '../../src/odds/odds-controller';
import { deadlineWords, explainOdds } from '../../src/odds/odds-explain';

const JUN_11 = dayNumber(new Date(2027, 5, 11));

const sim = (odds: number, runs = 1000) => ({ odds, onTime: Math.round(odds * runs), runs: new Int32Array(runs) });
const pay = (pays: string, odds: number) => ({ action: { kind: 'pay', id: pays, hold: { pays } }, simulation: sim(odds) }) as unknown as LadderStep;
const saturdays = (name: string, odds: number) => ({ action: { kind: 'saturdays', id: name, name, tasks: 3 }, simulation: sim(odds) }) as unknown as LadderStep;

function state(patch: { holds?: number; policy?: 'payRun' | 'due'; odds?: number; ladder?: LadderStep[]; phase?: OddsState['phase']; previewing?: number | null; from?: OddsPlan['contractFrom'] } = {}): OddsState {
  const { holds = 1, policy = 'payRun', odds = 0.109, ladder = [], phase = 'done', previewing = null, from = 'deadline' } = patch;
  const now = sim(odds);
  return {
    phase,
    plan: { contractDay: JUN_11, contractFrom: from, holds: Array.from({ length: holds }, (_, index) => ({ id: index })) },
    now,
    ladder: [{ action: null, simulation: now }, ...ladder],
    previewing,
    assumptions: { ...DEFAULT_ASSUMPTIONS, payPolicy: policy },
    progress: { done: 0, total: 1000, shown: 0, onTime: 0 },
  } as unknown as OddsState;
}

describe('what was run', () => {
  it('says the plan ran a thousand times with each task’s time varying, and what a marble is', () => {
    expect(explainOdds(state(), 'board').about).toBe(
      'The plan, run 1,000 times on the scheduling engine, each task taking a little more or less time, the way its kind of work does. Each marble is one run, on the day it hands over.',
    );
    expect(explainOdds(state(), 'dots').about).toContain('Each dot is one run');
  });

  it('says what is running before there is an answer, and nothing more', () => {
    const running = explainOdds(state({ phase: 'running' }), 'board');
    expect(running.about).toContain('run 1,000 times');
    expect(running.says).toBeNull();
    expect(running.step).toBeNull();
  });
});

describe('what the board says', () => {
  it('reads the percent against the date, says how this board pays, and suggests paying when due with PayPal', () => {
    const explained = explainOdds(state({ ladder: [pay('Footings', 0.754), saturdays('Slab on grade', 0.97)] }), 'board');
    expect(explained.says).toBe('If payments wait for the Friday pay run, 11% hand over by Fri, Jun 11, the contract date. Pay for Footings when it falls due, with PayPal, and it’s 75%.');
    expect(explained.step).toBe(1);
  });

  it('names every payment that helps, with the odds once all of them are paid when due', () => {
    const explained = explainOdds(state({ holds: 2, ladder: [pay('Footings', 0.5), pay('Steel', 0.82)] }), 'board');
    expect(explained.says).toContain('Pay for Footings and Steel when they fall due, with PayPal, and it’s 82%.');
    expect(explained.step).toBe(2);
  });

  it('suggests Saturdays when payments already go out when due', () => {
    const explained = explainOdds(state({ policy: 'due', odds: 0.754, ladder: [saturdays('Slab on grade', 0.97)] }), 'board');
    expect(explained.says).toBe('If payments go out when due, 75% hand over by Fri, Jun 11, the contract date. Work Saturdays on Slab on grade and it’s 97%.');
    expect(explained.step).toBe(1);
  });

  it('leaves the pay run out of a plan with no payment holding work', () => {
    expect(explainOdds(state({ holds: 0, odds: 0.42 }), 'board').says).toMatch(/^42% hand over by Fri, Jun 11, the contract date\./);
  });

  it('says when nothing raises the odds, or nothing more is needed, once the ways forward are in', () => {
    expect(explainOdds(state({ odds: 0.3 }), 'board').says).toContain('Nothing on the list of ways forward raises it.');
    expect(explainOdds(state({ odds: 0.86 }), 'board').says).toContain('Nothing more is needed to make the date.');
    expect(explainOdds(state({ odds: 0.3, phase: 'searching' }), 'board').says).toBe('If payments wait for the Friday pay run, 30% hand over by Fri, Jun 11, the contract date.');
  });

  it('reads the runs of a way forward on show, with nothing more to suggest', () => {
    const ladder = [pay('Footings', 0.754), saturdays('Slab on grade', 0.97)];
    expect(explainOdds(state({ ladder, previewing: 1 }), 'board')).toMatchObject({ says: 'With that step, 75% hand over by Fri, Jun 11, the contract date.', step: null });
    expect(explainOdds(state({ ladder, previewing: 2 }), 'board').says).toBe('With those steps, 97% hand over by Fri, Jun 11, the contract date.');
  });

  it('says where the date comes from', () => {
    const plan = (from: OddsPlan['contractFrom']) => ({ contractDay: JUN_11, contractFrom: from }) as OddsPlan;
    expect(deadlineWords(plan('constraint'))).toBe('Fri, Jun 11, the contract date');
    expect(deadlineWords(plan('baseline'))).toBe('Fri, Jun 11, the date first planned');
    expect(deadlineWords(plan('plan'))).toBe('Fri, Jun 11, the date in the plan');
  });

  it('keeps to plain words', () => {
    const all = [state({ ladder: [pay('Footings', 0.754)] }), state({ policy: 'due', ladder: [saturdays('Slab on grade', 0.97)] }), state({ phase: 'running' })]
      .flatMap((one) => Object.values(explainOdds(one, 'board')))
      .join(' ');
    expect(all).not.toMatch(/\b(Monte Carlo|simulation|P50|P80|percentile|probability|stochastic|distribution)\b/i);
  });
});

describe('on the Harbor plan', () => {
  const controllers: OddsController[] = [];
  afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()));

  it('carries the runs’ own numbers', async () => {
    const project = createProjectModel();
    await loadProjectInlineData(project, structuredClone(harborOffices.inlineData) as never);
    const controller = new OddsController(project, { today: () => new Date(2026, 10, 7), yieldNow: () => Promise.resolve(), assumptions: { ...DEFAULT_ASSUMPTIONS, runs: 200 }, maxSteps: 2 });
    controllers.push(controller);
    const answer = await controller.answerFresh('payRun');
    const explained = explainOdds(answer, 'board');
    expect(explained.about).toContain('run 200 times');
    expect(explained.says).toContain(`${Math.round(answer.now!.odds * 100)}% hand over by ${deadlineWords(answer.plan!)}.`);
    const step = explained.step === null ? null : answer.ladder[explained.step]!;
    if (step) expect(explained.says).toContain(`${Math.round(step.simulation.odds * 100)}%.`);
  }, 120_000);
});

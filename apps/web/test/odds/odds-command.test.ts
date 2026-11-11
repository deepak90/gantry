/**
 * Remy's odds, as this browser answers them: the command's arguments decide how holds are paid, a browser without
 * the plan says so, the summary sent back is the panel's own answer (the same runs, the same assumptions line), in
 * the shape the agent reads and inside the command result's 8 KB, and the same executor says what waiting for the
 * pay run would do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCommandResult, OddsSummary, type LatePaymentEffect, type OddsSummary as Summary } from '@collab/shared';
import { harborOffices } from '@collab/shared/seed';
import { DEFAULT_ASSUMPTIONS, type PayPolicy } from '../../src/gantt/monte-carlo';
import { createProjectModel, loadProjectInlineData } from '../../src/gantt/project';
import { commandExecutor, runScheduleOdds } from '../../src/odds/odds-command';
import { OddsController } from '../../src/odds/odds-controller';
import { assumptionWords, oddsSummary } from '../../src/odds/odds-summary';

const TODAY = new Date(2026, 10, 7);
const quick = () => Promise.resolve();
const controllers: OddsController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
});

const FAKE = { contract_date: '2027-06-11' } as Summary;

describe('the odds, asked for by Remy', () => {
  it('pays the holds as the command says, or as the person has it', async () => {
    const asked: (PayPolicy | undefined)[] = [];
    const runner = { runOdds: async (pay?: PayPolicy) => (asked.push(pay), FAKE) };
    expect(await runScheduleOdds(runner, { pay: 'pay_run' })).toEqual({ ok: true, result: { odds: FAKE } });
    await runScheduleOdds(runner, { pay: 'when_due' });
    await runScheduleOdds(runner, {});
    expect(asked).toEqual(['payRun', 'due', undefined]);
    expect(await runScheduleOdds(runner, { pay: 'next week' })).toMatchObject({ ok: false });
  });

  it('says so when this browser has no plan on screen, or is asked for something else', async () => {
    expect(await commandExecutor(() => null)('schedule_odds', {})).toMatchObject({ ok: false, result: { message: 'The plan is not open in this browser.' } });
    expect(await commandExecutor(() => ({ runOdds: async () => FAKE }))('propose_fix', {})).toMatchObject({ ok: false });
  });

  it('says what waiting for the pay run would do, when a payment is holding work', async () => {
    const effect = { held: 'Slab on grade', handover_if_late: '2027-06-08' } as LatePaymentEffect;
    const runner = (found: LatePaymentEffect | null) => ({ runOdds: async () => FAKE, latePaymentEffect: async () => found });
    expect(await commandExecutor(() => runner(effect))('late_payment_effect', {})).toEqual({ ok: true, result: { late_payment: effect } });
    const nothingHeld = { ok: false, result: { message: 'No payment is holding work in this plan.' } };
    expect(await commandExecutor(() => runner(null))('late_payment_effect', {})).toEqual(nothingHeld);
    expect(await commandExecutor(() => ({ runOdds: async () => FAKE }))('late_payment_effect', {})).toEqual(nothingHeld);
    expect(await commandExecutor(() => null)('late_payment_effect', {})).toMatchObject({ ok: false, result: { message: 'The plan is not open in this browser.' } });
  });

  it('sends back the panel’s own answer, in the shape the agent reads', async () => {
    const project = createProjectModel();
    await loadProjectInlineData(project, structuredClone(harborOffices.inlineData) as never);
    const controller = new OddsController(project, { today: () => TODAY, yieldNow: quick, assumptions: { ...DEFAULT_ASSUMPTIONS, runs: 200 }, maxSteps: 2 });
    controllers.push(controller);
    const state = await controller.answerFresh('payRun');
    const summary = oddsSummary(state);
    expect(OddsSummary.parse(summary)).toEqual(summary);
    expect(AgentCommandResult.parse({ odds: summary })).toEqual({ odds: summary });
    expect(JSON.stringify({ odds: summary }).length).toBeLessThan(8_192);
    expect(summary).toMatchObject({ contract_date: '2027-06-11', contract_from: 'deadline', planned_handover: '2027-05-27', runs: 200, seed: 7, pay: 'pay_run' });
    // The same numbers as the panel: the answer's own runs, and the pay step for paying when due.
    expect([summary.on_time, summary.odds]).toEqual([state.now!.onTime, state.now!.odds]);
    const payStep = state.ladder.find((step) => step.action?.kind === 'pay')!;
    expect(summary.paid_when_due).toMatchObject({ on_time: payStep.simulation.onTime, odds: payStep.simulation.odds });
    // Paying on time alone no longer reaches eight in ten, so the search goes on to Saturdays.
    expect(summary.ladder.map((step) => step.step)).toEqual(['Now, holds paid on the Friday pay run', 'Pay for Footings when it falls due', 'Saturdays on Slab on grade']);
    expect(summary.threats[0]?.name).toBe('Erect steel and metal deck');
    expect(summary.holds[0]).toMatchObject({ name: 'Footings paid on the Friday pay run' });
    expect(summary.assumptions).toBe(assumptionWords(state.plan, state.assumptions));
    expect(summary.assumptions).toContain('Saturdays at 1.5× of $65 an hour, loaded');
  }, 120_000);
});

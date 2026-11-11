/**
 * What a finished run of the odds gave, for whoever asked from elsewhere (Remy, through the assistant's command
 * channel): the same numbers the panel shows, taken from the same runs, with the assumptions line the panel shows.
 * Nothing is worked out here that the runs did not give.
 */
import { DateHelper } from '@bryntum/gantt';
import type { OddsSummary } from '@collab/shared';
import { wholeMoney } from '../gantt/look';
import { KIND_WORDS, dateOfDay, type OddsAssumptions, type OddsPlan, type WorkKind } from '../gantt/monte-carlo';
import { actionWords } from '../gantt/monte-carlo-optimizer';
import type { OddsState } from './odds-controller';

const isoDay = (day: number) => DateHelper.format(dateOfDay(day), 'YYYY-MM-DD');
const count = (value: number) => value.toLocaleString('en-US');

/** The assumptions in one line, as the panel shows them: the ranges of the kinds of work in the plan, Saturdays, runs, seed. */
export function assumptionWords(plan: OddsPlan | null, assumptions: OddsAssumptions): string {
  const kinds: WorkKind[] = plan?.kinds.length ? plan.kinds : ['winter', 'indoor'];
  const ranges = kinds.map((kind) => {
    const range = assumptions.ranges[kind];
    return `${KIND_WORDS[kind]} ${Math.round(range.low * 100)}–${Math.round(range.high * 100)}%`;
  });
  const rate = `Saturdays at ${assumptions.saturdayPremium}× of ${wholeMoney(assumptions.hourlyRate * 100, 'USD')} an hour, loaded`;
  return [...ranges, rate, `${count(assumptions.runs)} runs`, `seed ${assumptions.seed}`].join(' · ');
}

/** The summary of a finished answer; throws when there is none. */
export function oddsSummary(state: OddsState): OddsSummary {
  const { now, plan, ladder, threats, holds, assumptions } = state;
  if (!now || !plan || !state.complete) throw new Error('The odds have not finished running.');
  const payStep = ladder.find((step) => step.action?.kind === 'pay') ?? null;
  const whenDue = assumptions.payPolicy === 'due' ? now : payStep?.simulation ?? null;
  return {
    contract_date: isoDay(plan.contractDay),
    contract_from: plan.contractFrom,
    planned_handover: plan.plannedDay !== null ? isoDay(plan.plannedDay) : null,
    runs: now.runs.length,
    seed: assumptions.seed,
    assumptions: assumptionWords(plan, assumptions).slice(0, 400),
    pay: assumptions.payPolicy === 'due' ? 'when_due' : 'pay_run',
    on_time: now.onTime,
    odds: now.odds,
    p50: isoDay(now.p50),
    p80: isoDay(now.p80),
    paid_when_due: whenDue && assumptions.payPolicy === 'payRun' ? { on_time: whenDue.onTime, odds: whenDue.odds, p50: isoDay(whenDue.p50), p80: isoDay(whenDue.p80) } : null,
    holds: holds.slice(0, 4).map((hold) => ({ name: `${hold.name} on the Friday pay run`.slice(0, 160), days_later_p50: hold.days, days_later_p80: hold.p80Days, points: Math.round(hold.points * 10) / 10 })),
    threats: threats.slice(0, 5).map((threat) => ({ name: threat.name.slice(0, 160), correlation: Math.round(threat.correlation * 100) / 100 })),
    ladder: ladder.slice(0, 6).map((step) => ({
      step: (step.action ? actionWords(step.action) : assumptions.payPolicy === 'due' ? 'Now, holds paid when due' : 'Now, holds paid on the Friday pay run').slice(0, 200),
      on_time: step.simulation.onTime,
      odds: step.simulation.odds,
      p50: isoDay(step.simulation.p50),
      cost_minor: Math.round(step.costMinor),
      saturdays: Math.round(step.saturdays * 10) / 10,
    })),
    on_copy: now.onCopy,
  };
}

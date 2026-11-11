/**
 * The odds (`schedule_odds`): the plan run a thousand times on Bryntum's scheduling engine, in the browser of the
 * person who asked, a marble for each run falling on the board in their odds panel. Only a browser has the engine, so
 * the agent files a command for that person (their tab claims it, apps/web/src/odds/odds-command.ts) and reads back
 * what the runs gave.
 * The model gets those numbers with ready words; it never works one out, and never makes one up.
 */
import { LatePaymentEffect, OddsPayRule, OddsSummary } from '@collab/shared';
import { z } from 'zod';
import { day, usd } from '../plan/format';
import type { CommandOutcome } from './commands';
import { ToolRefusal } from './refusal';

/** What runs a command in a person's browser (the project's CommandRunner). */
export interface CommandPort {
  run(
    type: 'schedule_odds' | 'late_payment_effect' | 'ui_action',
    args: unknown,
    requestedBy: string,
    requiredRevision: number | null,
    options?: { timeoutMs?: number; claimTimeoutMs?: number },
  ): Promise<CommandOutcome>;
}

/** The runs take a few seconds, and the ways forward a few more. */
export const ODDS_TIMEOUT_MS = 90_000;

export const OddsToolSchemas = {
  schedule_odds: z.object({
    pay: OddsPayRule.nullish().describe(
      'How the payment holds are paid in the runs: pay_run (on the Friday pay run) or when_due (each the day it falls due). Leave it out to keep the setting the person has.',
    ),
  }),
  late_payment_effect: z.object({}),
};
export type OddsToolName = keyof typeof OddsToolSchemas;

export const ODDS_TOOL_DESCRIPTIONS: Record<OddsToolName, string> = {
  late_payment_effect:
    'What waiting for the Friday pay run would do to the work a payment holds, from the scheduling engine in the browser, which also draws on the chart where that work would go: when the held work would start, what it would have to wait out on its own calendar (waits_for: an inspector away, say), and when the handover would move to. Use it when someone asks what waiting or paying late would do, unless they ask about the odds or the deadline.',
  schedule_odds:
    'Run the plan a thousand times on the scheduling engine, in the browser of the person who asked, a marble for each run falling on the board in their odds panel: the chance of handing over by the contract date, the days half and eight in ten of the runs hand over by, the chance with every payment hold paid when it falls due, what moves the handover most, and the ways forward with what each costs. Use it when they ask about the odds, the chances, how likely the date is, or what threatens it. It takes a few seconds; say you are running it first. Every number in its answer comes from the runs: say those, as given, and the assumptions they rest on when asked.',
};

export const isOddsTool = (name: string): name is OddsToolName => name in OddsToolSchemas;

export interface OddsToolContext {
  speaker: { userId: string; name: string } | null;
  plan: { revision: number };
  commands?: CommandPort;
}

const percent = (odds: number) => (odds > 0 && odds < 0.01 ? `${(odds * 100).toFixed(1)}%` : `${Math.round(odds * 100)}%`);

const TIMES = ['', 'one time', 'two times', 'three times', 'four times', 'five times', 'six times', 'seven times', 'eight times', 'nine times'];

/** How often the date is made, as a colleague says it on a call: "about half the time", "about three times out of four", "about eight times out of ten". */
export function oddsWords(odds: number): string {
  if (odds < 0.01) return 'almost never';
  if (odds > 0.99) return 'almost every time';
  if (odds >= 0.45 && odds <= 0.55) return 'about half the time';
  // What the board's percent reads as: 75% said as "eight out of ten" would not match the screen.
  if (odds >= 0.73 && odds <= 0.77) return 'about three times out of four';
  if (odds >= 0.23 && odds <= 0.27) return 'about one time out of four';
  return `about ${TIMES[Math.max(1, Math.min(9, Math.round(odds * 10)))]} out of ten`;
}

const lateDay = (iso: string | null) => (iso ? day(iso) : null);

async function runLatePaymentEffect(ctx: OddsToolContext): Promise<unknown> {
  if (!ctx.speaker) throw new ToolRefusal('Only someone in the plan can ask this: the engine runs in that person’s browser.');
  if (!ctx.commands) throw new ToolRefusal('That can’t be worked out from here right now.');
  const outcome = await ctx.commands.run('late_payment_effect', {}, ctx.speaker.userId, ctx.plan.revision, { timeoutMs: 30_000 });
  if (outcome.status !== 'succeeded') return { ran: false, message: outcome.message };
  const effect = LatePaymentEffect.safeParse(outcome.row.result?.late_payment);
  if (!effect.success) return { ran: false, message: 'The browser answered without the forecast.' };
  const e = effect.data;
  return {
    ran: true,
    held: e.held,
    paid_on: day(e.paid_on),
    starts_on_time: lateDay(e.starts_on_time),
    starts_if_late: lateDay(e.starts_if_late),
    handover_on_time: lateDay(e.handover_on_time),
    handover_if_late: lateDay(e.handover_if_late),
    handover_moves_calendar_days: e.handover_on_time && e.handover_if_late ? Math.round((Date.parse(e.handover_if_late.slice(0, 10)) - Date.parse(e.handover_on_time.slice(0, 10))) / 86_400_000) : null,
    slip_days: e.slip_days,
    holidays_in_the_way: e.holidays,
    waits_for: e.waits_for ? { task: e.waits_for.task, why: e.waits_for.why, from: day(e.waits_for.from), until: day(e.waits_for.until), now_on: day(e.waits_for.now_on) } : null,
  };
}

export async function runOddsTool(name: OddsToolName, rawArgs: unknown, ctx: OddsToolContext): Promise<unknown> {
  if (name === 'late_payment_effect') return runLatePaymentEffect(ctx);
  const parsed = OddsToolSchemas.schedule_odds.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  if (!ctx.speaker) throw new ToolRefusal('Only someone in the plan can have the odds run: they run in that person’s browser.');
  if (!ctx.commands) throw new ToolRefusal('The odds can’t be run from here right now.');
  const outcome = await ctx.commands.run('schedule_odds', parsed.data.pay ? { pay: parsed.data.pay } : {}, ctx.speaker.userId, ctx.plan.revision, { timeoutMs: ODDS_TIMEOUT_MS });
  if (outcome.status !== 'succeeded') return { ran: false, message: outcome.message };
  const summary = OddsSummary.safeParse(outcome.row.result?.odds);
  if (!summary.success) return { ran: false, message: 'The browser answered without the odds.' };
  const odds = summary.data;
  const handedOver = (onTime: number) => `${onTime.toLocaleString('en-US')} of ${odds.runs.toLocaleString('en-US')} runs`;
  return {
    ran: true,
    question: `a thousand runs: the plan run ${odds.runs.toLocaleString('en-US')} times on the scheduling engine in ${ctx.speaker.name}'s browser, every task's length drawn from the assumptions, a marble for each on the board on their screen`,
    contract: { date: odds.contract_date, text: day(odds.contract_date), from: odds.contract_from },
    plan_alone: odds.planned_handover ? { handover: odds.planned_handover, text: day(odds.planned_handover), note: 'the plan as drawn, with no dice' } : null,
    pay: odds.pay,
    odds: { on_time: odds.on_time, runs: odds.runs, percent: percent(odds.odds), words: oddsWords(odds.odds), text: `On time in ${handedOver(odds.on_time)}, ${percent(odds.odds)}` },
    half_by: day(odds.p50),
    eight_in_ten_by: day(odds.p80),
    paid_when_due: odds.paid_when_due
      ? {
          on_time: odds.paid_when_due.on_time,
          percent: percent(odds.paid_when_due.odds),
          words: oddsWords(odds.paid_when_due.odds),
          half_by: day(odds.paid_when_due.p50),
          eight_in_ten_by: day(odds.paid_when_due.p80),
          text: `Paid when due: on time in ${handedOver(odds.paid_when_due.on_time)}, ${percent(odds.paid_when_due.odds)}`,
        }
      : null,
    holds: odds.holds.map((hold) => ({ name: hold.name, text: `half the runs hand over ${hold.days_later_p50} days later, eight in ten ${hold.days_later_p80} days later` })),
    threats: odds.threats.map((threat) => ({ task: threat.name, how_closely_the_handover_follows_it: percent(threat.correlation) })),
    ways_forward: odds.ladder.map((step) => ({
      step: step.step,
      odds: percent(step.odds),
      words: oddsWords(step.odds),
      half_by: day(step.p50),
      adds: step.cost_minor > 0 ? `${usd(step.cost_minor)} more` : 'nothing extra',
      ...(step.saturdays > 0 ? { saturdays: step.saturdays } : {}),
    })),
    assumptions: odds.assumptions,
    ...(odds.on_copy ? { note: 'Someone changed the plan while the runs went: they answer for the plan as it was when asked.' } : {}),
  };
}

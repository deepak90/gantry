/**
 * The odds, asked for by the assistant (Remy's `schedule_odds`): this browser opens the odds panel, runs the plan a
 * thousand times on its scheduling engine with the marbles pouring onto the board (or the dots falling), and reports
 * what the runs gave. The numbers Remy says come from here and nowhere else.
 */
import { ScheduleOddsArgs, type AgentCommandResult, type AgentCommandType, type LatePaymentEffect, type OddsSummary } from '@collab/shared';
import type { PayPolicy } from '../gantt/monte-carlo';
import type { CommandExecutor } from '../assistant/agent-commands';

/** What runs the odds here: the workspace's (GanttWorkspaceApi.runOdds). */
export interface OddsRunner {
  runOdds(pay?: PayPolicy): Promise<OddsSummary>;
  /** What waiting for the Friday pay run would do (null: no payment holds work). */
  latePaymentEffect?(): Promise<LatePaymentEffect | null>;
}

export async function runScheduleOdds(runner: OddsRunner, args: unknown): Promise<{ ok: boolean; result: AgentCommandResult }> {
  const parsed = ScheduleOddsArgs.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, result: { message: 'The request for the odds was not one this browser understands.' } };
  const pay: PayPolicy | undefined = parsed.data.pay === 'pay_run' ? 'payRun' : parsed.data.pay === 'when_due' ? 'due' : undefined;
  const odds = await runner.runOdds(pay);
  return { ok: true, result: { odds } };
}

/** The commands this browser carries out, given what runs the odds (null: no plan on screen here). */
export function commandExecutor(runner: () => OddsRunner | null): CommandExecutor {
  return async (type: AgentCommandType, args: unknown) => {
    if (type !== 'schedule_odds' && type !== 'late_payment_effect') return { ok: false, result: { message: 'This browser no longer carries that out.' } };
    const odds = runner();
    if (!odds) return { ok: false, result: { message: 'The plan is not open in this browser.' } };
    if (type === 'schedule_odds') return runScheduleOdds(odds, args);
    const effect = await odds.latePaymentEffect?.();
    return effect ? { ok: true, result: { late_payment: effect } } : { ok: false, result: { message: 'No payment is holding work in this plan.' } };
  };
}

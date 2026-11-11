/**
 * The odds board, explained in two plain lines (the panel shows them over and under the board): what was run and what
 * a marble is; then what this board's percent and date mean, how it pays the payments that hold work, and the step the
 * ways forward suggest, with its own odds. Only words: every number is the runs' own (odds/odds-controller.ts).
 */
import { dayWords, type OddsPlan } from '../gantt/monte-carlo';
import { actionWords, type LadderStep, type OddsAction } from '../gantt/monte-carlo-optimizer';
import type { OddsView } from './odds-board';
import type { OddsState } from './odds-controller';

export interface OddsExplained {
  /** What was run, and what each marble (or dot) on the board is. */
  about: string;
  /** What this board's percent and date mean, and the step to take; null while the runs go. */
  says: string | null;
  /** The step of the ways forward the suggestion stands for, whose runs can be shown on the board; null for none. */
  step: number | null;
}

/** The optimizer's aim: at these odds nothing more is looked for (gantt/monte-carlo-optimizer.ts `waysForward`). */
const ON_TRACK = 0.8;

const pct = (value: number) => (value > 0 && value < 0.01 ? (value * 100).toFixed(1) : Math.round(value * 100).toString());
const count = (value: number) => value.toLocaleString('en-US');

/** The day, and where it comes from. */
export function deadlineWords(plan: OddsPlan): string {
  const day = dayWords(plan.contractDay);
  if (plan.contractFrom === 'baseline') return `${day}, the date first planned`;
  if (plan.contractFrom === 'plan') return `${day}, the date in the plan`;
  return `${day}, the contract date`;
}

/** "A", "A and B", "A, B and C". */
function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

type PayAction = Extract<OddsAction, { kind: 'pay' }>;

/** The first steps of the ways forward that pay a hold when it falls due, and the last of them (all paid by then). */
function payingSteps(ladder: readonly LadderStep[]): { names: string[]; last: number } | null {
  const names: string[] = [];
  let last = -1;
  for (let index = 1; index < ladder.length; index += 1) {
    const action = ladder[index]!.action;
    if (action?.kind !== 'pay') break;
    names.push((action as PayAction).hold.pays);
    last = index;
  }
  return last > 0 ? { names, last } : null;
}

export function explainOdds(state: OddsState, view: OddsView): OddsExplained {
  const { plan, now, ladder, previewing, assumptions, phase, progress } = state;
  const running = phase === 'running';
  const runs = now && !running ? now.runs.length : progress.total || assumptions.runs;
  const piece = view === 'board' ? 'marble' : 'dot';
  const about = `The plan, run ${count(runs)} times on the scheduling engine, each task taking a little more or less time, the way its kind of work does. Each ${piece} is one run, on the day it hands over.`;
  if (!plan || !now || running) return { about, says: null, step: null };

  // A way forward on show (its name is over the board): what its runs say.
  const shownStep = previewing !== null ? ladder[previewing] : undefined;
  if (shownStep?.action) return { about, says: `${previewing === 1 ? 'With that step' : 'With those steps'}, ${pct(shownStep.simulation.odds)}% hand over by ${deadlineWords(plan)}.`, step: null };

  const how = plan.holds.length === 0 ? '' : assumptions.payPolicy === 'payRun' ? 'If payments wait for the Friday pay run, ' : 'If payments go out when due, ';
  const says = `${how}${pct(now.odds)}% hand over by ${deadlineWords(plan)}.`;

  const paying = assumptions.payPolicy === 'payRun' ? payingSteps(ladder) : null;
  if (paying) {
    const when = paying.names.length === 1 ? 'when it falls due' : 'when they fall due';
    return { about, says: `${says} Pay for ${listWords(paying.names)} ${when}, with PayPal, and it’s ${pct(ladder[paying.last]!.simulation.odds)}%.`, step: paying.last };
  }
  const first = ladder[1];
  if (first?.action?.kind === 'saturdays') {
    return { about, says: `${says} Work ${actionWords(first.action)} and it’s ${pct(first.simulation.odds)}%.`, step: 1 };
  }
  if (phase !== 'done') return { about, says, step: null };
  return { about, says: `${says} ${now.odds >= ON_TRACK ? 'Nothing more is needed to make the date.' : 'Nothing on the list of ways forward raises it.'}`, step: null };
}

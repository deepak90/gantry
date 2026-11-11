/**
 * Ways forward: a greedy search over actions the plan really supports, each tried on the scheduling engine. The
 * actions are the ones a builder has: pay a hold when it falls due instead of on the Friday pay run (through PayPal,
 * no extra cost), and work Saturdays on a part of the plan (the plan's own Monday-to-Saturday calendar), which costs
 * a premium on each Saturday actually worked.
 *
 * Each step tries every action left on a sample of the runs that miss the contract date (an action can only bring
 * a run earlier, so a run already on time stays on time and tells nothing), keeps the one with the best gain in odds
 * per dollar, and then runs all the runs again with it, so the odds each step shows come from complete runs with
 * the action applied, not from the sample. It stops at the target odds, or when nothing helps.
 */
import type { ProjectModel, TaskModel } from '@bryntum/gantt';
import { withoutFilters } from './filters';
import { saturdayCalendar } from './late-payment';
import { paymentLocks } from './payment-lock';
import { runProjectTransaction } from '../scenario/publish';
import {
  OddsError,
  payDayFor,
  policyOf,
  simulate,
  workLeft,
  yieldToBrowser,
  type HoldLever,
  type Id,
  type OddsAssumptions,
  type OddsPlan,
  type OddsQuestion,
  type OddsScenario,
  type SimulateOptions,
  type Simulation,
} from './monte-carlo';

export type OddsAction = { kind: 'pay'; id: Id; hold: HoldLever } | { kind: 'saturdays'; id: Id; name: string; tasks: number };

export interface LadderStep {
  /** null: the plan as it stands, paid by the person's rule. */
  action: OddsAction | null;
  /** Everything up to and including this step. */
  scenario: OddsScenario;
  simulation: Simulation;
  /** What this step adds, in minor units: its Saturday premium, averaged over its runs. A payment adds nothing. */
  costMinor: number;
  /** Saturdays worked on this step's part of the plan, averaged over its runs. */
  saturdays: number;
}

export interface LadderOptions extends Pick<SimulateOptions, 'sliceMs' | 'yieldNow' | 'signal'> {
  /** Stop once the odds reach this (0.8). */
  target?: number;
  /** At most this many steps after "now". */
  maxSteps?: number;
  /** Late runs each action is tried on before one is chosen. */
  sampleRuns?: number;
  /** A step must add at least this much to the odds to count (half a point). */
  minGain?: number;
  onStep?: (ladder: readonly LadderStep[]) => void;
  /** What is being tried, in words, and how far along the whole search is (0 to 1, roughly). */
  onProgress?: (words: string, share: number) => void;
}

interface TreeNode {
  isLeaf: boolean;
  isRoot?: boolean;
  children?: TaskModel[] | boolean;
}
const childrenOf = (task: TaskModel): TaskModel[] => {
  const children = (task as unknown as TreeNode).children;
  return Array.isArray(children) ? children : [];
};

const calendarIdOf = (task: TaskModel) => ((task as unknown as { calendar?: { id?: unknown } | null }).calendar?.id ?? null) as unknown;
const remainingDays = (tasks: readonly TaskModel[]) =>
  tasks.reduce((sum, task) => sum + (typeof task.duration === 'number' ? task.duration : 0) * (1 - (typeof task.percentDone === 'number' ? task.percentDone : 0) / 100), 0);

/**
 * The parts of the plan Saturdays could go on: each group of tasks (a slab, a deck, a floor's build-out), and each
 * long task that sits on its own in a phase (the steel).
 */
export function saturdayParts(plan: OddsPlan): { row: TaskModel; tasks: TaskModel[] }[] {
  const root = (plan.project.taskStore as unknown as { rootNode: TaskModel }).rootNode;
  const parts: { row: TaskModel; tasks: TaskModel[] }[] = [];
  const consider = (row: TaskModel, minDays: number) => {
    const tasks = workLeft(row);
    if (tasks.length === 0 || remainingDays(tasks) < minDays) return;
    // Already on the Saturday calendar in the plan: nothing to add.
    if (plan.saturdays && tasks.every((task) => calendarIdOf(task) === plan.saturdays!.id)) return;
    parts.push({ row, tasks });
  };
  const visit = (node: TaskModel) => {
    const children = childrenOf(node);
    if (node !== root && children.length > 0 && children.every((child) => (child as unknown as TreeNode).isLeaf)) {
      consider(node, 2);
      return;
    }
    for (const child of children) {
      if ((child as unknown as TreeNode).isLeaf) {
        if (node !== root) consider(child, 5);
      } else visit(child);
    }
  };
  visit(root);
  return parts;
}

/** The actions left to try on top of a scenario. */
export function actionsFor(plan: OddsPlan, assumptions: OddsAssumptions, scenario: OddsScenario): OddsAction[] {
  const actions: OddsAction[] = [];
  for (const hold of plan.holds) {
    if (policyOf(hold, scenario, assumptions) !== 'payRun' || hold.dueDay === null) continue;
    // Due on a pay-run day anyway: paying when due changes nothing.
    if (payDayFor('payRun', hold.dueDay, plan.todayDay) === payDayFor('due', hold.dueDay, plan.todayDay)) continue;
    actions.push({ kind: 'pay', id: hold.id, hold });
  }
  if (plan.saturdays) {
    const taken = new Set(scenario.saturdays ?? []);
    for (const { row, tasks } of saturdayParts(plan)) {
      if (taken.has(row.id)) continue;
      actions.push({ kind: 'saturdays', id: row.id, name: row.name ?? 'This part of the plan', tasks: tasks.length });
    }
  }
  return actions;
}

/** A scenario with one more action in it. */
export function withAction(scenario: OddsScenario, action: OddsAction): OddsScenario {
  if (action.kind === 'pay') {
    const pay = new Map(scenario.pay ?? []);
    pay.set(action.id, 'due');
    return { ...scenario, pay };
  }
  return { ...scenario, saturdays: [...(scenario.saturdays ?? []), action.id] };
}

const stepOf = (action: OddsAction | null, scenario: OddsScenario, simulation: Simulation): LadderStep => {
  const saturdays = action?.kind === 'saturdays' ? simulation.saturdays.get(action.id) : undefined;
  return { action, scenario, simulation, costMinor: saturdays?.premiumMinor ?? 0, saturdays: saturdays?.days ?? 0 };
};

export function actionWords(action: OddsAction): string {
  return action.kind === 'pay' ? `Pay for ${action.hold.pays} when it falls due` : `Saturdays on ${action.name}`;
}

/**
 * The ladder: "now", then each action that helps most per dollar, until the odds reach the target or nothing helps.
 * Resolves to the whole ladder (also handed to `onStep` as each step lands).
 */
export async function waysForward(question: OddsQuestion, assumptions: OddsAssumptions, now: Simulation, options: LadderOptions = {}): Promise<LadderStep[]> {
  const target = options.target ?? 0.8;
  const maxSteps = options.maxSteps ?? 4;
  const sampleRuns = options.sampleRuns ?? 30;
  const minGain = options.minGain ?? 0.005;
  const contractDay = question.live.contractDay;
  const sim = (scenario: OddsScenario, extra: SimulateOptions = {}) =>
    simulate(question, assumptions, scenario, { sliceMs: options.sliceMs, yieldNow: options.yieldNow, signal: options.signal, ...extra });
  const ladder: LadderStep[] = [stepOf(null, now.scenario, now)];
  let tried = new Set<string>();
  const keyOf = (action: OddsAction) => `${action.kind}:${String(action.id)}`;

  while (ladder.length <= maxSteps) {
    const last = ladder[ladder.length - 1]!;
    if (last.simulation.odds >= target) break;
    const plan = await question.plan(options.yieldNow ?? yieldToBrowser);
    const actions = actionsFor(plan, assumptions, last.scenario).filter((action) => !tried.has(keyOf(action)));
    if (actions.length === 0) break;
    const share = (phase: number) => Math.min(0.99, (ladder.length - 1 + phase) / maxSteps);

    // Payments first: they cost nothing, so any gain beats any Saturday. Each is checked with every run.
    const pay = actions.find((action) => action.kind === 'pay');
    let chosen: { action: OddsAction; simulation: Simulation } | null = null;
    if (pay) {
      options.onProgress?.(`Checking ${actionWords(pay)} with every run`, share(0.1));
      const simulation = await sim(withAction(last.scenario, pay));
      tried.add(keyOf(pay));
      if (simulation.odds - last.simulation.odds >= minGain || simulation.p50 < last.simulation.p50) chosen = { action: pay, simulation };
    } else {
      // Saturdays: tried on runs that miss the date, best gain per dollar first.
      const late: number[] = [];
      for (let i = 0; i < last.simulation.days.length && late.length < sampleRuns; i += 1) {
        if (last.simulation.days[i]! > contractDay) late.push(last.simulation.runs[i]!);
      }
      if (late.length === 0) break;
      const lateDays = new Map<number, number>();
      for (let i = 0; i < last.simulation.days.length; i += 1) lateDays.set(last.simulation.runs[i]!, last.simulation.days[i]!);
      const lateShare = 1 - last.simulation.odds;
      const scored: { action: OddsAction; points: number; days: number; cost: number }[] = [];
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index]!;
        options.onProgress?.(`Trying ${actionWords(action)}`, share(((index + 1) / actions.length) * 0.6));
        const sample = await sim(withAction(last.scenario, action), { runIndices: Int32Array.from(late) });
        let flips = 0;
        let daysGained = 0;
        for (let i = 0; i < sample.days.length; i += 1) {
          const day = sample.days[i]!;
          if (day <= contractDay) flips += 1;
          daysGained += (lateDays.get(sample.runs[i]!) ?? day) - day;
        }
        const cost = sample.saturdays.get(action.id)?.premiumMinor ?? 0;
        scored.push({ action, points: (flips / Math.max(1, sample.days.length)) * lateShare, days: daysGained / Math.max(1, sample.days.length), cost });
      }
      // Gain in odds per dollar; where no sampled run turns on time, days won per dollar.
      const worth = (entry: (typeof scored)[number]) => (entry.cost > 0 ? (entry.points > 0 ? 1e6 + entry.points / entry.cost : entry.days / entry.cost) : -1);
      const ranked = scored.filter((entry) => entry.cost > 0 && (entry.points > 0 || entry.days > 0)).sort((a, b) => worth(b) - worth(a));
      for (const entry of ranked.slice(0, 2)) {
        options.onProgress?.(`Checking ${actionWords(entry.action)} with every run`, share(0.8));
        const simulation = await sim(withAction(last.scenario, entry.action));
        tried.add(keyOf(entry.action));
        // It counts when it raises the odds, or (with odds near nothing) brings the middle run's handover earlier.
        if (simulation.odds - last.simulation.odds >= minGain || simulation.p50 < last.simulation.p50) {
          chosen = { action: entry.action, simulation };
          break;
        }
      }
      if (!chosen) break;
    }
    if (!chosen) {
      // The payment changed nothing here; Saturdays may still help.
      continue;
    }
    ladder.push(stepOf(chosen.action, withAction(last.scenario, chosen.action), chosen.simulation));
    tried = new Set([...tried].filter((key) => key.startsWith('pay:')));
    options.onStep?.(ladder);
  }
  options.onProgress?.('', 1);
  return ladder;
}

// ---------------------------------------------------------------------------------------------
// Applying a step
// ---------------------------------------------------------------------------------------------

/**
 * Puts the work left in a part of the plan on the plan's Monday-to-Saturday calendar, with the crews' own calendars
 * set aside, as one change for everyone (one revision) that one undo takes back. Resolves to how many tasks changed.
 */
export async function applySaturdays(project: ProjectModel, rowId: Id): Promise<number> {
  if ((project as ProjectModel & { readOnly?: boolean }).readOnly) throw new OddsError('This plan is read only here.');
  const saturdays = saturdayCalendar(project);
  if (!saturdays) throw new OddsError('The plan has no Monday-to-Saturday calendar.');
  const row = project.taskStore.getById(rowId) as TaskModel | undefined;
  if (!row) throw new OddsError('That part of the plan is no longer there.');
  const tasks = workLeft(row);
  const locked = tasks.find((task) => typeof task.id === 'number' && paymentLocks(project).has(task.id));
  if (locked) throw new OddsError(`“${locked.name}” is locked while PayPal pays for it.`);
  await withoutFilters(project, () =>
    runProjectTransaction(project, `Saturdays on ${row.name}`, () => {
      for (const task of tasks) task.set({ calendar: saturdays, ignoreResourceCalendar: true } as never);
    }),
  );
  return tasks.length;
}

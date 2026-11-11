/**
 * The odds panel's work, outside React: it asks the engine (gantt/monte-carlo.ts), keeps the answer and the ways
 * forward, drops the dots on the plot as the runs land, draws the odds on the chart, and asks again on its own when
 * PayPal's answer releases a hold, so the dots move because PayPal paid. A plan edit someone else makes doesn't
 * start a run; the panel says the answer is from before it.
 *
 * Every plot attached is told everything (the dot plot and the board both, whichever is on screen), so switching
 * between them is instant. A pass's runs start once the plots on screen are ready to show them as they land (the
 * board's physics loaded), so the first marbles don't pour out together.
 */
import type { CalendarModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import { readPayGate } from '@collab/shared';
import {
  DEFAULT_ASSUMPTIONS,
  OddsCanceledError,
  OddsQuestion,
  plannedRun,
  planSignature,
  simulate,
  taskThreats,
  yieldToBrowser,
  type Id,
  type OddsAssumptions,
  type OddsPlan,
  type PayPolicy,
  type Simulation,
  type TaskThreat,
  type ThreePoint,
  type WorkKind,
} from '../gantt/monte-carlo';
import { applySaturdays, waysForward, type LadderStep } from '../gantt/monte-carlo-optimizer';
import { gateFor } from '../gantt/pay-gates';
import { planClock } from '../plan-clock';
import { clearOddsOnChart, showOddsOnChart } from './chart-odds';
import type { PlotPass } from './dot-plot';

/** What a plot is told: the dot plot (odds/dot-plot.ts) and the board (odds/odds-board.ts). */
export interface PlotSink {
  begin(pass: PlotPass): void;
  land(landed: readonly { run: number; day: number }[]): void;
  end(runs: readonly number[]): void;
  /** `instant`: an answer already made, shown as it is (nothing falls: nothing is running). */
  show(runs: ArrayLike<number>, days: ArrayLike<number>, instant?: boolean): void;
  /**
   * Resolves when the plot can show runs the moment they land (the board: its physics loaded, with falls ready for
   * the first runs). Asked after `begin`; a pass's runs wait for every plot's, `READY_LIMIT_MS` at most. A plot that
   * isn't on screen resolves at once, so it holds nothing up.
   */
  ready?(): Promise<void>;
}

/** The longest the runs wait for the plots to be ready (a board whose physics won't load is not waited for longer). */
export const READY_LIMIT_MS = 4_000;

/** The same runs paid two ways, for the board's side by side ("Wait till Friday", "Pay today with PayPal"). */
export interface OddsComparison {
  wait: Simulation;
  pay: Simulation;
}

export type OddsPhase = 'idle' | 'running' | 'searching' | 'done' | 'error';
/** Why the runs are going: the panel says so. */
export type RunReason = 'opened' | 'again' | 'assumptions' | 'paid' | 'applied';

/** A hold the person's pay rule leaves on the Friday pay run, and what that costs against paying when it falls due. */
export interface HoldEffect {
  id: Id;
  name: string;
  /** Calendar days later the middle run hands over (P50) on the pay run, and P80's. */
  days: number;
  p80Days: number;
  /** Points of odds the pay run costs. */
  points: number;
}

export interface OddsState {
  phase: OddsPhase;
  reason: RunReason;
  assumptions: OddsAssumptions;
  plan: OddsPlan | null;
  /** Runs done in this pass, and the dots on screen: how many, how many on time (the counter reads these). */
  progress: { done: number; total: number; shown: number; onTime: number };
  now: Simulation | null;
  /** The answer before this one, when this one asks again (the odds moved from it). */
  before: { odds: number; onTime: number; runs: number; p50: number } | null;
  ladder: LadderStep[];
  searching: { words: string; share: number } | null;
  threats: TaskThreat[];
  holds: HoldEffect[];
  error: string | null;
  /** The plan has changed since the runs. */
  stale: boolean;
  askedAt: Date | null;
  runsPerSecond: number | null;
  /** The step of the ladder on show in the plot. */
  previewing: number | null;
  /** What PayPal just did, while the runs go again because of it. */
  paidNote: string | null;
  applying: Id | null;
  /** The last pass ran to the end (the ways forward included). */
  complete: boolean;
}

const STORAGE_KEY = 'collab.odds.v1';

function loadAssumptions(): OddsAssumptions {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ASSUMPTIONS;
    const saved = JSON.parse(raw) as Partial<OddsAssumptions>;
    const ranges = { ...DEFAULT_ASSUMPTIONS.ranges };
    for (const kind of Object.keys(ranges) as WorkKind[]) {
      const range = saved.ranges?.[kind] as Partial<ThreePoint> | undefined;
      if (range && [range.low, range.likely, range.high].every((value) => typeof value === 'number' && Number.isFinite(value))) ranges[kind] = range as ThreePoint;
    }
    return {
      ranges,
      runs: typeof saved.runs === 'number' && saved.runs >= 50 && saved.runs <= 5000 ? Math.round(saved.runs) : DEFAULT_ASSUMPTIONS.runs,
      seed: typeof saved.seed === 'number' && Number.isFinite(saved.seed) ? Math.round(saved.seed) : DEFAULT_ASSUMPTIONS.seed,
      saturdayPremium: typeof saved.saturdayPremium === 'number' && saved.saturdayPremium >= 1 && saved.saturdayPremium <= 3 ? saved.saturdayPremium : DEFAULT_ASSUMPTIONS.saturdayPremium,
      hourlyRate: typeof saved.hourlyRate === 'number' && saved.hourlyRate > 0 && saved.hourlyRate <= 500 ? saved.hourlyRate : DEFAULT_ASSUMPTIONS.hourlyRate,
      payPolicy: saved.payPolicy === 'due' || saved.payPolicy === 'payRun' ? saved.payPolicy : DEFAULT_ASSUMPTIONS.payPolicy,
    };
  } catch {
    return DEFAULT_ASSUMPTIONS;
  }
}

function saveAssumptions(assumptions: OddsAssumptions): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(assumptions));
  } catch {
    // A convenience only: the defaults come back next time.
  }
}

const sameRanges = (a: OddsAssumptions, b: OddsAssumptions) => JSON.stringify(a.ranges) === JSON.stringify(b.ranges) && a.seed === b.seed;

/** Whether the handover can fall on a day (the plan's own calendar), remembered per day. */
function workingDays(project: ProjectModel): (day: number) => boolean {
  const calendar = (project as unknown as { calendar?: CalendarModel }).calendar as unknown as { calculateDurationMs(start: Date, end: Date): number } | undefined;
  const known = new Map<number, boolean>();
  return (day) => {
    let working = known.get(day);
    if (working === undefined) {
      const utc = new Date(day * 86_400_000);
      const start = new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      working = calendar ? calendar.calculateDurationMs(start, end) > 0 : start.getDay() % 6 !== 0;
      known.set(day, working);
    }
    return !working;
  };
}

export interface OddsControllerOptions {
  /** Today: payments can't be made before it (default: the plan's today, plan-clock.ts). */
  today?: () => Date;
  /** How the browser gets its turn between slices (tests pass a plain promise). */
  yieldNow?: () => Promise<void>;
  /** The assumptions to start from, instead of the ones this browser kept. */
  assumptions?: OddsAssumptions;
  /** At most this many ways forward. */
  maxSteps?: number;
  /** The longest the runs wait for the plots to be ready (READY_LIMIT_MS when not given). */
  readyLimitMs?: number;
}

export class OddsController {
  private state: OddsState;
  private readonly listeners = new Set<() => void>();
  private readonly plots = new Set<PlotSink>();
  /** This pass as the plots were told it, and its runs landed so far: a plot attached part way through gets both. */
  private told: PlotPass | null = null;
  private landed: { run: number; day: number }[] = [];
  /** How `now` paid the holds, and the answer from before PayPal paid (for `comparison`). */
  private nowPolicy: PayPolicy | null = null;
  private beforePaid: Simulation | null = null;
  private question: OddsQuestion | null = null;
  private abort: AbortController | null = null;
  private pass = 0;
  private open = false;
  private readonly detachers: (() => void)[] = [];
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private progressAt = 0;

  private readonly today: () => Date;
  private readonly yieldNow: () => Promise<void>;
  private readonly maxSteps: number | undefined;
  private readonly readyLimitMs: number;

  constructor(
    private readonly project: ProjectModel,
    options: OddsControllerOptions = {},
  ) {
    this.today = options.today ?? planClock.now;
    this.yieldNow = options.yieldNow ?? yieldToBrowser;
    this.maxSteps = options.maxSteps;
    this.readyLimitMs = options.readyLimitMs ?? READY_LIMIT_MS;
    this.state = {
      phase: 'idle',
      reason: 'opened',
      assumptions: options.assumptions ?? loadAssumptions(),
      plan: null,
      progress: { done: 0, total: 0, shown: 0, onTime: 0 },
      now: null,
      before: null,
      ladder: [],
      searching: null,
      threats: [],
      holds: [],
      error: null,
      stale: false,
      askedAt: null,
      runsPerSecond: null,
      previewing: null,
      paidNote: null,
      applying: null,
      complete: false,
    };
    // PayPal's answer, from this browser or another: a hold marked paid releases its work, and the odds move. A
    // revision from another browser sets the gate without an update event of its own, so each hold's state is
    // compared whenever the engine has new results.
    this.gateStates = this.readGateStates();
    const detachReady = project.on('dataReady', () => {
      this.checkPaid();
      this.checkStale();
    }) as unknown as (() => void) | undefined;
    if (detachReady) this.detachers.push(detachReady);
  }

  private gateStates: Map<Id, string>;

  private readGateStates(): Map<Id, string> {
    const states = new Map<Id, string>();
    if (this.project.isDestroyed) return states;
    for (const task of this.project.taskStore.allRecords as TaskModel[]) {
      if (!task.isMilestone) continue;
      const gate = readPayGate((task as unknown as { payGate?: unknown }).payGate);
      if (gate) states.set(task.id, gate.state);
    }
    return states;
  }

  private checkPaid(): void {
    const before = this.gateStates;
    const now = this.readGateStates();
    this.gateStates = now;
    for (const [id, state] of now) {
      if (state === 'paid' && before.get(id) !== 'paid') {
        const record = this.project.taskStore.getById(id) as TaskModel | undefined;
        if (record) this.onPaid(record);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // For React
  // -------------------------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): OddsState => this.state;

  private set(patch: Partial<OddsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * A plot, while it is in the panel (the dot plot, the board): it is shown the answer there is, or, part way through
   * a pass, the runs landed so far, and from then on everything the others are told.
   */
  attachPlot(sink: PlotSink): () => void {
    this.plots.add(sink);
    const { now, plan, assumptions } = this.state;
    if (now && plan && this.state.phase !== 'running') {
      sink.begin({ fresh: true, total: now.runs.length, contractDay: plan.contractDay, plannedDay: plan.plannedDay, nonWorking: workingDays(this.project) });
      const step = this.state.previewing !== null ? this.state.ladder[this.state.previewing] : null;
      const shown = step?.simulation ?? now;
      sink.show(shown.runs, shown.days, true);
    } else if (this.state.phase === 'running' && plan) {
      sink.begin({ ...(this.told ?? { total: assumptions.runs, contractDay: plan.contractDay, plannedDay: plan.plannedDay, nonWorking: workingDays(this.project) }), fresh: true });
      if (this.landed.length > 0) sink.land([...this.landed]);
    }
    return () => {
      this.plots.delete(sink);
    };
  }

  /**
   * The same runs paid two ways, for the board's side by side: while the holds wait for the Friday pay run, this
   * answer against the last of its ways forward that pays one (every hold then paid when due); once PayPal has paid,
   * the answer from before against this one. Null when there is neither.
   */
  comparison(): OddsComparison | null {
    const { now, ladder } = this.state;
    if (!now) return null;
    if (this.nowPolicy === 'payRun') {
      let paid: Simulation | null = null;
      for (const step of ladder.slice(1)) {
        if (step.action?.kind !== 'pay') break;
        paid = step.simulation;
      }
      if (paid) return { wait: now, pay: paid };
    }
    return this.beforePaid ? { wait: this.beforePaid, pay: now } : null;
  }

  // -------------------------------------------------------------------------------------------
  // What the panel asks for
  // -------------------------------------------------------------------------------------------

  /** The panel opened: an answer that is still true is shown again, else the runs go. */
  show(): void {
    this.open = true;
    const { now, plan, complete } = this.state;
    if (now && plan && complete && !this.state.stale) {
      this.drawChart();
      return;
    }
    if (this.state.phase === 'running' || this.state.phase === 'searching') return;
    void this.run(now ? 'again' : 'opened', { morph: Boolean(now) });
  }

  /** The panel closed: the runs stop and the chart is left as it was. */
  hide(): void {
    this.open = false;
    this.cancel();
    this.question?.close();
    this.question = null;
    clearOddsOnChart();
    // A pass cut short leaves what it had; the next opening runs again.
    if (this.state.phase === 'running' || this.state.phase === 'searching') this.set({ phase: this.state.now ? 'done' : 'idle', searching: null, complete: false });
  }

  runAgain(): void {
    void this.run('again', { morph: Boolean(this.state.now) });
  }

  /**
   * For someone who asked from elsewhere (Remy): the runs go again from an empty plot, so the board pours on screen,
   * paid by `pay` when given (the panel's switch moves with it). Resolves with the finished answer; rejects when the
   * runs were stopped (the panel closed, another pass started) or the engine could not answer.
   */
  async answerFresh(pay?: PayPolicy): Promise<OddsState> {
    if (pay && pay !== this.state.assumptions.payPolicy) {
      const next = { ...this.state.assumptions, payPolicy: pay };
      saveAssumptions(next);
      this.set({ assumptions: next });
    }
    await this.run('again', { morph: false });
    const state = this.state;
    if (state.phase === 'error') throw new Error(state.error ?? 'The engine could not answer.');
    if (state.phase !== 'done' || !state.complete || !state.now) throw new Error('The runs were stopped before they finished.');
    return state;
  }

  setAssumptions(next: OddsAssumptions): void {
    const before = this.state.assumptions;
    saveAssumptions(next);
    this.set({ assumptions: next });
    // The same dice paid another way, or the same ranges with more runs: the dots move. Other dice: they fall again.
    void this.run('assumptions', { morph: Boolean(this.state.now) && sameRanges(before, next) });
  }

  setPayPolicy(policy: PayPolicy): void {
    if (policy === this.state.assumptions.payPolicy) return;
    this.setAssumptions({ ...this.state.assumptions, payPolicy: policy });
  }

  /** Shows a step of the ladder in the plot (null: back to now). Nothing is run: its runs are there. */
  preview(index: number | null): void {
    const { now, ladder } = this.state;
    if (!now) return;
    const step = index === null ? null : ladder[index];
    const target = step && index !== 0 ? step.simulation : now;
    this.tell((plot) => plot.show(target.runs, target.days));
    this.set({ previewing: step && index !== 0 ? index : null });
  }

  /** Puts a Saturday step into the plan (one change, one undo), then asks again. */
  async apply(step: LadderStep): Promise<void> {
    if (step.action?.kind !== 'saturdays') return;
    this.set({ applying: step.action.id, error: null });
    try {
      await applySaturdays(this.project, step.action.id);
      await this.project.commitAsync();
      this.set({ applying: null });
      await this.run('applied', { morph: true });
    } catch (error) {
      this.set({ applying: null, error: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    this.cancel();
    clearOddsOnChart();
    clearTimeout(this.staleTimer);
    this.detachers.splice(0).forEach((detach) => detach());
    this.question?.close();
    this.question = null;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------
  // The runs
  // -------------------------------------------------------------------------------------------

  private cancel(): void {
    this.pass += 1;
    this.abort?.abort();
    this.abort = null;
  }

  /** Tells every plot: one that throws is reported, and the others are still told. */
  private tell(call: (plot: PlotSink) => void): void {
    for (const plot of [...this.plots]) {
      try {
        call(plot);
      } catch (error) {
        console.error('The odds plot failed:', error);
      }
    }
  }

  /** Every plot ready to show the runs as they land (PlotSink.ready), or the ready limit, whichever comes first. */
  private async plotsReady(): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const plot of this.plots) {
      try {
        const wait = plot.ready?.();
        if (wait) waits.push(wait.catch(() => undefined));
      } catch {
        // Not ready to say: not waited for.
      }
    }
    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.readyLimitMs);
    });
    try {
      await Promise.race([Promise.all(waits), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  private onPaid(record: TaskModel): void {
    if (!this.open || this.project.isDestroyed) return;
    const gate = gateFor(this.project, record);
    const pays = gate?.pays.map((row) => row.name).join(' and ');
    const holds = gate?.holds.map((row) => row.name).join(' and ');
    this.set({ paidNote: pays && holds ? `PayPal paid for ${pays}, so ${holds} can start. The plan is running again.` : 'PayPal paid: the hold is released. The plan is running again.' });
    void this.run('paid', { morph: Boolean(this.state.now) });
  }

  private checkStale(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      const { now, phase } = this.state;
      if (!now || phase === 'running' || this.project.isDestroyed) return;
      const stale = planSignature(this.project) !== now.signature;
      if (stale !== this.state.stale) this.set({ stale });
    }, 400);
  }

  private drawChart(): void {
    const { now, plan, threats } = this.state;
    if (!now || !plan || !this.open || !now.finishes) return;
    const chips = new Map<Id, { label: string; name: string }>();
    for (const threat of threats.slice(0, 3)) {
      const percent = Math.round(threat.correlation * 100);
      chips.set(threat.id, {
        label: `Moves the handover ${percent}%`,
        name: `${threat.name}: the runs where it took longer handed over later. Rank correlation with the handover over ${now.runs.length.toLocaleString('en-US')} runs: ${threat.correlation.toFixed(2)}.`,
      });
    }
    showOddsOnChart(this.project, { finishes: now.finishes, chips, handoverId: plan.handover.id, p10: now.p10, p50: now.p50, p90: now.p90, runs: now.runs.length });
  }

  /**
   * One pass: the question, the runs (the dots land as they finish), the threats, then the ways forward. A newer
   * pass, or closing the panel, stops this one.
   */
  async run(reason: RunReason, { morph }: { morph: boolean }): Promise<void> {
    this.cancel();
    this.told = null;
    this.landed = [];
    const pass = this.pass;
    const abort = new AbortController();
    this.abort = abort;
    const live = () => pass === this.pass && !abort.signal.aborted;
    const previous = this.state.now;
    const previousPolicy = this.nowPolicy;
    const assumptions = this.state.assumptions;
    this.set({
      phase: 'running',
      reason,
      error: null,
      stale: false,
      complete: false,
      ladder: [],
      holds: [],
      searching: null,
      previewing: null,
      progress: { done: 0, total: assumptions.runs, shown: morph && previous ? previous.runs.length : 0, onTime: morph && previous ? previous.onTime : 0 },
      before: morph && previous ? { odds: previous.odds, onTime: previous.onTime, runs: previous.runs.length, p50: previous.p50 } : null,
      ...(reason === 'paid' ? {} : { paidNote: null }),
    });
    if (!morph) clearOddsOnChart();
    try {
      this.question?.close();
      this.question = null;
      const question = await OddsQuestion.ask(this.project, { today: this.today(), yieldNow: this.yieldNow });
      if (!live()) {
        question.close();
        return;
      }
      this.question = question;
      const plan = question.live;
      let plannedDay = plan.plannedDay;
      try {
        plannedDay = plannedRun(plan, assumptions, {}).day;
      } catch {
        // The plan's own date is a fine start for the axis.
      }
      this.set({ plan, askedAt: question.askedAt });
      const told: PlotPass = { fresh: !morph, total: assumptions.runs, contractDay: plan.contractDay, plannedDay, nonWorking: workingDays(this.project) };
      this.told = told;
      this.landed = [];
      this.tell((plot) => plot.begin(told));
      // The runs start when the plots on screen can show them as they land: the dot plot at once, the board once its
      // physics is loaded (or after READY_LIMIT_MS).
      await this.plotsReady();
      if (!live()) return;
      await this.yieldNow();
      if (!live()) return;

      // The dots on screen, on time or not: what the counter says while they land or move.
      const onScreen = new Map<number, boolean>();
      if (morph && previous) previous.runs.forEach((run, index) => onScreen.set(run, previous.days[index]! <= plan.contractDay));
      let onTime = [...onScreen.values()].filter(Boolean).length;
      const now = await simulate(question, assumptions, {}, {
        finishes: true,
        lengths: true,
        // Room in each frame for the dots to be drawn: the page keeps the screen's pace while they fall.
        sliceMs: 12,
        yieldNow: this.yieldNow,
        signal: abort.signal,
        onProgress: (done, total, landed) => {
          if (!live()) return;
          for (const { run, day } of landed) {
            const was = onScreen.get(run);
            const is = day <= plan.contractDay;
            if (was !== is) onTime += (is ? 1 : 0) - (was ? 1 : 0);
            onScreen.set(run, is);
          }
          for (const item of landed) this.landed.push(item);
          this.tell((plot) => plot.land(landed));
          const at = performance.now();
          if (at - this.progressAt > 50 || done === total) {
            this.progressAt = at;
            this.set({ progress: { done, total, shown: onScreen.size, onTime } });
          }
        },
      });
      if (!live()) return;
      const runs = [...now.runs];
      this.tell((plot) => plot.end(runs));
      this.told = null;
      this.landed = [];
      this.nowPolicy = assumptions.payPolicy;
      this.beforePaid = reason === 'paid' && previous && previousPolicy === 'payRun' ? previous : null;
      const threats = taskThreats(plan, now, 5);
      this.set({ phase: 'searching', now, threats, runsPerSecond: now.runs.length / (now.ms / 1000), progress: { done: now.runs.length, total: now.runs.length, shown: now.runs.length, onTime: now.onTime } });
      this.drawChart();

      // The ways forward: payments first, then Saturdays, each checked with every run.
      const ladder = await waysForward(question, assumptions, now, {
        // Nothing falls meanwhile: longer slices, still well inside a frame a person would notice.
        sliceMs: 26,
        yieldNow: this.yieldNow,
        ...(this.maxSteps !== undefined ? { maxSteps: this.maxSteps } : {}),
        signal: abort.signal,
        onStep: (steps) => {
          if (live()) this.set({ ladder: [...steps], holds: holdEffects(steps) });
        },
        onProgress: (words, share) => {
          if (live()) this.set({ searching: words ? { words, share } : null });
        },
      });
      if (!live()) return;
      this.set({ phase: 'done', ladder, holds: holdEffects(ladder), searching: null, paidNote: null, stale: question.changedSince(), complete: true });
    } catch (error) {
      if (error instanceof OddsCanceledError || abort.signal.aborted || !live()) return;
      this.set({ phase: 'error', error: error instanceof Error ? error.message : String(error), searching: null });
    } finally {
      // The answer is kept; the question (its watch on the plan, any copy of it) is let go.
      if (live()) {
        this.question?.close();
        this.question = null;
      }
    }
  }
}

/** What each hold on the pay run costs, from the ladder's payment steps (the same runs, paid two ways). */
function holdEffects(ladder: readonly LadderStep[]): HoldEffect[] {
  const effects: HoldEffect[] = [];
  for (let i = 1; i < ladder.length; i += 1) {
    const step = ladder[i]!;
    if (step.action?.kind !== 'pay') continue;
    const before = ladder[i - 1]!.simulation;
    const after = step.simulation;
    effects.push({
      id: step.action.id,
      name: step.action.hold.name,
      days: before.p50 - after.p50,
      p80Days: before.p80 - after.p80,
      points: (after.odds - before.odds) * 100,
    });
  }
  return effects;
}

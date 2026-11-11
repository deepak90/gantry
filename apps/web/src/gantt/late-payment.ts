/**
 * What a late payment costs, worked out by Bryntum's own scheduling engine. The engine keeps the plan as a
 * graph of computed values, and that graph can be branched: a branch starts identical to the live plan and
 * diverges as values are written into it, while the live plan, its stores and its revisions never see it
 * (Bryntum branches the same way to check a dragged task or a new link before they happen).
 *
 * For each day the money could land, a branch sets the gate to "start no earlier than the next morning",
 * reads where the held work and the handover end up, and is thrown away. Nothing is assumed about the
 * calendar: weekends, the holiday shutdown and public holidays all come from the engine, which is why a
 * payment two days late can move the handover by a week.
 *
 * If the engine can't branch (it is mid-commit, say), the same question goes to a scheduled copy of the
 * plan, the way library drops are previewed.
 */
import type { CalendarModel, ProjectModel, TaskModel } from '@bryntum/gantt';
import { laborOf } from './look';
import { createProjectModel, loadProjectInlineData, readProjectInlineData } from './project';
import { gateIndex, type Gate } from './pay-gates';
import { walkTree } from './walk';

const DAY_MS = 86_400_000;

export interface LatePaymentCase {
  /** The day the money lands; the work it holds can start the next working day. */
  payOn: Date;
  /** Calendar days after it was due. */
  daysLate: number;
  /** When the work it holds starts. */
  heldStart: Date | null;
  /** The day the keys can change hands: the first working day once the work before the handover is done. */
  handover: Date | null;
  /** Calendar days the handover moves against paying on time. */
  handoverSlip: number;
  /** Working days the handover moves. */
  workingDaysLost: number;
  /** Named days off the move runs over (public holidays, the shutdown), for the explanation. */
  holidays: string[];
  /** Tasks whose dates change. */
  moved: number;
  /** Paid this late, but with the held work on the plan's Saturday calendar: where the handover would be. */
  recovery: { calendar: string; handover: Date | null; handoverSlip: number } | null;
}

export interface LatePaymentForecast {
  /** The day the payment falls due: the day the work it pays for is done. */
  dueOn: Date;
  /** Paying on time. */
  onTime: LatePaymentCase;
  cases: LatePaymentCase[];
  /** How the engine was asked: a branch of the live graph, or a scheduled copy of the plan. */
  method: 'branch' | 'copy';
  ms: number;
}

/** The handover: the last milestone that is not a payment. */
export function handoverTask(project: ProjectModel): TaskModel | null {
  const { gates } = gateIndex(project);
  let found: TaskModel | null = null;
  for (const task of project.taskStore.allRecords as TaskModel[]) {
    if (!task.isMilestone || gates.has(task.id) || !(task.startDate instanceof Date)) continue;
    if (!found || task.startDate > (found.startDate as Date)) found = task;
  }
  return found;
}

const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const calendarDays = (from: Date, to: Date) => Math.round((midnight(to).getTime() - midnight(from).getTime()) / DAY_MS);

/**
 * The day the gate's payment falls due: the last day of the work it pays for, whether or not the payment has
 * been set for a later day.
 */
export function dueDay(gate: Gate): Date | null {
  const incoming = (gate.task as unknown as { incomingDeps?: Set<{ fromEvent?: TaskModel | null }> }).incomingDeps ?? new Set();
  const ends = [...incoming].map((link) => link.fromEvent?.endDate).filter((end): end is Date => end instanceof Date);
  const at = ends.length > 0 ? new Date(Math.max(...ends.map((end) => end.getTime()))) : gate.task.startDate instanceof Date ? gate.task.startDate : null;
  if (!at) return null;
  // The work ends at the start of the next day: due on the day before it.
  return at.getHours() === 0 && at.getMinutes() === 0 ? addDays(at, -1) : midnight(at);
}

interface Interval {
  name: string;
  start: Date;
  end: Date;
}

/** The calendar's named days off (not the weekly weekend), to say which ones a move runs over. */
function namedDaysOff(calendar: CalendarModel | null | undefined): Interval[] {
  const intervals = (calendar as unknown as { intervalStore?: { allRecords: { name?: string; isWorking?: boolean; startDate?: Date; endDate?: Date; recurrentStartDate?: string }[] } } | null)?.intervalStore?.allRecords ?? [];
  return intervals
    .filter((interval) => !interval.isWorking && !interval.recurrentStartDate && interval.startDate instanceof Date && interval.endDate instanceof Date)
    .map((interval) => ({ name: interval.name ?? 'Day off', start: interval.startDate!, end: interval.endDate! }));
}

/** The first working moment at or after `date`: a milestone the work ends on a Friday evening is a Monday morning. */
export function onWorkingTime(calendar: CalendarModel | null | undefined, date: Date): Date {
  const next = (calendar as unknown as { skipNonWorkingTime?(date: Date, isForward: boolean): unknown } | null | undefined)?.skipNonWorkingTime?.(date, true);
  return next instanceof Date ? next : date;
}

function workingDaysBetween(calendar: CalendarModel | null | undefined, from: Date, to: Date): number {
  if (!calendar || to <= from) return 0;
  const ms = (calendar as unknown as { calculateDurationMs(start: Date, end: Date): number }).calculateDurationMs(from, to);
  const project = (calendar as unknown as { project?: { hoursPerDay?: number } }).project;
  const dayMs = (project?.hoursPerDay ?? 24) * 3_600_000;
  return Math.round(ms / dayMs);
}

interface Reader {
  start(task: TaskModel): Date | null;
  end(task: TaskModel): Date | null;
}

/** One question to the engine: the day the money lands (null: on time), and a calendar the held work could keep instead. */
interface Question {
  payOn: Date | null;
  heldCalendar?: CalendarModel | null;
}

interface Answer {
  reader: Reader;
  done(): void;
}

interface Asker {
  ask(question: Question): Promise<Answer> | Answer;
  close(): void;
}

interface Branch {
  write(atom: unknown, value: unknown): void;
  read(atom: unknown): unknown;
  clearBranch(): void;
}

const atomsOf = (record: unknown) => (record as { $: Record<string, unknown> }).$;

/** The leaves of the work a gate holds: what a calendar for the held work applies to (a group's calendar isn't inherited). */
function heldLeaves(gate: Gate): TaskModel[] {
  const leaves: TaskModel[] = [];
  for (const row of gate.holds) {
    walkTree(row, (node) => {
      if (node.isLeaf && !node.isMilestone) leaves.push(node);
    });
  }
  return leaves;
}

/** Someone from outside on a calendar of their own, with no crew of ours on the task (a city inspector): our Saturdays don't change when they come. */
export function isOutsidersTask(task: TaskModel): boolean {
  return Boolean((task as unknown as { calendar?: unknown }).calendar) && laborOf(task).length === 0;
}

/** The held leaves that a calendar for the crews applies to. */
const heldCrewLeaves = (gate: Gate): TaskModel[] => heldLeaves(gate).filter((leaf) => !isOutsidersTask(leaf));

/**
 * Questions to branches of the live engine graph. A branch sees only committed data, so the plan is committed
 * first; conflicts are postponed inside the branch (a contractual finish date downstream would otherwise throw
 * instead of answering); every answer is read in the same tick it is asked, and the branch is always cleared.
 */
function branchAsker(project: ProjectModel, gate: Gate): Asker | null {
  const replica = (project as unknown as { replica?: { isCommitting?: boolean; branch?(config: object): Branch } }).replica;
  if (!replica?.branch || replica.isCommitting) return null;
  const leaves = heldCrewLeaves(gate);
  return {
    ask({ payOn, heldCalendar }) {
      const branch = replica.branch!({ autoCommit: false, onComputationCycle: 'throw' });
      try {
        branch.write(atomsOf(project).autoPostponeConflicts, true);
        const gateAtoms = atomsOf(gate.task);
        branch.write(gateAtoms.constraintType, payOn ? 'startnoearlierthan' : null);
        branch.write(gateAtoms.constraintDate, payOn ? addDays(payOn, 1) : null);
        // Only a calendar already in the plan: a new one, or an interval edit, would reach the live plan. A task
        // with crews works only when its crews' calendars agree, so the held work follows its own calendar here.
        if (heldCalendar) {
          for (const leaf of leaves) {
            branch.write(atomsOf(leaf).calendar, heldCalendar);
            branch.write(atomsOf(leaf).ignoreResourceCalendar, true);
          }
        }
      } catch (error) {
        branch.clearBranch();
        throw error;
      }
      const read = (task: TaskModel, field: 'startDate' | 'endDate') => {
        const value = branch.read(atomsOf(task)[field]);
        return value instanceof Date ? value : null;
      };
      return { reader: { start: (task) => read(task, 'startDate'), end: (task) => read(task, 'endDate') }, done: () => branch.clearBranch() };
    },
    close() {},
  };
}

/**
 * The same questions to one scheduled copy of the plan, reused for every question: slower, but needs nothing
 * from the live engine. A question the copy's engine refuses is an error, never the on-time plan passed off as
 * the answer.
 */
async function copyAsker(project: ProjectModel, gate: Gate): Promise<Asker> {
  const copy = createProjectModel({ config: { autoPostponeConflicts: true } as never });
  await loadProjectInlineData(copy, readProjectInlineData(project));
  const twin = copy.taskStore.getById(gate.id) as TaskModel;
  const leaves = heldCrewLeaves(gate).map((leaf) => copy.taskStore.getById(leaf.id) as TaskModel).filter(Boolean);
  const calendars = new Map(leaves.map((leaf) => [leaf.id, { calendar: (leaf as unknown as { calendar?: unknown }).calendar ?? null, ignore: (leaf as unknown as { ignoreResourceCalendar?: boolean }).ignoreResourceCalendar ?? false }]));
  const twinOf = (task: TaskModel) => copy.taskStore.getById(task.id) as TaskModel | undefined;
  const date = (value: unknown) => (value instanceof Date ? value : null);
  return {
    async ask({ payOn, heldCalendar }) {
      twin.set(payOn ? { constraintType: 'startnoearlierthan', constraintDate: addDays(payOn, 1) } : { constraintType: null, constraintDate: null });
      const copyCalendar = heldCalendar ? (copy as unknown as { calendarManagerStore: { getById(id: unknown): unknown } }).calendarManagerStore.getById(heldCalendar.id) : null;
      for (const leaf of leaves) {
        const own = calendars.get(leaf.id);
        leaf.set((copyCalendar ? { calendar: copyCalendar, ignoreResourceCalendar: true } : { calendar: own?.calendar ?? null, ignoreResourceCalendar: own?.ignore ?? false }) as never);
      }
      const result = (await copy.commitAsync()) as { rejectedWith?: unknown } | undefined;
      if (result?.rejectedWith) throw new Error('The scheduling engine refused this case.');
      return { reader: { start: (task) => date(twinOf(task)?.startDate), end: (task) => date(twinOf(task)?.endDate) }, done: () => undefined };
    },
    close: () => copy.destroy(),
  };
}

/** A branch of the live engine when it can give one, else a copy; the branch's answers are checked to arrive. */
async function askerFor(project: ProjectModel, gate: Gate): Promise<{ asker: Asker; method: 'branch' | 'copy' }> {
  // Rule one of branching: a branch sees committed data only, so pending edits are committed first.
  await project.commitAsync();
  const branch = branchAsker(project, gate);
  if (branch) {
    try {
      // A first question proves the branch answers here (it throws when the engine can't).
      const probe = (await branch.ask({ payOn: null })) as Answer;
      try {
        if (handoverTask(project)) probe.reader.start(handoverTask(project)!);
      } finally {
        probe.done();
      }
      return { asker: branch, method: 'branch' };
    } catch (error) {
      console.warn('The engine could not branch; asking a copy of the plan instead.', error);
    }
  }
  return { asker: await copyAsker(project, gate), method: 'copy' };
}

/** The work-Saturdays calendar the plan already has, if it has one: the usual way to win days back. */
export function saturdayCalendar(project: ProjectModel): CalendarModel | null {
  const store = (project as unknown as { calendarManagerStore?: { allRecords?: CalendarModel[] } }).calendarManagerStore;
  const all = store?.allRecords ?? [];
  return all.find((calendar) => /sat/i.test(calendar.name ?? '') && /mon/i.test(calendar.name ?? '')) ?? null;
}

/**
 * Where the plan goes if the gate's money lands each of `daysLate` calendar days after it falls due (0 is on
 * time). Each case is the engine's own answer; a late case also says whether working Saturdays on the held work
 * (a calendar the plan already has) would win the days back.
 */
export async function forecastLatePayment(project: ProjectModel, gate: Gate, daysLate: readonly number[]): Promise<LatePaymentForecast | null> {
  const due = dueDay(gate);
  const handover = handoverTask(project);
  if (!due) return null;
  const started = performance.now();
  const leaves = (project.taskStore.allRecords as TaskModel[]).filter((task) => task.isLeaf && task !== gate.task);
  const firstHeld = heldLeaves(gate)[0] ?? null;
  const calendar = (project as unknown as { calendar?: CalendarModel }).calendar;
  const daysOff = namedDaysOff(calendar);
  const saturdays = saturdayCalendar(project);

  type Measured = LatePaymentCase & { ends: Map<unknown, number> };
  const measure = (payOn: Date | null, reader: Reader, base: Measured | null): Measured => {
    const ends = new Map<unknown, number>();
    let moved = 0;
    for (const task of leaves) {
      const end = reader.end(task)?.getTime();
      if (end === undefined) continue;
      ends.set(task.id, end);
      if (base && base.ends.get(task.id) !== end) moved += 1;
    }
    // The keys change hands on a working day: the work that ends on Friday evening before a long weekend hands over after it.
    const milestone = handover ? reader.start(handover) : null;
    const handoverAt = milestone ? onWorkingTime(calendar, milestone) : null;
    const from = base?.handover ?? handoverAt;
    const slip = from && handoverAt ? calendarDays(from, handoverAt) : 0;
    const holidays = from && handoverAt && handoverAt > from ? daysOff.filter((off) => off.start < handoverAt && off.end > from).map((off) => off.name) : [];
    return {
      payOn: payOn ?? due,
      daysLate: payOn ? calendarDays(due, payOn) : 0,
      heldStart: firstHeld ? reader.start(firstHeld) : null,
      handover: handoverAt,
      handoverSlip: slip,
      workingDaysLost: from && handoverAt ? workingDaysBetween(calendar, from, handoverAt) : 0,
      holidays,
      moved,
      recovery: null,
      ends,
    };
  };
  const strip = ({ ends: _ends, ...rest }: Measured): LatePaymentCase => rest;
  const answer = async (asker: Asker, question: Question, base: Measured | null): Promise<Measured> => {
    const answered = await asker.ask(question);
    try {
      return measure(question.payOn, answered.reader, base);
    } finally {
      answered.done();
    }
  };

  const { asker, method } = await askerFor(project, gate);
  try {
    const onTime = await answer(asker, { payOn: null }, null);
    const cases: LatePaymentCase[] = [];
    for (const days of daysLate) {
      const payOn = addDays(due, days);
      const late = await answer(asker, { payOn }, onTime);
      if (late.handoverSlip > 0 && saturdays) {
        const won = await answer(asker, { payOn, heldCalendar: saturdays }, onTime);
        late.recovery = { calendar: saturdays.name ?? 'Saturdays', handover: won.handover, handoverSlip: won.handoverSlip };
      }
      cases.push(strip(late));
    }
    return { dueOn: due, onTime: strip(onTime), cases, method, ms: performance.now() - started };
  } finally {
    asker.close();
  }
}

/** Where each task that moves would be, with the money landing on `payOn`: the engine's answer. */
export async function latePaymentPositions(project: ProjectModel, gate: Gate, payOn: Date): Promise<Map<number | string, { start: Date; end: Date }>> {
  const positions = new Map<number | string, { start: Date; end: Date }>();
  const leaves = (project.taskStore.allRecords as TaskModel[]).filter((task) => task.isLeaf && task !== gate.task);
  const { asker } = await askerFor(project, gate);
  try {
    const answered = await asker.ask({ payOn });
    try {
      for (const task of leaves) {
        const start = answered.reader.start(task);
        const end = answered.reader.end(task);
        if (!start || !end || !(task.startDate instanceof Date) || !(task.endDate instanceof Date)) continue;
        if (start.getTime() !== task.startDate.getTime() || end.getTime() !== task.endDate.getTime()) positions.set(task.id, { start, end });
      }
    } finally {
      answered.done();
    }
  } finally {
    asker.close();
  }
  return positions;
}

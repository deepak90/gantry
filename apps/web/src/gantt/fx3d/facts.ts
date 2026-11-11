/**
 * What a model is built from: plain facts read off a task once, when its model opens. Lazy engine
 * values (slack, critical) are left out on purpose: reading them mid-commit can hang the tab.
 */
import type { TaskModel } from '@bryntum/gantt';
import { toDateOnly, withinBuffer } from '@collab/shared';
import { crewColor, crewSizeOn, equipmentOf, laborOf, original, statusOf, STATUS_LABELS, taskMoney, wholeMoney, type LookState } from '../look';
import { planClock } from '../../plan-clock';

export type KitName = 'site' | 'earth' | 'concrete' | 'steel' | 'envelope' | 'interior';
export type MachineKind = 'crane' | 'pump' | 'lift' | 'excavator';

const DAY_MS = 86_400_000;

export interface Constraint {
  type: string;
  /** In the words of the task editor. */
  label: string;
  date: Date;
  /** It holds the work back until its date, as a barrier does. */
  holdsStart: boolean;
}

export interface TaskFacts {
  name: string;
  /** Its number in the plan's outline, as in the WBS column. */
  wbs: string;
  /** Midnights of the working days on the task's own calendar, so "day 3 of 6" means what it says. */
  workDays: number[];
  /** Midnights of every day its machine is on rent: a rental is paid by the day, weekends too. */
  rentedDays: number[];
  /** Its days with no work planned are no more than a working day of cover either side: nothing wrong with that. */
  coverOnly: boolean;
  /** Reported on the task; the dates alone say what was planned. */
  percent: number;
  constraint: Constraint | null;
  deadline: Date | null;
  manual: boolean;
  inactive: boolean;
  kit: KitName;
  machines: MachineKind[];
  machineNames: string[];
  /** The machine on it and what a day of it costs, for the money view (the rate only for those who may see it). */
  rig: { name: string; color: string; rateMinor: number } | null;
  crews: { name: string; color: string; people: number; usual: boolean; icon: string; image?: string | undefined }[];
  status: string;
  /** Working days of the task. */
  duration: number;
  start: Date;
  end: Date;
  /** First and last moment on the model's ruler: the work, and a machine's time on site around it. */
  rulerStart: Date;
  rulerEnd: Date;
  /** Name of the machine on site, for the words on the ruler. */
  machine: string | null;
}

export function machineKind(name: string): MachineKind | null {
  if (/crane/i.test(name)) return 'crane';
  if (/pump/i.test(name)) return 'pump';
  if (/lift/i.test(name)) return 'lift';
  if (/excavator|digger/i.test(name)) return 'excavator';
  return null;
}

/** Which model shows this work: the words of the task first, then the machine on it. */
export function kitFor(name: string, machines: readonly MachineKind[]): KitName {
  if (/excavat|earthwork|trench|grading/i.test(name)) return 'earth';
  if (/pour|footing|concrete|slab|cure|backfill/i.test(name)) return 'concrete';
  if (/steel|frame|bolt up/i.test(name)) return 'steel';
  if (/roof|wall panel|exterior|window|cladding|envelope/i.test(name)) return 'envelope';
  if (/site setup|fenc|mobiliz/i.test(name)) return 'site';
  if (machines.includes('excavator')) return 'earth';
  if (machines.includes('pump')) return 'concrete';
  if (machines.includes('crane')) return 'steel';
  if (machines.includes('lift')) return 'envelope';
  return 'interior';
}

const CONSTRAINTS: Readonly<Record<string, string>> = {
  startnoearlierthan: 'Start no earlier than',
  startnolaterthan: 'Start no later than',
  finishnoearlierthan: 'Finish no earlier than',
  finishnolaterthan: 'Finish no later than',
  muststarton: 'Must start on',
  mustfinishon: 'Must finish on',
};

interface PlannedTask {
  constraintType?: string | null;
  constraintDate?: Date | null;
  deadlineDate?: Date | null;
  manuallyScheduled?: boolean;
  inactive?: boolean;
  wbsCode?: unknown;
  effectiveCalendar?: { isWorkingTime?(start: Date, end: Date): boolean };
}

/** The task's working days: the calendar decides, and a task with none still has its dates. */
export function workDaysOf(start: Date, end: Date, calendar?: PlannedTask['effectiveCalendar']): number[] {
  const days: number[] = [];
  const all: number[] = [];
  for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate()); day < end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    all.push(day.getTime());
    if (!calendar?.isWorkingTime || calendar.isWorkingTime(day, next)) days.push(day.getTime());
  }
  return days.length > 0 ? days : all;
}

export type Progress = {
  state: 'ahead' | 'active' | 'done';
  /** How much of the work is built, from 0 to 1. */
  built: number;
  /** Which working day this is, from 1; 0 when the date falls on a day off or outside the work. */
  day: number;
  of: number;
};

/**
 * Where a task stands on a date. The dates say what was planned; from today on (the plan's today, plan-clock.ts), what
 * has been reported counts too, so a task that has really begun already shows the work done on it.
 */
export function progressAt(facts: Pick<TaskFacts, 'workDays' | 'percent' | 'start' | 'end'>, at: number, today = planClock.now().getTime()): Progress {
  const of = facts.workDays.length;
  let finished = 0;
  let partial = 0;
  let day = 0;
  for (const [index, midnight] of facts.workDays.entries()) {
    if (at >= midnight + DAY_MS) finished = index + 1;
    else if (at >= midnight) {
      partial = (at - midnight) / DAY_MS;
      day = index + 1;
    }
  }
  const planned = of > 0 ? (finished + partial) / of : at >= facts.end.getTime() ? 1 : 0;
  const built = at >= today ? Math.max(planned, facts.percent / 100) : planned;
  return { state: built >= 1 ? 'done' : built > 0 ? 'active' : 'ahead', built: Math.min(1, built), day, of };
}

/** The same work as far as it has been reported done: what a person said, whatever the date says. */
export function reportedProgress(percent: number, plan: Progress): Progress {
  const built = Math.min(1, Math.max(0, percent / 100));
  return { ...plan, built, state: built >= 1 ? 'done' : built > 0 ? 'active' : 'ahead' };
}

type MachineWithCalendar = { effectiveCalendar?: PlannedTask['effectiveCalendar'] };

function isCoverOnly(rental: { start: string; end: string }, start: Date, end: Date, machine: MachineWithCalendar | undefined, planned: PlannedTask): boolean {
  const calendar = machine?.effectiveCalendar ?? planned.effectiveCalendar;
  const works = (day: string): boolean => {
    const at = dateOnly(day);
    return !calendar?.isWorkingTime || calendar.isWorkingTime(at, new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1));
  };
  return withinBuffer(rental, { start: toDateOnly(start), end: toDateOnly(end) }, works);
}

function dateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

export function factsOf(rendered: TaskModel, look: LookState): TaskFacts {
  const task = original(rendered);
  const machineNames = equipmentOf(task).map((resource) => resource.name);
  const machines = machineNames.map(machineKind).filter((kind): kind is MachineKind => kind !== null);
  const name = task.name ?? '';
  const start = task.startDate instanceof Date ? task.startDate : planClock.now();
  const end = task.endDate instanceof Date ? task.endDate : new Date(start.getTime() + DAY_MS);
  const decoration = look.decorations.get(task.id as number);
  const rental = decoration?.rental;
  const rulerStart = rental && dateOnly(rental.start) < start ? dateOnly(rental.start) : start;
  const rulerEnd = rental && dateOnly(rental.end) > end ? dateOnly(rental.end) : end;
  const planned = task as TaskModel & PlannedTask;
  const constraintType = planned.constraintType ?? '';
  const constraintLabel = CONSTRAINTS[constraintType];
  return {
    name,
    wbs: planned.wbsCode == null ? '' : String(planned.wbsCode),
    workDays: workDaysOf(start, end, planned.effectiveCalendar),
    rentedDays: rental ? workDaysOf(dateOnly(rental.start), dateOnly(rental.end)) : [],
    coverOnly: rental ? isCoverOnly(rental, start, end, equipmentOf(task)[0] as MachineWithCalendar | undefined, planned) : false,
    percent: task.percentDone ?? 0,
    constraint: constraintLabel && planned.constraintDate instanceof Date ? { type: constraintType, label: constraintLabel, date: planned.constraintDate, holdsStart: constraintType === 'startnoearlierthan' || constraintType === 'muststarton' } : null,
    deadline: planned.deadlineDate instanceof Date ? planned.deadlineDate : null,
    manual: Boolean(planned.manuallyScheduled),
    inactive: Boolean(planned.inactive),
    kit: kitFor(name, machines),
    machines,
    machineNames,
    rig: equipmentOf(task)[0] ? { name: equipmentOf(task)[0]!.name, color: crewColor(equipmentOf(task)[0]!), rateMinor: decoration?.rentalRateMinor ?? 0 } : null,
    crews: laborOf(task).map((resource) => {
      const size = crewSizeOn(task, resource);
      const image = (resource as unknown as { imageUrl?: string | null }).imageUrl;
      return { name: resource.name, color: crewColor(resource), people: size.people, usual: size.usual, icon: (resource as unknown as { iconCls?: string }).iconCls || 'fa fa-helmet-safety', ...(image ? { image } : {}) };
    }),
    status: STATUS_LABELS[statusOf(task)],
    duration: typeof task.duration === 'number' ? task.duration : 1,
    start,
    end,
    rulerStart,
    rulerEnd,
    machine: rental?.equipment ?? machineNames[0] ?? null,
  };
}

export const shortDate = (date: Date): string => date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

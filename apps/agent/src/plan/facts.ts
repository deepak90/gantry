/**
 * Plain facts about the plan for the assistant's fact tools, all worked out in code so the numbers are
 * the same every time: money totals over the cost columns (budget, forecast, spent, paid) with the
 * differences and percentages, the milestones with their slip and slack, the calendars, the time
 * ranges on the timeline (the shutdown and the bands library pieces brought), and working-day
 * arithmetic on a calendar. Money stays in integer minor units; percentages are rounded to one place.
 */
import { addDays, addWorkingDays, countWorkingDays, isWorkingDay, nextWorkingDay, SEED_SHUTDOWN, subtractWorkingDays, type SeedCalendarId } from '@collab/shared/seed';
import { scheduleFloat } from './analysis';
import { day, lastDay, usd } from './format';
import type { PlanSnapshot, PlanTask } from './snapshot';

const round1 = (value: number) => Math.round(value * 10) / 10;
/** `part` as a percentage of `whole`, one decimal place; null when there is no whole to compare with. */
export const percentOf = (part: number, whole: number): number | null => (whole === 0 ? null : round1((part / whole) * 100));

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

export type CostGroupBy = 'none' | 'phase' | 'group' | 'crew' | 'task';

export interface CostTotals {
  tasks: number;
  budget_minor: number;
  forecast_minor: number;
  /** Spent so far (the Spent column, `incurred`). */
  spent_minor: number;
  paid_minor: number;
  /** Forecast minus budget: positive is over budget. */
  over_budget_minor: number;
  /** Spent but not yet paid. */
  unpaid_minor: number;
  /** Forecast still to spend. */
  to_spend_minor: number;
  over_budget_percent: number | null;
  spent_percent_of_forecast: number | null;
  paid_percent_of_spent: number | null;
  /** Work done, weighted by forecast (what the money says should be spent by now). */
  done_percent_by_forecast: number | null;
  text: Record<string, string>;
}

export interface CostGroup extends CostTotals {
  key: string;
  name: string;
}

/** A machine on rent for a task: its supplier, what it is, and what its billable days come to. */
export interface RentalCost {
  supplier: string;
  machine: string;
  task: string;
  days: number;
  amount_minor: number;
  text: string;
}

export interface CostReport {
  scope: string;
  totals: CostTotals;
  groups: CostGroup[];
  /** True when more groups exist than are listed (the biggest by forecast come first). */
  truncated: boolean;
  /** By crew: the machines on rent for the tasks, apart from the crews' work (a machine is no crew). */
  rentals?: RentalCost[];
  note: string;
}

/** Calendar days from `start` to `end` (exclusive), as a rental is billed: weekends included. */
function billableDays(start: string, end: string): number {
  return Math.max(0, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000));
}

/** The machines on rent for these tasks, each at its rate times its billable days, under its supplier. */
function rentalsFor(plan: PlanSnapshot, tasks: readonly PlanTask[]): RentalCost[] {
  const names = new Map(tasks.map((task) => [task.id, task.name]));
  return plan.bookings
    .filter((booking) => names.has(booking.taskId))
    .map((booking) => {
      const days = billableDays(booking.billableStart, booking.billableEnd);
      const amount = days * booking.rentalRateMinor;
      return {
        supplier: booking.supplierName,
        machine: plan.resources.find((resource) => resource.id === booking.resourceId)?.name ?? 'Equipment',
        task: names.get(booking.taskId)!,
        days,
        amount_minor: amount,
        text: usd(amount),
      };
    });
}

function totalsOf(tasks: readonly PlanTask[], crewShare: (task: PlanTask) => number = () => 1): CostTotals {
  let budget = 0;
  let forecast = 0;
  let spent = 0;
  let paid = 0;
  let doneWeighted = 0;
  for (const task of tasks) {
    const share = crewShare(task);
    budget += Math.round(task.budgetMinor * share);
    forecast += Math.round(task.forecastMinor * share);
    spent += Math.round(task.incurredMinor * share);
    paid += Math.round(task.paidMinor * share);
    doneWeighted += task.forecastMinor * share * (task.percentDone / 100);
  }
  const over = forecast - budget;
  return {
    tasks: tasks.length,
    budget_minor: budget,
    forecast_minor: forecast,
    spent_minor: spent,
    paid_minor: paid,
    over_budget_minor: over,
    unpaid_minor: spent - paid,
    to_spend_minor: Math.max(0, forecast - spent),
    over_budget_percent: percentOf(over, budget),
    spent_percent_of_forecast: percentOf(spent, forecast),
    paid_percent_of_spent: percentOf(paid, spent),
    done_percent_by_forecast: percentOf(doneWeighted, forecast),
    text: {
      budget: usd(budget),
      forecast: usd(forecast),
      spent: usd(spent),
      paid: usd(paid),
      over_budget: over >= 0 ? usd(over) : `${usd(-over)} under`,
      unpaid: usd(spent - paid),
      to_spend: usd(Math.max(0, forecast - spent)),
    },
  };
}

const MAX_GROUPS = 25;

/**
 * Totals of the cost columns over leaf tasks (groups only add up their tasks, so nothing is counted
 * twice), optionally limited to some tasks (and everything under them) and split by phase, by the
 * group directly above, by crew (a task shared by crews is split by their units) or per task.
 */
export function costReport(plan: PlanSnapshot, options: { taskIds?: readonly number[]; groupBy?: CostGroupBy } = {}): CostReport {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const children = new Map<number, PlanTask[]>();
  for (const task of plan.tasks) if (task.parentId !== null) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  const leavesUnder = (task: PlanTask): PlanTask[] => (task.isLeaf ? [task] : (children.get(task.id) ?? []).flatMap(leavesUnder));
  const picked = options.taskIds?.length
    ? [...new Map(options.taskIds.flatMap((id) => (byId.get(id) ? leavesUnder(byId.get(id)!) : [])).map((task) => [task.id, task])).values()]
    : plan.tasks.filter((task) => task.isLeaf);
  const missing = (options.taskIds ?? []).filter((id) => !byId.has(id));
  const leaves = picked.filter((task) => !task.inactive);
  const groupBy = options.groupBy ?? 'none';
  const groups: CostGroup[] = [];
  if (groupBy === 'phase' || groupBy === 'group' || groupBy === 'task') {
    const keyOf = (task: PlanTask): { key: string; name: string } => {
      if (groupBy === 'task') return { key: String(task.id), name: task.name };
      if (groupBy === 'phase') return { key: task.phase, name: task.phase };
      const parent = task.parentId !== null ? byId.get(task.parentId) : undefined;
      return parent ? { key: String(parent.id), name: parent.name } : { key: String(task.id), name: task.name };
    };
    const buckets = new Map<string, { name: string; tasks: PlanTask[] }>();
    for (const task of leaves) {
      const { key, name } = keyOf(task);
      const bucket = buckets.get(key) ?? { name, tasks: [] };
      bucket.tasks.push(task);
      buckets.set(key, bucket);
    }
    for (const [key, bucket] of buckets) groups.push({ key, name: bucket.name, ...totalsOf(bucket.tasks) });
  } else if (groupBy === 'crew') {
    // A machine is no crew: a task's money is its crews', and each machine on rent is listed apart (rentals).
    const machines = new Set(plan.resources.filter((resource) => resource.kind === 'equipment').map((resource) => resource.id));
    const crewsOf = new Map<number, { resourceId: number; units: number }[]>();
    for (const assignment of plan.assignments) {
      if (machines.has(assignment.resourceId)) continue;
      crewsOf.set(assignment.taskId, [...(crewsOf.get(assignment.taskId) ?? []), { resourceId: assignment.resourceId, units: assignment.units }]);
    }
    const buckets = new Map<number, PlanTask[]>();
    const unassigned: PlanTask[] = [];
    for (const task of leaves) {
      const crews = crewsOf.get(task.id) ?? [];
      if (crews.length === 0) unassigned.push(task);
      for (const crew of crews) buckets.set(crew.resourceId, [...(buckets.get(crew.resourceId) ?? []), task]);
    }
    for (const [resourceId, tasks] of buckets) {
      const resource = plan.resources.find((candidate) => candidate.id === resourceId);
      const share = (task: PlanTask) => {
        const crews = crewsOf.get(task.id) ?? [];
        const units = crews.reduce((sum, crew) => sum + crew.units, 0);
        return units === 0 ? 1 / crews.length : (crews.find((crew) => crew.resourceId === resourceId)?.units ?? 0) / units;
      };
      groups.push({ key: String(resourceId), name: resource?.name ?? `Crew ${resourceId}`, ...totalsOf(tasks, share) });
    }
    if (unassigned.length) groups.push({ key: 'none', name: 'No crew', ...totalsOf(unassigned) });
  }
  groups.sort((a, b) => b.forecast_minor - a.forecast_minor || a.name.localeCompare(b.name));
  const scope = options.taskIds?.length ? `${leaves.length} task(s) under ${options.taskIds.length} picked task(s)` : 'the whole plan';
  const notes = ['Leaf tasks only: groups add up their tasks.'];
  const rentals = groupBy === 'crew' ? rentalsFor(plan, leaves) : [];
  if (groupBy === 'crew') {
    notes.push('A task shared by crews is split between them by their units.');
    notes.push('A machine is no crew: each machine on rent is under rentals, at its rate times its billable days (weekends included), billed to its supplier apart from the crews’ work. What a firm is paid: its crew’s share of the tasks, plus its rentals.');
  }
  if (missing.length) notes.push(`No task ${missing.join(', ')} in the plan.`);
  return {
    scope,
    totals: totalsOf(leaves),
    groups: groups.slice(0, MAX_GROUPS),
    truncated: groups.length > MAX_GROUPS,
    ...(rentals.length ? { rentals } : {}),
    note: notes.join(' '),
  };
}

// ---------------------------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------------------------

export interface MilestoneRow {
  id: number;
  name: string;
  wbs: string | null;
  phase: string;
  date: string;
  baseline_date: string | null;
  /** Working days later than the baseline (negative: earlier); null without a baseline. */
  slip_days: number | null;
  /** Working days it can move before the handover moves; null when nothing follows from it. */
  slack_days: number | null;
  critical: boolean;
  done: boolean;
  is_handover: boolean;
  constraint: string | null;
}

/** Working days from `from` to `to` (negative when `to` is earlier). */
export function workingDaysFrom(from: string, to: string, calendar: SeedCalendarId): number {
  return to >= from ? countWorkingDays(from, to, calendar) : -countWorkingDays(to, from, calendar);
}

export function milestones(plan: PlanSnapshot): MilestoneRow[] {
  const float = scheduleFloat(plan);
  return plan.tasks
    .filter((task) => task.isMilestone && !task.inactive)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id)
    .map((task) => ({
      id: task.id,
      name: task.name,
      wbs: task.wbs ?? null,
      phase: task.phase,
      date: task.start,
      baseline_date: task.baselineStart,
      slip_days: task.baselineStart ? workingDaysFrom(task.baselineStart, task.start, task.calendar) : null,
      slack_days: float[task.id]?.float_days ?? null,
      critical: float[task.id]?.critical ?? false,
      done: task.percentDone >= 100,
      is_handover: task.id === plan.handoverTaskId,
      constraint: task.constraintType ? `${task.constraintType}${task.constraintDate ? ` ${task.constraintDate}` : ''}` : null,
    }));
}

// ---------------------------------------------------------------------------------------------
// Calendars and time ranges
// ---------------------------------------------------------------------------------------------

export const CALENDARS: Record<SeedCalendarId, { name: string; works: string; days_off: string }> = {
  standard: { name: 'Standard', works: 'Monday to Friday', days_off: 'Saturdays, Sundays and the holiday shutdown' },
  site: { name: 'Site', works: 'Monday to Saturday', days_off: 'Sundays and the holiday shutdown' },
  inspector: { name: 'City inspector', works: 'Monday to Friday', days_off: 'Saturdays, Sundays, the holiday shutdown and when the inspector is away' },
};

export interface CalendarReport {
  calendars: { id: SeedCalendarId; name: string; works: string; days_off: string; crews: string[]; tasks: number }[];
  holidays: { name: string; first_day: string; last_day: string; working_days_lost: Record<SeedCalendarId, number> }[];
  note: string;
}

export function calendarReport(plan: PlanSnapshot): CalendarReport {
  const ids: SeedCalendarId[] = ['standard', 'site'];
  return {
    calendars: ids.map((id) => ({
      id,
      ...CALENDARS[id],
      crews: plan.resources.filter((resource) => resource.calendar === id).map((resource) => resource.name),
      tasks: plan.tasks.filter((task) => task.isLeaf && task.calendar === id).length,
    })),
    holidays: [
      {
        name: 'Holiday shutdown',
        first_day: SEED_SHUTDOWN.startDate,
        last_day: lastDay(SEED_SHUTDOWN.endDate),
        working_days_lost: {
          standard: countWorkingDaysIgnoringShutdown(SEED_SHUTDOWN.startDate, SEED_SHUTDOWN.endDate, 'standard'),
          site: countWorkingDaysIgnoringShutdown(SEED_SHUTDOWN.startDate, SEED_SHUTDOWN.endDate, 'site'),
          inspector: countWorkingDaysIgnoringShutdown(SEED_SHUTDOWN.startDate, SEED_SHUTDOWN.endDate, 'inspector'),
        },
      },
    ],
    note: 'A task works to its own calendar; a link’s lag counts on the calendar of the task it leads to. Rental is billed on the site calendar.',
  };
}

/** Weekdays (Mon-Fri, or Mon-Sat on site) in a span, as if there were no shutdown: what a holiday costs. */
function countWorkingDaysIgnoringShutdown(start: string, endExclusive: string, calendar: SeedCalendarId): number {
  let count = 0;
  for (let date = start; date < endExclusive; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (calendar === 'site' ? weekday !== 0 : weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

export interface TimeRangeRow {
  kind: 'holiday' | 'band';
  name: string;
  first_day: string;
  last_day: string;
  /** For a band: the task it belongs to (the top task of the library piece). */
  task?: { id: number; name: string };
  note?: string;
}

/** The task under `top` at a child-index path (siblings in plan order), or null. */
function taskAtPath(plan: PlanSnapshot, top: PlanTask, path: readonly number[]): PlanTask | null {
  let current: PlanTask | null = top;
  for (const index of path) {
    const parentId: number | undefined = current?.id;
    const kids: PlanTask[] = plan.tasks.filter((task) => task.parentId === parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    current = kids[index] ?? null;
    if (!current) return null;
  }
  return current;
}

/** The ranges drawn on the timeline: the holiday shutdown and every library band, by date; optionally only those touching [from, to]. */
export function timeRanges(plan: PlanSnapshot, window: { from?: string; to?: string } = {}): TimeRangeRow[] {
  const rows: TimeRangeRow[] = [{ kind: 'holiday', name: 'Holiday shutdown (no work on any calendar)', first_day: SEED_SHUTDOWN.startDate, last_day: lastDay(SEED_SHUTDOWN.endDate) }];
  for (const task of plan.tasks) {
    for (const band of task.bands ?? []) {
      const fromTask = taskAtPath(plan, task, band.from.path);
      const toTask = taskAtPath(plan, task, band.to.path);
      if (!fromTask || !toTask) continue;
      const a = band.from.edge === 'start' ? fromTask.start : fromTask.end;
      const b = band.to.edge === 'start' ? toTask.start : toTask.end;
      const [start, end] = a <= b ? [a, b] : [b, a];
      if (start === end) continue;
      rows.push({ kind: 'band', name: band.name, first_day: start, last_day: lastDay(end), task: { id: task.id, name: task.name }, ...(band.note ? { note: band.note } : {}) });
    }
  }
  return rows
    .filter((row) => (!window.from || row.last_day >= window.from) && (!window.to || row.first_day <= window.to))
    .sort((a, b) => a.first_day.localeCompare(b.first_day) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Working time
// ---------------------------------------------------------------------------------------------

export type TimeQuestion =
  | { op: 'working_days_between'; from: string; to: string; calendar: SeedCalendarId }
  | { op: 'add_working_days'; from: string; days: number; calendar: SeedCalendarId }
  | { op: 'subtract_working_days'; from: string; days: number; calendar: SeedCalendarId }
  | { op: 'is_working_day'; date: string; calendar: SeedCalendarId }
  | { op: 'next_working_day'; date: string; calendar: SeedCalendarId }
  | { op: 'calendar_days_between'; from: string; to: string };

/** Why a day is off, or null when it is a working day. */
function dayOff(date: string, calendar: SeedCalendarId): string | null {
  if (isWorkingDay(date, calendar)) return null;
  if (date >= SEED_SHUTDOWN.startDate && date < SEED_SHUTDOWN.endDate) return 'holiday shutdown';
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? 'Sunday' : 'Saturday';
}

export function answerTime(question: TimeQuestion): Record<string, unknown> {
  switch (question.op) {
    case 'working_days_between': {
      const { from, to, calendar } = question;
      const [start, end] = from <= to ? [from, to] : [to, from];
      // Inclusive of both days as people count them ("from Monday to Friday" is five days).
      const days = countWorkingDays(start, addDays(end, 1), calendar);
      const offDays: Record<string, number> = {};
      for (let date = start; date <= end; date = addDays(date, 1)) {
        const why = dayOff(date, calendar);
        if (why) offDays[why] = (offDays[why] ?? 0) + 1;
      }
      return {
        working_days: days,
        counted: `${day(start)} to ${day(end)}, both days included, on the ${CALENDARS[calendar].name.toLowerCase()} calendar (${CALENDARS[calendar].works})`,
        calendar_days: countCalendarDays(start, end) + 1,
        days_off: offDays,
      };
    }
    case 'add_working_days': {
      const { from, days, calendar } = question;
      const start = nextWorkingDay(from, calendar);
      const endExclusive = addWorkingDays(start, Math.max(1, days), calendar);
      const last = lastWorkingDayBefore(endExclusive, calendar);
      return {
        first_day: start,
        last_day: last,
        next_free_day: nextWorkingDay(endExclusive, calendar),
        counted: `${days} working day(s) starting ${day(start)} on the ${CALENDARS[calendar].name.toLowerCase()} calendar: the last one is ${day(last)}`,
      };
    }
    case 'subtract_working_days': {
      const { from, days, calendar } = question;
      // The day `days` working days before `from` (from itself not counted).
      const result = subtractWorkingDays(from, Math.max(1, days), calendar);
      return { date: result, counted: `${days} working day(s) before ${day(from)} on the ${CALENDARS[calendar].name.toLowerCase()} calendar is ${day(result)}` };
    }
    case 'is_working_day': {
      const why = dayOff(question.date, question.calendar);
      return { date: question.date, weekday: day(question.date).slice(0, 3), working: why === null, ...(why ? { why_not: why } : {}) };
    }
    case 'next_working_day': {
      const next = nextWorkingDay(question.date, question.calendar);
      return { date: next, same_day: next === question.date, text: day(next) };
    }
    case 'calendar_days_between': {
      const [start, end] = question.from <= question.to ? [question.from, question.to] : [question.to, question.from];
      return { calendar_days: countCalendarDays(start, end), counted: `from ${day(start)} to ${day(end)}, not counting the first day`, weeks: round1(countCalendarDays(start, end) / 7) };
    }
  }
}

function countCalendarDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function lastWorkingDayBefore(endExclusive: string, calendar: SeedCalendarId): string {
  let date = addDays(endExclusive, -1);
  while (!isWorkingDay(date, calendar)) date = addDays(date, -1);
  return date;
}

// ---------------------------------------------------------------------------------------------
// Where the plan stands today
// ---------------------------------------------------------------------------------------------

const CALENDAR_NAMES: Record<string, string> = { standard: 'Standard (Mon-Fri)', site: 'Site (Mon-Sat)', inspector: 'City inspector' };

export interface PlanState {
  /** The plan's today (the pinned day on the hosted site). */
  today: string;
  /** Work that should have finished by today and isn't done. */
  late: { count: number; tasks: { id: number; name: string; last_day: string; percent_done: number }[] };
  /** Each payment hold: what it pays for, what waits for it and why, when it falls due, and where it stands. */
  holds: { id: number; name: string; due: string; state: string; pays_for: string[]; holds: string[]; why: string }[];
  /** Days off that fall on dates, by name, the calendars they are on and the tasks those calendars hold up then. */
  daysOff: { name: string; first_day: string; last_day: string; calendars: string[]; tasks: string[] }[];
}

/** Where the plan stands on `today`: what is late, what is held for a payment and why, and the days off ahead. */
export function planState(plan: PlanSnapshot, today: string): PlanState {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const late = plan.tasks.filter((task) => task.isLeaf && !task.isMilestone && !task.inactive && task.percentDone < 100 && lastDay(task.end) < today).sort((a, b) => (a.end < b.end ? -1 : 1));
  const holds = plan.tasks
    .filter((task) => task.payGate)
    .map((gate) => {
      const pays = gate.payGate!.pays.map((id) => (typeof id === 'number' ? byId.get(id)?.name : undefined)).filter((name): name is string => Boolean(name));
      const held = plan.dependencies.filter((link) => link.from === gate.id).map((link) => byId.get(link.to)?.name).filter((name): name is string => Boolean(name));
      const state = gate.payGate!.state;
      return {
        id: gate.id,
        name: gate.name,
        due: gate.start,
        state,
        pays_for: pays,
        holds: held,
        why: state === 'paid' ? `${pays.join(' and ')} is paid for: ${held.join(' and ') || 'the work after it'} is released.` : `${held.join(' and ') || 'The work after it'} can't start until ${pays.join(' and ') || 'the work before it'} is paid for (due ${day(gate.start)}).`,
      };
    });
  const grouped = new Map<string, PlanState['daysOff'][number]>();
  for (const brk of plan.calendarBreaks ?? []) {
    if (brk.last_day < today) continue;
    const key = `${brk.name}|${brk.first_day}|${brk.last_day}`;
    const entry = grouped.get(key) ?? { name: brk.name, first_day: brk.first_day, last_day: brk.last_day, calendars: [], tasks: [] };
    const calendar = CALENDAR_NAMES[brk.calendar] ?? brk.calendar;
    if (!entry.calendars.includes(calendar)) entry.calendars.push(calendar);
    // Tasks on that calendar whose days run into the break: who it holds up.
    for (const task of plan.tasks) {
      if (!task.isLeaf || task.calendar !== brk.calendar || entry.tasks.includes(task.name)) continue;
      if (task.start <= brk.last_day && lastDay(task.end) >= addDays(brk.first_day, -14)) entry.tasks.push(task.name);
    }
    grouped.set(key, entry);
  }
  // A break every calendar shares names no task in particular.
  const daysOff = [...grouped.values()]
    .map((entry) => (entry.calendars.length > 1 ? { ...entry, tasks: [] } : { ...entry, tasks: entry.tasks.slice(0, 6) }))
    .sort((a, b) => (a.first_day < b.first_day ? -1 : 1))
    .slice(0, 8);
  return {
    today,
    late: { count: late.length, tasks: late.slice(0, 6).map((task) => ({ id: task.id, name: task.name, last_day: lastDay(task.end), percent_done: Math.round(task.percentDone) })) },
    holds,
    daysOff,
  };
}

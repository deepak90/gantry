/**
 * The watch list on the server: the plan as the rules read it (packages/shared/src/watch.ts), built
 * from the agent's PlanSnapshot the way the browser builds it from the live project
 * (apps/web/src/alerts/live.ts), so a rule raises the same situations here as on screen; then which
 * runs to open and close, and which daily rules are due. Pure: the runner (agent/watch.ts) reads and
 * writes the rows.
 *
 * The agent never runs the scheduling engine: dates are the ones the engine last wrote, slack is the
 * agent's own backward pass (scheduleFloat), idle rental comes from the same detector the assistant
 * quotes (detectors.ts), so what a rule says and what the assistant then says about it agree.
 */
import { addDays, isWorkingDay } from '@collab/shared/seed';
import type { WatchAlert, WatchPlan, WatchRuleRow, WatchRunRow, WatchTask } from '@collab/shared';
import { scheduleFloat } from './analysis';
import { idleEquipment } from './detectors';
import { neededOn, type PlanSnapshot, type PlanTask } from './snapshot';

const DAY_MS = 86_400_000;
const utc = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

/** Whole calendar days from `from` to `to` (negative when `to` is earlier), as the browser counts slips. */
function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** A local date as `YYYY-MM-DD`. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The plan as the watch rules see it, "today" being `today` (YYYY-MM-DD). */
export function watchPlanFrom(plan: PlanSnapshot, today: string): WatchPlan {
  const float = scheduleFloat(plan);
  const idle = new Map<number, NonNullable<WatchTask['idle']>>();
  for (const booking of plan.bookings) {
    let issue: ReturnType<typeof idleEquipment>;
    try {
      issue = idleEquipment(plan, booking);
    } catch {
      continue; // The booked task or equipment is gone from the plan.
    }
    // Paid days with no work planned, on both sides of the work: what the detector counts and the assistant quotes.
    const days = Number(issue?.facts.idle_days_before_start ?? 0) + Number(issue?.facts.idle_days_after_finish ?? 0);
    if (!issue || days <= 0) continue;
    idle.set(booking.taskId, { days, costMinor: days * booking.rentalRateMinor, equipment: String(issue.facts.equipment) });
  }
  const tasks: WatchTask[] = plan.tasks.map((task) => ({
    id: task.id,
    name: task.name,
    wbs: task.wbs ?? null,
    parentId: task.parentId,
    isLeaf: task.isLeaf,
    isMilestone: task.isMilestone,
    start: task.start,
    end: task.end,
    startSlipDays: task.baselineStart ? daysBetween(task.baselineStart, task.start) : null,
    finishSlipDays: task.baselineEnd ? daysBetween(task.baselineEnd, task.end) : null,
    slackDays: float[task.id]?.float_days ?? null,
    percentDone: task.percentDone,
    budgetMinor: task.budgetMinor,
    forecastMinor: task.forecastMinor,
    spentMinor: task.incurredMinor,
    crewIds: plan.assignments.filter((assignment) => assignment.taskId === task.id).map((assignment) => assignment.resourceId),
    idle: idle.get(task.id) ?? null,
  }));
  return { today, tasks, crews: plan.resources.map((resource) => ({ id: resource.id, name: resource.name, equipment: resource.kind === 'equipment' })), overbooked: overbookedDays(plan) };
}

/** The days a task works (a split task: its pieces only). */
function workDates(task: PlanTask): string[] {
  const dates: string[] = [];
  for (const span of task.segments ?? [{ start: task.start, end: task.end }]) {
    for (let date = span.start; date < span.end; date = addDays(date, 1)) if (isWorkingDay(date, task.calendar)) dates.push(date);
  }
  return dates;
}

/**
 * Days each crew is booked on more than it can do (over 100% on a working day of the task), as runs
 * of consecutive days with the same tasks, as the browser groups them. Finished, inactive and
 * milestone work books nobody.
 */
export function overbookedDays(plan: PlanSnapshot): WatchPlan['overbooked'] {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const load = new Map<number, Map<string, { units: number; tasks: Set<number> }>>();
  for (const assignment of plan.assignments) {
    const task = byId.get(assignment.taskId);
    if (!task || !task.isLeaf || task.isMilestone || task.inactive || task.percentDone >= 100) continue;
    const days = load.get(assignment.resourceId) ?? new Map<string, { units: number; tasks: Set<number> }>();
    load.set(assignment.resourceId, days);
    for (const date of workDates(task).filter((candidate) => neededOn(assignment, candidate))) {
      const slot = days.get(date) ?? { units: 0, tasks: new Set<number>() };
      slot.units += assignment.units;
      slot.tasks.add(task.id);
      days.set(date, slot);
    }
  }
  const clashes: WatchPlan['overbooked'] = [];
  for (const [crewId, days] of load) {
    let run: WatchPlan['overbooked'][number] | null = null;
    let last = '';
    for (const date of [...days.keys()].sort()) {
      const slot = days.get(date)!;
      if (slot.units <= 100 || slot.tasks.size < 2) {
        run = null;
        continue;
      }
      const ids = [...slot.tasks].sort((a, b) => a - b);
      if (run && ids.join() === run.taskIds.join() && daysBetween(last, date) <= 3) run.days += 1;
      else {
        run = { crewId, firstDay: date, days: 1, taskIds: ids };
        clashes.push(run);
      }
      last = date;
    }
  }
  return clashes;
}

/**
 * What one pass over `checked` rules changes: a situation the rules raise that has no open run opens
 * one (false to true); an open run of a checked rule whose situation is gone closes. Runs of rules
 * not checked in this pass are left alone (a daily rule is not re-judged on every change).
 */
export function diffRuns(checked: readonly Pick<WatchRuleRow, 'id'>[], alerts: readonly WatchAlert[], open: readonly WatchRunRow[]): { fire: WatchAlert[]; resolve: WatchRunRow[] } {
  const ruleIds = new Set(checked.map((rule) => rule.id));
  const key = (ruleId: string, situation: string) => `${ruleId}\n${situation}`;
  const current = new Map<string, WatchAlert>();
  for (const alert of alerts) {
    if (ruleIds.has(alert.ruleId) && !current.has(key(alert.ruleId, alert.situation))) current.set(key(alert.ruleId, alert.situation), alert);
  }
  const opened = new Set(open.map((run) => key(run.rule_id, run.situation)));
  return {
    fire: [...current.entries()].filter(([at]) => !opened.has(at)).map(([, alert]) => alert),
    resolve: open.filter((run) => ruleIds.has(run.rule_id) && !current.has(key(run.rule_id, run.situation))),
  };
}

/** `HH:MM` of a local time. */
export function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * The daily rules due at `now`: enabled, their time passed today, and not yet run today
 * (`lastRun`: rule id -> the day it last ran).
 */
export function dueDailyRules<T extends Pick<WatchRuleRow, 'id' | 'enabled' | 'trigger'>>(rules: readonly T[], now: Date, lastRun: ReadonlyMap<string, string>): T[] {
  const today = isoDay(now);
  const clock = clockOf(now);
  return rules.filter((rule) => rule.enabled && rule.trigger.kind === 'daily' && rule.trigger.at <= clock && lastRun.get(rule.id) !== today);
}

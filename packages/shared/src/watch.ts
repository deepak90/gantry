/**
 * The watch list: rules a project keeps about what deserves a look, and the alerts they raise. A rule
 * reads as a sentence: **when** (every time the plan changes, or once a day at a time) **if** a
 * condition, or any or all of a few, holds on a scope (the whole plan, some tasks and everything under
 * them, the work in a date window, a crew: finishing or starting later than planned, starting soon,
 * little slack, over budget, money spent ahead of the work, work in a date window, rented equipment
 * paid while idle, a crew or machine booked twice, the work finished) **then** an action (show it on
 * the watch list, ask the assistant to look into it, or prepare an invoice for the finished work).
 *
 * Rules only raise findings; they never change the plan. So they cannot step on each other: two rules
 * can only say something twice, and a fix someone accepts simply changes what the next check finds.
 *
 * `evaluateWatch` is plain code over a plain view of the plan, so every browser shows the same alerts
 * and no model is involved. The assistant service runs the rules once per change on the server and
 * records a run when a situation appears (false to true) and when it clears; that is where the
 * actions happen, once, however many people have the plan open. Mirrors supabase/migrations/
 * *_watch_list.sql and *_watch_triggers.sql.
 */
import { z } from 'zod';
import { format, money, type CurrencyCode } from './money';
import { timestamp, uuid } from './schemas';

const day = z.iso.date();
const taskId = z.int().positive();

export const WatchScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan') }),
  /** These tasks and everything under them (a group stands for its work package). */
  z.object({ kind: z.literal('tasks'), task_ids: z.array(taskId).min(1).max(50) }),
  /** The tasks with work between these days (both included). */
  z.object({ kind: z.literal('dates'), from: day, to: day }),
  /** The tasks these crews work on. */
  z.object({ kind: z.literal('crew'), resource_ids: z.array(taskId).min(1).max(10) }),
]);
export type WatchScope = z.infer<typeof WatchScope>;

export const WatchSimpleCondition = z.discriminatedUnion('kind', [
  /** Finishes more than `days` days after its planned (baseline) finish. */
  z.object({ kind: z.literal('finish_slip'), days: z.int().min(0).max(365) }),
  z.object({ kind: z.literal('start_slip'), days: z.int().min(0).max(365) }),
  /** Unfinished work with less than `days` working days of slack. */
  z.object({ kind: z.literal('slack_below'), days: z.int().min(0).max(60) }),
  /** Forecast above budget by `percent` or more. */
  z.object({ kind: z.literal('over_budget'), percent: z.number().min(0).max(1000) }),
  /** Spent (as a share of the forecast) ahead of the work done by `points` or more. */
  z.object({ kind: z.literal('spent_ahead'), points: z.int().min(0).max(100) }),
  /** Has work between these days (e.g. an inspection week, a road closure). */
  z.object({ kind: z.literal('in_window'), from: day, to: day }),
  /** Unstarted work that starts within `days` days of today. */
  z.object({ kind: z.literal('starts_soon'), days: z.int().min(0).max(90) }),
  /** Rented equipment booked for days with no work planned, before its work or after it. */
  z.object({ kind: z.literal('idle_rental') }),
  /** A crew (or, with `equipment_only`, a rented machine) booked on two tasks on the same day. */
  z.object({ kind: z.literal('crew_overbooked'), equipment_only: z.boolean().optional() }),
  /** Every task of the scope under one group (a floor) is finished: raised once per group. */
  z.object({ kind: z.literal('all_done') }),
]);
export type WatchSimpleCondition = z.infer<typeof WatchSimpleCondition>;

/** One condition, or any or all of a few (one level: a rule stays a sentence). */
export const WatchCondition = z.union([
  WatchSimpleCondition,
  z.object({ kind: z.literal('any'), of: z.array(WatchSimpleCondition).min(2).max(3) }),
  z.object({ kind: z.literal('all'), of: z.array(WatchSimpleCondition).min(2).max(3) }),
]);
export type WatchCondition = z.infer<typeof WatchCondition>;
export type WatchConditionKind = WatchCondition['kind'];
export type WatchSimpleKind = WatchSimpleCondition['kind'];

/** The conditions a rule is made of. */
export const conditionsOf = (condition: WatchCondition): readonly WatchSimpleCondition[] => (condition.kind === 'any' || condition.kind === 'all' ? condition.of : [condition]);

/** When a rule is checked. */
export const WatchTrigger = z.discriminatedUnion('kind', [
  /** Every time the plan changes (once per change, a few seconds after it settles), and when the rule is saved. */
  z.object({ kind: z.literal('change') }),
  /** Once a day at this time (24-hour `HH:MM`, the assistant service's clock), and when the rule is saved. */
  z.object({ kind: z.literal('daily'), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
]);
export type WatchTrigger = z.infer<typeof WatchTrigger>;

/** What happens when a rule's situation appears. */
export const WatchAction = z.discriminatedUnion('kind', [
  /** Show it on the watch list and pop it up for whoever has the plan open. */
  z.object({ kind: z.literal('alert') }),
  /** Also ask the assistant to look into it and suggest alternatives, in a new conversation for the rule's author. */
  z.object({ kind: z.literal('ask_assistant'), note: z.string().max(400).optional() }),
  /** Prepare an invoice to the project's client for the finished work; a person looks it over and sends it. */
  z.object({ kind: z.literal('prepare_invoice') }),
]);
export type WatchAction = z.infer<typeof WatchAction>;

export const WatchRuleRow = z.object({
  id: uuid,
  project_id: uuid,
  name: z.string().min(1).max(120),
  scope: WatchScope,
  condition: WatchCondition,
  trigger: WatchTrigger.default({ kind: 'change' }),
  action: WatchAction.default({ kind: 'alert' }),
  enabled: z.boolean(),
  created_by: uuid.nullable(),
  /** The conversation the rule was drafted in: what it finds is told there. */
  thread_id: uuid.nullable().default(null),
  created_at: timestamp,
  updated_at: timestamp,
});
export type WatchRuleRow = z.infer<typeof WatchRuleRow>;

/**
 * One time a rule's situation appeared on the server, and when it cleared. Titles carry no amounts
 * (every member reads them; the assistant's conversation for the rule's author may).
 */
export const WatchRunRow = z.object({
  id: uuid,
  project_id: uuid,
  rule_id: uuid,
  /** The rule and what it is about (a task, or all of them): one open run per situation. */
  situation: z.string().min(1).max(200),
  fingerprint: z.string().min(1).max(200),
  severity: z.enum(['high', 'medium', 'low']),
  title: z.string().max(400),
  detail: z.string().max(1000),
  task_ids: z.array(taskId).max(50),
  /** The plan revision it was seen on; null for a daily check. */
  revision: z.int().nonnegative().nullable(),
  /** The conversation the assistant opened about it ("ask the assistant"). */
  thread_id: uuid.nullable(),
  fired_at: timestamp,
  resolved_at: timestamp.nullable(),
});
export type WatchRunRow = z.infer<typeof WatchRunRow>;

export const WatchDismissalRow = z.object({
  id: uuid,
  project_id: uuid,
  rule_id: uuid,
  fingerprint: z.string().min(1).max(200),
  dismissed_by: uuid.nullable(),
  created_at: timestamp,
});
export type WatchDismissalRow = z.infer<typeof WatchDismissalRow>;

/** Plain words for each condition, for the rule form and the list. */
export const WATCH_CONDITION_WORDS: Readonly<Record<WatchConditionKind, { label: string; icon: string; money?: boolean }>> = {
  finish_slip: { label: 'Finishes later than planned', icon: 'flag-checkered' },
  start_slip: { label: 'Starts later than planned', icon: 'play' },
  slack_below: { label: 'Little slack left', icon: 'hourglass-half' },
  over_budget: { label: 'Over budget', icon: 'sack-dollar', money: true },
  spent_ahead: { label: 'Money spent ahead of the work', icon: 'money-bill-trend-up', money: true },
  in_window: { label: 'Has work in a date window', icon: 'calendar-xmark' },
  starts_soon: { label: 'Starts soon', icon: 'calendar-day' },
  idle_rental: { label: 'Rented equipment paid while idle', icon: 'truck-ramp-box', money: true },
  crew_overbooked: { label: 'A crew booked twice', icon: 'people-arrows' },
  all_done: { label: 'The work is finished', icon: 'circle-check' },
  any: { label: 'Any of these', icon: 'list-ul' },
  all: { label: 'All of these', icon: 'list-check' },
};

/** A condition in a few words, as a block of a rule. */
export function conditionWords(condition: WatchSimpleCondition): string {
  switch (condition.kind) {
    case 'finish_slip':
    case 'start_slip':
      return `${condition.kind === 'finish_slip' ? 'Finishes' : 'Starts'} ${condition.days === 0 ? 'later than planned' : `more than ${condition.days} days late`}`;
    case 'slack_below':
      return `Under ${condition.days} days of slack`;
    case 'over_budget':
      return `${condition.percent}% or more over budget`;
    case 'spent_ahead':
      return `Spending ${condition.points} points ahead of the work`;
    case 'in_window':
      return `Has work between ${shortDay(condition.from)} and ${shortDay(condition.to)}`;
    case 'starts_soon':
      return `Starts within ${condition.days} days`;
    case 'idle_rental':
      return 'Rented equipment is sitting idle';
    case 'crew_overbooked':
      return condition.equipment_only ? 'Equipment is booked twice' : 'A crew is booked twice';
    case 'all_done':
      return 'The work is finished';
  }
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2027-02-01` as people read it: "Mon, Feb 1". */
export function shortDay(date: string): string {
  const parsed = new Date(utc(date));
  return `${SHORT_WEEKDAYS[parsed.getUTCDay()]}, ${SHORT_MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCDate()}`;
}

// -----------------------------------------------------------------------------------------
// The plan as the rules see it
// -----------------------------------------------------------------------------------------

export interface WatchTask {
  id: number;
  name: string;
  wbs: string | null;
  parentId: number | null;
  isLeaf: boolean;
  isMilestone: boolean;
  /** `YYYY-MM-DD`; end exclusive. */
  start: string;
  end: string;
  /** Days later than the baseline (negative: earlier); null without a baseline. */
  startSlipDays: number | null;
  finishSlipDays: number | null;
  /** Working days it can slip before the handover moves; null when unknown. */
  slackDays: number | null;
  percentDone: number;
  budgetMinor: number;
  forecastMinor: number;
  spentMinor: number;
  crewIds: number[];
  /** Rented equipment booked with no work planned, before this task or after it (from the bookings). */
  idle: { days: number; costMinor: number | null; equipment: string } | null;
}

export interface WatchPlan {
  /** `YYYY-MM-DD`: what "soon" counts from. */
  today: string;
  tasks: WatchTask[];
  crews: { id: number; name: string; equipment?: boolean }[];
  /** Days a crew is booked on more than one task, from the assignments. */
  overbooked: { crewId: number; firstDay: string; days: number; taskIds: number[] }[];
}

export interface WatchAlert {
  ruleId: string;
  ruleName: string;
  condition: WatchSimpleKind;
  /** What the alert is about (the rule and a task, or all of them): stays while it gets worse or better. */
  situation: string;
  /** Stable for the same situation; a worse one (a bigger slip, another task) gets a new one. */
  fingerprint: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  taskIds: number[];
}

export interface WatchOptions {
  canViewCosts: boolean;
  currency: CurrencyCode;
}

/** More matching tasks than this make one alert that lists them, not one alert each. */
const GROUP_OVER = 4;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const taskLabel = (task: WatchTask) => `${task.wbs ? `${task.wbs} ` : ''}${task.name}`;
const isDone = (task: WatchTask) => task.percentDone >= 100;

/** The tasks a scope covers, in plan order (groups stand for everything under them). */
export function tasksInScope(scope: WatchScope, plan: WatchPlan): WatchTask[] {
  switch (scope.kind) {
    case 'plan':
      return plan.tasks;
    case 'tasks': {
      const wanted = new Set(scope.task_ids);
      for (let grew = true; grew; ) {
        grew = false;
        for (const task of plan.tasks) {
          if (task.parentId !== null && wanted.has(task.parentId) && !wanted.has(task.id)) {
            wanted.add(task.id);
            grew = true;
          }
        }
      }
      return plan.tasks.filter((task) => wanted.has(task.id));
    }
    case 'dates':
      return plan.tasks.filter((task) => task.isLeaf && worksIn(task, scope.from, scope.to));
    case 'crew': {
      const crews = new Set(scope.resource_ids);
      return plan.tasks.filter((task) => task.crewIds.some((id) => crews.has(id)));
    }
  }
}

/** Whether the task has work on any day from `from` to `to` (both included). */
function worksIn(task: WatchTask, from: string, to: string): boolean {
  const end = task.isMilestone ? task.start : task.end;
  return task.isMilestone ? task.start >= from && task.start <= to : task.start <= to && end > from;
}

const amount = (minor: number, options: WatchOptions) => (options.canViewCosts ? format(money(minor, options.currency)) : null);

interface Hit {
  task: WatchTask;
  /** What makes the situation worse, for the fingerprint (days, percent). */
  measure: number;
  text: string;
}

/** Alerts from one rule: one per task, or one for all of them when many tasks match. */
function alertsFor(rule: Pick<WatchRuleRow, 'id' | 'name'> & { condition: WatchSimpleCondition }, hits: Hit[], severity: WatchAlert['severity'], summary: (count: number) => string): WatchAlert[] {
  if (hits.length === 0) return [];
  const base = { ruleId: rule.id, ruleName: rule.name, condition: rule.condition.kind, severity };
  if (hits.length > GROUP_OVER) {
    const worst = [...hits].sort((a, b) => b.measure - a.measure);
    return [
      {
        ...base,
        situation: `${rule.id}:many`,
        fingerprint: `${rule.id}:many:${hits.length}:${worst[0]!.measure}`,
        title: summary(hits.length),
        detail: worst
          .slice(0, 3)
          .map((hit) => hit.text)
          .join(' · ')
          .concat(hits.length > 3 ? ` · and ${hits.length - 3} more` : ''),
        taskIds: worst.map((hit) => hit.task.id),
      },
    ];
  }
  return hits.map((hit) => ({ ...base, situation: `${rule.id}:${hit.task.id}`, fingerprint: `${rule.id}:${hit.task.id}:${hit.measure}`, title: hit.text, detail: rule.name, taskIds: [hit.task.id] }));
}

/** The alerts the enabled rules raise on the plan now (dismissed ones are left to the caller). */
export function evaluateWatch(rules: readonly Pick<WatchRuleRow, 'id' | 'name' | 'scope' | 'condition' | 'enabled'>[], plan: WatchPlan, options: WatchOptions): WatchAlert[] {
  const alerts: WatchAlert[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const scoped = tasksInScope(rule.scope, plan);
    const parts = conditionsOf(rule.condition).map((condition) => alertsOfCondition({ ...rule, condition }, condition, scoped, plan, options));
    if (rule.condition.kind === 'all') {
      // All of them: what the first one raises, on tasks each of the others raises too.
      const rest = parts.slice(1).map((part) => new Set(part.flatMap((alert) => alert.taskIds)));
      alerts.push(...parts[0]!.filter((alert) => alert.taskIds.some((id) => rest.every((set) => set.has(id)))));
    } else {
      // Any of them: a task can be raised for two reasons, so its situations are kept apart.
      const composite = rule.condition.kind === 'any';
      alerts.push(...parts.flat().map((alert) => (composite ? { ...alert, situation: `${alert.situation}:${alert.condition}`, fingerprint: `${alert.fingerprint}:${alert.condition}` } : alert)));
    }
  }
  return alerts;
}

/** What one of a rule's conditions raises on the tasks in its scope. */
function alertsOfCondition(rule: Pick<WatchRuleRow, 'id' | 'name' | 'scope'> & { condition: WatchSimpleCondition }, condition: WatchSimpleCondition, scoped: readonly WatchTask[], plan: WatchPlan, options: WatchOptions): WatchAlert[] {
  const alerts: WatchAlert[] = [];
  const crewName = (id: number) => plan.crews.find((crew) => crew.id === id)?.name ?? `Crew ${id}`;
  const open = scoped.filter((task) => !isDone(task));
  {
    switch (condition.kind) {
      case 'finish_slip':
      case 'start_slip': {
        const finish = condition.kind === 'finish_slip';
        const hits = open.flatMap((task): Hit[] => {
          const slip = finish ? task.finishSlipDays : task.startSlipDays;
          return slip !== null && slip > condition.days ? [{ task, measure: slip, text: `${taskLabel(task)} ${finish ? 'finishes' : 'starts'} ${plural(slip, 'day')} later than planned` }] : [];
        });
        alerts.push(...alertsFor(rule, hits, hits.some((hit) => hit.task.isMilestone) ? 'high' : 'medium', (count) => `${plural(count, 'task')} ${finish ? 'finish' : 'start'} later than planned`));
        break;
      }
      case 'slack_below': {
        const hits = open
          .filter((task) => task.isLeaf && task.slackDays !== null && task.slackDays < condition.days)
          .map((task): Hit => ({ task, measure: condition.days - (task.slackDays ?? 0), text: `${taskLabel(task)} has ${task.slackDays! <= 0 ? 'no slack' : `only ${plural(task.slackDays!, 'day')} of slack`}` }));
        alerts.push(...alertsFor(rule, hits, 'medium', (count) => `${plural(count, 'task')} with under ${plural(condition.days, 'day')} of slack`));
        break;
      }
      case 'over_budget': {
        const hits = open
          .filter((task) => task.isLeaf && task.budgetMinor > 0 && ((task.forecastMinor - task.budgetMinor) / task.budgetMinor) * 100 >= Math.max(condition.percent, 0.0001))
          .map((task): Hit => {
            const percent = Math.round(((task.forecastMinor - task.budgetMinor) / task.budgetMinor) * 1000) / 10;
            const over = amount(task.forecastMinor - task.budgetMinor, options);
            return { task, measure: Math.round(percent), text: `${taskLabel(task)} is ${percent}% over budget${over ? ` (${over})` : ''}` };
          });
        alerts.push(...alertsFor(rule, hits, 'medium', (count) => `${plural(count, 'task')} ${condition.percent}% or more over budget`));
        break;
      }
      case 'spent_ahead': {
        const hits = open
          .filter((task) => task.isLeaf && task.forecastMinor > 0 && (task.spentMinor / task.forecastMinor) * 100 - task.percentDone >= condition.points)
          .map((task): Hit => {
            const spent = Math.round((task.spentMinor / task.forecastMinor) * 100);
            return { task, measure: spent - Math.round(task.percentDone), text: `${taskLabel(task)}: ${spent}% of the money spent, ${Math.round(task.percentDone)}% of the work done` };
          });
        alerts.push(...alertsFor(rule, hits, 'medium', (count) => `${plural(count, 'task')} spending ahead of the work`));
        break;
      }
      case 'in_window': {
        const hits = open
          .filter((task) => (task.isLeaf || task.isMilestone) && worksIn(task, condition.from, condition.to))
          .map((task): Hit => ({ task, measure: 0, text: `${taskLabel(task)} has work between ${condition.from} and ${condition.to}` }));
        alerts.push(...alertsFor(rule, hits, 'medium', (count) => `${plural(count, 'task')} with work between ${condition.from} and ${condition.to}`));
        break;
      }
      case 'starts_soon': {
        const until = addDays(plan.today, condition.days);
        const hits = open
          .filter((task) => (task.isLeaf || task.isMilestone) && task.percentDone === 0 && task.start >= plan.today && task.start <= until)
          .map((task): Hit => {
            const days = dayDiff(plan.today, task.start);
            return { task, measure: condition.days - days, text: `${taskLabel(task)} starts ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}` };
          });
        alerts.push(...alertsFor(rule, hits, 'low', (count) => `${plural(count, 'task')} start within ${plural(condition.days, 'day')}`));
        break;
      }
      case 'idle_rental': {
        const hits = scoped
          .filter((task) => task.idle && task.idle.days > 0)
          .map((task): Hit => {
            const cost = task.idle!.costMinor !== null ? amount(task.idle!.costMinor, options) : null;
            return { task, measure: task.idle!.days, text: `${task.idle!.equipment} booked ${plural(task.idle!.days, 'day')} with no work planned on ${task.name}${cost ? ` (${cost})` : ''}` };
          });
        alerts.push(...alertsFor(rule, hits, 'high', (count) => `${plural(count, 'rental')} paid while idle`));
        break;
      }
      case 'all_done': {
        // One alert per group (a floor): the scope's tasks under it, all finished.
        const groups = new Map<number, WatchTask[]>();
        for (const task of scoped) {
          if (!task.isLeaf || task.parentId === null) continue;
          groups.set(task.parentId, [...(groups.get(task.parentId) ?? []), task]);
        }
        for (const [groupId, tasks] of groups) {
          if (!tasks.every(isDone)) continue;
          const group = plan.tasks.find((task) => task.id === groupId);
          alerts.push({
            ruleId: rule.id,
            ruleName: rule.name,
            condition: 'all_done',
            situation: `${rule.id}:done:${groupId}`,
            fingerprint: `${rule.id}:done:${groupId}:${tasks.length}`,
            severity: 'low',
            title: `${plural(tasks.length, 'task')} finished on ${group?.name ?? 'this part of the plan'}`,
            detail: tasks.map((task) => task.name).slice(0, 4).join(', '),
            taskIds: tasks.map((task) => task.id),
          });
        }
        break;
      }
      case 'crew_overbooked': {
        const inScope = new Set(scoped.map((task) => task.id));
        const crews = rule.scope.kind === 'crew' ? new Set(rule.scope.resource_ids) : null;
        const machines = new Set(plan.crews.filter((crew) => crew.equipment).map((crew) => crew.id));
        const clashes = plan.overbooked.filter((clash) => (!condition.equipment_only || machines.has(clash.crewId)) && (crews ? crews.has(clash.crewId) : clash.taskIds.some((id) => inScope.has(id))));
        const byTask = new Map(plan.tasks.map((task) => [task.id, task]));
        for (const clash of clashes.slice(0, 6)) {
          const names = clash.taskIds.map((id) => byTask.get(id)?.name ?? `task ${id}`);
          alerts.push({
            ruleId: rule.id,
            ruleName: rule.name,
            condition: 'crew_overbooked',
            situation: `${rule.id}:${clash.crewId}:${clash.firstDay}`,
            fingerprint: `${rule.id}:${clash.crewId}:${clash.firstDay}:${clash.taskIds.join(',')}`,
            severity: 'medium',
            title: `${crewName(clash.crewId)} booked twice from ${shortDay(clash.firstDay)} (${plural(clash.days, 'day')})`,
            detail: names.join(' and '),
            taskIds: clash.taskIds,
          });
        }
        break;
      }
    }
  }
  return alerts;
}

/** A rule's scope and condition in a few words, for the list. */
export function describeRule(rule: Pick<WatchRuleRow, 'scope' | 'condition'>, names: { task(id: number): string | null; crew(id: number): string | null }): string {
  const scope = rule.scope;
  const what =
    scope.kind === 'plan'
      ? 'the whole plan'
      : scope.kind === 'tasks'
        ? scope.task_ids.map((id) => names.task(id) ?? `task ${id}`).slice(0, 3).join(', ') + (scope.task_ids.length > 3 ? ` and ${scope.task_ids.length - 3} more` : '')
        : scope.kind === 'dates'
          ? `work between ${scope.from} and ${scope.to}`
          : scope.resource_ids.map((id) => names.crew(id) ?? `crew ${id}`).join(', ');
  const whole = rule.condition;
  if (whole.kind === 'any' || whole.kind === 'all') {
    const words = whole.of.map((part) => conditionWords(part).toLowerCase());
    return `${what}: ${whole.kind === 'any' ? words.join(' or ') : words.join(' and ')}`;
  }
  const condition = whole;
  const when =
    condition.kind === 'finish_slip' || condition.kind === 'start_slip'
      ? `${condition.kind === 'finish_slip' ? 'finishes' : 'starts'} ${condition.days === 0 ? 'later than planned' : `more than ${plural(condition.days, 'day')} late`}`
      : condition.kind === 'slack_below'
        ? `under ${plural(condition.days, 'day')} of slack`
        : condition.kind === 'over_budget'
          ? `${condition.percent}% or more over budget`
          : condition.kind === 'spent_ahead'
            ? `spending ${condition.points} points ahead of the work`
            : condition.kind === 'in_window'
              ? `work between ${condition.from} and ${condition.to}`
              : condition.kind === 'starts_soon'
                ? `starts within ${plural(condition.days, 'day')}`
                : WATCH_CONDITION_WORDS[condition.kind].label.toLowerCase();
  return `${what}: ${when}`;
}

/** A daily rule's 24-hour `HH:MM` as people read it: "07:00" is "7:00 AM", "14:30" is "2:30 PM". */
export function clockTime(at: string): string {
  const [hours = 0, minutes = 0] = at.split(':').map(Number);
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** When a rule is checked, in words: "Every time the plan changes", "Every day at 7:00 AM". */
export function describeTrigger(trigger: WatchTrigger): string {
  return trigger.kind === 'change' ? 'Every time the plan changes' : `Every day at ${clockTime(trigger.at)}`;
}

/** What a rule does, in words. */
export function describeAction(action: WatchAction): string {
  return action.kind === 'alert' ? 'Show it on the watch list' : action.kind === 'prepare_invoice' ? 'Prepare a PayPal invoice' : 'Ask the assistant for alternatives';
}

const DAY_MS = 86_400_000;
const utc = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

function addDays(date: string, days: number): string {
  return new Date(utc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** A rule as people make it, before it is saved. */
export interface WatchRecipe {
  key: string;
  name: string;
  /** One line on why a team keeps it. */
  why: string;
  scope: WatchScope;
  condition: WatchCondition;
  trigger: WatchTrigger;
  action: WatchAction;
  /** Watches the plan's handover milestone (the app puts it in the scope when the rule is added). */
  forHandover?: boolean;
}

/**
 * Ready-made rules to start from. None is on until someone adds it: a fresh plan raises nothing by
 * itself (the team decides what deserves a look).
 */
export const WATCH_RECIPES: readonly WatchRecipe[] = [
  {
    key: 'idle-rental',
    name: 'Rented equipment paid while it stands idle',
    why: 'Equipment on rent costs money every day it waits for its work.',
    scope: { kind: 'plan' },
    condition: { kind: 'idle_rental' },
    trigger: { kind: 'change' },
    action: { kind: 'ask_assistant', note: 'Suggest how to stop paying for idle days: move the rental, or the work.' },
  },
  {
    key: 'over-budget',
    name: 'Work 10% or more over budget',
    why: 'Catch a forecast that has run past its budget while there is time to act.',
    scope: { kind: 'plan' },
    condition: { kind: 'over_budget', percent: 10 },
    trigger: { kind: 'change' },
    action: { kind: 'ask_assistant', note: 'Suggest cheaper ways to do the work or recover the cost.' },
  },
  {
    key: 'crew-twice',
    name: 'A crew booked on two tasks at once',
    why: 'One firm cannot be in two places: spot it before the day comes.',
    scope: { kind: 'plan' },
    condition: { kind: 'crew_overbooked' },
    trigger: { kind: 'change' },
    action: { kind: 'alert' },
  },
  {
    key: 'handover-late',
    name: 'The handover moves later than planned',
    why: 'The date the owner was promised.',
    scope: { kind: 'plan' },
    condition: { kind: 'finish_slip', days: 0 },
    trigger: { kind: 'change' },
    action: { kind: 'alert' },
    forHandover: true,
  },
  {
    key: 'starts-soon',
    name: 'Work starting this week',
    why: 'A morning look at what starts in the next few days.',
    scope: { kind: 'plan' },
    condition: { kind: 'starts_soon', days: 5 },
    trigger: { kind: 'daily', at: '07:00' },
    action: { kind: 'alert' },
  },
];

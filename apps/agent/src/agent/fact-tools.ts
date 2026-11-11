/**
 * The assistant's fact tools: exact arithmetic, money totals over the cost columns, working days on
 * the project calendars, the calendars themselves, milestones, the time ranges on the timeline, the
 * plan's change history and the project's watch list (its rules as sentences, what they raise now and
 * what is still open). Everything is worked out in code (plan/calc.ts, plan/facts.ts,
 * plan/changes.ts) so the same question gets the same number every time; amounts come back in minor
 * units (and as text), which also lets the grounding check accept them in a reply.
 */
import { z } from 'zod';
import { describeAction, describeRule, describeTrigger, evaluateWatch } from '@collab/shared';
import { calculate, CalcError } from '../plan/calc';
import { editDecisions, planChanges } from '../plan/changes';
import { answerTime, calendarReport, costReport, milestones, timeRanges, type CostGroupBy, type TimeQuestion } from '../plan/facts';
import { day, usd } from '../plan/format';
import type { PlanSnapshot } from '../plan/snapshot';
import { planDay } from '../plan/today';
import { watchPlanFrom } from '../plan/watch';
import type { SeedCalendarId } from '@collab/shared/seed';
import { ToolRefusal } from './refusal';
import type { ToolContext } from './tools';

const date = z.iso.date().describe('Calendar date YYYY-MM-DD');
const calendarRef = z
  .union([z.enum(['standard', 'site']), z.string().min(1).max(80)])
  .nullish()
  .describe('Calendar: "standard" (Mon-Fri) or "site" (Mon-Sat), or a crew name or task id whose calendar to use; default standard');

export const FactToolSchemas = {
  calculate: z.object({
    expression: z
      .string()
      .min(1)
      .max(400)
      .describe('One arithmetic expression on numbers up to a trillion: + - * / ^, %, parentheses, round(x, n), sum, mean, median, min, max, abs, sqrt, log'),
    values: z
      .record(z.string().min(1).max(40), z.union([z.number(), z.string().max(40)]))
      .nullish()
      .describe('Named numbers used in the expression, e.g. {"forecast": 5200, "budget": 4800}'),
    decimals: z.int().min(0).max(10).nullish().describe('Places to round the answer to (default 2)'),
    money: z.boolean().nullish().describe('True when the answer is an amount of money in dollars'),
  }),
  sum_costs: z.object({
    task_ids: z.array(z.int().positive()).max(60).nullish().describe('Only these tasks (and everything under them); omit for the whole plan'),
    group_by: z.enum(['none', 'phase', 'group', 'crew', 'task']).nullish().describe('Split the totals by phase, by the group above each task, by crew or per task'),
  }),
  count_working_days: z.object({
    op: z.enum(['working_days_between', 'add_working_days', 'subtract_working_days', 'is_working_day', 'next_working_day', 'calendar_days_between']),
    from: date.nullish().describe('First day (working_days_between, add/subtract, calendar_days_between)'),
    to: date.nullish().describe('Last day, included (working_days_between, calendar_days_between)'),
    date: date.nullish().describe('The day to ask about (is_working_day, next_working_day)'),
    days: z.int().min(1).max(2000).nullish().describe('How many working days (add/subtract)'),
    calendar: calendarRef,
  }),
  get_calendars: z.object({}),
  get_milestones: z.object({}),
  get_time_ranges: z.object({ from: date.nullish(), to: date.nullish() }),
  get_watch_list: z.object({}),
  get_plan_changes: z.object({
    task_ids: z.array(z.int().positive()).max(30).nullish().describe('Only changes that touched these tasks'),
    since: date.nullish().describe('Only changes made on or after this day'),
    limit: z.int().min(1).max(30).nullish().describe('How many changes, newest first (default 10)'),
  }),
};
export type FactToolName = keyof typeof FactToolSchemas;

export const FACT_TOOL_DESCRIPTIONS: Record<FactToolName, string> = {
  calculate:
    'Work out any arithmetic exactly (decimal math, so 0.1 + 0.2 is 0.3): differences, ratios, percentages ("15% * 2400" or "(5200 - 4800) / 4800 * 100"), averages, rounding, powers and roots. Use it for every number you did not get straight from another tool; never do sums yourself. Set money true for an amount of money so it may be quoted.',
  sum_costs:
    'Add up the cost columns (budget, forecast, spent, paid) for the whole plan, some tasks, or split by phase, group, crew or task, with over budget, unpaid, still to spend and percentages (over budget %, spent % of forecast, paid % of spent, work done by forecast). Leaf tasks only, so groups are not counted twice; matches the totals the plan shows.',
  count_working_days:
    'Working-time arithmetic on the project calendars: working days between two days (both included), the last day of N working days from a start, N working days before a day, whether a day is a working day (and why not), the next working day, or plain calendar days between two days. Weekends and the holiday shutdown are taken into account.',
  get_calendars: 'The project calendars (which days each works, the holiday shutdown and the working days it costs), which crews work to which calendar, and how lags count.',
  get_milestones: 'Every milestone in date order: its date, baseline date and slip in working days, slack before the handover moves, whether it is critical or done, any fixed-date constraint, and which one is the handover.',
  get_time_ranges: 'The ranges drawn on the timeline: the holiday shutdown and the bands library pieces brought (curing, drying, rooms closed to other trades), with their first and last days and the task each belongs to.',
  get_watch_list:
    'The project’s watch list: each rule as a sentence (when it is checked, what it watches, what it does: show an alert or ask you for alternatives), whether it is on, what it raises on the plan right now, and the situations still open since it spoke up. Use it when asked what is being watched, why an alert or a conversation appeared, or before suggesting a rule. Titles carry no amounts.',
  get_plan_changes:
    'The plan’s change history, newest first: who changed what and when (by hand or through the assistant), with before and after values, links and crews, and the moves the engine made as a result; plus what people decided about the assistant’s drafted changes (applied, applied automatically, declined).',
};

export const isFactTool = (name: string): name is FactToolName => name in FactToolSchemas;

function withoutNulls<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined)) as Partial<T>;
}

/** A calendar by id, or the calendar of a crew (by name) or a task (by id). */
function resolveCalendar(plan: PlanSnapshot, ref: string | undefined): SeedCalendarId {
  if (!ref || ref === 'standard' || ref === 'site') return (ref as SeedCalendarId | undefined) ?? 'standard';
  const id = Number(ref);
  if (Number.isInteger(id)) {
    const task = plan.tasks.find((candidate) => candidate.id === id);
    if (task) return task.calendar;
  }
  const wanted = ref.trim().toLowerCase();
  const crew = plan.resources.find((resource) => resource.name.toLowerCase() === wanted) ?? plan.resources.find((resource) => resource.name.toLowerCase().includes(wanted));
  if (crew) return crew.calendar;
  throw new ToolRefusal(`No calendar, crew or task called "${ref}"; use "standard" or "site", a crew name or a task id`);
}

/** "-1234.50" -> -123450, without going through floating point. */
function minorFromCents(fixed: string): number {
  const negative = fixed.startsWith('-');
  const [whole = '0', cents = '00'] = fixed.replace('-', '').split('.');
  const minor = Number(whole) * 100 + Number(cents.padEnd(2, '0').slice(0, 2));
  return negative ? -minor : minor;
}

export function runFactTool(name: FactToolName, rawArgs: unknown, ctx: ToolContext): unknown {
  const parsed = FactToolSchemas[name].safeParse(rawArgs);
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  const { plan } = ctx;
  switch (name) {
    case 'calculate': {
      const args = withoutNulls(parsed.data as z.infer<typeof FactToolSchemas.calculate>);
      try {
        const result = calculate(args.expression!, args.values ?? {}, args.decimals ?? 2);
        if (!args.money) return result;
        const minor = minorFromCents(calculate(args.expression!, args.values ?? {}, 2).rounded);
        return { ...result, amount_minor: minor, text: usd(minor) };
      } catch (error) {
        if (error instanceof CalcError) throw new ToolRefusal(error.message);
        throw error;
      }
    }
    case 'sum_costs': {
      const args = withoutNulls(parsed.data as z.infer<typeof FactToolSchemas.sum_costs>);
      return costReport(plan, { ...(args.task_ids ? { taskIds: args.task_ids } : {}), groupBy: (args.group_by ?? 'none') as CostGroupBy });
    }
    case 'count_working_days': {
      const args = withoutNulls(parsed.data as z.infer<typeof FactToolSchemas.count_working_days>);
      const calendar = resolveCalendar(plan, args.calendar ?? undefined);
      const need = <K extends 'from' | 'to' | 'date' | 'days'>(key: K) => {
        const value = args[key];
        if (value === undefined) throw new ToolRefusal(`${args.op} needs ${key}`);
        return value as NonNullable<(typeof args)[K]>;
      };
      const question: TimeQuestion =
        args.op === 'working_days_between' ? { op: args.op, from: need('from'), to: need('to'), calendar }
        : args.op === 'add_working_days' || args.op === 'subtract_working_days' ? { op: args.op, from: need('from'), days: need('days'), calendar }
        : args.op === 'calendar_days_between' ? { op: args.op, from: need('from'), to: need('to') }
        : { op: args.op!, date: need('date'), calendar };
      return { calendar, ...answerTime(question) };
    }
    case 'get_calendars':
      return calendarReport(plan);
    case 'get_milestones': {
      const rows = milestones(plan);
      return { count: rows.length, milestones: rows.map((row) => ({ ...row, text: day(row.date) })) };
    }
    case 'get_time_ranges': {
      const args = withoutNulls(parsed.data as z.infer<typeof FactToolSchemas.get_time_ranges>);
      const rows = timeRanges(plan, { ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) });
      return { count: rows.length, ranges: rows };
    }
    case 'get_watch_list': {
      const { rules, open } = ctx.watch;
      const now = evaluateWatch(rules, watchPlanFrom(plan, planDay(ctx.planDate)), { canViewCosts: false, currency: plan.currency });
      const taskName = (id: number) => plan.tasks.find((task) => task.id === id)?.name ?? null;
      const crewName = (id: number) => plan.resources.find((resource) => resource.id === id)?.name ?? null;
      return {
        count: rules.length,
        rules: rules.map((rule) => ({
          name: rule.name,
          on: rule.enabled,
          when: describeTrigger(rule.trigger),
          watches: describeRule(rule, { task: taskName, crew: crewName }),
          then: describeAction(rule.action),
          ...(rule.action.kind === 'ask_assistant' && rule.action.note ? { asks_you_to: rule.action.note } : {}),
          raises_now: now.filter((alert) => alert.ruleId === rule.id).map((alert) => ({ title: alert.title, task_ids: alert.taskIds })),
        })),
        open: open.map((run) => ({ rule: rules.find((rule) => rule.id === run.rule_id)?.name ?? 'a removed rule', title: run.title, since: run.fired_at, task_ids: run.task_ids, conversation: run.thread_id !== null })),
        note: rules.length === 0 ? 'Nothing is watched yet: the team adds rules (or recipes) in the Watch tab.' : 'Rules are checked in code on every change (or daily at their time); you are asked only by rules that say so.',
      };
    }
    case 'get_plan_changes': {
      const args = withoutNulls(parsed.data as z.infer<typeof FactToolSchemas.get_plan_changes>);
      const limit = args.limit ?? 10;
      const rows = ctx.history.rows;
      const changes = rows ? planChanges(rows, plan.members, { ...(args.task_ids ? { taskIds: args.task_ids } : {}), ...(args.since ? { since: args.since } : {}) }) : [];
      const decisions = editDecisions(ctx.history.decisions, plan.members, args.since ?? undefined);
      return {
        count: changes.length,
        changes: changes.slice(0, limit),
        truncated: changes.length > limit,
        assistant_drafts: decisions.slice(0, limit),
        note: 'Changes since the plan was last saved as a whole; older edits are part of the starting plan.',
      };
    }
  }
}

export function summarizeFactTool(name: FactToolName, value: Record<string, any>): string {
  switch (name) {
    case 'calculate':
      return `${value.expression} = ${value.rounded}`;
    case 'sum_costs':
      return `${value.totals?.tasks ?? 0} task(s): forecast ${value.totals?.text?.forecast}, budget ${value.totals?.text?.budget}`;
    case 'count_working_days':
      return String(value.counted ?? value.text ?? (value.working !== undefined ? (value.working ? 'working day' : `not working: ${value.why_not}`) : 'ok'));
    case 'get_calendars':
      return `${value.calendars?.length ?? 0} calendar(s)`;
    case 'get_milestones':
    case 'get_time_ranges':
      return `${value.count} found`;
    case 'get_plan_changes':
      return `${value.count} change(s), ${value.assistant_drafts?.length ?? 0} decision(s)`;
    case 'get_watch_list':
      return `${value.count} rule(s), ${value.open?.length ?? 0} open`;
  }
}

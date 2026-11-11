/**
 * A read-only query over the plan, for questions no other tool answers ("which critical tasks start in March and have
 * no crew?", "how many start-to-start links have a lead?", "total forecast by phase"): one entity, conditions on its
 * fields, the fields to return, an order, a limit, and simple aggregates.
 *
 * Nothing here runs code from the model. Every field is a name from a fixed list per entity and every operator one of
 * a fixed set, matched against rows built here from the plan; a field or an operator that isn't listed is refused with
 * the ones that are.
 */
import { lastDay, usd } from './format';
import { taskFacts } from './analysis';
import { calendarReport, timeRanges } from './facts';
import type { PlanSnapshot } from './snapshot';
import { rentalDays } from '@collab/shared';

export const QUERY_ENTITIES = ['tasks', 'links', 'crews', 'assignments', 'calendars', 'time_ranges', 'rentals', 'pay_holds'] as const;
export type QueryEntity = (typeof QUERY_ENTITIES)[number];

export const QUERY_OPS = ['=', '!=', '<', '<=', '>', '>=', 'contains', 'starts_with', 'in', 'is_empty', 'not_empty'] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export const AGGREGATES = ['count', 'sum', 'min', 'max', 'avg'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

type Value = string | number | boolean | null;
type Row = Record<string, Value>;

export interface QueryCondition {
  field: string;
  op: QueryOp;
  value?: Value | readonly (string | number)[] | null;
}

export interface PlanQuery {
  entity: QueryEntity;
  where?: readonly QueryCondition[] | null;
  select?: readonly string[] | null;
  order_by?: readonly { field: string; direction?: 'asc' | 'desc' | null }[] | null;
  limit?: number | null;
  group_by?: string | null;
  aggregate?: readonly { fn: Aggregate; field?: string | null }[] | null;
}

export class QueryError extends Error {}

const LINK_TYPES: Record<number, { code: string; words: string }> = {
  0: { code: 'SS', words: 'start-to-start' },
  1: { code: 'SF', words: 'start-to-finish' },
  2: { code: 'FS', words: 'finish-to-start' },
  3: { code: 'FF', words: 'finish-to-finish' },
};

/** Each entity's fields, a line on each, and the ones a row shows when no fields are asked for. */
export const QUERY_FIELDS: Record<QueryEntity, { fields: Record<string, string>; shown: readonly string[] }> = {
  tasks: {
    fields: {
      id: 'task id',
      name: 'task name',
      wbs: 'outline number, e.g. 2.3.1',
      kind: 'phase, group, task or milestone',
      parent: 'the group it is in',
      path: 'groups above it and itself, "A › B › C"',
      phase: 'top-level phase',
      start: 'first day, YYYY-MM-DD',
      last_day: 'last working day, YYYY-MM-DD',
      working_days: 'length in working days',
      calendar: 'Mon-Fri, Mon-Sat or City inspector',
      percent_done: '0 to 100',
      status: 'not_started, in_progress or done',
      critical: 'true when it sets the handover date (no slack)',
      total_slack_days: 'working days it can slip before the handover moves (negative: already late)',
      baseline_start: 'first day as first planned',
      baseline_last_day: 'last day as first planned',
      finish_slip_days: 'working days its finish moved from the baseline (late is positive)',
      constraint_type: 'e.g. startnoearlierthan, muststarton; empty when none',
      constraint_date: 'the constraint’s date',
      deadline: 'the date it must be done by (moves nothing)',
      manually_scheduled: 'true when its links do not move it',
      inactive: 'true when switched off',
      crews: 'crews and machines on it, by name',
      crew_count: 'how many crews and machines',
      waits_for: 'links into it',
      leads_to: 'links out of it',
      budget_minor: 'budget, in cents',
      forecast_minor: 'forecast final cost, in cents',
      spent_minor: 'value of work done, in cents',
      paid_minor: 'paid out, in cents',
      pay_hold: 'true for a payment hold (work after it waits for a progress payment)',
      note: 'its note (first 200 characters)',
    },
    shown: ['id', 'wbs', 'name', 'start', 'last_day', 'working_days', 'percent_done', 'critical'],
  },
  links: {
    fields: {
      id: 'link id',
      from_id: 'id of the task that comes first',
      from: 'the task that comes first',
      to_id: 'id of the task that waits',
      to: 'the task that waits',
      type: 'FS, SS, FF or SF',
      type_words: 'finish-to-start, start-to-start, finish-to-finish or start-to-finish',
      lag_days: 'working days of lag (negative: a lead)',
      active: 'false when switched off',
    },
    shown: ['from', 'to', 'type', 'lag_days'],
  },
  crews: {
    fields: {
      id: 'crew id',
      name: 'crew, firm or machine name',
      company: 'the firm',
      trade: 'what it does',
      kind: 'labor or equipment',
      calendar: 'standard (Mon-Fri) or site (Mon-Sat)',
      tasks: 'how many tasks it is on',
    },
    shown: ['name', 'trade', 'kind', 'tasks'],
  },
  assignments: {
    fields: {
      task_id: 'task id',
      task: 'task name',
      crew_id: 'crew id',
      crew: 'crew or machine name',
      kind: 'labor or equipment',
      units: 'percent of the crew',
      on_site_from: 'a machine’s first day on this task',
      on_site_last_day: 'a machine’s last day on this task',
    },
    shown: ['task', 'crew', 'units'],
  },
  calendars: {
    fields: { id: 'standard or site', name: 'calendar name', works: 'which days it works', days_off: 'its days off', crews: 'crews on it', tasks: 'how many tasks work to it' },
    shown: ['name', 'works', 'days_off', 'tasks'],
  },
  time_ranges: {
    fields: { kind: 'holiday or band', name: 'what it is', first_day: 'YYYY-MM-DD', last_day: 'YYYY-MM-DD', task_id: 'the task a band belongs to', task: 'that task’s name', note: 'its note' },
    shown: ['kind', 'name', 'first_day', 'last_day', 'task'],
  },
  rentals: {
    fields: {
      id: 'rental (booking) id',
      machine: 'the machine',
      supplier: 'who rents it out',
      task_id: 'task id it is booked on',
      task: 'task name',
      first_day: 'first day on rent',
      last_day: 'last day on rent',
      days_on_rent: 'calendar days on rent, weekends included',
      rate_per_day_minor: 'day rate, in cents',
      booked_minor: 'what the rental as booked comes to, in cents',
    },
    shown: ['machine', 'task', 'first_day', 'last_day', 'days_on_rent'],
  },
  pay_holds: {
    fields: {
      id: 'the hold’s milestone id',
      name: 'its name',
      due: 'the day it falls due',
      state: 'waiting, paying, paid or failed',
      pays_for: 'the work it pays for',
      holds: 'the work that waits for it',
      paid_minor: 'what was sent, in cents',
      paid_at: 'when PayPal confirmed it',
    },
    shown: ['name', 'due', 'state', 'pays_for', 'holds'],
  },
};

/** The rows of an entity, built from the plan. */
export function queryRows(plan: PlanSnapshot, entity: QueryEntity): Row[] {
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const resources = new Map(plan.resources.map((resource) => [resource.id, resource]));
  const nameOf = (id: number) => tasksById.get(id)?.name ?? null;
  switch (entity) {
    case 'tasks':
      return taskFacts(plan) as unknown as Row[];
    case 'links':
      return plan.dependencies.map((link) => ({
        id: link.id ?? null,
        from_id: link.from,
        from: nameOf(link.from),
        to_id: link.to,
        to: nameOf(link.to),
        type: LINK_TYPES[link.type]?.code ?? 'FS',
        type_words: LINK_TYPES[link.type]?.words ?? 'finish-to-start',
        lag_days: Math.round(link.lag * 100) / 100,
        active: link.active !== false,
      }));
    case 'crews':
      return plan.resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
        company: resource.company,
        trade: resource.trade ?? '',
        kind: resource.kind,
        calendar: resource.calendar,
        tasks: new Set(plan.assignments.filter((assignment) => assignment.resourceId === resource.id).map((assignment) => assignment.taskId)).size,
      }));
    case 'assignments':
      return plan.assignments.map((assignment) => {
        const resource = resources.get(assignment.resourceId);
        return {
          task_id: assignment.taskId,
          task: nameOf(assignment.taskId),
          crew_id: assignment.resourceId,
          crew: resource?.name ?? null,
          kind: resource?.kind ?? null,
          units: assignment.units,
          on_site_from: assignment.rentalStart ?? null,
          on_site_last_day: assignment.rentalEnd ? lastDay(assignment.rentalEnd) : null,
        };
      });
    case 'calendars':
      return calendarReport(plan).calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, works: calendar.works, days_off: calendar.days_off, crews: calendar.crews.join(', '), tasks: calendar.tasks }));
    case 'time_ranges':
      return timeRanges(plan).map((range) => ({ kind: range.kind, name: range.name, first_day: range.first_day, last_day: range.last_day, task_id: range.task?.id ?? null, task: range.task?.name ?? null, note: range.note ?? null }));
    case 'rentals':
      return plan.bookings.map((booking) => {
        const days = rentalDays(booking.billableStart, booking.billableEnd);
        return {
          id: booking.id,
          machine: resources.get(booking.resourceId)?.name ?? null,
          supplier: booking.supplierName,
          task_id: booking.taskId,
          task: nameOf(booking.taskId),
          first_day: booking.billableStart,
          last_day: lastDay(booking.billableEnd),
          days_on_rent: days,
          rate_per_day_minor: booking.rentalRateMinor,
          booked_minor: days * booking.rentalRateMinor,
        };
      });
    case 'pay_holds':
      return plan.tasks
        .filter((task) => task.payGate)
        .map((task) => ({
          id: task.id,
          name: task.name,
          due: task.start,
          state: task.payGate!.state,
          pays_for: task.payGate!.pays.map((id) => (typeof id === 'number' ? nameOf(id) : null) ?? String(id)).join(', '),
          holds: plan.dependencies.filter((link) => link.from === task.id).map((link) => nameOf(link.to) ?? '').filter(Boolean).join(', '),
          paid_minor: task.payGate!.amountMinor,
          paid_at: task.payGate!.paidAt,
        }));
  }
}

const isEmpty = (value: Value) => value === null || value === '' || value === false;
const text = (value: Value) => (value === null ? '' : String(value)).toLowerCase();

function compare(a: Value, b: Value): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en-US', { numeric: true });
}

/** A value as the field holds it: "true" for a yes/no field, a number for a numeric one. */
function coerce(sample: Value, value: Value): Value {
  if (typeof sample === 'boolean' && typeof value === 'string') return value.toLowerCase() === 'true' ? true : value.toLowerCase() === 'false' ? false : value;
  if (typeof sample === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function matches(row: Row, condition: QueryCondition, sample: Value): boolean {
  const actual = row[condition.field] ?? null;
  const { op } = condition;
  if (op === 'is_empty') return isEmpty(actual);
  if (op === 'not_empty') return !isEmpty(actual);
  if (op === 'in') {
    const list = Array.isArray(condition.value) ? condition.value : [condition.value as Value];
    return list.some((each) => compare(actual, coerce(sample, each as Value)) === 0 || text(actual) === text(each as Value));
  }
  const wanted = coerce(sample, (Array.isArray(condition.value) ? condition.value[0] : condition.value) as Value);
  switch (op) {
    case '=':
      return typeof actual === 'string' && typeof wanted === 'string' ? text(actual) === text(wanted) : compare(actual, wanted) === 0;
    case '!=':
      return typeof actual === 'string' && typeof wanted === 'string' ? text(actual) !== text(wanted) : compare(actual, wanted) !== 0;
    case '<':
      return actual !== null && compare(actual, wanted) < 0;
    case '<=':
      return actual !== null && compare(actual, wanted) <= 0;
    case '>':
      return actual !== null && compare(actual, wanted) > 0;
    case '>=':
      return actual !== null && compare(actual, wanted) >= 0;
    case 'contains':
      return text(actual).includes(text(wanted));
    case 'starts_with':
      return text(actual).startsWith(text(wanted));
  }
}

const isMoney = (field: string) => field.endsWith('_minor');

export interface QueryResult {
  entity: QueryEntity;
  /** Rows that matched, before the limit. */
  count: number;
  rows?: Row[];
  truncated?: boolean;
  groups?: (Row & { text?: Record<string, string> })[];
  totals?: Row & { text?: Record<string, string> };
  text: string;
}

/** Runs a query on the plan. Throws QueryError, naming what is allowed, for a field or an operator that isn't. */
export function runQuery(plan: PlanSnapshot, query: PlanQuery): QueryResult {
  const spec = QUERY_FIELDS[query.entity];
  const known = Object.keys(spec.fields);
  const check = (field: string, where: string) => {
    if (!known.includes(field)) throw new QueryError(`${query.entity} has no field "${field}" (${where}). Its fields: ${known.join(', ')}.`);
  };
  for (const condition of query.where ?? []) check(condition.field, 'where');
  for (const field of query.select ?? []) check(field, 'select');
  for (const order of query.order_by ?? []) check(order.field, 'order_by');
  if (query.group_by) check(query.group_by, 'group_by');
  for (const aggregate of query.aggregate ?? []) {
    if (aggregate.fn !== 'count' && !aggregate.field) throw new QueryError(`${aggregate.fn} needs a field.`);
    if (aggregate.field) check(aggregate.field, 'aggregate');
  }

  const all = queryRows(plan, query.entity);
  const sample = (field: string) => all.find((row) => row[field] !== null && row[field] !== undefined)?.[field] ?? null;
  let rows = all.filter((row) => (query.where ?? []).every((condition) => matches(row, condition, sample(condition.field))));
  for (const order of [...(query.order_by ?? [])].reverse()) {
    const sign = order.direction === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => sign * compare(a[order.field] ?? null, b[order.field] ?? null));
  }
  const count = rows.length;
  const limit = Math.max(1, Math.min(50, query.limit ?? 20));

  const aggregates = query.aggregate ?? [];
  const totalOf = (members: Row[]) => {
    const out: Row & { text?: Record<string, string> } = {};
    const words: Record<string, string> = {};
    for (const { fn, field } of aggregates) {
      const key = field ? `${fn}_${field}` : 'count';
      if (fn === 'count') {
        out[key] = members.length;
        continue;
      }
      const numbers = members.map((member) => member[field!]).filter((value): value is number => typeof value === 'number');
      const value =
        numbers.length === 0
          ? null
          : fn === 'sum'
            ? numbers.reduce((total, each) => total + each, 0)
            : fn === 'min'
              ? Math.min(...numbers)
              : fn === 'max'
                ? Math.max(...numbers)
                : Math.round((numbers.reduce((total, each) => total + each, 0) / numbers.length) * 100) / 100;
      out[key] = value;
      if (value !== null && isMoney(field!)) words[key] = usd(Math.round(value));
    }
    if (Object.keys(words).length > 0) out.text = words;
    return out;
  };

  if (query.group_by) {
    const field = query.group_by;
    const buckets = new Map<string, Row[]>();
    for (const row of rows) {
      const key = row[field] === null || row[field] === undefined ? '' : String(row[field]);
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    }
    const groups = [...buckets.entries()].map(([key, members]) => ({ [field]: key || null, ...(aggregates.length > 0 ? totalOf(members) : { count: members.length }) }));
    const shown = groups.slice(0, 30);
    return { entity: query.entity, count, groups: shown, ...(groups.length > shown.length ? { truncated: true } : {}), text: `${count} ${query.entity.replace('_', ' ')} in ${groups.length} group${groups.length === 1 ? '' : 's'} by ${field}` };
  }
  if (aggregates.length > 0) {
    return { entity: query.entity, count, totals: totalOf(rows), text: `${count} ${query.entity.replace('_', ' ')} matched` };
  }
  const fields = query.select && query.select.length > 0 ? query.select : spec.shown;
  const picked = rows.slice(0, limit).map((row) => {
    const out: Row & { text?: Record<string, string> } = {};
    const words: Record<string, string> = {};
    for (const field of fields) {
      out[field] = row[field] ?? null;
      if (isMoney(field) && typeof row[field] === 'number') words[field] = usd(row[field] as number);
    }
    if (Object.keys(words).length > 0) out.text = words;
    return out;
  });
  return {
    entity: query.entity,
    count,
    rows: picked,
    ...(count > picked.length ? { truncated: true } : {}),
    text: count === 0 ? `No ${query.entity.replace('_', ' ')} match.` : `${count} ${query.entity.replace('_', ' ')} matched${count > picked.length ? `; the first ${picked.length} shown` : ''}`,
  };
}

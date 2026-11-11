/**
 * `query_plan`: a read-only look-up over the plan for whatever no other tool answers. The model names an entity,
 * conditions on its fields, the fields it wants, an order, a limit and simple aggregates; plan/query.ts answers from
 * the plan with fields and operators from fixed lists. No code from the model runs anywhere.
 */
import { z } from 'zod';
import { AGGREGATES, QUERY_ENTITIES, QUERY_FIELDS, QUERY_OPS, QueryError, runQuery, type PlanQuery } from '../plan/query';
import type { PlanSnapshot } from '../plan/snapshot';
import { ToolRefusal } from './refusal';

const fieldName = z.string().trim().min(1).max(40);
const scalar = z.union([z.string().max(120), z.number(), z.boolean()]);

export const QueryToolSchemas = {
  query_plan: z.object({
    entity: z.enum(QUERY_ENTITIES),
    where: z
      .array(
        z.object({
          field: fieldName,
          op: z.enum(QUERY_OPS),
          value: z.union([scalar, z.array(z.union([z.string().max(120), z.number()])).max(40)]).nullish().describe('Dates as YYYY-MM-DD; a list for "in"; leave out for is_empty and not_empty'),
        }),
      )
      .max(8)
      .nullish()
      .describe('Conditions, all of which must hold'),
    select: z.array(fieldName).max(12).nullish().describe('Fields to return; leave out for the usual ones'),
    order_by: z.array(z.object({ field: fieldName, direction: z.enum(['asc', 'desc']).nullish() })).max(3).nullish(),
    limit: z.int().min(1).max(50).nullish().describe('Rows to return (default 20)'),
    group_by: fieldName.nullish().describe('Group the matches by this field (with aggregate, or a count per group)'),
    aggregate: z
      .array(z.object({ fn: z.enum(AGGREGATES), field: fieldName.nullish() }))
      .max(4)
      .nullish()
      .describe('count, or sum/min/max/avg of a number field, over the matches (per group with group_by)'),
  }),
};
export type QueryToolName = keyof typeof QueryToolSchemas;

const fieldsLine = Object.entries(QUERY_FIELDS)
  .map(([entity, spec]) => `${entity}: ${Object.keys(spec.fields).join(', ')}`)
  .join('. ');

export const QUERY_TOOL_DESCRIPTIONS: Record<QueryToolName, string> = {
  query_plan: `Look things up in the plan when no other tool answers the question: one entity, conditions on its fields (=, !=, <, <=, >, >=, contains, starts_with, in, is_empty, not_empty), the fields to return, an order, a limit, and count/sum/min/max/avg, grouped or not. Read only. Use the typed tools first where one fits (find_tasks, get_task, get_critical_path, get_calendars, get_time_ranges, sum_costs); use this for the rest ("critical tasks in March with no crew", "links with a lead", "forecast by phase"). Money fields end in _minor (cents) and come with text in dollars; never add them up yourself. Entities and their fields: ${fieldsLine}.`,
};

export const isQueryTool = (name: string): name is QueryToolName => name in QueryToolSchemas;

export function runQueryTool(_name: QueryToolName, rawArgs: unknown, ctx: { plan: PlanSnapshot }): unknown {
  const parsed = QueryToolSchemas.query_plan.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolRefusal(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  try {
    return { plan_as_of: ctx.plan.statusDate, ...runQuery(ctx.plan, parsed.data as PlanQuery) };
  } catch (error) {
    if (error instanceof QueryError) throw new ToolRefusal(error.message);
    throw error;
  }
}

export function summarizeQueryTool(result: Record<string, unknown>): string {
  return typeof result.text === 'string' ? result.text : 'ok';
}
